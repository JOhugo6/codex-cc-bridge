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
function observations(write, elapsed, mode = 'supervisor') {
  if (!['supervisor', 'json', 'import-json'].includes(mode)) throw new TypeError('Invalid probe mode');
  const control = mode !== 'supervisor';
  const seen = new Set();
  let invalid = false;
  const order = mode === 'json' ? ['module-ps-start', 'json-start', 'json-complete']
    : mode === 'import-json' ? ['module-ps-start', 'module-import-start', 'module-import-complete', 'json-start', 'json-complete']
    : ['ps-start', 'breakpoint-5-set', 'breakpoint-6-set', 'supervisor-call', 'add-type-start', 'add-type-complete', 'child-start'];
  const output = control ? 'module-control-complete' : 'child-io';
  const phases = new Map(order.filter(stage => stage !== 'child-start').map(stage => [`ci-probe:${stage}`, stage]));
  function record(stage) {
    if (seen.has(stage)) { invalid = true; return; }
    // stdout/stderr are separate pipes: IO can arrive before its stderr stages.
    // Enforce only the order on the shell's stderr, including module controls.
    const index = order.indexOf(stage);
    if (index > 0 && !seen.has(order[index - 1])) invalid = true;
    seen.add(stage);
    write(diagnostic(stage, { elapsedMs: elapsed(),
      ...(stage === 'child-start' || stage === 'child-io' ? { childStarted: true } : {}),
      ...(stage === 'child-io' ? { ready: true } : {}),
    }));
  }
  const stdout = lines(line => { if (line === `ci-probe:${output}`) record(output); else invalid = true; },
    256, () => { invalid = true; });
  const stderr = lines(line => {
    if (phases.has(line)) record(phases.get(line));
    else if (line.startsWith('claude-bridge-child-pid:')) {
      if (control || !/^claude-bridge-child-pid:[1-9][0-9]{0,9}$/.test(line)) invalid = true;
      else record('child-start');
    } else if (line.startsWith('ci-probe:')) invalid = true;
    // Unrelated stderr remains tolerated; markers from other modes do not.
  }, 256, undefined, ['ci-probe:', 'claude-bridge-child-pid:']);
  return {
    stderr,
    stdout,
    complete: () => !invalid && stdout.atBoundary() && !stderr.hasLostPrefix() && [...order, output].every(stage => seen.has(stage)),
    state: () => control ? {} : ({ ...(seen.has('child-start') || seen.has('child-io') ? { childStarted: true } : {}),
      ...(seen.has('child-io') ? { ready: true } : {}) }),
  };
}
async function sample(shell, root, write, mode = 'supervisor', spawnChild = spawn) {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const observed = observations(write, elapsed, mode);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC)$/i.test(key)));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: root, TMP: root, CLAUDE_BRIDGE_CHILD: '1' });
  // Only the supervisor sample launches a synthetic Node child. Module controls
  // parse a fixed literal in the shell and never represent native readiness.
  const program = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(input!=='CI_PROBE_INPUT\\n')process.exitCode=3;else process.stdout.write('ci-probe:child-io\\n');});";
  const launch = Buffer.from(JSON.stringify({ command: process.execPath, args: ['-e', program], cwd: root, parentPid: process.pid })).toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-File', ...(mode === 'supervisor'
    ? [path.join(__dirname, 'ci-supervisor-probe.ps1'), '-Supervisor', SUPERVISOR, '-LaunchBase64', launch]
    : [path.join(__dirname, 'ci-module-control.ps1'), '-Mode', mode])];
  return new Promise(resolve => {
    const child = spawnChild(shell, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false, oversized = false, bytes = 0, spawnFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, DEADLINE_MS);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { oversized = true; child.kill(); return; }
      if (!oversized) observed[stream](chunk);
    });
    child.stdin.on('error', () => {}); // Shell death may close stdin first.
    child.on('error', () => { spawnFailed = true; });
    child.on('close', exit => {
      clearTimeout(timer);
      const code = spawnFailed ? 'SPAWN_FAILED' : timedOut ? 'TIMEOUT' : oversized ? 'OUTPUT_LIMIT'
        : exit !== 0 ? 'EXIT_NONZERO' : !observed.complete() ? 'PROBE_PROTOCOL' : 'OK';
      write(diagnostic('probe-close', { code, exit, elapsedMs: elapsed(), timedOut, oversized, ...observed.state() }));
      resolve(code === 'OK');
    });
    child.stdin.end(mode === 'supervisor' ? 'CI_PROBE_INPUT\n' : '');
  });
}
async function runSamples(ps5, ps7, root, write, runSample = sample) {
  let ok = true;
  // Preserve the four original samples, then run exactly two PS5-only controls.
  // Shared scratch/cache does not imply cold-cache or native readiness evidence.
  for (const [shell, stage, mode] of [[ps5, 'probe-ps5-first', 'supervisor'], [ps5, 'probe-ps5-repeat', 'supervisor'],
    [ps7, 'probe-ps7-first', 'supervisor'], [ps7, 'probe-ps7-repeat', 'supervisor'],
    [ps5, 'control-ps5-json', 'json'], [ps5, 'control-ps5-import-json', 'import-json']]) {
    write(diagnostic(stage));
    try { if (!await runSample(shell, root, write, mode)) ok = false; }
    catch { ok = false; write(diagnostic('probe-close', { code: 'UNKNOWN' })); }
  }
  return ok;
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
    return await runSamples(ps5, args[1], root, write) ? 0 : 1;
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
module.exports = { main, observations, inspectSources, sample, runSamples };
