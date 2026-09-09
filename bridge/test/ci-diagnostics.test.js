'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { diagnostic, failure, failureDiagnostic, emit, lines } = require('./ci-diagnostics');
const { checkCompatibility } = require('./ci-native-compatibility');
const { main: prerequisite } = require('./ci-native-prerequisite');
const { observations, inspectSources, main: probe } = require('./ci-supervisor-probe');
const SECRET = 'SYNTHETIC_DIAGNOSTIC_SECRET_C:/private/token/account/task';
const VERSION = '2.1.263';
const FLAGS = ['--print', '--model'];
const result = stdout => ({ code: 0, stdout, stderr: SECRET, timedOut: false, oversized: false });
const success = args => Promise.resolve(result(args[0] === '--version' ? `${VERSION} (Claude Code)` : FLAGS.join(' ')));
function safe(value) {
  const output = JSON.stringify(value);
  assert.ok(!output.includes(SECRET));
  assert.ok(output.length < 1024);
  return output;
}

test('CI diagnostic allowlist rejects raw text, unbounded numbers, getters and forged errors', () => {
  const data = { stage: SECRET, code: SECRET, elapsedMs: Infinity, exit: SECRET,
    timedOut: SECRET, oversized: 1, childStarted: 'false', ready: null,
    stdout: SECRET, stderr: SECRET, message: SECRET, stack: SECRET, argv: [SECRET], env: { SECRET } };
  assert.deepEqual(diagnostic(SECRET, data), { stage: 'unknown' });
  for (const bad of [-1, NaN, Infinity, 300001, SECRET]) assert.ok(!('elapsedMs' in diagnostic('fixture', { elapsedMs: bad })));
  for (const bad of [-2147483649, 4294967296, 0.5, NaN, SECRET]) assert.ok(!('exit' in diagnostic('fixture', { exit: bad })));
  assert.deepEqual(diagnostic('native-version', { elapsedMs: 1.6, exit: 0, code: 'OK', ready: true }),
    { stage: 'native-version', elapsedMs: 2, exit: 0, code: 'OK', ready: true });
  const getters = Object.defineProperties({}, Object.fromEntries(['stage', 'elapsedMs', 'exit', 'code', 'ready', 'timedOut', 'oversized', 'childStarted'].map(key => [key, { get() { throw new Error(SECRET); } }])));
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); } });
  for (const error of [new Error(SECRET), { diagnostic: data, code: SECRET }, getters, proxy, null, SECRET]) {
    assert.deepEqual(failureDiagnostic(error), { stage: 'unknown', code: 'UNKNOWN' });
    const records = [];
    emit(error, line => records.push(line));
    safe(records);
  }
});

test('native compatibility emits two bounded successful stages and checks every invocation', async () => {
  const calls = [], records = [];
  const env = Object.freeze({ ONLY_SYNTHETIC: SECRET });
  const launch = async (args, options) => {
    calls.push(args);
    assert.equal(options.input, '');
    assert.equal(options.env, env);
    return { ...await success(args), childStarted: true };
  };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await checkCompatibility(launch, { env, input: SECRET }, VERSION, FLAGS, d => records.push(d)),
      { version: VERSION, flags: FLAGS });
  }
  assert.deepEqual(calls, [['--version'], ['--help'], ['--version'], ['--help']]);
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.code, 'OK');
    assert.equal(record.ready, true);
    assert.equal(record.childStarted, true);
    assert.ok(record.elapsedMs >= 0);
    safe(record);
  }
});

test('native compatibility classifies each failed stage without leaking child output', async () => {
  const cases = [
    ['TIMEOUT', { timedOut: true }], ['OUTPUT_LIMIT', { oversized: true }],
    ['EXIT_NONZERO', { code: 13 }], ['INVALID_RESULT', { code: null }],
    ['INVALID_RESULT', { stdout: null }],
  ];
  for (const stage of ['version', 'help']) {
    for (const [code, patch] of [...cases, [stage === 'version' ? 'VERSION_MISMATCH' : 'FLAGS_MISSING', { stdout: SECRET }]]) {
      let calls = 0;
      const records = [];
      const launch = async args => {
        calls++;
        return args[0] === `--${stage}` ? { ...result(SECRET), ...patch } : success(args);
      };
      await assert.rejects(checkCompatibility(launch, {}, VERSION, FLAGS, d => records.push(d)), error => {
        assert.equal(error.code, 'NATIVE_CONTRACT_INCOMPATIBLE');
        assert.equal(error.message, `Native CLI compatibility prerequisite failed (${stage === 'help' ? 'flags' : stage}); no task launched.`);
        const data = failureDiagnostic(error);
        assert.equal(data.stage, `native-${stage}`);
        assert.equal(data.code, code);
        assert.ok(!('ready' in data));
        assert.ok(!('childStarted' in data)); // not observed, not false
        assert.ok(data.elapsedMs >= 0);
        safe({ message: error.message, diagnostic: data });
        return true;
      });
      assert.equal(calls, stage === 'version' ? 1 : 2);
      assert.equal(records.length, stage === 'version' ? 0 : 1);
    }
  }
});

test('spawn errors and unexpected objects retain generic-safe behavior', async () => {
  for (const error of [Object.assign(new Error(SECRET), { code: SECRET, stdout: SECRET, diagnostic: { stage: SECRET } }),
    new Proxy({}, { get() { throw new Error(SECRET); }, getOwnPropertyDescriptor() { throw new Error(SECRET); } }), SECRET, null]) {
    await assert.rejects(checkCompatibility(async () => { throw error; }, {}, VERSION, FLAGS), error => {
      const record = failureDiagnostic(error);
      assert.equal(record.code, 'SPAWN_FAILED');
      assert.ok(!('childStarted' in record));
      safe(record);
      return true;
    });
  }
  await assert.rejects(checkCompatibility(async () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); } }), {}, VERSION, FLAGS), error => {
    assert.equal(failureDiagnostic(error).code, 'INVALID_RESULT');
    safe(failureDiagnostic(error));
    return true;
  });
});

test('CI prerequisite preserves failure exit, successful observations and cleanup failures', async () => {
  for (const failVerify of [false, true]) {
    const records = [];
    let closed = 0, tasks = 0;
    const code = await prerequisite(async () => ({
      verifyCompatibility: observe => checkCompatibility(failVerify ? async () => result(SECRET) : success, {}, VERSION, FLAGS, observe),
      close: async () => { closed++; }, run: () => { tasks++; },
    }), value => records.push(value));
    assert.equal(code, failVerify ? 1 : 0);
    assert.equal(closed, 1);
    assert.equal(tasks, 0);
    assert.equal(records.length, failVerify ? 1 : 2);
    records.forEach(safe);
  }
  const records = [];
  assert.equal(await prerequisite(async () => { throw new Error(SECRET); }, value => records.push(value)), 1);
  assert.deepEqual(records.pop(), { stage: 'unknown', code: 'UNKNOWN' });
  assert.equal(await prerequisite(async () => ({ verifyCompatibility: async () => {}, close: async () => { throw new Error(SECRET); } }), value => records.push(value)), 1);
  assert.deepEqual(records.pop(), { stage: 'cleanup', code: 'UNKNOWN' });
  const verifiedFailure = failure('safe', 'NATIVE_CONTRACT_INCOMPATIBLE', 'native-help', { code: 'TIMEOUT', timedOut: true });
  assert.equal(await prerequisite(async () => ({ verifyCompatibility: async () => { throw verifiedFailure; }, close: async () => { throw new Error(SECRET); } }), value => records.push(value)), 1);
  assert.deepEqual(records.map(record => record.stage), ['native-help', 'cleanup']);
  records.forEach(safe);
});

test('bounded line observer handles fragments and discards oversized synthetic text', () => {
  const received = [];
  const observe = lines(line => received.push(line));
  observe(Buffer.from('a\r')); observe(Buffer.from('\nb\nc'));
  observe(Buffer.from('d\n' + SECRET.repeat(20))); observe(Buffer.from('\nend\n'));
  assert.deepEqual(received, ['a', 'b', 'cd', 'end']);
});

test('line discard notification is immediate, once per overlong line, and contains no raw text', () => {
  for (const chunks of [[SECRET.repeat(1000)], ['x'.repeat(256), 'x'], ['x'.repeat(128), 'x'.repeat(129)]]) {
    const received = [], discarded = [];
    const observe = lines(line => received.push(line), 256, (...args) => discarded.push(args));
    for (const chunk of chunks) observe(Buffer.from(chunk));
    assert.deepEqual(discarded, [[]]); // No newline or raw discarded argument needed.
    assert.equal(observe.atBoundary(), false);
    observe(Buffer.from('ci-probe:child-io\nend\n'));
    assert.deepEqual(received, ['end']); // A suffix of the discarded line is not a marker.
    assert.deepEqual(discarded, [[]]);
    assert.equal(observe.atBoundary(), true);
    observe(Buffer.from('x'.repeat(257) + '\n'));
    assert.deepEqual(discarded, [[], []]);
  }
});

test('bounded line observer preserves newline-inclusive limits and exposes partial input without emitting it', () => {
  for (const ending of ['\n', '\r\n']) for (const length of [255, 256, 257]) {
    const received = [], discarded = [];
    const observe = lines(line => received.push(line), 256, (...args) => discarded.push(args));
    const text = 'x'.repeat(length - ending.length) + ending;
    for (const character of text) observe(Buffer.from(character));
    assert.deepEqual(received, length <= 256 ? ['x'.repeat(length - ending.length)] : []);
    assert.deepEqual(discarded, length <= 256 ? [] : [[]]);
    assert.equal(observe.atBoundary(), true);
    observe(Buffer.from('part'));
    assert.equal(observe.atBoundary(), false);
    assert.equal(received.length, length <= 256 ? 1 : 0); // EOF is not an implicit newline.
    observe(Buffer.from('ial\n'));
    assert.equal(received.at(-1), 'partial');
    assert.equal(observe.atBoundary(), true);
  }
  const received = [], discarded = [];
  const observe = lines(line => received.push(line), 4, (...args) => discarded.push(args));
  observe(Buffer.from('abc\nabcd\nend\n'));
  assert.deepEqual(received, ['abc', 'end']);
  assert.deepEqual(discarded, [[]]);
});

test('probe stdout cannot regain success after single or chunked discarded lines before or after valid IO', () => {
  const phases = 'ci-probe:ps-start\nci-probe:add-type-start\nci-probe:add-type-complete\nclaude-bridge-child-pid:1234\n';
  const marker = 'ci-probe:child-io\n';
  for (const length of [254, 255, 256, 257, 300, 4096]) {
    for (const ending of ['\n', '\r\n']) for (const chunked of [false, true]) for (const markerFirst of [false, true]) {
      const records = [], observed = observations(d => records.push(d), () => 0);
      // IO and supervisor stderr may arrive in either cross-pipe order.
      if (markerFirst) observed.stdout(Buffer.from(marker));
      else observed.stderr(Buffer.from(phases));
      const text = 'x'.repeat(length) + ending;
      const chunks = chunked ? [text.slice(0, 128), text.slice(128, 256), text.slice(256)] : [text];
      for (const chunk of chunks) observed.stdout(Buffer.from(chunk));
      if (markerFirst) observed.stderr(Buffer.from(phases));
      else observed.stdout(Buffer.from(marker));
      assert.equal(observed.complete(), false, `length=${length}, ending=${ending.length}, chunked=${chunked}, markerFirst=${markerFirst}`);
      records.forEach(safe);
    }
  }
});

test('probe rejects trailing partial stdout at EOF even after all valid markers, without requiring a newline', () => {
  for (const trailing of ['x', '\r', 'ci-probe:child-io', 'x'.repeat(256), 'x'.repeat(257), SECRET.repeat(20)]) {
    for (const chunked of [false, true]) {
      const records = [], observed = observations(d => records.push(d), () => 0);
      observed.stderr(Buffer.from('ci-probe:ps-start\nci-probe:add-type-start\nci-probe:add-type-complete\nclaude-bridge-child-pid:1234\n'));
      observed.stdout(Buffer.from('ci-probe:child-io\n'));
      assert.equal(observed.complete(), true);
      for (const chunk of chunked ? [...trailing] : [trailing]) observed.stdout(Buffer.from(chunk));
      assert.equal(observed.complete(), false);
      records.forEach(safe);
    }
  }
});

test('probe still accepts fragmented normal stdout and ignores non-marker stderr, including discarded and partial text', () => {
  const records = [], observed = observations(d => records.push(d), () => 0);
  observed.stderr(Buffer.from(SECRET.repeat(20)));
  observed.stderr(Buffer.from('\nci-probe:ps-start\nci-probe:add-type-start\nci-probe:add-type-complete\nclaude-bridge-ch'));
  observed.stderr(Buffer.from('ild-pid:1234\r'));
  observed.stderr(Buffer.from('\n' + SECRET.repeat(20) + '\n' + SECRET));
  observed.stdout(Buffer.from('ci-probe:child-'));
  assert.equal(observed.complete(), false);
  assert.deepEqual(observed.state(), { childStarted: true });
  observed.stdout(Buffer.from('io\r'));
  assert.equal(observed.complete(), false);
  observed.stdout(Buffer.from('\n'));
  assert.equal(observed.complete(), true);
  assert.deepEqual(observed.state(), { childStarted: true, ready: true });
  assert.equal(records.length, 5);
  records.forEach(safe);
});

test('supervisor observations distinguish Add-Type, child start and actual IO without emitting PID or text', () => {
  const records = [];
  const observed = observations(d => records.push(d), () => 12);
  observed.stderr(Buffer.from(SECRET + '\nci-probe:ps-start\nci-probe:add-type-st'));
  assert.deepEqual(observed.state(), {});
  observed.stderr(Buffer.from('art\nci-probe:add-type-complete\n'));
  assert.deepEqual(observed.state(), {});
  // Separate-pipe delivery can put child stdout before supervisor stderr.
  observed.stdout(Buffer.from('ci-probe:child-io\n'));
  assert.deepEqual(observed.state(), { childStarted: true, ready: true });
  observed.stderr(Buffer.from('claude-bridge-child-pid:1234\n'));
  assert.equal(observed.complete(), true);
  assert.equal(records.length, 5);
  records.forEach(record => assert.ok(!safe(record).includes('1234')));
  for (const record of records.slice(0, 3)) assert.ok(!('childStarted' in record) && !('ready' in record));
});

test('missing, duplicate and unordered probe markers fail closed; readiness stays unavailable until observed', () => {
  for (const text of [SECRET, 'ci-probe:add-type-complete\n', 'ci-probe:ps-start\nci-probe:ps-start\n']) {
    const records = [];
    const observed = observations(d => records.push(d), () => 0);
    observed.stderr(Buffer.from(text));
    assert.equal(observed.complete(), false);
    assert.deepEqual(observed.state(), {});
    records.forEach(safe);
  }
});

test('test-only probe requires inspected unchanged supervisor source and explicit shell selection', async () => {
  assert.equal(await inspectSources(), true);
  const records = [];
  assert.equal(await probe([], value => records.push(value)), 1);
  assert.deepEqual(records, [{ stage: 'probe-setup', code: 'INVALID_RESULT' }]);
  const wrapper = await fs.readFile(path.join(__dirname, 'ci-supervisor-probe.ps1'), 'utf8');
  assert.ok(wrapper.includes('Set-PSBreakpoint -Script $Supervisor -Line 5'));
  assert.ok(wrapper.includes('Set-PSBreakpoint -Script $Supervisor -Line 6'));
  assert.ok(wrapper.includes('& $Supervisor -LaunchBase64 $LaunchBase64'));
});

test('native fixture constructs config, project and environment from its canonical owned root without launching CLI', async () => {
  const f = await require('./native-contract-fixture').fixture();
  try {
    assert.equal(f.root, await fs.realpath(f.root));
    assert.equal(f.config, path.join(f.root, 'config'));
    assert.equal(f.project, path.join(f.root, 'project'));
    assert.equal(f.env.HOME, f.root);
    assert.equal(f.env.USERPROFILE, f.root);
    assert.equal(f.env.CLAUDE_CONFIG_DIR, f.config);
    assert.equal(f.env.HTTP_PROXY, f.base);
    assert.equal(f.env.HTTPS_PROXY, f.base);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('CI wiring keeps explicit suite splits, fail-closed native prerequisite and post-suite probes', async () => {
  const { scripts } = JSON.parse(await fs.readFile(path.join(__dirname, '../package.json'), 'utf8'));
  for (const name of ['test', 'test:unit', 'test:ci-diagnostics']) {
    assert.ok(scripts[name].split(' ').includes('test/ci-diagnostics.test.js'));
    assert.ok(!scripts[name].includes('*'));
  }
  for (const name of ['test:native', 'test:installer']) assert.ok(!scripts[name].includes('ci-diagnostics.test.js'));
  const workflow = await fs.readFile(path.join(__dirname, '../../.github/workflows/test.yml'), 'utf8');
  assert.match(workflow, /node test\/ci-native-prerequisite\.js\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  const native = workflow.slice(workflow.indexOf('  native-contract:'));
  assert.ok(native.indexOf('node $helper --output $out') < native.indexOf('node test/ci-native-prerequisite.js'));
  assert.ok(native.indexOf('node test/ci-native-prerequisite.js') < native.indexOf('run: npm.cmd run test:native'));
  assert.ok(native.indexOf('run: npm.cmd run test:native') < native.indexOf('node test/ci-supervisor-probe.js'));
  assert.ok(workflow.includes('github.event.pull_request.base.sha || github.sha'));
  assert.ok(workflow.includes('sparse-checkout: bridge/ci'));
});
