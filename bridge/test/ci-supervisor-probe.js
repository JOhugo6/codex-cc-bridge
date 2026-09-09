'use strict';
// Bounded TEST-ONLY timing probe. Synthetic Node child, never native inference.
// This instruments an unchanged supervisor with debugger line actions; timings
// include debugger overhead and are NOT proof of a hosted-runner root cause.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { diagnostic, emit, lines } = require('./ci-diagnostics');
const DEADLINE_MS = 15000;
const SUPERVISOR = path.join(__dirname, '../lib/windows-job-runner.ps1');
const PINS = {
  'windows-job-runner.ps1': '2e8218d0f36caedd9e728aa7fb583ba77fd880a83cf1a50be1b5bd9ee68f7a45',
  'windows-job-runner.cs': 'a7b91def303aed0ed7d1cad3ecf12615cc9b145d8d4ad73b432e24a8f277ec3f',
};
async function inspectSources() {
  for (const [name, expected] of Object.entries(PINS)) {
    const source = await fs.readFile(path.join(__dirname, '../lib', name), 'utf8');
    if (createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex') !== expected) return false;
  }
  return true;
}
function observations(write, elapsed) {
  const seen = new Set();
  let invalid = false;
  const order = ['ps-start', 'add-type-start', 'add-type-complete', 'child-start'];
  function record(stage) {
    if (seen.has(stage)) { invalid = true; return; }
    // stdout/stderr are separate pipes: child IO can arrive before its stderr
    // child-start marker. Enforce only the order on the supervisor's stderr.
    const index = order.indexOf(stage);
    if (index > 0 && !seen.has(order[index - 1])) invalid = true;
    seen.add(stage);
    write(diagnostic(stage, { elapsedMs: elapsed(),
      ...(stage === 'child-start' || stage === 'child-io' ? { childStarted: true } : {}),
      ...(stage === 'child-io' ? { ready: true } : {}),
    }));
  }
  const stdout = lines(line => { if (line === 'ci-probe:child-io') record('child-io'); else invalid = true; },
    256, () => { invalid = true; });
  return {
    stderr: lines(line => {
      const phases = new Map([
        ['ci-probe:ps-start', 'ps-start'], ['ci-probe:add-type-start', 'add-type-start'],
        ['ci-probe:add-type-complete', 'add-type-complete'],
      ]);
      if (phases.has(line)) record(phases.get(line));
      else if (/^claude-bridge-child-pid:[1-9][0-9]{0,9}$/.test(line)) record('child-start');
    }),
    stdout,
    complete: () => !invalid && stdout.atBoundary() && [...order, 'child-io'].every(stage => seen.has(stage)),
    state: () => ({ ...(seen.has('child-start') || seen.has('child-io') ? { childStarted: true } : {}),
      ...(seen.has('child-io') ? { ready: true } : {}) }),
  };
}
async function sample(shell, root, write) {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const observed = observations(write, elapsed);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC)$/i.test(key)));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: root, TMP: root, CLAUDE_BRIDGE_CHILD: '1' });
  // Only this synthetic child supplies IO. No credentials, provider, native CLI,
  // real user profile or network access is needed by this timing experiment.
  const program = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(input!=='CI_PROBE_INPUT\\n')process.exitCode=3;else process.stdout.write('ci-probe:child-io\\n');});";
  const launch = Buffer.from(JSON.stringify({ command: process.execPath, args: ['-e', program], cwd: root, parentPid: process.pid })).toString('base64');
  return new Promise(resolve => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'ci-supervisor-probe.ps1'), '-Supervisor', SUPERVISOR, '-LaunchBase64', launch],
    { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false, oversized = false, bytes = 0, spawnFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, DEADLINE_MS);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { oversized = true; child.kill(); return; }
      if (!oversized) observed[stream](chunk);
    });
    child.stdin.on('error', () => {}); // Supervisor death may close stdin first.
    child.on('error', () => { spawnFailed = true; });
    child.on('close', exit => {
      clearTimeout(timer);
      const code = spawnFailed ? 'SPAWN_FAILED' : timedOut ? 'TIMEOUT' : oversized ? 'OUTPUT_LIMIT'
        : exit !== 0 ? 'EXIT_NONZERO' : !observed.complete() ? 'PROBE_PROTOCOL' : 'OK';
      write(diagnostic('probe-close', { code, exit, elapsedMs: elapsed(), timedOut, oversized, ...observed.state() }));
      resolve(code === 'OK');
    });
    child.stdin.end('CI_PROBE_INPUT\n');
  });
}
async function main(args = process.argv.slice(2), write = emit) {
  if (process.platform !== 'win32' || args.length !== 2 || args[0] !== '--powershell7' || !path.isAbsolute(args[1])) {
    write(diagnostic('probe-setup', { code: 'INVALID_RESULT' }));
    return 1;
  }
  let root;
  try {
    if (!await inspectSources()) {
      write(diagnostic('probe-setup', { code: 'SOURCE_MISMATCH' }));
      return 1;
    }
    const ps5 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    // Verify both selected executables exist before sampling; absence is a failed
    // gate, not an optional skip. Versions/exact selection are logged by the caller.
    for (const shell of [ps5, args[1]]) if (!(await fs.stat(shell)).isFile()) throw new Error();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-supervisor-probe-')));
    for (const name of ['appdata', 'localappdata']) await fs.mkdir(path.join(root, name));
    let ok = true;
    // Fixed order, two samples per shell, fresh shell each time. First/repeat
    // measures cache warmth only incidentally; this does not force a cold cache.
    for (const [shell, stage] of [[ps5, 'probe-ps5-first'], [ps5, 'probe-ps5-repeat'],
      [args[1], 'probe-ps7-first'], [args[1], 'probe-ps7-repeat']]) {
      write(diagnostic(stage));
      if (!await sample(shell, root, write)) ok = false;
    }
    return ok ? 0 : 1;
  } catch {
    write(diagnostic('probe-setup', { code: 'UNKNOWN' }));
    return 1;
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  emit(diagnostic('cleanup', { code: 'UNKNOWN' })); process.exitCode = 1;
});
module.exports = { main, observations, inspectSources };
