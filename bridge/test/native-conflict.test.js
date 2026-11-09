'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { config, safeError } = require('../lib/config');
const { ClaudeBridge } = require('../lib/bridge');
const { hash } = require('../lib/store');
const { validateSettings } = require('../lib/native-runtime');
const { synthetic, internals, SENTINEL } = require('./native-runtime-fixture');
const { privateModule, capture } = require('./diagnostic-fixture');

const SKIP_PERMISSIONS = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const COBALT = 'allow_cobalt_plinth_alkanet';
const baseline = (restrictions = {}) => ({ restrictions, compliance_taints: [], monitoring_notice: null,
  defaults: { remote_control_at_startup: false } });
const diagnostic = err => ({ code: err.code, message: err.message,
  ...(err.reason ? { reason: err.reason } : {}), ...(err.source ? { source: err.source } : {}) });
function conflict(reason, source, forbidden = []) {
  return err => {
    assert.equal(err.code, 'NATIVE_CONFLICT'); assert.equal(err.reason, reason); assert.equal(err.source, source);
    const encoded = JSON.stringify(diagnostic(err));
    for (const secret of [SENTINEL, COBALT, SKIP_PERMISSIONS, ...forbidden]) assert.ok(!encoded.includes(secret));
    assert.deepEqual(diagnostic(safeError(safeError(err))), diagnostic(err));
    return true;
  };
}
async function withFixture(action) {
  const f = await synthetic();
  try { await action(f); } finally { await f.close(); }
}
const settings = f => config({ ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable,
  CLAUDE_BRIDGE_CONFIG_DIR: f.config, CLAUDE_BRIDGE_STATE_DIR: path.join(f.root, 'bridge-state') });
const createRuntime = f => options => f.api.private.createRuntime(options, f.deps);
const noBackend = { run() { assert.fail('conflict must prevent task submission'); }, close() {} };

// Seed real validated state without a task or launch. Include completed-request
// history to prove that only last_error changes when continuation preflight fails.
async function seedReady(f, id = 'existing') {
  const bridge = new ClaudeBridge(noBackend, settings(f), createRuntime(f));
  const { identity } = await f.runtime().preflight({ cwd: f.project });
  const session_id = randomUUID();
  const output = { reply: 'synthetic historical result', session_id, turn: 1,
    working_dir: f.project, model: identity.model, runtime: identity, replayed: false };
  const state = { version: 2, conversation_id: id, session_id, working_dir: f.project,
    model: identity.model, runtime: identity, turn: 1, status: 'ready',
    policy: { permissionMode: 'bypassPermissions', allowedTools: [], disableTools: false },
    requests: [{ id: 'completed', hash: hash('historical message'), output }], last_result: output,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await fs.mkdir(bridge.store.root, { recursive: true });
  await bridge.store.save(id, state);
  return { bridge, state };
}

// Real public MCP registration, schema validation, client and JSON serialization;
// only transport/config/runtime dependencies use private, synthetic-only seams.
async function connectMcp(f, runtime = createRuntime(f)) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const entry = privateModule('../index.js', '', {
    './lib/config': { config: () => settings(f), safeError },
    '@modelcontextprotocol/sdk/server/stdio.js': { StdioServerTransport: class { constructor() { return serverTransport; } } },
  });
  const emitters = [process, process.stdin];
  const events = ['SIGINT', 'SIGTERM', 'end'];
  const listeners = emitters.map(emitter => new Map(events.map(event => [event, emitter.listeners(event)])));
  try { await entry.main(() => noBackend, runtime); }
  finally {
    emitters.forEach((emitter, i) => events.forEach(event => {
      for (const listener of emitter.listeners(event)) if (!listeners[i].get(event).includes(listener)) emitter.removeListener(event, listener);
    }));
  }
  const client = new Client({ name: 'synthetic-conflict-regression', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

test('reported settings and unknown personal restriction have distinct private-safe diagnostics', () => {
  const api = internals();
  for (const value of ['', '0', '1', SENTINEL]) {
    assert.throws(() => validateSettings({ env: { [SKIP_PERMISSIONS.toLowerCase()]: value } }),
      conflict('SETTINGS_PROHIBITED_ENV', 'SETTINGS'));
  }
  for (const allowed of [false, true]) {
    assert.throws(() => api.private.validatePersonalCache(baseline({ [COBALT]: { allowed } }), 'policy-limits.json'),
      conflict('POLICY_CACHE_RESTRICTION', 'POLICY_CACHE'));
  }
  const cases = [
    [{ [SENTINEL]: SENTINEL }, 'SETTINGS_UNSUPPORTED_FIELD'],
    [{ apiKeyHelper: SENTINEL }, 'SETTINGS_AUTH_HELPER'],
    [{ fallbackModel: [SENTINEL] }, 'SETTINGS_MODEL_ROUTING'],
    [{ switchModelsOnFlag: true }, 'SETTINGS_MODEL_ROUTING'],
    [{ modelOverrides: { [SENTINEL]: SENTINEL } }, 'SETTINGS_MODEL_ROUTING'],
    [{ modelSettings: { [SENTINEL]: { [SENTINEL]: SENTINEL } } }, 'SETTINGS_MODEL_ROUTING'],
    [{ disableAllHooks: SENTINEL }, 'SETTINGS_HOOK_POLICY'],
  ];
  for (const [value, reason] of cases) assert.throws(() => validateSettings(value), conflict(reason, 'SETTINGS'));
});

test('connector restriction accepts and preserves only the established boolean shape', async () => {
  for (const allowed of [false, true]) await withFixture(async f => {
    const cache = baseline({ allow_connector_file_downloads: { allowed } });
    const before = structuredClone(cache);
    assert.equal(f.api.private.validatePersonalCache(cache, 'policy-limits.json'), undefined);
    assert.deepEqual(cache, before);
    await f.json('config/policy-limits.json', cache);
    const file = path.join(f.config, 'policy-limits.json');
    const bytes = await fs.readFile(file, 'utf8');
    const prepared = await f.runtime().preflight({ cwd: f.project });
    assert.equal(prepared.identity.model, 'claude-opus-5[1m]');
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    // Independent prohibition remains even with a valid connector cache.
    for (const value of ['1', '0', '']) {
      await f.json('config/settings.json', { env: { [SKIP_PERMISSIONS]: value } });
      await assert.rejects(f.runtime().preflight({ cwd: f.project }),
        conflict('SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS', [f.root]));
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
    }
  });
  const api = internals();
  for (const restriction of [null, [], {}, { allowed: 'false' }, { allowed: 0 },
    { allowed: true, [SENTINEL]: SENTINEL }, { [SENTINEL]: false }]) {
    assert.throws(() => api.private.validatePersonalCache(baseline({ allow_connector_file_downloads: restriction }), 'policy-limits.json'),
      conflict('POLICY_CACHE_RESTRICTION', 'POLICY_CACHE'));
  }
});

test('policy and remote cache schema remain fail closed without leaking keys or values', () => {
  const api = internals();
  for (const cache of [{ ...baseline(), [SENTINEL]: SENTINEL }, { ...baseline(), restrictions: null },
    { ...baseline(), compliance_taints: [SENTINEL] }, { ...baseline(), monitoring_notice: SENTINEL },
    { ...baseline(), defaults: { remote_control_at_startup: true } }, { ...baseline(), defaults: { [SENTINEL]: SENTINEL } }]) {
    assert.throws(() => api.private.validatePersonalCache(cache, 'policy-limits.json'), conflict('POLICY_CACHE_SCHEMA', 'POLICY_CACHE'));
  }
  for (const cache of [{}, { channelsEnabled: SENTINEL }]) {
    assert.throws(() => api.private.validatePersonalCache(cache, 'remote-settings.json'),
      conflict('REMOTE_SETTINGS_CACHE_SCHEMA', 'REMOTE_SETTINGS_CACHE'));
  }
  assert.throws(() => api.private.validatePersonalCache({ [SENTINEL]: SENTINEL }, 'remote-settings.json'),
    conflict('SETTINGS_UNSUPPORTED_FIELD', 'REMOTE_SETTINGS_CACHE'));
  for (const cache of [null, []]) assert.throws(() => api.private.validatePersonalCache(cache, 'policy-limits.json'), { code: 'NATIVE_SOURCE' });
  for (const text of ['{"' + SENTINEL, JSON.stringify(null)]) {
    assert.throws(() => api.private.parseSettings(text, false, false, 'policy-limits.json'), err => {
      assert.equal(err.code, 'NATIVE_SOURCE'); assert.equal(err.reason, undefined); assert.equal(err.source, undefined);
      assert.ok(!err.message.includes(SENTINEL)); return true;
    });
  }
});

test('file and registry settings parsing preserves static source categories', async () => {
  const cases = [
    ['config/settings.json', { env: { [SKIP_PERMISSIONS]: SENTINEL } }, 'SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS'],
    ['project/.claude/settings.local.json', { env: { [SKIP_PERMISSIONS]: SENTINEL } }, 'SETTINGS_PROHIBITED_ENV', 'PROJECT_SETTINGS'],
    ['Program Files/ClaudeCode/managed-settings.json', { [SENTINEL]: SENTINEL }, 'SETTINGS_UNSUPPORTED_FIELD', 'MANAGED_SETTINGS'],
    ['Program Files/ClaudeCode/managed-settings.d/test.json', { [SENTINEL]: SENTINEL }, 'SETTINGS_UNSUPPORTED_FIELD', 'MANAGED_SETTINGS'],
    ['config/remote-settings.json', { [SENTINEL]: SENTINEL }, 'SETTINGS_UNSUPPORTED_FIELD', 'REMOTE_SETTINGS_CACHE'],
  ];
  for (const [relative, value, reason, source] of cases) await withFixture(async f => {
    await f.json(relative, value);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict(reason, source, [f.root]));
    assert.equal(f.calls.length, 0, 'invalid sources prevent every native metadata command');
  });
  await withFixture(async f => {
    Object.assign(f.registered[0], { present: true, kind: 'String',
      raw: JSON.stringify({ [SENTINEL]: SENTINEL }), value: JSON.stringify({}) });
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('SETTINGS_UNSUPPORTED_FIELD', 'MANAGED_REGISTRY', [f.root]));
    assert.equal(f.calls.length, 0);
  });
});

test('other unsupported native control and authentication sources have static conflict reasons', async () => {
  for (const [name, reason] of [['CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'PARENT_ENV_CONFLICT'],
    [SKIP_PERMISSIONS, 'PARENT_ENV_CONFLICT'], ['ANTHROPIC_PROFILE', 'AUTH_PROFILE_CONFLICT']]) await withFixture(async f => {
    await assert.rejects(async () => f.runtime({ parentEnv: { ...f.parentEnv, [name]: SENTINEL } }).preflight({ cwd: f.project }),
      conflict(reason, 'PARENT_ENV', [f.root]));
    assert.equal(f.calls.length, 0);
  });
  for (const [relative, reason, source, directory] of [
    ['appdata/Anthropic', 'UNSUPPORTED_AUTH_STORE', 'AUTH_STORE', true],
    ['config/.config.json', 'LEGACY_CONFIG_PRESENT', 'LEGACY_CONFIG'],
    ['descriptor-fallback/.oauth_token', 'DESCRIPTOR_AUTH_PRESENT', 'DESCRIPTOR_AUTH'],
  ]) await withFixture(async f => {
    if (directory) await fs.mkdir(path.join(f.root, relative), { recursive: true }); else await f.text(relative, SENTINEL);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict(reason, source, [f.root]));
    assert.equal(f.calls.length, 0);
    assert.ok(!f.reads.includes(path.join(f.root, relative)), 'presence-only auth conflict must not read contents');
  });
});

test('MCP independently reports both failures and leaves failed first preflight without state', async () => withFixture(async f => {
  const client = await connectMcp(f);
  try {
    const call = () => client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'new-conflict',
      request_id: 'new-request', message: 'synthetic preflight only', working_dir: f.project } });
    await f.json('config/policy-limits.json', baseline({ [COBALT]: { allowed: false } }));
    let response = await call(); assert.equal(response.isError, true);
    conflict('POLICY_CACHE_RESTRICTION', 'POLICY_CACHE', [f.root])(JSON.parse(response.content[0].text));
    await f.json('config/settings.json', { env: { [SKIP_PERMISSIONS]: SENTINEL } });
    response = await call(); assert.equal(response.isError, true);
    conflict('POLICY_CACHE_RESTRICTION', 'POLICY_CACHE', [f.root])(JSON.parse(response.content[0].text));
    // Repair only the synthetic cache. The independent settings failure remains.
    await f.json('config/policy-limits.json', baseline({ allow_connector_file_downloads: { allowed: false } }));
    response = await call(); assert.equal(response.isError, true);
    conflict('SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS', [f.root])(JSON.parse(response.content[0].text));
    assert.deepEqual(Object.keys(JSON.parse(response.content[0].text)).sort(), ['code', 'message', 'reason', 'source']);
    const status = await client.callTool({ name: 'claude_status', arguments: { conversation_id: 'new-conflict' } });
    assert.deepEqual(status.structuredContent, { exists: false, conversation_id: 'new-conflict' });
    assert.deepEqual(await fs.readdir(settings(f).stateDir), []);
    assert.equal(f.calls.length, 0);
  } finally { await client.close(); }
}));

test('existing ready conversation persists only safe conflict diagnostics across MCP restart', async () => withFixture(async f => {
  const { bridge, state } = await seedReady(f);
  for (const [cache, userSettings, reason, source] of [
    [baseline({ [COBALT]: { allowed: false } }), {}, 'POLICY_CACHE_RESTRICTION', 'POLICY_CACHE'],
    [baseline({ allow_connector_file_downloads: { allowed: true } }), { env: { [SKIP_PERMISSIONS]: SENTINEL } }, 'SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS'],
  ]) {
    await f.json('config/policy-limits.json', cache); await f.json('config/settings.json', userSettings);
    let client = await connectMcp(f);
    try {
      const response = await client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'existing',
        request_id: 'failed-request', message: 'synthetic preflight only' } });
      assert.equal(response.isError, true);
      conflict(reason, source, [f.root])(JSON.parse(response.content[0].text));
    } finally { await client.close(); }
    const persisted = JSON.parse(await fs.readFile(bridge.store.file('existing'), 'utf8'));
    conflict(reason, source, [f.root])(persisted.last_error);
    const { last_error, ...unchanged } = persisted; assert.deepEqual(unchanged, state);
    client = await connectMcp(f, () => assert.fail('status and replay must not preflight'));
    try {
      const response = await client.callTool({ name: 'claude_status', arguments: { conversation_id: 'existing' } });
      conflict(reason, source, [f.root])(response.structuredContent.last_error);
      assert.equal(response.structuredContent.status, 'ready'); assert.equal(response.structuredContent.turn, 1);
      const replay = await client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'existing',
        request_id: 'completed', message: 'historical message' } });
      assert.equal(replay.structuredContent.replayed, true); assert.equal(replay.structuredContent.session_id, state.session_id);
    } finally { await client.close(); }
  }
  // Deliberately corrupt untrusted persisted diagnostic fields, not identity.
  const persisted = JSON.parse(await fs.readFile(bridge.store.file('existing'), 'utf8'));
  persisted.last_error = { code: 'NATIVE_CONFLICT', message: SENTINEL, reason: SENTINEL, source: f.root };
  await bridge.store.save('existing', persisted);
  const clean = (await new ClaudeBridge(noBackend, settings(f)).status('existing')).last_error;
  assert.deepEqual(Object.keys(clean).sort(), ['code', 'message']); assert.ok(!JSON.stringify(clean).includes(SENTINEL));
  await f.json('config/settings.json', {});
  const recovered = new ClaudeBridge({ run: async input => ({ reply: 'synthetic result', session_id: input.sessionId }) },
    settings(f), createRuntime(f));
  const output = await recovered.turn({ conversation_id: 'existing', message: 'synthetic backend only' });
  assert.equal(output.session_id, state.session_id); assert.equal(output.turn, 2);
  assert.equal((await recovered.status('existing')).last_error, null, 'successful continuation clears stale conflict diagnostics');
}));

test('doctor native preflight reports the same safe reason and source for real synthetic validators', async () => withFixture(async f => {
  const doctor = privateModule('../doctor.js', '', { './lib/native-runtime': { ...f.api, createNativeRuntime: createRuntime(f) } });
  for (const [cache, userSettings, reason, source] of [
    [baseline({ [COBALT]: { allowed: false } }), {}, 'POLICY_CACHE_RESTRICTION', 'POLICY_CACHE'],
    [baseline(), { env: { [SKIP_PERMISSIONS]: SENTINEL } }, 'SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS'],
  ]) {
    await f.json('config/policy-limits.json', cache); await f.json('config/settings.json', userSettings);
    const result = await capture(() => doctor.main(['--native', '--cwd', f.project], {
      ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable, CLAUDE_BRIDGE_CONFIG_DIR: f.config }));
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr); conflict(reason, source, [f.root])(error);
    assert.equal(error.task_submitted, false); assert.equal(error.live_credentials_verified, false);
    assert.equal(error.model_entitlement_verified, false); assert.equal(f.calls.length, 0);
  }
}));

test('central sanitizer rejects arbitrary and cross-code reason/source details on every pass', () => {
  const raw = { code: 'NATIVE_CONFLICT', reason: 'SETTINGS_PROHIBITED_ENV', source: 'USER_SETTINGS',
    message: SENTINEL, stack: SENTINEL, detail: SENTINEL, env: { [SENTINEL]: SENTINEL } };
  const clean = safeError(safeError(raw)); conflict(raw.reason, raw.source)(clean);
  assert.deepEqual(Object.keys(clean).sort(), ['code', 'reason', 'source']);
  for (const input of [
    { ...raw, reason: SENTINEL }, { ...raw, reason: '__proto__' }, { ...raw, reason: 'toString' },
    { ...raw, code: 'NATIVE_DRIFT' }, { ...raw, code: SENTINEL },
  ]) {
    const error = safeError(safeError(input)); assert.equal(error.reason, undefined); assert.equal(error.source, undefined);
    assert.ok(!JSON.stringify(diagnostic(error)).includes(SENTINEL));
  }
  for (const source of [SENTINEL, '__proto__', 'toString', {}, ['USER_SETTINGS'], null]) {
    const error = safeError(safeError({ ...raw, source }));
    assert.equal(error.reason, raw.reason); assert.equal(error.source, undefined);
    assert.ok(!JSON.stringify(diagnostic(error)).includes(SENTINEL));
  }
});

test('untrusted error reasons and sources are redacted in MCP, stored state, status and doctor', async () => withFixture(async f => {
  const { bridge } = await seedReady(f);
  for (const fields of [
    { reason: SENTINEL, source: 'USER_SETTINGS' },
    { reason: 'SETTINGS_PROHIBITED_ENV', source: f.root },
    { reason: 'SETTINGS_PROHIBITED_ENV', source: 'USER_SETTINGS' },
  ]) {
    const raw = Object.assign(new Error(SENTINEL), { code: 'NATIVE_CONFLICT', ...fields, detail: SENTINEL });
    const expected = diagnostic(safeError(raw));
    const runtime = () => ({ async preflight() { throw raw; } });
    const client = await connectMcp(f, runtime);
    try {
      const response = await client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'existing', message: 'synthetic preflight only' } });
      assert.equal(response.isError, true); assert.deepEqual(JSON.parse(response.content[0].text), expected);
      assert.ok(!JSON.stringify(response).includes(SENTINEL)); assert.ok(!JSON.stringify(response).includes(f.root));
      const status = await client.callTool({ name: 'claude_status', arguments: { conversation_id: 'existing' } });
      assert.deepEqual(status.structuredContent.last_error, expected);
    } finally { await client.close(); }
    const saved = JSON.parse(await fs.readFile(bridge.store.file('existing'), 'utf8'));
    assert.deepEqual(saved.last_error, expected); assert.ok(!JSON.stringify(saved.last_error).includes(f.root));
    const doctor = privateModule('../doctor.js', '', { './lib/native-runtime': { ...f.api, createNativeRuntime: runtime } });
    const result = await capture(() => doctor.main(['--native', '--cwd', f.project], {
      ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable, CLAUDE_BRIDGE_CONFIG_DIR: f.config }));
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, expected.code); assert.equal(error.reason, expected.reason); assert.equal(error.source, expected.source);
    assert.equal(error.message, expected.reason ? expected.message : undefined);
    assert.ok(!result.stderr.includes(SENTINEL)); assert.ok(!result.stderr.includes(f.root));
  }
}));
