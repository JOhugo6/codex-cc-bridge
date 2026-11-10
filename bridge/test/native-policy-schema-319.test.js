'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { config } = require('../lib/config');
const { ClaudeBridge } = require('../lib/bridge');
const { validateSettings } = require('../lib/native-runtime');
const { synthetic, SENTINEL } = require('./native-runtime-fixture');
const { TEAM_DOCTOR, TEAM_DEBUG } = require('./team-fixture');

const KEY = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const REPORTED = 'allow_cobalt_plinth_alkanet';
const policy = restrictions => ({ restrictions, compliance_taints: [], monitoring_notice: null,
  defaults: { remote_control_at_startup: false } });
const conflict = reason => err => {
  assert.equal(err.code, 'NATIVE_CONFLICT'); assert.equal(err.reason, reason);
  for (const value of [KEY, REPORTED, SENTINEL]) assert.ok(!JSON.stringify(err).includes(value));
  return true;
};
// Keep every positive/negative case scoped to the two characterized builds.
for (const nativeVersion of ['2.1.319', '2.1.322']) {
const nativeTest = (name, ...args) => test(`${nativeVersion}: ${name}`, ...args);
async function fixture(t, version = nativeVersion, options) {
  const f = await synthetic(options); t.after(() => f.close());
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, launch) => {
    const result = await execute(command, args, launch);
    return args.includes('--version') ? { stdout: `${version} (Claude Code)\n`, stderr: '' } : result;
  };
  return f;
}

nativeTest('preserves generic restriction-map keys and both boolean values through preflight and launch', async t => {
  for (const allowed of [false, true]) {
    const f = await fixture(t);
    const restrictions = Object.fromEntries([REPORTED, 'allow_other_native_schema_key', 'enforce_other_native_schema_key',
      'require_other_native_schema_key', 'arbitrary key', '', 'žluťoučký', 'constructor', 'toString'].map(key => [key, { allowed }]));
    const bytes = Buffer.from('\uFEFF' + JSON.stringify(policy(restrictions), null, 2) + '\r\n');
    const file = path.join(f.config, 'policy-limits.json');
    await fs.writeFile(file, bytes);
    f.beforeExecute = (command, args, launch) => {
      assert.equal(Object.keys(launch.env).some(k => k.toUpperCase() === KEY), false);
      assert.ok(args.includes('--strict-mcp-config'));
      assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
      assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks, true);
      assert.equal(args.some(arg => arg.includes('SYNTHETIC_TASK')), false);
    };
    const prepared = await f.runtime().preflight({ cwd: f.project });
    assert.equal(prepared.identity.version, nativeVersion);
    assert.equal(prepared.identity.model, 'claude-opus-5[1m]');
    await prepared.launch(launch => {
      assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
      assert.equal(launch.env.ANTHROPIC_API_KEY, '');
      assert.equal(launch.env.CLAUDE_CODE_USE_BEDROCK, '0');
      assert.equal(Object.keys(launch.env).some(k => k.toUpperCase() === KEY), false);
      assert.equal(launch.args.includes('--permission-mode'), false);
    });
    assert.deepEqual(await fs.readFile(file), bytes, 'no rewriting, filtering or deletion of cache content');
    assert.ok(!f.reads.some(name => name.endsWith('.credentials.json')));
  }
});

nativeTest('generic restrictions require the verified exact native version; pure validators remain strict', async t => {
  for (const version of ['2.1.264', '2.1.318', '2.1.320', '2.1.321', '2.1.323', '3.0.0']) {
    const f = await fixture(t, version);
    await f.json('config/policy-limits.json', policy({ [REPORTED]: { allowed: false } }));
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('POLICY_CACHE_RESTRICTION'));
    assert.deepEqual(f.calls, [{ kind: 'version' }], 'only the bounded non-inference version probe may run');
  }
  for (const version of ['2.1.263', '2.1.319-beta', 'not-a-version']) {
    const f = await fixture(t, version);
    await f.json('config/policy-limits.json', policy({ [REPORTED]: { allowed: true } }));
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_COMPATIBILITY' });
    assert.deepEqual(f.calls, [{ kind: 'version' }]);
  }
  const f = await fixture(t);
  assert.throws(() => f.api.private.validatePersonalCache(policy({ [REPORTED]: { allowed: false } }), 'policy-limits.json', nativeVersion),
    conflict('POLICY_CACHE_RESTRICTION'));
  assert.throws(() => validateSettings({ env: { [KEY]: '1' } }, { nativeVersion }), conflict('SETTINGS_PROHIBITED_ENV'));
  assert.throws(() => f.runtime({ nativeVersion }), { code: 'NATIVE_INPUT' });
  await assert.rejects(f.runtime().preflight({ cwd: f.project, nativeVersion }), { code: 'NATIVE_INPUT' });
  assert.equal(f.calls.length, 0);
});

nativeTest('malformed restriction records and unsupported active/top-level policy states fail before the version probe', async t => {
  const f = await fixture(t);
  for (const restriction of [null, [], {}, true, false, 'false', 0,
    { allowed: null }, { allowed: 0 }, { allowed: 'false' }, { allowed: [] },
    { allowed: true, extra: false }, { other: true }]) {
    await f.json('config/policy-limits.json', policy({ [REPORTED]: restriction }));
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('POLICY_CACHE_RESTRICTION'));
  }
  for (const value of [
    { ...policy({}), restrictions: null }, { ...policy({}), restrictions: [] },
    { ...policy({}), compliance_taints: ['hipaa'] }, { ...policy({}), compliance_taints: {} },
    { ...policy({}), monitoring_notice: { text: 'notice', url: null } },
    { ...policy({}), defaults: { remote_control_at_startup: true } },
    { ...policy({}), defaults: { new_default: false } },
    { ...policy({}), core_skills: [] }, { ...policy({}), artifact_create_notice: null },
    { ...policy({}), unknown: false }, { ...policy({}), env: { [KEY]: '1' } },
  ]) {
    await f.json('config/policy-limits.json', value);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('POLICY_CACHE_SCHEMA'));
  }
  for (const value of [null, [], '{']) {
    await f.text('config/policy-limits.json', typeof value === 'string' ? value : JSON.stringify(value));
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_SOURCE' });
  }
  assert.equal(f.calls.length, 0, 'staging never authorizes malformed or active unsupported inputs');
  await f.text('config/policy-limits.json', JSON.stringify(policy(JSON.parse('{"__proto__":{"allowed":false}}'))));
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('POLICY_CACHE_RESTRICTION'));
  assert.equal(f.calls.length, 0, 'native parser would silently omit __proto__, so refuse it before metadata');
  for (const restriction of [
    Object.assign(Object.create({ allowed: false }), { other: true }),
    Object.defineProperty({ allowed: false }, 'hidden', { value: true }),
    { allowed: false, [Symbol('unsupported')]: true },
  ]) {
    assert.throws(() => f.api.private.validatePersonalCache(policy({ allow_connector_file_downloads: restriction }), 'policy-limits.json'),
      conflict('POLICY_CACHE_RESTRICTION'));
  }
});

nativeTest('only the native-ignored settings name is accepted, with source bytes retained and no launch waiver', async t => {
  const f = await fixture(t);
  const file = path.join(f.config, 'settings.json');
  for (const name of [KEY, KEY.toLowerCase()]) for (const value of ['1', '0', '', 'synthetic']) {
    const bytes = Buffer.from(JSON.stringify({ theme: 'dark', permissions: { deny: ['Read(./secret)'] },
      env: { [name]: value, ISSUE2_RETAINED: 'retained' } }, null, 2) + '\r\n');
    await fs.writeFile(file, bytes);
    const prepared = await f.runtime().preflight({ cwd: f.project });
    await prepared.launch(launch => {
      assert.equal(Object.keys(launch.env).some(k => k.toUpperCase() === KEY), false);
      const guard = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
      assert.equal(Object.keys(guard.env).some(k => k.toUpperCase() === KEY), false);
    });
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  for (const version of ['2.1.264', '2.1.318', '2.1.320', '2.1.321', '2.1.323']) {
    const older = await fixture(t, version);
    await older.json('config/settings.json', { env: { [KEY]: '1' } });
    await assert.rejects(older.runtime().preflight({ cwd: older.project }), conflict('SETTINGS_PROHIBITED_ENV'));
    assert.deepEqual(older.calls, [{ kind: 'version' }]);
  }
  for (const env of [{ [KEY + '_TYPO']: '1' }, { CLAUDE_CODE_MANAGED_SETTINGS_PATH: '' },
    { ANTHROPIC_BASE_URL: 'https://example.invalid' }, { CLAUDE_CODE_NEW_CONTROL: '0' }]) {
    const invalid = await fixture(t);
    await invalid.json('config/settings.json', { env });
    await assert.rejects(invalid.runtime().preflight({ cwd: invalid.project }), conflict('SETTINGS_PROHIBITED_ENV'));
    assert.equal(invalid.calls.length, 0);
  }
  for (const value of [null, false, 0, {}, [], 'contains\0nul']) {
    const invalid = await fixture(t);
    await invalid.json('config/settings.json', { env: { [KEY]: value } });
    await assert.rejects(invalid.runtime().preflight({ cwd: invalid.project }), { code: 'NATIVE_SOURCE' });
    assert.equal(invalid.calls.length, 0);
  }
  for (const name of [KEY, KEY.toLowerCase()]) for (const value of ['', '0', '1']) {
    const invalid = await fixture(t);
    await assert.rejects(invalid.runtime({ parentEnv: { ...invalid.parentEnv, [name]: value } }).preflight({ cwd: invalid.project }),
      conflict('PARENT_ENV_CONFLICT'));
    assert.equal(invalid.calls.length, 0);
  }
});

nativeTest('ordinary workflow-warning boolean is preserved without a forced setting or extra grant', async t => {
  for (const relative of ['config/settings.json', 'config/settings.local.json',
    'project/.claude/settings.json', 'project/.claude/settings.local.json']) for (const value of [false, true]) {
    const f = await fixture(t);
    const bytes = Buffer.from('\uFEFF' + JSON.stringify({ skipWorkflowUsageWarning: value,
      permissions: { deny: ['Read(./private)'] }, theme: 'dark' }, null, 2) + '\r\n');
    await f.text(relative, bytes.toString('utf8'));
    f.beforeExecute = (command, args) => {
      const guard = JSON.parse(args[args.indexOf('--settings') + 1]);
      assert.equal(Object.hasOwn(guard, 'skipWorkflowUsageWarning'), false, 'metadata cannot force saved consent');
    };
    const prepared = await f.runtime().preflight({ cwd: f.project });
    await prepared.launch(launch => {
      assert.equal(Object.hasOwn(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]), 'skipWorkflowUsageWarning'), false);
      assert.deepEqual(launch.args.slice(0, 2), ['--model', 'claude-opus-5[1m]']);
      assert.equal(launch.args.includes('--permission-mode'), false);
    });
    assert.deepEqual(await fs.readFile(path.join(f.root, relative)), bytes, 'both boolean values and all source bytes remain unchanged');
    await f.json(relative, { skipWorkflowUsageWarning: !value });
    await assert.rejects(prepared.launch(() => assert.fail('edited preference must invalidate the prepared snapshot')), { code: 'NATIVE_DRIFT' });
  }
});

nativeTest('workflow-warning support stays private, exact-version, ordinary-only and boolean-only', async t => {
  for (const value of [null, 0, 1, '', 'false', 'true', [], {}]) {
    const f = await fixture(t);
    await f.json('config/settings.json', { skipWorkflowUsageWarning: value });
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_SOURCE' });
    assert.equal(f.calls.length, 0, 'invalid field types are refused before even the version probe');
  }
  for (const version of ['2.1.264', '2.1.318', '2.1.320', '2.1.321', '2.1.323']) for (const value of [false, true]) {
    const f = await fixture(t, version);
    await f.json('config/settings.json', { skipWorkflowUsageWarning: value });
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('SETTINGS_UNSUPPORTED_FIELD'));
    assert.deepEqual(f.calls, [{ kind: 'version' }]);
  }
  for (const relative of ['Program Files/ClaudeCode/managed-settings.json',
    'Program Files/ClaudeCode/managed-settings.d/workflow.json', 'config/remote-settings.json']) {
    const f = await fixture(t);
    await f.json(relative, { skipWorkflowUsageWarning: false });
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('SETTINGS_UNSUPPORTED_FIELD'));
    assert.equal(f.calls.length, 0, 'managed policy support was not expanded');
  }
  const f = await fixture(t);
  Object.assign(f.registered[0], { present: true, kind: 'String', raw: '{"skipWorkflowUsageWarning":false}', value: '{"skipWorkflowUsageWarning":false}' });
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('SETTINGS_UNSUPPORTED_FIELD'));
  assert.equal(f.calls.length, 0);
  for (const value of [false, true]) {
    assert.throws(() => validateSettings({ skipWorkflowUsageWarning: value }), conflict('SETTINGS_UNSUPPORTED_FIELD'));
    assert.throws(() => validateSettings({ skipWorkflowUsageWarning: value }, { nativeVersion }), conflict('SETTINGS_UNSUPPORTED_FIELD'));
  }
  const unknown = await fixture(t);
  await unknown.json('config/settings.json', { skipWorkflowUsageWarnings: true });
  await assert.rejects(unknown.runtime().preflight({ cwd: unknown.project }), conflict('SETTINGS_UNSUPPORTED_FIELD'));
  assert.equal(unknown.calls.length, 0);
});

nativeTest('version-probe changes and post-preflight policy/settings edits cannot replace the original source baseline', async t => {
  for (const phase of ['version', 'launch']) for (const source of ['policy-limits.json', 'settings.json']) {
    const f = await fixture(t);
    await f.json('config/policy-limits.json', policy({ [REPORTED]: { allowed: false } }));
    await f.json('config/settings.json', { env: { [KEY]: '1' } });
    const file = path.join(f.config, source);
    const change = () => fs.appendFile(file, ' ');
    if (phase === 'version') {
      f.beforeExecute = async (command, args) => { if (args.includes('--version')) await change(); };
      await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_DRIFT' });
      assert.deepEqual(f.calls, [{ kind: 'version' }]);
    } else {
      const prepared = await f.runtime().preflight({ cwd: f.project });
      await change();
      await assert.rejects(prepared.launch(() => assert.fail('edited source must not launch')), { code: 'NATIVE_DRIFT' });
    }
  }
});

nativeTest('Team generic records still require complete native policy attestation and retain both caches', async t => {
  const f = await fixture(t, nativeVersion, { tier: 'team' });
  await f.json('config/policy-limits.json', policy({ [REPORTED]: { allowed: false }, require_synthetic: { allowed: true } }));
  await f.json('config/remote-settings.json', { channelsEnabled: true, permissions: { deny: ['Read(./private)'] } });
  const bytes = await fs.readFile(path.join(f.config, 'policy-limits.json'));
  f.doctorOutput = TEAM_DOCTOR; f.doctorStderr = TEAM_DEBUG;
  const prepared = await f.runtime().preflight({ cwd: f.project });
  await prepared.launch(() => {});
  assert.deepEqual(await fs.readFile(path.join(f.config, 'policy-limits.json')), bytes);
  f.doctorStderr = '';
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_POLICY' });
});

nativeTest('completed requests preserve identity in status and replay while unsupported continuation leaves historical state intact', async t => {
  const f = await fixture(t);
  await f.json('config/policy-limits.json', policy({ [REPORTED]: { allowed: false } }));
  await f.json('config/settings.json', { env: { [KEY]: '1' } });
  const settings = config({ ...f.parentEnv, CLAUDE_BRIDGE_COMMAND: f.executable,
    CLAUDE_BRIDGE_CONFIG_DIR: f.config, CLAUDE_BRIDGE_STATE_DIR: path.join(f.root, 'bridge-state') });
  let runs = 0;
  const backend = { async run(input) { runs++; return { reply: 'synthetic policy schema result', session_id: input.sessionId }; } };
  const bridge = new ClaudeBridge(backend, settings, options => f.api.private.createRuntime(options, f.deps));
  const request = { conversation_id: 'schema-' + nativeVersion, request_id: 'completed', message: 'synthetic unit task', working_dir: f.project };
  const output = await bridge.turn(request);
  assert.equal(runs, 1);
  assert.equal(output.runtime.version, nativeVersion);
  const status = await bridge.status(request.conversation_id);
  assert.equal(status.status, 'ready'); assert.equal(status.turn, 1);
  assert.deepEqual(status.runtime, output.runtime); assert.deepEqual(status.last_result, output);
  await f.json('config/policy-limits.json', policy({ [REPORTED]: { allowed: false, unsupported: true } }));
  const calls = f.calls.length;
  assert.deepEqual(await bridge.turn(request), { ...output, replayed: true });
  assert.equal(f.calls.length, calls, 'completed replay does not execute metadata or tasks');
  await assert.rejects(bridge.turn({ ...request, request_id: 'next' }), conflict('POLICY_CACHE_RESTRICTION'));
  assert.equal(runs, 1);
  const after = await bridge.status(request.conversation_id);
  assert.equal(after.status, 'ready'); assert.equal(after.turn, 1);
  assert.deepEqual(after.last_result, output); assert.deepEqual(after.runtime, output.runtime);
  assert.equal(after.last_error.reason, 'POLICY_CACHE_RESTRICTION');
});
}
