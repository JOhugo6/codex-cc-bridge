'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../lib/config');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-bridge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = path.join(dir, 'Project s mezerou ž');
  await fs.mkdir(cwd);
  return { dir, cwd, settings: { ...config({}), stateDir: path.join(dir, 'state') } };
}
// Private offline fixtures: no env or MCP input can enable these in production.
const { ClaudeBridge } = require('../lib/bridge');
const { ClaudeBackend } = require('../lib/claude-backend');
const { resolveModel, RUNTIME_CONTRACT } = require('../lib/native-runtime');
function sterileEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(k)));
  return { ...env, HOME: root, USERPROFILE: root, CLAUDE_BRIDGE_CHILD: '1' };
}
function fakeLaunch(cwd, model = 'claude-opus-5[1m]', mode = 'normal') {
  return Object.freeze({ command: process.execPath, cwd, shell: false, windowsHide: true,
    args: Object.freeze([path.join(__dirname, 'fake-claude.js'), '--stub-mode', mode,
      '--model', model, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}']),
    env: Object.freeze(sterileEnv(path.dirname(cwd))),
  });
}
function fakeRuntime(options) {
  return { async preflight({ cwd, model, expectedIdentity }) {
    const identity = Object.freeze({ contract: RUNTIME_CONTRACT, version: '2.1.264', executable: process.execPath,
      model: resolveModel(model), cwd, home: path.dirname(cwd), configRoot: options.configRoot || path.dirname(cwd),
      configRootMode: options.configRoot === undefined ? 'default' : 'explicit', nativeConfigRoot: options.configRoot ?? null,
      accountFingerprint: 'a'.repeat(64), executableFingerprint: 'b'.repeat(64) });
    if (expectedIdentity && JSON.stringify(expectedIdentity) !== JSON.stringify(identity)) throw Object.assign(new Error('fixture drift'), { code: 'NATIVE_DRIFT' });
    return Object.freeze({ identity, launch: submit => submit(fakeLaunch(cwd, identity.model)) });
  } };
}
class TestBridge extends ClaudeBridge {
  constructor(backend, settings, runtime = fakeRuntime) { super(backend, settings, runtime); }
}
class TestBackend extends ClaudeBackend {
  constructor(settings, mode = 'normal') { super(settings); this.mode = mode; }
  run(input) { return super.run({ ...input, launch: fakeLaunch(input.cwd, input.model, this.mode) }); }
}
module.exports = { fixture, sterileEnv, fakeLaunch, fakeRuntime, TestBridge, TestBackend };
