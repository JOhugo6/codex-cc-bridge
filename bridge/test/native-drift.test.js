'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { synthetic, SENTINEL } = require('./native-runtime-fixture');
const { safeError } = require('../lib/config');
const { fixture, TestBridge } = require('./helpers');

async function withFixture(fn) {
  const f = await synthetic();
  try { await fn(f); } finally { await f.close(); }
}
const rejects = reason => err => err.code === 'NATIVE_DRIFT' && err.reason === reason && !err.message.includes(SENTINEL);

test('saved account mismatch is actionable and legacy fingerprint remains strict', async () => withFixture(async f => {
  const first = await f.runtime().preflight({ cwd: f.project });
  for (const change of [{ email: SENTINEL }, { orgId: SENTINEL }, { accountUuid: SENTINEL }, { subscriptionType: 'pro' }]) {
    const saved = f.account;
    f.account = { ...saved, ...change };
    await assert.rejects(f.runtime().preflight({ cwd: f.project, expectedIdentity: first.identity }), rejects('SAVED_ACCOUNT_CHANGED'));
    f.account = saved;
  }
  await f.runtime().preflight({ cwd: f.project, expectedIdentity: first.identity });
  const modifiedRuntime = { ...first.identity, executableFingerprint: 'a'.repeat(64), accountFingerprint: 'b'.repeat(64) };
  await assert.rejects(f.runtime().preflight({ cwd: f.project, expectedIdentity: modifiedRuntime }), rejects('SAVED_RUNTIME_CHANGED'));
}));

test('account changes during validation refuse launch independently from saved mismatch', async () => withFixture(async f => {
  const prepared = await f.runtime().preflight({ cwd: f.project });
  f.account = { ...f.account, orgId: SENTINEL };
  let launched = false;
  await assert.rejects(prepared.launch(() => { launched = true; }), rejects('ACCOUNT_CHANGED'));
  assert.equal(launched, false);
}));

test('changed source categories expose no path, metadata or credentials and block launch', async () => {
  for (const [relative, reason] of [['.claude.json', 'GLOBAL_METADATA_CHANGED'], ['.credentials.json', 'CREDENTIAL_METADATA_CHANGED'], ['settings.json', 'SETTINGS_CHANGED'], ['executable', 'EXECUTABLE_CHANGED']]) {
    await withFixture(async f => {
      const prepared = await f.runtime().preflight({ cwd: f.project });
      const file = relative === 'executable' ? f.executable : path.join(f.config, relative);
      await fs.appendFile(file, SENTINEL);
      let launched = false;
      await assert.rejects(prepared.launch(() => { launched = true; }), err => {
        assert.ok(!JSON.stringify({ ...err, message: err.message }).includes(f.root));
        return rejects(reason)(err);
      });
      assert.equal(launched, false);
    });
  }
});

test('sanitization preserves only reason enums for matching codes across repeat calls', () => {
  const raw = { code: 'NATIVE_DRIFT', reason: 'SAVED_ACCOUNT_CHANGED', message: SENTINEL, account: SENTINEL };
  const clean = safeError(safeError(raw));
  assert.equal(clean.reason, raw.reason);
  assert.ok(!JSON.stringify(clean).includes(SENTINEL));
  for (const error of [{ code: 'NATIVE_DRIFT', reason: SENTINEL }, { code: 'NATIVE_AUTH', reason: raw.reason }, { code: 'NATIVE_DRIFT', reason: '__proto__' }]) {
    assert.equal(safeError(error).reason, undefined);
  }
});

test('sanitized reason survives persisted failed turn and bridge restart status', async t => {
  const { cwd, settings } = await fixture(t);
  const backend = { run: async () => { throw Object.assign(new Error(SENTINEL), { code: 'NATIVE_DRIFT', reason: 'GLOBAL_METADATA_CHANGED' }); } };
  const first = new TestBridge(backend, settings);
  await assert.rejects(first.turn({ conversation_id: 'drift-reason', message: 'test', working_dir: cwd }), rejects('GLOBAL_METADATA_CHANGED'));
  const status = await new TestBridge(backend, settings).status('drift-reason');
  assert.equal(status.last_error.reason, 'GLOBAL_METADATA_CHANGED');
  assert.ok(!JSON.stringify(status).includes(SENTINEL));
});

test('MCP error response preserves sanitized reason and drops unknown detail', async () => {
  const { privateModule } = require('./diagnostic-fixture');
  const handlers = {};
  class Server {
    constructor() { this.server = {}; }
    registerTool(name, schema, handler) { handlers[name] = handler; }
    async connect() {}
  }
  class Bridge {
    async turn() { throw Object.assign(new Error(SENTINEL), { code: 'NATIVE_DRIFT', reason: 'SAVED_ACCOUNT_CHANGED', detail: SENTINEL }); }
  }
  const entry = privateModule('../index.js', '', {
    '@modelcontextprotocol/sdk/server/mcp.js': { McpServer: Server },
    './lib/bridge': { ClaudeBridge: Bridge },
  });
  const listeners = [process, process.stdin].map(emitter => [emitter, new Map(['SIGINT', 'SIGTERM', 'end'].map(event => [event, emitter.listeners(event)]))]);
  await entry.main(() => ({ close() {} }));
  for (const [emitter, events] of listeners) for (const [event, before] of events) for (const listener of emitter.listeners(event)) if (!before.includes(listener)) emitter.removeListener(event, listener);
  const response = await handlers.claude_turn({}, {});
  assert.equal(response.isError, true);
  const error = JSON.parse(response.content[0].text);
  assert.equal(error.reason, 'SAVED_ACCOUNT_CHANGED');
  assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'reason']);
  assert.ok(!JSON.stringify(response).includes(SENTINEL));
});

test('doctor emits only allowlisted native reason and safe message', async () => {
  const { privateModule, capture } = require('./diagnostic-fixture');
  const doctor = privateModule('../doctor.js', '', {
    './lib/native-runtime': { ...require('../lib/native-runtime'), createNativeRuntime() { return { async preflight() {
      throw Object.assign(new Error(SENTINEL), { code: 'NATIVE_POLICY', reason: 'POLICY_UNATTESTED' });
    } }; } },
  });
  const result = await capture(() => doctor.main(['--native']));
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.reason, 'POLICY_UNATTESTED');
  assert.equal(error.task_submitted, false);
  assert.ok(!result.stderr.includes(SENTINEL));
});
