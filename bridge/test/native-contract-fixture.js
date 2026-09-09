'use strict';

// Private, offline native-CLI experiment. NOT a runtime or public bridge option.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const MODEL = 'claude-opus-5';
const SUPPORTED_VERSION = '2.1.263';
const REQUIRED_FLAGS = Object.freeze(['--print', '--model', '--settings', '--setting-sources', '--strict-mcp-config', '--mcp-config', '--fallback-model', '--input-format', '--output-format', '--verbose']);
const SYNTHETIC_KEY = 'sk-ant-api03-native-contract-not-a-real-key';
const SYNTHETIC_OAUTH = 'sk-ant-oat01-native-contract-not-a-real-token';
const EXE = process.env.NATIVE_CONTRACT_CLAUDE_EXE || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');

// This is only executable/flag compatibility, NOT the blocked routing contract.
// Always run before the task-bearing process; never rely on a separate test's
// selection, order or exit code. The unchecked launcher stays private to fixture.
async function checkCompatibility(launch, options, supportedVersion, requiredFlags) {
  const probeOptions = { ...options, input: '' };
  const failure = stage => Object.assign(new Error(`Native CLI compatibility prerequisite failed (${stage}); no task launched.`), { code: 'NATIVE_CONTRACT_INCOMPATIBLE' });
  const version = await launch(['--version'], probeOptions);
  if (version.code !== 0 || version.timedOut || version.oversized || version.stdout.trim() !== `${supportedVersion} (Claude Code)`) throw failure('version');
  const help = await launch(['--help'], probeOptions);
  const flags = new Set(help.stdout.split(/\s+/));
  if (help.code !== 0 || help.timedOut || help.oversized || !requiredFlags.every(flag => flags.has(flag))) throw failure('flags');
  return { version: supportedVersion, flags: [...requiredFlags] };
}

async function fixture({ supportedVersion = SUPPORTED_VERSION, requiredFlags = REQUIRED_FLAGS } = {}) {
  const expectedFlags = [...requiredFlags];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-contract-a1-'));
  const config = path.join(root, 'config');
  const project = path.join(root, 'project');
  await Promise.all([config, project, path.join(root, 'appdata'), path.join(root, 'localappdata')].map(p => fs.mkdir(p, { recursive: true })));
  const requests = [];
  const blocked = [];
  let responder;
  const server = http.createServer(async (req, res) => {
    // Also serves as a deny-only forward proxy: never forward any request.
    if (!req.url.startsWith('/')) {
      blocked.push('http-proxy');
      res.writeHead(502).end();
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(chunk);
      }
    } catch { res.destroy(); return; } // Aborted native requests are expected during cleanup.
    let body;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
    catch { res.writeHead(400).end(); return; }
    const record = {
      url: req.url,
      body,
      // Never retain raw authorization headers, even in the synthetic fixture.
      syntheticKey: req.headers['x-api-key'] === SYNTHETIC_KEY,
      syntheticOAuth: req.headers.authorization === `Bearer ${SYNTHETIC_OAUTH}`,
    };
    if (requests.length >= 32) { res.writeHead(429).end(); return; }
    requests.push(record);
    if (responder && await responder(record, res)) return;
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }));
    } else if (req.url.startsWith('/v1/messages')) {
      reply(res, body.model);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Offline fixture: endpoint not implemented' } }));
    }
  });
  server.on('connect', (req, socket) => {
    blocked.push('https-proxy');
    socket.on('error', () => {}); // The native client may reset a denied CONNECT.
    socket.end('HTTP/1.1 502 Offline-only fixture\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Sterile outer sandbox. No real auth/provider variables or user home enter it.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(k)) env[k] = v;
  }
  Object.assign(env, {
    HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost',
    ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: SYNTHETIC_KEY,
    CLAUDE_BRIDGE_CHILD: '1',
  });
  const children = new Set();
  function launchNative(args, options) {
    return new Promise((resolve, reject) => {
      let command = EXE;
      let commandArgs = args;
      if (process.platform === 'win32') {
        // Reuse the existing kill-on-owner-exit Job object; no shell interpolation.
        const launch = Buffer.from(JSON.stringify({ command, args, cwd: project, parentPid: process.pid })).toString('base64');
        command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        commandArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../lib/windows-job-runner.ps1'), '-LaunchBase64', launch];
      }
      // options.env is already a snapshot. Never merge deleted keys back in.
      const child = spawn(command, commandArgs, { cwd: project, env: { ...options.env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const kill = () => { try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
      children.add(kill);
      let stdout = '', stderr = '', timedOut = false, oversized = false;
      const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs || 25000);
      child.stdout.on('data', b => {
        if (oversized) return;
        stdout += b;
        if (stdout.length > 2 * 1024 * 1024) { oversized = true; stdout = ''; kill(); }
      });
      child.stderr.on('data', b => { stderr = (stderr + b).slice(-32000); });
      child.stdin.on('error', e => { if (e.code !== 'EPIPE') kill(); });
      child.on('error', e => { clearTimeout(timer); children.delete(kill); reject(new Error(`Native executable unavailable (${e.code}); set NATIVE_CONTRACT_CLAUDE_EXE to an actual native executable.`)); });
      child.on('close', code => { clearTimeout(timer); children.delete(kill); resolve({ code, stdout, stderr, timedOut, oversized }); });
      child.stdin.end(options.input);
    });
  }
  return {
    root, config, project, env, base, requests, blocked,
    setResponder(fn) { responder = fn; },
    async json(relative, data) {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(data));
    },
    async text(relative, data) {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    },
    verifyCompatibility() {
      return checkCompatibility(launchNative, { env: { ...env } }, supportedVersion, expectedFlags);
    },
    async run(args, options = {}) {
      // Snapshot at entry, before awaiting the prerequisite. Supplying env means
      // exact replacement, while omission means a copy of the fixture default.
      const launchOptions = { ...options, env: { ...(options.env === undefined ? env : options.env) } };
      const launchArgs = [...args];
      await checkCompatibility(launchNative, launchOptions, supportedVersion, expectedFlags);
      return launchNative(launchArgs, { ...launchOptions, input: launchOptions.input ?? 'NATIVE_CONTRACT_SYNTHETIC_TASK' });
    },
    async close() {
      for (const kill of children) kill();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function reply(res, model, content = [{ type: 'text', text: 'NATIVE_CONTRACT_OK' }]) {
  const message = { id: 'msg_native_contract', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      event('content_block_start', { index, content_block: { ...block, input: {} } });
      event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {});
  res.end();
}

function printArgs(extra = []) {
  return ['--print', '--output-format', 'json', '--model', MODEL,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{"disableAllHooks":true}', ...extra];
}

module.exports = { SUPPORTED_VERSION, REQUIRED_FLAGS, fixture, printArgs, reply, MODEL, EXE, SYNTHETIC_KEY, SYNTHETIC_OAUTH };
