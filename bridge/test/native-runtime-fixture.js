'use strict';

// Private synthetic-only adapter. No production export/env/MCP path can enable DI.
// Reuses the frozen HTTP fixture without changing its launch or characterization code.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { fixture, reply, SYNTHETIC_OAUTH } = require('./native-contract-fixture');
const SENTINEL = 'native-runtime-synthetic-secret-never-real';
const EMAIL = 'runtime-synthetic@example.invalid';

// Private test executable discovery only; never an option of the runtime API.
function nativeExecutable(env = process.env, { home = os.homedir(), platform = process.platform, exists = syncFs.existsSync } = {}) {
  if (env.NATIVE_CONTRACT_CLAUDE_EXE) return env.NATIVE_CONTRACT_CLAUDE_EXE;
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const local = path.join(home, '.local', 'bin', name);
  if (exists(local)) return local;
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const dir of search.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
    if (path.isAbsolute(candidate) && exists(candidate)) return candidate;
  }
  return local; // The normal preflight fails closed when no executable is present.
}

function internals() {
  const filename = path.resolve(__dirname, '../lib/native-runtime.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(syncFs.readFileSync(filename, 'utf8') + '\nmodule.exports.private = {createRuntime, production, inspectSources, preparedEnvironment, envEntries, accountFingerprint, FLAGS, EMPTY_PINS, FALSE_PINS, MODEL_PINS, PROVIDERS, registrySettings};', filename);
  return loaded.exports;
}
function emptyRegistry() {
  return ['LocalMachine', 'CurrentUser'].flatMap(hive => ['Registry64', 'Registry32'].map(view => ({ hive, view, present: false })));
}

async function synthetic({ native = false, defaultRoot = false, tier = 'max' } = {}) {
  const base = native ? await fixture() : null;
  // Canonicalize our new unit root before profile paths and containment checks.
  // The native fixture owns and canonicalizes its own base root.
  const root = base?.root || await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-runtime-unit-')));
  const config = path.join(root, defaultRoot ? '.claude' : 'config');
  const project = base?.project || path.join(root, 'project');
  const appdata = path.join(root, 'appdata');
  const managed = path.join(root, 'Program Files', 'ClaudeCode');
  for (const p of [config, project, appdata, path.join(root, 'localappdata')]) await fs.mkdir(p, { recursive: true });
  const executable = native ? nativeExecutable() : path.join(root, 'claude.exe');
  if (!native) await fs.writeFile(executable, 'synthetic-native-executable');
  const parentEnv = base ? { ...base.env } : {
    HOME: root, USERPROFILE: root, APPDATA: appdata, LOCALAPPDATA: path.join(root, 'localappdata'),
    SystemRoot: path.join(root, 'Windows'), Path: 'synthetic-unrelated-path',
  };
  delete parentEnv.CLAUDE_CONFIG_DIR;
  const api = internals();
  const reads = [], stats = [], calls = [];
  const registered = emptyRegistry();
  let account = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: tier, email: EMAIL, orgId: 'synthetic-org' };
  let beforeExecute;
  // Reject any accidental real config/credential read, including through a future adapter change.
  function allowed(file) {
    const p = path.resolve(file);
    assert.ok(p === path.resolve(executable) || p === root || p.startsWith(root + path.sep), 'fixture attempted non-synthetic filesystem access');
    return p;
  }
  const checkedFs = {
    async stat(p) { stats.push(allowed(p)); return fs.stat(p); },
    async lstat(p) { stats.push(allowed(p)); return fs.lstat(p); },
    async realpath(p) { allowed(p); return fs.realpath(p); },
    async readdir(p) { allowed(p); return fs.readdir(p); },
    async readFile(p, encoding) {
      allowed(p); assert.ok(!/\.credentials\.json$|\.claude\.json$|[\\/]Anthropic[\\/]/i.test(p), 'adapter must not read credential-bearing configuration');
      reads.push(path.resolve(p)); return fs.readFile(p, encoding);
    },
  };
  const checkedSyncFs = {
    lstatSync(file) {
      const p = path.resolve(file);
      // Ancestor identity checks are metadata-only, never real settings/credentials.
      const isAncestor = [root, path.resolve(executable)].some(child => child.startsWith(p.endsWith(path.sep) ? p : p + path.sep));
      if (!isAncestor) allowed(p);
      stats.push(p); return syncFs.lstatSync(p);
    },
    readdirSync(p) { allowed(p); return syncFs.readdirSync(p); },
    readFileSync() { assert.fail('synchronous validation must never read file contents'); },
  };
  const deps = { ...api.private.production, fs: checkedFs, syncFs: checkedSyncFs, platform: 'win32', homedir: () => root,
    ancestorBoundary: root, descriptorRoot: path.join(root, 'descriptor-fallback'), systemRoots: () => [managed],
    registry: async () => structuredClone(registered), endpoint: base?.base || 'https://api.anthropic.com',
    transportEnv: base ? { HTTP_PROXY: base.base, HTTPS_PROXY: base.base, ALL_PROXY: base.base, NO_PROXY: '127.0.0.1,localhost' } : undefined,
    execute: async (command, args, options) => {
      calls.push({ kind: args.at(-1) === '--version' ? 'version' : args.at(-1) === '--help' ? 'help' : args.includes('doctor') ? 'doctor' : 'auth' });
      if (beforeExecute) await beforeExecute(command, args, options);
      if (native) return api.private.production.execute(command, args, options);
      if (args.includes('--version')) return { stdout: '2.1.263 (Claude Code)\n', stderr: '' };
      if (args.includes('--help')) return { stdout: api.private.FLAGS.join(' '), stderr: '' };
      if (args.includes('doctor')) return { stdout: 'Managed settings (remote): not fetched — requires an Enterprise or Team subscription\nOrganization policy: not applicable to Pro and Max accounts\n', stderr: '' };
      return { stdout: JSON.stringify(account), stderr: '' };
    },
  };
  async function json(relative, data) {
    const file = path.resolve(root, relative); allowed(file);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data));
  }
  async function text(relative, data) {
    const file = path.resolve(root, relative); allowed(file);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
  }
  async function login(subscriptionType = tier, gateway = false, gatewayUrl = base?.base) {
    const credentials = { claudeAiOauth: { accessToken: SYNTHETIC_OAUTH, refreshToken: SENTINEL,
      expiresAt: Date.now() + 86400000, scopes: ['user:inference', 'user:profile'], subscriptionType,
      rateLimitTier: 'default_claude_max_5x' } };
    if (gateway) {
      credentials.enterpriseGateway = { url: gatewayUrl, jwt: SENTINEL, expiresAt: Date.now() + 86400000 };
      credentials.gatewayTrust = { '127.0.0.1': 'http-loopback' };
    }
    await json(path.relative(root, path.join(config, '.credentials.json')), credentials);
  }
  await login();
  const globalFile = path.join(defaultRoot ? root : config, '.claude.json');
  await json(path.relative(root, globalFile), { hasCompletedOnboarding: true,
    oauthAccount: { accountUuid: '11111111-1111-4111-8111-111111111111', emailAddress: EMAIL, organizationUuid: '22222222-2222-4222-8222-222222222222' },
    projects: { [project]: { hasTrustDialogAccepted: true }, [project.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } });
  const children = new Set();
  function runPrepared(launch, { extraArgs = [], input = 'NATIVE_RUNTIME_SYNTHETIC_TASK', timeoutMs = 30000 } = {}) {
    assert.equal(launch.shell, false);
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args, '--print', '--output-format', 'json', '--input-format', 'text', ...extraArgs],
        { cwd: launch.cwd, env: { ...launch.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let stdout = '', stderr = '', size = 0, bad = false;
      const timer = setTimeout(() => { bad = true; child.kill(); }, timeoutMs);
      const collect = (out, b) => {
        size += b.length;
        if (size > 2 * 1024 * 1024) { bad = true; child.kill(); return; }
        if (out) stdout += b; else stderr += b;
      };
      child.stdout.on('data', b => collect(true, b)); child.stderr.on('data', b => collect(false, b));
      child.on('error', () => { bad = true; }); child.stdin.on('error', e => { if (e.code !== 'EPIPE') { bad = true; child.kill(); } });
      child.on('close', code => {
        clearTimeout(timer); children.delete(child);
        // Never include raw native output in an error/report.
        if (bad || [SENTINEL, SYNTHETIC_OAUTH].some(s => (stdout + stderr).includes(s))) return reject(new Error('Synthetic native run failed bounds or redaction check'));
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  }
  return { root, config, project, appdata, managed, globalFile, executable, parentEnv, api, deps, reads, stats, calls, registered,
    json, text, login, base, runPrepared,
    get account() { return account; }, set account(value) { account = value; },
    set beforeExecute(value) { beforeExecute = value; },
    runtime(overrides = {}) {
      return api.private.createRuntime({ executable, parentEnv, ...(defaultRoot ? {} : { configRoot: config }), ...overrides }, deps);
    },
    async close() {
      for (const child of children) child.kill();
      if (base) await base.close(); else await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await assert.rejects(fs.stat(root), e => e.code === 'ENOENT');
    },
  };
}

const inference = f => f.base.requests.filter(r => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'));
function assertWire(f, count) {
  const requests = inference(f);
  assert.equal(requests.length, count, 'inference count must be nonvacuous');
  for (const r of requests) {
    assert.equal(r.url, '/v1/messages?beta=true'); assert.equal(r.body.model, 'claude-opus-5');
    assert.equal(r.syntheticOAuth, true); assert.equal(r.syntheticKey, false);
    assert.ok(r.body.fallbacks === undefined || Array.isArray(r.body.fallbacks) && r.body.fallbacks.length === 0);
  }
}
function refusal(res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
  emit('message_start', { message: { id: 'msg_runtime_refusal', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Synthetic transport refusal.' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber', explanation: 'Synthetic offline fixture; no unsafe task.' } }, usage: { output_tokens: 6 } });
  emit('message_stop', {}); res.end();
}
module.exports = { nativeExecutable, synthetic, internals, emptyRegistry, inference, assertWire, reply, refusal, SENTINEL, EMAIL };
