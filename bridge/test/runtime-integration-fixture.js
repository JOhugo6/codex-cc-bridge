'use strict';
// Private test executable, never imported by production. The only transport seam
// is attached here to the frozen adapter, under a disposable synthetic profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { internals, emptyRegistry } = require('./native-runtime-fixture');

async function connectNative(f, overrides = {}) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const descriptor = path.join(f.root, 'integration-descriptor.json');
  await fs.writeFile(descriptor, JSON.stringify({ root: f.root, executable: f.executable, endpoint: f.base.base }));
  const env = { ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable,
    CLAUDE_BRIDGE_STATE_DIR: path.join(f.root, 'bridge-state'), CLAUDE_BRIDGE_TIMEOUT_MS: '30000',
    ...(f.globalFile === path.join(f.root, '.claude.json') ? {} : { CLAUDE_BRIDGE_CONFIG_DIR: f.config }),
    ...overrides,
  };
  // The MCP host is not itself the model child. Native preparation reinstates the guard.
  delete env.CLAUDE_BRIDGE_CHILD;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [__filename, descriptor], env, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', b => { diagnostics = (diagnostics + b).slice(-16000); });
  const client = new Client({ name: 'synthetic-native-integration', version: '1.0.0' });
  try { await client.connect(transport); }
  catch { await transport.close(); throw new Error('Synthetic integration MCP startup failed.'); }
  return { client, diagnostics: () => diagnostics, close: () => client.close() };
}

async function serve(descriptorFile) {
  const spec = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  const root = await fs.realpath(spec.root);
  assert.ok(/^native-contract-a1-/.test(path.basename(root)));
  assert.equal(path.dirname(descriptorFile), root);
  assert.match(spec.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  const api = internals();
  const allowed = p => {
    p = path.resolve(p);
    assert.ok(p === path.resolve(spec.executable) || p === root || p.startsWith(root + path.sep), 'non-synthetic filesystem access');
    return p;
  };
  const checkedFs = {
    stat: p => fs.stat(allowed(p)), lstat: p => fs.lstat(allowed(p)),
    realpath: p => fs.realpath(allowed(p)), readdir: p => fs.readdir(allowed(p)),
    readFile(p, encoding) {
      allowed(p);
      assert.ok(!/\.credentials\.json$|\.claude\.json$|[\\/]Anthropic[\\/]/i.test(p), 'credential-content read');
      return fs.readFile(p, encoding);
    },
  };
  const checkedSyncFs = {
    lstatSync(p) {
      p = path.resolve(p);
      if (![root, path.resolve(spec.executable)].some(child => child.startsWith(p.endsWith(path.sep) ? p : p + path.sep))) allowed(p);
      return syncFs.lstatSync(p);
    },
    readdirSync: p => syncFs.readdirSync(allowed(p)),
    readFileSync() { assert.fail('ledger must not read file contents'); },
  };
  const deps = { ...api.private.production, fs: checkedFs, syncFs: checkedSyncFs, platform: 'win32',
    homedir: () => root, ancestorBoundary: root, descriptorRoot: path.join(root, 'descriptor-fallback'),
    systemRoots: () => [path.join(root, 'Program Files', 'ClaudeCode')],
    registry: async () => emptyRegistry(), endpoint: spec.endpoint,
    transportEnv: { HTTP_PROXY: spec.endpoint, HTTPS_PROXY: spec.endpoint, ALL_PROXY: spec.endpoint, NO_PROXY: '127.0.0.1,localhost' },
  };
  const { main } = require('../index');
  // Real config -> bridge -> frozen native preflight/launch -> real ClaudeBackend
  // -> Windows Job supervisor -> actual native CLI. No backend or result mock.
  await main(undefined, options => api.private.createRuntime(options, deps));
}

// Capture the *actual backend spawn call* without an OS process. No production
// injection flag or alternate spawn implementation is added for this probe.
function backendProbe(onSpawn) {
  const filename = path.resolve(__dirname, '../lib/claude-backend.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:child_process' ? { spawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    onSpawn({ command, args, options, child });
    return child;
  } } : original(name);
  loaded._compile(syncFs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports.ClaudeBackend;
}

if (require.main === module) serve(process.argv[2]).catch(() => {
  process.stderr.write('Synthetic native integration server failed.\n'); process.exitCode = 1;
});
module.exports = { connectNative, backendProbe };
