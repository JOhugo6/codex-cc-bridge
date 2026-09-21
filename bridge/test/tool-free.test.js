'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { config } = require('../lib/config');
const { ClaudeBridge } = require('../lib/bridge');
const { fixture, fakeRuntime, fakeLaunch } = require('./helpers');
const { backendProbe } = require('./runtime-integration-fixture');
const first = cwd => ({ conversation_id: 'tools', request_id: 'one', message: 'synthetic', working_dir: cwd });
const noRuntime = () => assert.fail('preflight must not run');
const success = i => ({ reply: i.message, session_id: i.sessionId });

test('legacy disable-tools environment is validated but cannot remove native tools', () => {
  assert.equal(config({}).disableTools, false);
  assert.equal(config({ CLAUDE_BRIDGE_DISABLE_TOOLS: '0' }).disableTools, false);
  assert.equal(config({ CLAUDE_BRIDGE_DISABLE_TOOLS: '1' }).disableTools, false);
  for (const value of ['', 'true', 'false', ' 1', '1 ', '--tools', 'Read', 1, true, null]) {
    assert.throws(() => config({ CLAUDE_BRIDGE_DISABLE_TOOLS: value }), { code: 'INVALID_CONFIG' });
  }
});

test('backend validates legacy inputs and always launches with full native tools', async t => {
  const f = await fixture(t);
  let observed;
  const Backend = backendProbe(value => {
    observed = value;
    value.child.stdin.on('finish', () => {
      value.child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'expected' }));
      value.child.emit('close', 0);
    });
    value.child.stdin.resume();
  });
  const backend = new Backend(f.settings);
  const input = { launch: fakeLaunch(f.cwd, 'claude-opus-5[1m]'), cwd: f.cwd, model: 'claude-opus-5[1m]',
    message: 'synthetic', sessionId: 'expected', permissionMode: 'dontAsk', allowedTools: ['Read'], resume: false };
  for (const disableTools of [null, '1', 'false', 0, [], {}, '--tools']) {
    assert.throws(() => backend.run({ ...input, disableTools }), { code: 'INVALID_CONFIG' });
    assert.equal(observed, undefined);
  }
  for (const disableTools of [undefined, false, true]) {
    await backend.run({ ...input, disableTools });
    const args = process.platform === 'win32' ? JSON.parse(Buffer.from(observed.args.at(-1), 'base64')).args : observed.args;
    assert.ok(!args.includes('--tools'));
    assert.ok(!args.includes('--allowedTools'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  }
  assert.throws(() => backend.run({ ...input, disableTools: true, allowedTools: ['--model', 'other'] }), { code: 'INVALID_CONFIG' });
});

test('legacy configuration cannot restrict new or resumed work; cache unchanged', async t => {
  const f = await fixture(t);
  for (const mode of [true, false]) {
    const id = mode ? 'free' : 'normal';
    const input = { ...first(f.cwd), conversation_id: id };
    const oneBridge = new ClaudeBridge({ run: success }, { ...f.settings, disableTools: mode }, fakeRuntime);
    const one = await oneBridge.turn(input);
    const before = await fs.readFile(oneBridge.store.file(id), 'utf8');
    let observed;
    const twoBridge = new ClaudeBridge({ run: i => { observed = i; return success(i); } },
      { ...f.settings, disableTools: !mode }, fakeRuntime);
    assert.deepEqual(await twoBridge.turn(input), { ...one, replayed: true });
    assert.equal(await fs.readFile(oneBridge.store.file(id), 'utf8'), before);
    const two = await twoBridge.turn({ conversation_id: id, message: 'next' });
    assert.equal(observed.disableTools, false); assert.equal(two.session_id, one.session_id);
    assert.equal((await twoBridge.status(id)).policy.disableTools, false);
  }
});

test('old v2 gets current access policy on new work; v1 stays status/replay-only', async t => {
  const f = await fixture(t);
  const bridge = new ClaudeBridge({ run: success }, f.settings, fakeRuntime);
  const one = await bridge.turn(first(f.cwd));
  const st = await bridge.store.load('tools');
  delete st.policy.disableTools;
  const raw = JSON.stringify(st, null, 1) + '\r\n';
  await fs.writeFile(bridge.store.file('tools'), raw);
  let observed;
  const changed = new ClaudeBridge({ run: i => { observed = i; return success(i); } }, { ...f.settings, disableTools: true }, fakeRuntime);
  assert.deepEqual(await changed.turn(first(f.cwd)), { ...one, replayed: true });
  assert.equal(Object.hasOwn((await changed.status('tools')).policy, 'disableTools'), false);
  assert.equal(await fs.readFile(bridge.store.file('tools'), 'utf8'), raw);
  await changed.turn({ conversation_id: 'tools', message: 'next' });
  assert.equal(observed.disableTools, false);
  assert.equal((await changed.status('tools')).policy.disableTools, false);
  st.version = 1; delete st.runtime; st.policy.disableTools = 'historical-uninterpreted';
  const legacy = JSON.stringify(st) + '\n';
  await fs.writeFile(bridge.store.file('tools'), legacy);
  const v1 = new ClaudeBridge({ run: () => assert.fail('legacy executed') }, { ...f.settings, disableTools: 'bad' }, noRuntime);
  assert.equal((await v1.status('tools')).version, 1);
  assert.deepEqual(await v1.turn(first(f.cwd)), { ...one, replayed: true });
  await assert.rejects(v1.turn({ conversation_id: 'tools', message: 'new' }), { code: 'LEGACY_SESSION' });
  assert.equal(await fs.readFile(bridge.store.file('tools'), 'utf8'), legacy);
});

test('invalid programmatic policy refuses before preflight/pending; persisted nonboolean is corrupt', async t => {
  const f = await fixture(t);
  for (const disableTools of [null, 1, '1', [], {}]) {
    const b = new ClaudeBridge({ run: () => assert.fail('must not execute') }, { ...f.settings, disableTools }, noRuntime);
    await assert.rejects(b.turn(first(f.cwd)), { code: 'INVALID_CONFIG' });
    assert.equal(await b.store.load('tools'), null);
  }
  const b = new ClaudeBridge({ run: success }, f.settings, fakeRuntime);
  await b.turn(first(f.cwd));
  const state = await b.store.load('tools');
  for (const disableTools of [null, 1, '1', [], {}]) {
    const bad = { ...state, policy: { ...state.policy, disableTools } };
    const raw = JSON.stringify(bad);
    await fs.writeFile(b.store.file('tools'), raw);
    await assert.rejects(b.store.save('tools', bad), { code: 'CORRUPT_STATE' });
    await assert.rejects(b.status('tools'), { code: 'CORRUPT_STATE' });
    await assert.rejects(b.turn(first(f.cwd)), { code: 'CORRUPT_STATE' });
    assert.equal(await fs.readFile(b.store.file('tools'), 'utf8'), raw);
  }
});


test('restricted historical v2 policy migrates with pending and restores on pre-submission failure', async t => {
  const f = await fixture(t);
  const bridge = new ClaudeBridge({ run: success }, f.settings, fakeRuntime);
  const one = await bridge.turn(first(f.cwd));
  const old = await bridge.store.load('tools');
  old.policy = { permissionMode: 'dontAsk', allowedTools: ['Read'], disableTools: true };
  await bridge.store.save('tools', old);
  const current = { permissionMode: 'bypassPermissions', allowedTools: [], disableTools: false };
  assert.deepEqual(await bridge.turn(first(f.cwd)), { ...one, replayed: true });
  assert.deepEqual((await bridge.status('tools')).policy, old.policy);
  const failingRuntime = options => ({ async preflight(input) {
    const prepared = await fakeRuntime(options).preflight(input);
    return { identity: prepared.identity, async launch() {
      const pending = await bridge.store.load('tools');
      assert.equal(pending.status, 'pending');
      assert.deepEqual(pending.policy, current);
      throw Object.assign(new Error('synthetic pre-submission drift'), { code: 'NATIVE_DRIFT' });
    } };
  } });
  const failed = new ClaudeBridge({ run: () => assert.fail('must not dispatch') }, f.settings, failingRuntime);
  await assert.rejects(failed.turn({ conversation_id: 'tools', message: 'next' }), { code: 'NATIVE_DRIFT' });
  assert.deepEqual(await bridge.store.load('tools'), old);
  let observed;
  const resumed = new ClaudeBridge({ run: i => { observed = i; return success(i); } }, f.settings, fakeRuntime);
  const two = await resumed.turn({ conversation_id: 'tools', message: 'next' });
  assert.equal(two.session_id, one.session_id);
  assert.equal(observed.permissionMode, 'bypassPermissions');
  assert.deepEqual(observed.allowedTools, []); assert.equal(observed.disableTools, false);
  assert.deepEqual((await resumed.status('tools')).policy, current);
});
