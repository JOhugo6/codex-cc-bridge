'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { privateModule, profile, capture } = require('./diagnostic-fixture');
const { synthetic, SENTINEL } = require('./native-runtime-fixture');
const { connect } = require('../doctor');
const entry = path.resolve(__dirname, '../doctor.js');
const api = privateModule('../doctor.js', 'module.exports.private = { verifyTools, parseArgs, nativeDiagnostic };');

function cli(args, env) {
  return spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 25000, windowsHide: true });
}
test('doctor import is inert and default CLI checks real public schemas without native login/executable', t => {
  const f = profile(t);
  const imported = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(entry)})`], { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout + imported.stderr, '');
  const result = cli([], { ...f.env, CLAUDE_BRIDGE_MODEL: 'invalid-but-lazy', CLAUDE_CONFIG_DIR: path.join(f.root, 'absent-parent') });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'mcp-handshake'); assert.equal(output.native_checked, false);
  assert.deepEqual(output.tools, ['claude_turn', 'claude_status']);
  assert.equal(output.task_submitted, false); assert.equal(output.model_entitlement_verified, false);
  assert.equal(fs.existsSync(f.env.CLAUDE_BRIDGE_STATE_DIR), false);
  assert.equal(fs.existsSync(path.join(f.root, '.claude')), false);
});
test('doctor CLI help, unknown/duplicate/missing options and private overrides reject safely', t => {
  const f = profile(t);
  for (const flag of ['--help', '-h']) {
    const r = cli([flag], f.env); assert.equal(r.status, 0); assert.match(r.stdout, /ancillary services/);
  }
  for (const args of [['--unknown'], ['--native', '--native'], ['--cwd'], ['--native', '--cwd', 'relative'],
    ['--model', 'opus'], ['--native', '--model'], ['--help', '--native'], ['--endpoint', SENTINEL],
    ['server.js'], ['--native', '--message', SENTINEL], ['--native', '--cwd', '--help'], ['--help', '--help']]) {
    const r = cli(args, f.env); assert.equal(r.status, 1, String(args));
    assert.equal(JSON.parse(r.stderr).code, 'DOCTOR_ARGUMENTS'); assert.ok(!r.stderr.includes(SENTINEL));
  }
  const model = cli(['--native', '--model', 'unsupported-' + SENTINEL], f.env);
  assert.equal(model.status, 1); assert.equal(JSON.parse(model.stderr).code, 'NATIVE_MODEL');
  assert.ok(!model.stderr.includes(SENTINEL));
  const missing = cli(['--native'], f.env);
  assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stderr).code, 'NATIVE_ROOT');
});
test('doctor detects schema drift, not just public tool names', async t => {
  const f = profile(t);
  // Exact sterile environment for real default MCP server; no calls to claude_turn.
  const result = spawnSync(process.execPath, [entry], { env: f.env, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const client = await connect(undefined, { ...f.env });
  t.after(() => client.close());
  const { tools } = await client.listTools();
  api.private.verifyTools(tools);
  for (const mutate of [
    xs => xs.pop(), xs => xs.push(xs[0]), xs => { xs[1] = xs[0]; },
    xs => { xs[0].inputSchema.additionalProperties = true; },
    xs => { xs[0].inputSchema.required = ['conversation_id']; },
    xs => { xs[0].inputSchema.properties.message.maxLength = 200000; },
    xs => { xs[0].inputSchema.properties.provider = { type: 'string' }; },
    xs => { xs[1].inputSchema.properties.conversation_id.pattern = '.*'; },
  ]) {
    const changed = structuredClone(tools); mutate(changed);
    assert.throws(() => api.private.verifyTools(changed), e => e.code === 'MCP_SCHEMA');
  }
});
test('doctor preflight mirrors exact child-root semantics, sanitizes identity, never launches', async t => {
  for (const defaultRoot of [true, false]) {
    const f = await synthetic({ defaultRoot }); t.after(() => f.close());
    assert.equal(f.root, fs.realpathSync.native(f.root));
    assert.equal(f.config, path.join(f.root, defaultRoot ? '.claude' : 'config'));
    assert.equal(f.config, fs.realpathSync.native(f.config));
    let seen;
    const native = { ...f.api, createNativeRuntime(options) { seen = options; return f.api.private.createRuntime(options, f.deps); } };
    const doctor = privateModule('../doctor.js', '', { './lib/native-runtime': native });
    const env = { ...f.parentEnv, CLAUDE_CONFIG_DIR: path.join(f.root, 'parent-only'), CLAUDE_BRIDGE_COMMAND: f.executable,
      ...(defaultRoot ? {} : { CLAUDE_BRIDGE_CONFIG_DIR: f.config }) };
    const before = { ...env };
    const r = await capture(() => doctor.main(['--native', '--cwd', f.project, '--model', 'opus'], env));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.model, 'claude-opus-5[1m]'); assert.equal(out.version, '2.1.264');
    assert.equal(out.profile_mode, defaultRoot ? 'default' : 'explicit');
    assert.equal(out.task_submitted, false); assert.equal(out.live_credentials_verified, false);
    assert.equal(Object.hasOwn(seen.parentEnv, 'CLAUDE_CONFIG_DIR'), false);
    assert.equal(seen.configRoot, defaultRoot ? undefined : f.config);
    assert.deepEqual(env, before);
    assert.equal(f.calls.length, 5); // version, help, auth, doctor, stable auth; no launch recheck.
    assert.ok(!r.stdout.includes(f.root) && !r.stdout.includes(SENTINEL));
    assert.equal(fs.existsSync(path.join(f.root, '.codex')), false);
  }
});
test('doctor errors emit bounded known codes, never native stderr/messages/stacks or arbitrary codes', async t => {
  const f = await synthetic(); t.after(() => f.close());
  for (const code of ['NATIVE_AUTH', 'NATIVE_COMPATIBILITY', 'NATIVE_DRIFT', SENTINEL]) {
    const doctor = privateModule('../doctor.js', '', { './lib/native-runtime': { ...f.api,
      createNativeRuntime() { throw Object.assign(new Error(SENTINEL.repeat(10000)), { code }); } } });
    const r = await capture(() => doctor.main(['--native'], { ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable }));
    assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.ok(r.stderr.length < 1000);
    assert.ok(!r.stderr.includes(SENTINEL)); assert.equal(JSON.parse(r.stderr).code, code === SENTINEL ? 'DOCTOR_FAILED' : code);
  }
});
test('MCP connection errors are redacted and hung initialization is bounded with child cleanup', { timeout: 20000 }, async t => {
  const f = profile(t);
  await assert.rejects(connect(path.join(__dirname, 'diagnostic-fixture.js'), f.env), e => e.code === 'MCP_HANDSHAKE' && !e.message.includes('SYNTHETIC_DIAGNOSTIC_SECRET'));
  const hang = path.join(f.root, 'hang.cjs'), pidFile = path.join(f.root, 'pid');
  fs.writeFileSync(hang, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const started = Date.now();
  await assert.rejects(connect(hang, f.env), e => e.code === 'MCP_HANDSHAKE');
  assert.ok(Date.now() - started < 15000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
});
