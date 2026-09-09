'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { synthetic, SENTINEL } = require('./native-runtime-fixture');
const { privateModule, capture } = require('./diagnostic-fixture');

test('explicit doctor uses actual pinned native metadata only in synthetic loopback/deny profiles', { timeout: 180000 }, async t => {
  for (const defaultRoot of [false, true]) {
    const f = await synthetic({ native: true, defaultRoot }); t.after(() => f.close());
    const doctor = privateModule('../doctor.js', '', { './lib/native-runtime': { ...f.api,
      createNativeRuntime(options) { return f.api.private.createRuntime(options, f.deps); } } });
    const env = { ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable,
      ...(defaultRoot ? {} : { CLAUDE_BRIDGE_CONFIG_DIR: f.config }) };
    const before = { ...env };
    const r = await capture(() => doctor.main(['--native', '--cwd', f.project], env));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, '2.1.263'); assert.equal(out.model, 'claude-opus-5[1m]');
    assert.equal(out.profile_mode, defaultRoot ? 'default' : 'explicit');
    assert.equal(out.task_submitted, false); assert.equal(out.live_credentials_verified, false);
    assert.equal(out.model_entitlement_verified, false);
    assert.ok(!r.stdout.includes(SENTINEL) && !r.stdout.includes(f.root));
    assert.equal(f.calls.length, 5);
    assert.equal(f.base.requests.length, 0, 'No loopback inference or task request permitted');
    assert.deepEqual(env, before);
  }
});
