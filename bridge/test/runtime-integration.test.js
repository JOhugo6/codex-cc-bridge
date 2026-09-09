'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { config, fail } = require('../lib/config');
const { ClaudeBridge } = require('../lib/bridge');
const { ClaudeBackend, parseResult } = require('../lib/claude-backend');
const { resolveModel, RUNTIME_CONTRACT } = require('../lib/native-runtime');
const { fixture, fakeRuntime, fakeLaunch } = require('./helpers');
const { synthetic, inference, assertWire, reply, SENTINEL, EMAIL } = require('./native-runtime-fixture');
const { connectNative, backendProbe } = require('./runtime-integration-fixture');
const MODEL = 'claude-opus-5[1m]';
const SECRET = 'SYNTHETIC_INTEGRATION_ERROR_SECRET';
const success = i => ({ reply: i.message, session_id: i.sessionId });
const reject = code => ({ code });
const noRuntime = () => assert.fail('runtime must remain lazy');

function invalidToolPolicies() {
  return [
    ['Read', '--model', 'claude-unsupported-review-probe'],
    ['Read', '--no-session-persistence'],
    ['--model=claude-unsupported-review-probe'], ['-p'], ['-mopus'], ['--'], ['-'],
    [' \t--model'], ['\r\n-p'], ['﻿--'], ['Read\0--model'],
    [null], [123], [false], [{}], [['--model']], [''], ['  '], ['R'.repeat(501)],
    null, 'Read', { 0: '--model', length: 1 },
  ];
}

test('allowed-tool configuration rejects argv options and malformed values but preserves rule flags', () => {
  for (const allowedTools of invalidToolPolicies()) {
    assert.throws(() => config({ CLAUDE_BRIDGE_ALLOWED_TOOLS: JSON.stringify(allowedTools) }), reject('INVALID_CONFIG'));
  }
  const good = ['Read', 'Read(./--model)', 'Bash(git --version)', 'Bash(node --test *)', 'Bash(git log --oneline:*)', 'mcp__local__tool'];
  assert.deepEqual(config({ CLAUDE_BRIDGE_ALLOWED_TOOLS: JSON.stringify(good) }).allowedTools, good);
});

test('direct backend rejects option-like and unusual allowed-tool arrays before supervised spawn', async t => {
  const f = await fixture(t);
  const Backend = backendProbe(() => assert.fail('invalid policy must not spawn'));
  const backend = new Backend(f.settings);
  const launch = fakeLaunch(f.cwd, MODEL);
  const disguised = ['--model']; disguised.some = () => false;
  const throwing = ['Read']; Object.defineProperty(throwing, '0', { get() { throw new Error(SECRET); } });
  for (const allowedTools of [...invalidToolPolicies(), undefined, new Set(['Read']), new Array(1), [new String('Read')], disguised, throwing]) {
    assert.throws(() => backend.run({ launch, cwd: f.cwd, model: MODEL, message: SECRET, sessionId: 'expected',
      permissionMode: 'dontAsk', allowedTools, resume: false }), e => e.code === 'INVALID_CONFIG' && !e.message.includes(SECRET));
  }
  assert.equal(backend.active.size, 0);
});

test('backend snapshots indexed primitive rules without executing an overridden array iterator', async t => {
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
  const allowedTools = ['Read', 'Bash(git --version)'];
  allowedTools[Symbol.iterator] = () => assert.fail('untrusted iterator must not run');
  const result = backend.run({ launch: fakeLaunch(f.cwd, MODEL), cwd: f.cwd, model: MODEL, message: 'only stdin',
    sessionId: 'expected', permissionMode: 'dontAsk', allowedTools, resume: false });
  assert.ok(observed, 'validation must not introduce an asynchronous spawn gap');
  const args = process.platform === 'win32'
    ? JSON.parse(Buffer.from(observed.args.at(-1), 'base64')).args : observed.args;
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1), ['Read', 'Bash(git --version)']);
  assert.equal((await result).reply, 'ok');
});

test('programmatic policy validation precedes preflight and pending but respects pinned policy and cache', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const before = await contents(f.bridge);
  for (const allowedTools of [...invalidToolPolicies(), new Array(1)]) {
    const bad = new ClaudeBridge({ run: () => assert.fail('invalid policy submitted') }, { ...f.settings, allowedTools }, noRuntime);
    await assert.rejects(bad.turn(first(f.cwd, { conversation_id: 'invalid-policy' })), reject('INVALID_CONFIG'));
    assert.equal(await bad.store.load('invalid-policy'), null);
    assert.equal((await bad.turn(first(f.cwd))).replayed, true);
    assert.equal((await bad.status('integration')).status, 'ready');
    assert.equal(await contents(bad), before);
  }
  let observed;
  const b = new ClaudeBridge({ run: input => { observed = input; return success(input); } },
    { ...f.settings, allowedTools: ['--model', 'unsupported'] }, fakeRuntime);
  const two = await b.turn({ conversation_id: 'integration', message: 'pinned valid policy' });
  assert.equal(two.turn, 2); assert.deepEqual(observed.allowedTools, []);
});

test('v2 policy rejects injected options on load/save without changing bytes or replaying corrupt state', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const good = await f.bridge.store.load('integration');
  const b = new ClaudeBridge({ run: () => assert.fail('corrupt policy submitted') }, f.settings, noRuntime);
  for (const allowedTools of invalidToolPolicies()) {
    const bad = structuredClone(good); bad.policy.allowedTools = allowedTools;
    const raw = JSON.stringify(bad, null, 1) + '\n';
    await fs.writeFile(b.store.file('integration'), raw);
    await assert.rejects(b.status('integration'), reject('CORRUPT_STATE'));
    await assert.rejects(b.turn(first(f.cwd)), reject('CORRUPT_STATE'));
    await assert.rejects(b.turn({ conversation_id: 'integration', message: 'new' }), reject('CORRUPT_STATE'));
    await assert.rejects(b.store.save('integration', bad), reject('CORRUPT_STATE'));
    assert.equal(await contents(b), raw);
  }
});

test('v1 historical option-like policy stays status/exact-replay only without migration or rewritten bytes', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const st = await f.bridge.store.load('integration');
  st.version = 1; st.model = 'historical-provider'; delete st.runtime;
  st.policy.allowedTools = ['Read', '--model', 'claude-unsupported-review-probe', '--no-session-persistence', '-p', '--'];
  for (const output of [st.last_result, ...st.requests.map(r => r.output)]) { delete output.model; delete output.runtime; }
  const raw = JSON.stringify(st, null, 1) + '\r\n';
  await fs.writeFile(f.bridge.store.file('integration'), raw);
  const b = new ClaudeBridge({ run: () => assert.fail('legacy policy submitted') },
    { ...f.settings, command: 'missing', model: 'invalid', allowedTools: ['--model'] }, noRuntime);
  const status = await b.status('integration');
  assert.equal(status.version, 1); assert.equal(status.inference_allowed, false);
  assert.deepEqual(status.policy.allowedTools, st.policy.allowedTools);
  const output = await b.turn(first(f.cwd));
  assert.deepEqual(output, { ...st.last_result, replayed: true });
  await assert.rejects(b.turn(first(f.cwd, { message: 'changed' })), reject('REQUEST_ID_CONFLICT'));
  await assert.rejects(b.turn({ conversation_id: 'integration', message: 'new' }), reject('LEGACY_SESSION'));
  assert.equal(await contents(b), raw);
});

for (const [name, allowedTools] of [
  ['model override', ['Read', '--model', 'claude-unsupported-review-probe']],
  ['session persistence override', ['Read', '--no-session-persistence']],
]) test(`actual native policy regression: ${name} refuses before inference; valid rules still resume`, { timeout: 180000 }, async () => {
  const f = await synthetic({ native: true });
  let connection;
  const backend = new ClaudeBackend({ timeoutMs: 30000 });
  const toolError = (response, code) => {
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).code, code);
  };
  try {
    // The public MCP startup rejects the original malicious environment before
    // any native preflight or task. The same fixture must later run successfully.
    await assert.rejects(connectNative(f, { CLAUDE_BRIDGE_ALLOWED_TOOLS: JSON.stringify(allowedTools) }),
      { message: 'Synthetic integration MCP startup failed.' });
    assertWire(f, 0);
    await assert.rejects(fs.stat(path.join(f.root, 'bridge-state')), reject('ENOENT'));
    // Independently exercise the direct backend boundary with a genuinely
    // prepared actual-native descriptor, not a fake CLI's option parser.
    const prepared = await f.runtime().preflight({ cwd: f.project, model: MODEL });
    let callback = false;
    await assert.rejects(prepared.launch(launch => {
      callback = true;
      return backend.run({ launch, cwd: f.project, model: MODEL, sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'INVALID_POLICY_MUST_NOT_REACH_INFERENCE', permissionMode: 'dontAsk', allowedTools, resume: false });
    }), reject('INVALID_CONFIG'));
    assert.equal(callback, true); assert.equal(backend.active.size, 0); assertWire(f, 0);

    await f.text('project/positive.txt', 'POLICY_VALID_READ_CONTENT');
    let requested = false;
    f.base.setResponder((r, res) => {
      if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || requested) return false;
      requested = true;
      reply(res, r.body.model, [
        { type: 'tool_use', id: 'policy_read', name: 'Read', input: { file_path: path.join(f.project, 'positive.txt') } },
        { type: 'tool_use', id: 'policy_bash', name: 'Bash', input: { command: 'git --version' } },
      ]);
      return true;
    });
    const good = ['Read(./positive.txt)', 'Bash(git --version)'];
    connection = await connectNative(f, { CLAUDE_BRIDGE_ALLOWED_TOOLS: JSON.stringify(good) });
    const input = first(f.project, { message: 'POLICY_POSITIVE_FIRST_TASK' });
    const one = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.ok(!one.isError, JSON.stringify(one));
    assert.equal(one.structuredContent.model, MODEL); assert.equal(one.structuredContent.runtime.version, '2.1.263');
    assertWire(f, 2);
    const results = inference(f).at(-1).body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(x => x.type === 'tool_result');
    assert.ok(results.some(x => x.tool_use_id === 'policy_read' && !x.is_error && JSON.stringify(x.content).includes('POLICY_VALID_READ_CONTENT')));
    assert.ok(results.some(x => x.tool_use_id === 'policy_bash' && !x.is_error && /git version/.test(JSON.stringify(x.content))),
      'a legitimate flag inside Bash(...) must retain its effective permission');
    await connection.close(); connection = null;
    connection = await connectNative(f, { CLAUDE_BRIDGE_ALLOWED_TOOLS: '[]' });
    const replay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.equal(replay.structuredContent.replayed, true); assertWire(f, 2);
    const two = await connection.client.callTool({ name: 'claude_turn', arguments: {
      conversation_id: 'integration', request_id: 'two', message: 'POLICY_POSITIVE_SECOND_TASK' } });
    assert.ok(!two.isError, JSON.stringify(two));
    assert.equal(two.structuredContent.session_id, one.structuredContent.session_id);
    assert.equal(two.structuredContent.turn, 2); assert.equal(two.structuredContent.model, MODEL); assertWire(f, 3);
    assert.ok(JSON.stringify(inference(f).at(-1).body.messages).includes(input.message));
    const status = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'integration' } });
    assert.deepEqual(status.structuredContent.policy.allowedTools, good);
    const stateFile = status.structuredContent.state_file;
    const corrupt = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    corrupt.policy.allowedTools = allowedTools;
    const raw = JSON.stringify(corrupt, null, 1) + '\n';
    await fs.writeFile(stateFile, raw);
    toolError(await connection.client.callTool({ name: 'claude_turn', arguments: input }), 'CORRUPT_STATE');
    toolError(await connection.client.callTool({ name: 'claude_turn', arguments: {
      conversation_id: 'integration', request_id: 'three', message: 'INVALID_POLICY_MUST_NOT_REACH_INFERENCE' } }), 'CORRUPT_STATE');
    toolError(await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'integration' } }), 'CORRUPT_STATE');
    assert.equal(await fs.readFile(stateFile, 'utf8'), raw); assertWire(f, 3);
    const wire = JSON.stringify(inference(f));
    assert.ok(!wire.includes('INVALID_POLICY_MUST_NOT_REACH_INFERENCE'));
    assert.ok(!wire.includes('claude-unsupported-review-probe'));
  } finally { backend.close(); if (connection) await connection.close(); await f.close(); }
});

async function unit(t, runtime = fakeRuntime, backend = { run: success }) {
  const f = await fixture(t);
  return { ...f, bridge: new ClaudeBridge(backend, f.settings, runtime), backend };
}
function first(cwd, extra = {}) {
  return { conversation_id: 'integration', request_id: 'one', message: 'first task', working_dir: cwd, ...extra };
}
async function contents(bridge) { return fs.readFile(bridge.store.file('integration'), 'utf8'); }

test('explicit existing profile drift and exact root spelling cannot replace session identity', async () => {
  const f = await synthetic();
  try {
    const settings = { ...config(f.parentEnv), command: f.executable, configRoot: f.config, stateDir: path.join(f.root, 'bridge-state') };
    const runtime = o => f.api.private.createRuntime(o, f.deps);
    const b = new ClaudeBridge({ run: success }, settings, runtime);
    await b.turn(first(f.project));
    const before = await contents(b);
    await f.json('other-profile/.claude.json', { oauthAccount: { emailAddress: 'synthetic@example.invalid' } });
    for (const configRoot of [path.join(f.root, 'other-profile'), f.config.replaceAll('\\', '/')]) {
      if (configRoot === f.config) continue;
      const changed = new ClaudeBridge({ run: () => assert.fail('profile drift must not launch') }, { ...settings, configRoot }, runtime);
      assert.equal((await changed.turn(first(f.project))).replayed, true);
      await assert.rejects(changed.turn({ conversation_id: 'integration', message: 'next' }), reject('NATIVE_DRIFT'));
      assert.equal(await contents(changed), before);
    }
  } finally { await f.close(); }
});

test('failed ready restoration leaves a conservative durable pending marker, never a replacement', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const original = await f.bridge.status('integration');
  const runtime = options => ({ async preflight(input) {
    const p = await fakeRuntime(options).preflight(input);
    return { identity: p.identity, launch: async () => { throw fail('NATIVE_DRIFT'); } };
  } });
  const b = new ClaudeBridge({ run: () => assert.fail('must not execute') }, f.settings, runtime);
  const save = b.store.save.bind(b.store);
  b.store.save = (id, st) => st.status === 'ready' ? Promise.reject(new Error(SECRET)) : save(id, st);
  await assert.rejects(b.turn({ conversation_id: 'integration', message: 'next' }), reject('NATIVE_DRIFT'));
  const status = await b.status('integration');
  assert.equal(status.status, 'pending'); assert.equal(status.session_id, original.session_id);
  await assert.rejects(f.bridge.turn({ conversation_id: 'integration', message: 'retry' }), reject('TURN_UNCERTAIN'));
});

test('failure committing a submitted success is uncertain and preserves completed earlier requests', async t => {
  const f = await unit(t);
  const original = await f.bridge.turn(first(f.cwd));
  const save = f.bridge.store.save.bind(f.bridge.store);
  f.bridge.store.save = (id, st) => st.status === 'ready' ? Promise.reject(new Error(SECRET)) : save(id, st);
  await assert.rejects(f.bridge.turn({ conversation_id: 'integration', message: 'next' }), e => e.code === 'BRIDGE_ERROR' && !e.message.includes(SECRET));
  const status = await f.bridge.status('integration');
  assert.equal(status.status, 'uncertain'); assert.equal(status.session_id, original.session_id); assert.equal(status.turn, 1);
  assert.equal((await f.bridge.turn(first(f.cwd))).replayed, true);
});

test('legacy status sanitizes historical raw diagnostics without rewriting its state', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const st = await f.bridge.store.load('integration');
  st.version = 1; delete st.runtime;
  st.last_error = { code: 'CLAUDE_EXIT', message: SECRET };
  await f.bridge.store.save('integration', st);
  const before = await contents(f.bridge);
  assert.ok(!JSON.stringify(await f.bridge.status('integration')).includes(SECRET));
  assert.equal(await contents(f.bridge), before);
});

// These are integration regressions, separate from the immutable adapter proofs.
test('config is injectable and lazy; explicit profile spelling only, never parent CLAUDE_CONFIG_DIR', async t => {
  const f = await fixture(t);
  const env = { HOME: f.dir, USERPROFILE: f.dir, CLAUDE_CONFIG_DIR: path.join(f.dir, 'parent-profile'),
    CLAUDE_BRIDGE_COMMAND: path.join(f.dir, 'absent.exe') };
  const settings = config(env);
  assert.equal(settings.model, 'opus');
  assert.ok(!Object.hasOwn(settings, 'configRoot'));
  assert.equal(settings.command, env.CLAUDE_BRIDGE_COMMAND);
  assert.deepEqual(settings.parentEnv, env);
  const profile = f.dir.replaceAll('\\', '/') + '/existing native profile';
  assert.equal(config({ ...env, CLAUDE_BRIDGE_CONFIG_DIR: profile }).configRoot, profile);
  assert.equal(config({ ...env, CLAUDE_BRIDGE_CONFIG_DIR: '' }).configRoot, '');
  let options;
  const b = new ClaudeBridge({ run: success }, { ...settings, stateDir: f.settings.stateDir }, o => { options = o; return fakeRuntime(o); });
  await b.status('not-created');
  assert.equal(options, undefined);
  await b.turn(first(f.cwd));
  assert.ok(!Object.keys(options.parentEnv).some(k => k.toUpperCase() === 'CLAUDE_CONFIG_DIR'));
  assert.ok(!Object.hasOwn(options, 'configRoot'));
  assert.deepEqual(settings.parentEnv, env, 'parent snapshot must not be mutated');
});

test('new model precedence is pure and supported aliases pin canonically across changed defaults', async t => {
  const f = await unit(t);
  assert.equal(resolveModel(undefined), MODEL);
  assert.equal(resolveModel('opus[1m]', 'claude-opus-5'), MODEL);
  assert.equal(resolveModel(undefined, 'claude-opus-5'), 'claude-opus-5');
  for (const value of [null, '', 'default', 'inherit', 'opusplan', 'gpt-6', 'sonnet', 'claude-opus-4-6', 'gateway/opus']) {
    assert.throws(() => resolveModel(value), reject('NATIVE_MODEL'));
    await assert.rejects(f.bridge.turn(first(f.cwd, { model: value })), e => ['INVALID_INPUT', 'NATIVE_MODEL'].includes(e.code));
  }
  const one = await f.bridge.turn(first(f.cwd, { model: 'opus[1m]' }));
  assert.equal(one.model, MODEL);
  assert.equal(one.runtime.model, MODEL);
  const changed = new ClaudeBridge(f.backend, { ...f.settings, model: 'unsupported-new-default' }, fakeRuntime);
  const replay = await changed.turn(first(f.cwd, { model: 'opus' }));
  assert.equal(replay.replayed, true);
  const next = await changed.turn({ conversation_id: 'integration', message: 'next', request_id: 'two' });
  assert.equal(next.model, MODEL);
  assert.equal(next.session_id, one.session_id);
  const selected = new ClaudeBridge(f.backend, { ...f.settings, model: 'claude-opus-5' }, fakeRuntime);
  assert.equal((await selected.turn(first(f.cwd, { conversation_id: 'configured' }))).model, 'claude-opus-5');
  assert.equal((await selected.turn(first(f.cwd, { conversation_id: 'override', model: 'opus' }))).model, MODEL);
  await assert.rejects(changed.turn(first(f.cwd, { conversation_id: 'invalid-default' })), reject('NATIVE_MODEL'));
});

test('v1 unknown-provider state is status/exact replay only, unchanged and never migrated', async t => {
  const f = await unit(t);
  const result = await f.bridge.turn(first(f.cwd));
  const st = await f.bridge.store.load('integration');
  st.version = 1; st.model = 'unknown-provider-historical-alias'; delete st.runtime;
  for (const out of [st.last_result, ...st.requests.map(r => r.output)]) { delete out.model; delete out.runtime; }
  await f.bridge.store.save('integration', st);
  const before = await contents(f.bridge);
  const b = new ClaudeBridge({ run: () => assert.fail('legacy execution') }, { ...f.settings, model: 'invalid', command: 'missing' }, noRuntime);
  const status = await b.status('integration');
  assert.equal(status.version, 1); assert.equal(status.inference_allowed, false); assert.equal(status.runtime, null);
  const out = await b.turn(first(f.cwd, { model: st.model }));
  assert.equal(out.reply, result.reply); assert.equal(out.replayed, true);
  await assert.rejects(b.turn(first(f.cwd, { message: 'changed' })), reject('REQUEST_ID_CONFLICT'));
  await assert.rejects(b.turn(first(f.cwd, { model: 'opus' })), reject('MODEL_MISMATCH'));
  await assert.rejects(b.turn({ conversation_id: 'integration', message: 'new work' }), reject('LEGACY_SESSION'));
  assert.equal(await contents(b), before);
});

test('v1 null model remains replayable without current model resolution', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const st = await f.bridge.store.load('integration');
  st.version = 1; st.model = null; delete st.runtime;
  await f.bridge.store.save('integration', st);
  const b = new ClaudeBridge(f.backend, { ...f.settings, model: 'not-native' }, noRuntime);
  assert.equal((await b.turn(first(f.cwd))).replayed, true);
  assert.equal((await b.status('integration')).model, null);
  await assert.rejects(b.turn({ conversation_id: 'integration', message: 'new' }), reject('LEGACY_SESSION'));
});

test('replay with unusable CLI/auth, changed profile/default and absent cwd needs no runtime', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  await fs.rm(f.cwd, { recursive: true });
  const b = new ClaudeBridge({ run: () => assert.fail('replay must not execute') }, {
    ...f.settings, model: 'invalid', command: path.join(f.dir, 'missing.exe'), configRoot: path.join(f.dir, 'missing-profile'),
  }, noRuntime);
  const controller = new AbortController(); controller.abort();
  assert.equal((await b.turn({ conversation_id: 'integration', request_id: 'one', message: 'first task' }, controller.signal)).replayed, true);
  assert.equal((await b.status('integration')).version, 2);
  await assert.rejects(b.turn({ conversation_id: 'integration', request_id: 'one', message: 'different' }), reject('REQUEST_ID_CONFLICT'));
  await assert.rejects(b.turn({ conversation_id: 'integration', request_id: 'one', message: 'first task', model: 'claude-opus-5' }), reject('MODEL_MISMATCH'));
});

test('v2 schema rejects corrupt identity/cache/pending fields without native or data leakage', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const good = await f.bridge.store.load('integration');
  const cases = [
    s => { s.version = 3; }, s => { s.model = 'opus'; }, s => { s.runtime.model = 'claude-opus-5'; },
    s => { s.runtime.cwd = f.dir; }, s => { s.runtime.configRoot = 'relative'; },
    s => { s.runtime.contract += '/unknown'; }, s => { s.runtime.accountFingerprint = SECRET; },
    s => { s.runtime.executableFingerprint = 'bad'; }, s => { s.runtime.env = { TOKEN: SECRET }; },
    s => { s.runtime.nativeConfigRoot = f.dir; }, s => { s.session_id = SECRET; },
    s => { s.policy.allowedTools = [null]; }, s => { s.policy.permissionMode = 'bypassPermissions'; },
    s => { s.created_at = 'yesterday'; }, s => { s.turn = 1.5; },
    s => { s.requests.push(structuredClone(s.requests[0])); }, s => { s.requests[0].hash = SECRET; },
    s => { s.requests[0].output.session_id = 'different'; }, s => { s.requests[0].output.turn = 2; },
    s => { s.requests[0].output.working_dir = f.dir; }, s => { s.requests[0].output.runtime.model = 'other'; },
    s => { s.last_result.turn = 0; }, s => { delete s.last_result; },
    s => { s.status = 'pending'; }, s => { s.pending = { message_hash: 'a'.repeat(64) }; },
  ];
  const b = new ClaudeBridge(f.backend, f.settings, noRuntime);
  for (const mutate of cases) {
    const bad = structuredClone(good); mutate(bad);
    const raw = JSON.stringify(bad);
    await fs.writeFile(b.store.file('integration'), raw);
    await assert.rejects(b.status('integration'), e => e.code === 'CORRUPT_STATE' && !e.message.includes(SECRET));
    await assert.rejects(b.turn(first(f.cwd)), reject('CORRUPT_STATE'));
    assert.equal(await contents(b), raw);
  }
  await fs.writeFile(b.store.file('integration'), '{"' + SECRET);
  await assert.rejects(b.status('integration'), e => !e.message.includes(SECRET) && e.code === 'CORRUPT_STATE');
});

test('initial runtime/preflight failure leaves an existing ready state byte-for-byte intact', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const before = await contents(f.bridge);
  for (const runtime of [() => { throw fail('NATIVE_ROOT', SECRET); }, () => ({ preflight: async () => { throw fail('NATIVE_AUTH', SECRET); } })]) {
    const b = new ClaudeBridge({ run: () => assert.fail('preflight must not submit') }, f.settings, runtime);
    await assert.rejects(b.turn({ conversation_id: 'integration', message: 'next' }), e => !e.message.includes(SECRET));
    assert.equal(await contents(b), before);
    await assert.rejects(b.turn(first(f.cwd, { conversation_id: 'new' })), e => !e.message.includes(SECRET));
    assert.equal((await b.status('new')).exists, false);
  }
});

test('final launch failure before callback restores ready snapshot, including new allocated session', async t => {
  const f = await unit(t);
  await f.bridge.turn(first(f.cwd));
  const before = await contents(f.bridge);
  const runtime = options => ({ async preflight(input) {
    const p = await fakeRuntime(options).preflight(input);
    return { identity: p.identity, launch: async () => { throw fail('NATIVE_DRIFT', SECRET); } };
  } });
  const b = new ClaudeBridge({ run: () => assert.fail('callback must not execute') }, f.settings, runtime);
  await assert.rejects(b.turn({ conversation_id: 'integration', message: 'next' }), reject('NATIVE_DRIFT'));
  assert.equal(await contents(b), before);
  await assert.rejects(b.turn(first(f.cwd, { conversation_id: 'new' })), reject('NATIVE_DRIFT'));
  const allocated = await b.status('new');
  assert.equal(allocated.status, 'ready'); assert.equal(allocated.turn, 0); assert.equal(allocated.pending, null);
  const retried = await f.bridge.turn(first(f.cwd, { conversation_id: 'new' }));
  assert.equal(retried.session_id, allocated.session_id);
});

test('all after-callback failures stay uncertain even when they reuse preflight error codes', async t => {
  const f = await fixture(t);
  for (const [index, run] of [
    () => { throw fail('NATIVE_DRIFT', SECRET); },
    async () => { throw fail('NATIVE_AUTH', SECRET); },
    async () => { throw Object.assign(new Error(SECRET), { code: SECRET }); },
  ].entries()) {
    const b = new ClaudeBridge({ run }, f.settings, fakeRuntime);
    const input = first(f.cwd, { conversation_id: 'after-' + index });
    await assert.rejects(b.turn(input), e => !e.message.includes(SECRET) && !e.code.includes(SECRET));
    const status = await b.status(input.conversation_id);
    assert.equal(status.status, 'uncertain'); assert.equal(status.turn, 0);
    assert.ok(!JSON.stringify(status).includes(SECRET));
    const restarted = new ClaudeBridge({ run: () => assert.fail('uncertain retry') }, f.settings, noRuntime);
    await assert.rejects(restarted.turn(input), reject('TURN_UNCERTAIN'));
  }
});

test('durable pending precedes final launch; submit synchronously enters the supervised backend', async t => {
  const f = await fixture(t);
  const events = [];
  let bridge;
  const runtime = options => ({ async preflight(input) {
    events.push('preflight');
    const prepared = await fakeRuntime(options).preflight(input);
    return { identity: prepared.identity, launch(submit) {
      events.push('final-check');
      const st = JSON.parse(syncFs.readFileSync(bridge.store.file('integration'), 'utf8'));
      assert.equal(st.status, 'pending');
      assert.equal(st.pending.request_id, 'one');
      queueMicrotask(() => events.push('microtask'));
      const result = submit(fakeLaunch(input.cwd, input.model));
      assert.ok(events.includes('spawn'), 'spawn cannot be delayed after callback entry');
      return result;
    } };
  } });
  const Backend = backendProbe(({ child }) => {
    events.push('spawn');
    child.stdin.on('data', () => {});
    child.stdin.on('finish', () => {
      const st = JSON.parse(syncFs.readFileSync(bridge.store.file('integration'), 'utf8'));
      child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: st.session_id }));
      child.emit('close', 0);
    });
  });
  bridge = new ClaudeBridge(new Backend(f.settings), f.settings, runtime);
  const save = bridge.store.save.bind(bridge.store);
  bridge.store.save = async (id, st) => { events.push('save-' + st.status); return save(id, st); };
  await bridge.turn(first(f.cwd));
  assert.deepEqual(events.slice(0, 4), ['preflight', 'save-pending', 'final-check', 'spawn']);
  assert.ok(events.indexOf('spawn') < events.indexOf('microtask'));
  assert.equal(events.at(-1), 'save-ready');
});

test('pending after a crash preserves identity, blocks new execution, but retains older cache', async t => {
  const f = await unit(t);
  const one = await f.bridge.turn(first(f.cwd));
  const st = await f.bridge.store.load('integration');
  st.status = 'pending'; st.pending = { request_id: 'two', message_hash: 'a'.repeat(64), started_at: new Date().toISOString() };
  await f.bridge.store.save('integration', st);
  const restarted = new ClaudeBridge(f.backend, f.settings, noRuntime);
  assert.equal((await restarted.turn(first(f.cwd))).replayed, true);
  await assert.rejects(restarted.turn({ conversation_id: 'integration', request_id: 'two', message: 'next' }), reject('TURN_UNCERTAIN'));
  assert.equal((await restarted.status('integration')).session_id, one.session_id);
});

test('cancellation while pending but before prepared.launch restores ready without submission', async t => {
  const f = await unit(t);
  const controller = new AbortController();
  const save = f.bridge.store.save.bind(f.bridge.store);
  f.bridge.store.save = async (id, st) => { await save(id, st); if (st.status === 'pending') controller.abort(); };
  await assert.rejects(f.bridge.turn(first(f.cwd), controller.signal), reject('CANCELLED'));
  assert.equal((await f.bridge.status('integration')).status, 'ready');
});

test('real frozen preflight detects account and executable drift without changing ready state', async () => {
  const f = await synthetic();
  try {
    const settings = { ...config(f.parentEnv), command: f.executable, configRoot: f.config, stateDir: path.join(f.root, 'bridge-state') };
    let runs = 0;
    const b = new ClaudeBridge({ run: i => { runs++; return success(i); } }, settings, o => f.api.private.createRuntime(o, f.deps));
    await b.turn(first(f.project));
    const before = await contents(b);
    const savedAccount = structuredClone(f.account);
    f.account = { ...savedAccount, email: 'different-synthetic@example.invalid' };
    await assert.rejects(b.turn({ conversation_id: 'integration', message: 'next' }), reject('NATIVE_DRIFT'));
    assert.equal(await contents(b), before);
    f.account = savedAccount;
    await fs.appendFile(f.executable, 'changed executable');
    await assert.rejects(b.turn({ conversation_id: 'integration', message: 'next' }), reject('NATIVE_DRIFT'));
    assert.equal(await contents(b), before); assert.equal(runs, 1);
  } finally { await f.close(); }
});

test('real frozen final source recheck after pending restores state before callback', async () => {
  const f = await synthetic();
  try {
    const settings = { ...config(f.parentEnv), command: f.executable, configRoot: f.config, stateDir: path.join(f.root, 'bridge-state') };
    let runs = 0;
    const b = new ClaudeBridge({ run: i => { runs++; return success(i); } }, settings, o => f.api.private.createRuntime(o, f.deps));
    await b.turn(first(f.project));
    const before = await contents(b);
    const save = b.store.save.bind(b.store);
    b.store.save = async (id, st) => {
      await save(id, st);
      if (st.status === 'pending') await f.json('project/.claude/settings.local.json', { permissions: { deny: ['Read'] } });
    };
    await assert.rejects(b.turn({ conversation_id: 'integration', message: 'next' }), reject('NATIVE_DRIFT'));
    assert.equal(await contents(b), before); assert.equal(runs, 1);
  } finally { await f.close(); }
});

test('backend uses exact immutable descriptor environment/args and stdin; no parent merge or conflicting guard', async t => {
  const f = await fixture(t);
  const launch = fakeLaunch(f.cwd, MODEL);
  let observed, stdin = '';
  const Backend = backendProbe(value => {
    observed = value;
    value.child.stdin.on('data', b => { stdin += b; });
    value.child.stdin.on('finish', () => {
      value.child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'expected', modelUsage: { 'claude-opus-5': { inputTokens: 1 } } }));
      value.child.emit('close', 0);
    });
  });
  const backend = new Backend({ command: 'IGNORED', prefixArgs: ['--settings', SECRET], timeoutMs: 5000 });
  const message = 'ONLY_STDIN ž\r\n"$ & `\n';
  const pending = backend.run({ launch, cwd: f.cwd, model: MODEL, message, sessionId: 'expected', permissionMode: 'dontAsk', allowedTools: ['Read'], resume: false });
  assert.ok(observed, 'backend must spawn synchronously');
  assert.equal(observed.options.env, launch.env);
  assert.equal(observed.options.shell, false);
  let command = observed.command, args = observed.args;
  if (process.platform === 'win32') {
    const wrapped = JSON.parse(Buffer.from(args[args.indexOf('-LaunchBase64') + 1], 'base64'));
    command = wrapped.command; args = wrapped.args;
    assert.equal(wrapped.cwd, f.cwd); assert.equal(wrapped.parentPid, process.pid);
  }
  assert.equal(command, launch.command);
  assert.deepEqual(args.slice(0, launch.args.length), launch.args);
  for (const flag of ['--settings', '--model', '--mcp-config', '--strict-mcp-config']) assert.equal(args.filter(x => x === flag).length, 1);
  assert.ok(!JSON.stringify(args).includes(message)); assert.ok(!JSON.stringify(args).includes(SECRET));
  assert.equal(Object.isFrozen(launch.env), true); assert.equal(Object.isFrozen(launch.args), true);
  assert.throws(() => { launch.env.TOKEN = SECRET; }, TypeError);
  const result = await pending;
  assert.equal(stdin, message); assert.deepEqual(result.model_evidence, ['claude-opus-5']);
  assert.throws(() => new ClaudeBackend(f.settings).run({ cwd: f.cwd }), reject('INVALID_CONFIG'));
});

test('structured model drift is rejected; absent usage and self-description are not identity evidence', () => {
  const record = { type: 'result', subtype: 'success', session_id: 'expected', result: 'I am another model' };
  assert.deepEqual(parseResult(JSON.stringify(record), 'expected', MODEL).model_evidence, []);
  assert.throws(() => parseResult(JSON.stringify({ ...record, modelUsage: { 'different-model': {} } }), 'expected', MODEL), reject('MODEL_DRIFT'));
  assert.throws(() => parseResult(JSON.stringify({ ...record, modelUsage: { 'claude-opus-5': {}, 'another': {} } }), 'expected', MODEL), reject('MODEL_DRIFT'));
  for (const raw of ['{"' + SECRET, JSON.stringify({ type: 'result', subtype: SECRET, errors: [SECRET], result: SECRET })]) {
    assert.throws(() => parseResult(raw, 'expected', MODEL), e => !e.message.includes(SECRET));
  }
});

for (const defaultRoot of [false, true]) test(`actual native two-turn MCP/backend restart/replay, guards and permissions (${defaultRoot ? 'default' : 'explicit'} profile)`, { timeout: 120000 }, async () => {
  const f = await synthetic({ native: true, defaultRoot });
  let connection;
  try {
    await f.json(path.relative(f.root, path.join(f.config, 'settings.json')), {
      model: 'opus[1m]', permissions: { deny: ['Read(./denied.txt)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cmd.exe /d /c "echo DISALLOWED_HOOK>hook-fired.txt"' }] }] },
    });
    await f.json('project/.claude/settings.json', { permissions: { allow: ['Read(./allowed.txt)'] } });
    await f.json('project/.claude/settings.local.json', { permissions: { ask: ['Read(./ask.txt)'] } });
    await f.json('project/.mcp.json', { mcpServers: { forbidden_synthetic: { command: 'not-a-real-executable' } } });
    await f.text('project/CLAUDE.md', 'INTEGRATION_PROJECT_CONTEXT');
    await f.text(path.relative(f.root, path.join(f.config, 'CLAUDE.md')), 'INTEGRATION_USER_CONTEXT');
    await f.text(path.relative(f.root, path.join(f.config, 'skills/integration-marker/SKILL.md')), '---\nname: integration-marker\ndescription: INTEGRATION_SHARED_SKILL\n---\nSynthetic skill. Do not execute.');
    for (const name of ['allowed', 'denied', 'ask']) await f.text('project/' + name + '.txt', 'INTEGRATION_' + name.toUpperCase() + '_CONTENT');
    let reads = false;
    f.base.setResponder((r, res) => {
      if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || reads) return false;
      reads = true;
      reply(res, r.body.model, ['allowed', 'denied', 'ask'].map(name => ({ type: 'tool_use', id: 'integration_' + name, name: 'Read', input: { file_path: path.join(f.project, name + '.txt') } })));
      return true;
    });
    connection = await connectNative(f, { CLAUDE_CONFIG_DIR: path.join(f.root, 'ignored-parent-root'),
      OPENAI_API_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET, AGENT_PROXY_URL: f.base.base });
    const input = first(f.project, { message: 'INTEGRATION_FIRST_TASK ž\r\nNever self-identify.' });
    const response = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.ok(!response.isError, JSON.stringify(response));
    const one = response.structuredContent;
    assert.equal(one.turn, 1); assert.equal(one.model, MODEL);
    assert.equal(one.runtime.contract, RUNTIME_CONTRACT);
    assert.equal(one.runtime.configRootMode, defaultRoot ? 'default' : 'explicit');
    assert.deepEqual(one.model_evidence, [MODEL]);
    assertWire(f, 2);
    const wire = JSON.stringify(inference(f));
    assert.ok(wire.includes('INTEGRATION_PROJECT_CONTEXT')); assert.ok(wire.includes('INTEGRATION_USER_CONTEXT'));
    assert.ok(wire.includes('integration-marker'));
    const tools = inference(f)[0].body.tools || [];
    assert.ok(!tools.some(x => x.name.startsWith('mcp__')));
    const results = inference(f).flatMap(r => r.body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(x => x.type === 'tool_result');
    assert.ok(results.some(x => x.tool_use_id === 'integration_allowed' && !x.is_error && JSON.stringify(x.content).includes('INTEGRATION_ALLOWED_CONTENT')));
    assert.ok(results.some(x => x.tool_use_id === 'integration_denied' && x.is_error));
    assert.ok(results.some(x => x.tool_use_id === 'integration_ask' && x.is_error));
    assert.ok(!wire.includes('INTEGRATION_DENIED_CONTENT')); assert.ok(!wire.includes('INTEGRATION_ASK_CONTENT'));
    await assert.rejects(fs.stat(path.join(f.project, 'hook-fired.txt')), reject('ENOENT'));
    assert.ok(!connection.diagnostics().includes(SECRET));
    await connection.close(); connection = null;
    connection = await connectNative(f, { CLAUDE_BRIDGE_MODEL: 'claude-opus-5' });
    const replay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.equal(replay.structuredContent.replayed, true); assertWire(f, 2);
    const second = await connection.client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'integration', request_id: 'two', message: 'INTEGRATION_SECOND_TASK' } });
    assert.ok(!second.isError, JSON.stringify(second));
    assert.equal(second.structuredContent.session_id, one.session_id);
    assert.equal(second.structuredContent.turn, 2); assert.equal(second.structuredContent.model, MODEL);
    assertWire(f, 3);
    assert.ok(JSON.stringify(inference(f).at(-1).body.messages).includes('INTEGRATION_FIRST_TASK'));
    const status = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'integration' } });
    assert.equal(status.structuredContent.status, 'ready'); assert.equal(status.structuredContent.version, 2);
    const state = await fs.readFile(status.structuredContent.state_file, 'utf8');
    for (const value of [SECRET, SENTINEL, EMAIL]) {
      assert.ok(!state.includes(value)); assert.ok(!JSON.stringify(status).includes(value)); assert.ok(!connection.diagnostics().includes(value));
    }
    assert.ok(!state.includes('refreshToken')); assert.ok(!state.includes('accessToken'));
    await connection.close(); connection = null;
    // Replay after real synthetic login removal and an unusable executable proves
    // the public MCP path does not accidentally preflight cached requests/status.
    await fs.rm(path.join(f.config, '.credentials.json'));
    connection = await connectNative(f, { CLAUDE_BRIDGE_COMMAND: path.join(f.root, 'missing.exe'), CLAUDE_BRIDGE_MODEL: 'invalid-default' });
    const offlineReplay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.equal(offlineReplay.structuredContent.replayed, true); assertWire(f, 3);
    assert.equal((await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'integration' } })).structuredContent.turn, 2);
  } finally { if (connection) await connection.close(); await f.close(); }
});
