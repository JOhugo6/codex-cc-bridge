'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { diagnostic, failure, failureDiagnostic, emit, lines } = require('./ci-diagnostics');
const { checkCompatibility } = require('./ci-native-compatibility');
const { main: prerequisite } = require('./ci-native-prerequisite');
const { observations, inspectSources, sample, runSamples, parseArgs, main: probe } = require('./ci-supervisor-probe');
const { EventEmitter } = require('node:events');
const { isDeepStrictEqual } = require('node:util');
const SECRET = 'SYNTHETIC_DIAGNOSTIC_SECRET_C:/private/token/account/task';
const VERSION = '2.1.263';
const FLAGS = ['--print', '--model'];
const result = stdout => ({ code: 0, stdout, stderr: SECRET, timedOut: false, oversized: false });
const success = args => Promise.resolve(result(args[0] === '--version' ? '2.1.264 (Claude Code)' : FLAGS.join(' ')));
function safe(value) {
  const output = JSON.stringify(value);
  assert.ok(!output.includes(SECRET));
  assert.ok(output.length < 1024);
  return output;
}

function phaseNames(mode) {
  if (mode === 'direct') return ['child-start'];
  if (mode === 'json') return ['module-ps-start', 'json-start', 'json-complete'];
  if (mode === 'import-json') return ['module-ps-start', 'module-import-start', 'module-import-complete', 'json-start', 'json-complete'];
  return ['ps-start', 'breakpoint-6-set', 'breakpoint-7-set', 'supervisor-call', 'add-type-start', 'add-type-complete', 'child-start'];
}
function stderrPhases(phases) {
  return phases.map(stage => stage === 'child-start' ? 'claude-bridge-child-pid:1234\n' : `ci-probe:${stage}\n`).join('');
}
function outputMarker(mode) {
  return ['direct', 'supervisor'].includes(mode) ? 'ci-probe:child-io\n' : 'ci-probe:module-control-complete\n';
}
function fakeSpawn(run, calls = []) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    let closed = false;
    child.finish = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { child.finish(null); return true; };
    child.stdin.end = input => { queueMicrotask(() => run(child, input)); };
    calls.push({ command, args, options });
    return child;
  };
}

test('optional prefix tracking retains only loss state and preserves default line callbacks', () => {
  for (const prefix of ['ci-probe:', 'claude-bridge-child-pid:']) {
    for (const length of [prefix.length, 255, 256, 257, 4096]) for (const ending of ['', '\n', '\r\n']) for (const chunked of [false, true]) {
      const received = [], discarded = [], legacyReceived = [], legacyDiscarded = [];
      const observe = lines(line => received.push(line), 256, (...args) => discarded.push(args), [prefix]);
      const legacy = lines(line => legacyReceived.push(line), 256, (...args) => legacyDiscarded.push(args));
      const text = prefix + 'x'.repeat(length - prefix.length) + ending;
      for (const chunk of chunked ? [...text] : [text]) {
        observe(Buffer.from(chunk)); legacy(Buffer.from(chunk));
      }
      const oversized = text.length > 256;
      assert.deepEqual(received, ending && !oversized ? [text.slice(0, -ending.length)] : []);
      assert.deepEqual(discarded, oversized ? [[]] : []);
      assert.deepEqual(legacyReceived, received);
      assert.deepEqual(legacyDiscarded, discarded);
      assert.equal(observe.atBoundary(), Boolean(ending));
      assert.equal(legacy.atBoundary(), observe.atBoundary());
      assert.equal(legacy.hasLostPrefix(), false);
      assert.equal(observe.hasLostPrefix(), !ending || oversized);
      if (oversized) {
        observe(Buffer.from('\nend\n'));
        assert.equal(received.at(-1), 'end');
        assert.equal(observe.hasLostPrefix(), true);
        assert.deepEqual(discarded, [[]]);
      }
    }
    const prefixes = [prefix], observe = lines(() => {}, 256, undefined, prefixes);
    prefixes[0] = 'other:'; // The observer owns its validated prefix snapshot.
    observe(Buffer.from(prefix.slice(0, -1)));
    assert.equal(observe.hasLostPrefix(), false); // Not yet an identified reserved prefix.
    observe(Buffer.from(prefix.slice(-1)));
    assert.equal(observe.hasLostPrefix(), true);
    observe(Buffer.from('complete\n'));
    assert.equal(observe.hasLostPrefix(), false);
  }
  for (const prefixes of [null, 'ci-probe:', [null], [''], ['x'.repeat(257)]]) {
    assert.throws(() => lines(() => {}, 256, undefined, prefixes), /Invalid line prefixes/);
  }
});

test('reserved stderr faults survive discard, EOF and later valid phases in every probe mode', () => {
  for (const mode of ['direct', 'supervisor', 'json', 'import-json']) for (const prefix of ['ci-probe:', 'claude-bridge-child-pid:']) {
    const texts = [prefix, prefix + SECRET, ...[255, 256, 257, 300].map(length => prefix + 'x'.repeat(length - prefix.length))];
    for (const text of texts) for (const ending of ['', '\n', '\r\n']) for (const chunked of [false, true]) for (const validFirst of [false, true]) {
      const records = [], observed = observations(d => records.push(d), () => 0, mode);
      const valid = () => {
        observed.stderr(Buffer.from(stderrPhases(phaseNames(mode))));
        observed.stdout(Buffer.from(outputMarker(mode)));
      };
      if (validFirst) { valid(); assert.equal(observed.complete(), true); }
      const data = text + ending;
      for (const chunk of chunked ? [...data] : [data]) observed.stderr(Buffer.from(chunk));
      if (!validFirst) {
        if (!ending) observed.stderr(Buffer.from('\n'));
        valid();
      }
      assert.equal(observed.complete(), false, `${mode}, prefix=${prefix}, length=${text.length}, ending=${ending.length}, chunked=${chunked}, validFirst=${validFirst}`);
      // Failure is not merely a missing phase: all expected observations arrived.
      assert.equal(records.length, phaseNames(mode).length + 1);
      if (!['direct', 'supervisor'].includes(mode)) assert.deepEqual(observed.state(), {});
      records.forEach(safe);
    }
  }
});

test('zero-exit mocked samples reject reserved partial and discarded stderr rather than report OK', async () => {
  for (const mode of ['direct', 'supervisor', 'json', 'import-json']) for (const prefix of ['ci-probe:', 'claude-bridge-child-pid:']) {
    for (const text of [prefix, prefix + '1234', prefix + SECRET, prefix + SECRET + '\n', prefix + SECRET + '\r',
      prefix + 'x'.repeat(300), prefix + 'x'.repeat(300) + '\n']) for (const chunked of [false, true]) {
      const records = [], calls = [];
      const passed = await sample('mock-shell', path.resolve('synthetic-protocol-root'), d => records.push(d), mode,
        fakeSpawn(child => {
          child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames(mode))));
          child.stdout.emit('data', Buffer.from(outputMarker(mode)));
          for (const chunk of chunked ? [...text] : [text]) child.stderr.emit('data', Buffer.from(chunk));
          child.finish(0);
        }, calls));
      assert.equal(calls.length, 1);
      assert.equal(passed, false);
      assert.equal(records.at(-1).code, 'PROBE_PROTOCOL');
      assert.equal(records.at(-1).exit, 0);
      assert.equal(records.at(-1).timedOut, false);
      assert.equal(records.at(-1).oversized, false);
      if (!['direct', 'supervisor'].includes(mode)) for (const record of records) assert.ok(!('ready' in record) && !('childStarted' in record));
      records.forEach(safe);
    }
  }
});

test('mocked samples still tolerate long and partial nonreserved stderr with embedded protocol text', async () => {
  for (const mode of ['direct', 'supervisor', 'json', 'import-json']) for (const prefix of ['ci-probe:', 'claude-bridge-child-pid:']) {
    for (const noise of [SECRET, SECRET.repeat(20), 'noise ' + prefix + SECRET, 'x'.repeat(300) + prefix + SECRET]) {
      const records = [];
      const passed = await sample('mock-shell', path.resolve('synthetic-protocol-root'), d => records.push(d), mode,
        fakeSpawn(child => {
          for (const character of noise + '\r\n' + stderrPhases(phaseNames(mode)) + noise) {
            child.stderr.emit('data', Buffer.from(character));
          }
          for (const character of outputMarker(mode)) child.stdout.emit('data', Buffer.from(character));
          child.finish(0);
        }));
      assert.equal(passed, true);
      assert.equal(records.at(-1).code, 'OK');
      assert.equal(records.at(-1).exit, 0);
      if (!['direct', 'supervisor'].includes(mode)) for (const record of records) assert.ok(!('ready' in record) && !('childStarted' in record));
      records.forEach(safe);
    }
  }
});

test('mocked aggregate preserves reserved stderr failures in all four or ten selected positions', async () => {
  for (const legacyDiagnostics of [false, true]) {
    const count = legacyDiagnostics ? 10 : 4;
    for (const prefix of ['ci-probe:', 'claude-bridge-child-pid:']) for (const ending of ['', '\n']) for (let failed = -1; failed < count; failed++) {
      const records = [];
      let calls = 0;
      const passed = await runSamples('mock-ps5', 'mock-ps7', path.resolve('synthetic-protocol-root'), d => records.push(d),
        (shell, root, write, mode) => {
          const bad = calls++ === failed;
          return sample(shell, root, write, mode, fakeSpawn(child => {
            const invalid = () => child.stderr.emit('data', Buffer.from(prefix + 'x'.repeat(300) + ending));
            if (bad && ending) invalid(); // Discarded fault precedes all valid phases.
            child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames(mode))));
            child.stdout.emit('data', Buffer.from(outputMarker(mode)));
            if (bad && !ending) invalid(); // Reserved partial line remains at EOF.
            child.finish(0);
          }));
        }, legacyDiagnostics);
      assert.equal(calls, count);
      assert.equal(passed, failed === -1);
      const closed = records.filter(record => record.stage === 'probe-close');
      assert.deepEqual(closed.map(record => record.code), Array.from({ length: count }, (_, i) => i === failed ? 'PROBE_PROTOCOL' : 'OK'));
      assert.ok(closed.every(record => record.exit === 0 && !record.timedOut && !record.oversized));
      records.forEach(safe);
    }
  }
});

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
      { version: '2.1.264', flags: FLAGS });
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
  const marker = 'ci-probe:child-io\n';
  for (const mode of ['direct', 'supervisor']) for (const length of [254, 255, 256, 257, 300, 4096]) {
    const phases = stderrPhases(phaseNames(mode));
    for (const ending of ['\n', '\r\n']) for (const chunked of [false, true]) for (const markerFirst of [false, true]) {
      const records = [], observed = observations(d => records.push(d), () => 0, mode);
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
  for (const mode of ['direct', 'supervisor']) for (const trailing of ['x', '\r', 'ci-probe:child-io', 'x'.repeat(256), 'x'.repeat(257), SECRET.repeat(20)]) {
    for (const chunked of [false, true]) {
      const records = [], observed = observations(d => records.push(d), () => 0, mode);
      observed.stderr(Buffer.from(stderrPhases(phaseNames(mode))));
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
  observed.stderr(Buffer.from('\nci-probe:ps-start\nci-probe:breakpoint-6-set\nci-probe:breakpoint-7-set\nci-probe:supervisor-call\nci-probe:add-type-start\nci-probe:add-type-complete\nclaude-bridge-ch'));
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
  assert.equal(records.length, 8);
  records.forEach(safe);
});

test('supervisor observations distinguish Add-Type, child start and actual IO without emitting PID or text', () => {
  const records = [];
  const observed = observations(d => records.push(d), () => 12);
  observed.stderr(Buffer.from(SECRET + '\nci-probe:ps-start\nci-probe:breakpoint-6-set\nci-probe:breakpoint-7-set\nci-probe:supervisor-call\nci-probe:add-type-st'));
  assert.deepEqual(observed.state(), {});
  observed.stderr(Buffer.from('art\nci-probe:add-type-complete\n'));
  assert.deepEqual(observed.state(), {});
  // Separate-pipe delivery can put child stdout before supervisor stderr.
  observed.stdout(Buffer.from('ci-probe:child-io\n'));
  assert.deepEqual(observed.state(), { childStarted: true, ready: true });
  observed.stderr(Buffer.from('claude-bridge-child-pid:1234\n'));
  assert.equal(observed.complete(), true);
  assert.equal(records.length, 8);
  records.forEach(record => assert.ok(!safe(record).includes('1234')));
  for (const record of records.slice(0, 6)) assert.ok(!('childStarted' in record) && !('ready' in record));
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
  assert.ok(wrapper.includes('Set-PSBreakpoint -Script $Supervisor -Line 6'));
  assert.ok(wrapper.includes('Set-PSBreakpoint -Script $Supervisor -Line 7'));
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

test('every supervisor and module phase is required exactly once in stderr order', () => {
  for (const mode of ['direct', 'supervisor', 'json', 'import-json']) {
    const phases = phaseNames(mode);
    const variants = [phases, ...phases.map((_, i) => phases.filter((_, j) => i !== j)),
      ...phases.map((_, i) => [...phases.slice(0, i), phases[i], ...phases.slice(i)]), ...(phases.length > 1 ? [[...phases].reverse()] : [])];
    for (const [index, variant] of variants.entries()) {
      const records = [], observed = observations(d => records.push(d), () => 0, mode);
      // Cross-pipe ordering is deliberately unconstrained.
      observed.stdout(Buffer.from(outputMarker(mode)));
      observed.stderr(Buffer.from(stderrPhases(variant)));
      assert.equal(observed.complete(), index === 0, `${mode} variant ${index}`);
      if (!['direct', 'supervisor'].includes(mode)) {
        assert.deepEqual(observed.state(), {});
        for (const record of records) assert.ok(!('ready' in record) && !('childStarted' in record));
      }
      records.forEach(safe);
    }
  }
  assert.throws(() => observations(() => {}, () => 0, SECRET), /Invalid probe mode/);
});

test('module controls accept fragmented markers and stderr noise without implying readiness', () => {
  for (const mode of ['json', 'import-json']) {
    const records = [], observed = observations(d => records.push(d), () => 5, mode);
    observed.stderr(Buffer.from(SECRET.repeat(20) + '\n'));
    for (const character of stderrPhases(phaseNames(mode))) observed.stderr(Buffer.from(character));
    observed.stderr(Buffer.from(SECRET.repeat(20) + '\n' + SECRET));
    assert.equal(observed.complete(), false);
    for (const character of outputMarker(mode)) observed.stdout(Buffer.from(character));
    assert.equal(observed.complete(), true);
    assert.deepEqual(observed.state(), {});
    assert.equal(records.at(-1).stage, 'module-control-complete');
    for (const record of records) { safe(record); assert.ok(!('ready' in record) && !('childStarted' in record)); }
  }
});

test('module controls reject malformed, discarded, duplicated and incomplete stdout', () => {
  for (const mode of ['json', 'import-json']) {
    const marker = outputMarker(mode);
    const invalid = ['', 'ci-probe:child-io\n', marker + marker, 'garbage\n' + marker,
      'x'.repeat(300) + '\n' + marker, marker + 'x'.repeat(300) + '\n', marker + 'x', marker + '\r', marker.slice(0, -1)];
    for (const text of invalid) for (const chunked of [false, true]) {
      const records = [], observed = observations(d => records.push(d), () => 0, mode);
      observed.stderr(Buffer.from(stderrPhases(phaseNames(mode))));
      for (const chunk of chunked ? [...text] : [text]) observed.stdout(Buffer.from(chunk));
      assert.equal(observed.complete(), false);
      assert.deepEqual(observed.state(), {});
      records.forEach(safe);
    }
    for (const unexpected of ['ci-probe:ps-start\n', 'ci-probe:' + SECRET + '\n', 'claude-bridge-child-pid:1234\n']) {
      const observed = observations(() => {}, () => 0, mode);
      observed.stderr(Buffer.from(stderrPhases(phaseNames(mode)) + unexpected));
      observed.stdout(Buffer.from(marker));
      assert.equal(observed.complete(), false);
      assert.deepEqual(observed.state(), {});
    }
  }
});

test('mocked sample checks child exits and protocol instead of treating module output as readiness', async () => {
  for (const mode of ['direct', 'supervisor', 'json', 'import-json']) for (const expected of ['OK', 'EXIT_NONZERO', 'PROBE_PROTOCOL', 'SPAWN_FAILED', 'OUTPUT_LIMIT']) {
    const records = [], calls = [];
    const passed = await sample('mock-shell', path.resolve('synthetic-module-control'), d => records.push(d), mode,
      fakeSpawn((child, input) => {
        assert.equal(input, ['direct', 'supervisor'].includes(mode) ? 'CI_PROBE_INPUT\n' : '');
        if (expected === 'SPAWN_FAILED') { child.emit('error', new Error(SECRET)); child.finish(null); return; }
        child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames(mode))));
        child.stdout.emit('data', Buffer.from(expected === 'OUTPUT_LIMIT' ? 'x'.repeat(65537)
          : expected === 'PROBE_PROTOCOL' ? outputMarker(mode) + 'trailing' : outputMarker(mode)));
        child.finish(expected === 'EXIT_NONZERO' ? 7 : 0);
      }, calls));
    assert.equal(calls.length, 1);
    assert.equal(passed, expected === 'OK');
    assert.equal(records.at(-1).code, expected);
    if (expected === 'EXIT_NONZERO') assert.equal(records.at(-1).exit, 7);
    if (expected === 'OK') assert.equal(records.at(-1).exit, 0);
    if (!['direct', 'supervisor'].includes(mode)) for (const record of records) assert.ok(!('childStarted' in record) && !('ready' in record));
    records.forEach(safe);
  }
});

test('mocked samples in every mode retain a finite 60-second cold-start bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const mode of ['direct', 'supervisor', 'json', 'import-json']) {
      const records = [];
      let settled = false, kills = 0;
      const pending = sample('mock-shell', path.resolve('synthetic-module-control'), d => records.push(d), mode,
        fakeSpawn(child => {
          const kill = child.kill;
          child.kill = () => { kills++; return kill(); };
        })).then(value => { settled = true; return value; });
      await Promise.resolve();
      t.mock.timers.tick(59999);
      assert.equal(settled, false);
      assert.equal(kills, 0);
      assert.equal(records.length, 0);
      t.mock.timers.tick(1);
      assert.equal(await pending, false);
      assert.equal(kills, 1);
      assert.equal(records.at(-1).code, 'TIMEOUT');
      assert.equal(records.at(-1).timedOut, true);
      assert.ok(!('ready' in records.at(-1)) && !('childStarted' in records.at(-1)));
    }
  } finally { t.mock.timers.reset(); }
});

test('cold samples can complete after 15 seconds without retries or relaxing their protocol', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const mode of ['direct', 'supervisor', 'json', 'import-json']) {
      const records = [], calls = [];
      let child;
      const pending = sample('mock-shell', path.resolve('synthetic-cold-start'), d => records.push(d), mode,
        fakeSpawn(value => { child = value; }, calls));
      await Promise.resolve();
      t.mock.timers.tick(45000);
      assert.equal(records.length, 0);
      child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames(mode))));
      child.stdout.emit('data', Buffer.from(outputMarker(mode)));
      child.finish(0);
      assert.equal(await pending, true);
      assert.equal(calls.length, 1);
      assert.equal(records.at(-1).code, 'OK');
      assert.equal(records.at(-1).timedOut, false);
      records.forEach(safe);
    }
  } finally { t.mock.timers.reset(); }
});

test('mocked controls use the same synthetic environment and only fixed mode arguments', async () => {
  const calls = [], root = path.resolve('synthetic-module-control');
  for (const mode of ['direct', 'supervisor', 'json', 'import-json']) {
    assert.equal(await sample('mock-shell', root, () => {}, mode, fakeSpawn(child => {
      child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames(mode))));
      child.stdout.emit('data', Buffer.from(outputMarker(mode))); child.finish(0);
    }, calls)), true);
  }
  for (const call of calls) {
    assert.equal(call.command, 'mock-shell');
    assert.ok(isDeepStrictEqual(call.options.env, calls[0].options.env));
    assert.ok(call.options.cwd === root && call.options.env.HOME === root && call.options.env.USERPROFILE === root);
    assert.ok(call.options.env.APPDATA === path.join(root, 'appdata') && call.options.env.LOCALAPPDATA === path.join(root, 'localappdata'));
    assert.equal(call.options.env.CLAUDE_BRIDGE_CHILD, '1');
    assert.ok(!Object.keys(call.options.env).some(key => /^(PSMODULEPATH|WINPSMODULEPATH|ANTHROPIC_|CLAUDE_CONFIG_DIR)/i.test(key)));
  }
  for (const [index, mode] of ['json', 'import-json'].entries()) {
    const args = calls[index + 2].args;
    assert.equal(args.length, 6);
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
    assert.equal(path.basename(args[3]), 'ci-module-control.ps1');
    assert.deepEqual(args.slice(4), ['-Mode', mode]);
  }
});

test('four direct samples precede optional legacy samples and preserve every failure or exception', async () => {
  const direct = [['ps5', 'direct'], ['ps5', 'direct'], ['ps7', 'direct'], ['ps7', 'direct']];
  const legacy = [['ps5', 'supervisor'], ['ps5', 'supervisor'], ['ps7', 'supervisor'], ['ps7', 'supervisor'],
    ['ps5', 'json'], ['ps5', 'import-json']];
  const directHeaders = ['direct-ps5-first', 'direct-ps5-repeat', 'direct-ps7-first', 'direct-ps7-repeat'];
  const legacyHeaders = ['probe-ps5-first', 'probe-ps5-repeat', 'probe-ps7-first', 'probe-ps7-repeat', 'control-ps5-json', 'control-ps5-import-json'];
  for (const legacyDiagnostics of [false, true]) {
    const expected = legacyDiagnostics ? [...direct, ...legacy] : direct;
    const headers = legacyDiagnostics ? [...directHeaders, ...legacyHeaders] : directHeaders;
    for (let failed = -1; failed < expected.length; failed++) for (const throws of [false, true]) {
      const calls = [], records = [];
      let active = 0, peak = 0;
      const runSample = async (shell, root, write, mode) => {
        assert.equal(root, 'synthetic-root');
        const index = calls.length;
        calls.push([shell, mode]); active++; peak = Math.max(peak, active);
        await Promise.resolve(); active--;
        if (index === failed && throws) throw new Error(SECRET);
        return index !== failed;
      };
      // Omitting the optional argument exercises the default four-sample gate.
      const passed = await runSamples('ps5', 'ps7', 'synthetic-root', d => records.push(d), runSample,
        ...(legacyDiagnostics ? [true] : []));
      assert.equal(passed, failed === -1);
      assert.equal(peak, 1);
      assert.deepEqual(calls, expected);
      assert.deepEqual(records.filter(d => d.stage !== 'probe-close').map(d => d.stage), headers);
      assert.deepEqual(records.filter(d => d.stage === 'probe-close'), failed !== -1 && throws ? [{ stage: 'probe-close', code: 'UNKNOWN' }] : []);
      records.forEach(safe);
    }
  }
});

test('direct observations require unique PID and exact terminated IO without debugger or module markers', () => {
  const pid = 'claude-bridge-child-pid:1234\n', io = outputMarker('direct');
  for (const first of ['stdout', 'stderr']) {
    const records = [], observed = observations(d => records.push(d), () => 0, 'direct');
    assert.equal(observed.complete(), false);
    assert.deepEqual(observed.state(), {});
    for (const stream of [first, first === 'stdout' ? 'stderr' : 'stdout']) {
      for (const character of stream === 'stdout' ? io : pid) observed[stream](Buffer.from(character));
      if (stream === first) assert.equal(observed.complete(), false);
    }
    assert.equal(observed.complete(), true);
    assert.deepEqual(observed.state(), { childStarted: true, ready: true });
    assert.deepEqual(records.map(d => d.stage).sort(), ['child-io', 'child-start']);
    records.forEach(record => assert.ok(!safe(record).includes('1234')));
  }
  const badPids = ['', '0', '-1', '+1', '01', '1.5', '12345678901', ' 1234', '1234 ', SECRET];
  const foreign = [...new Set([...phaseNames('supervisor'), ...phaseNames('import-json'), 'module-control-complete', 'child-io'])]
    .filter(stage => stage !== 'child-start').map(stage => `ci-probe:${stage}\n`);
  for (const extra of [...badPids.map(value => `claude-bridge-child-pid:${value}\n`), pid,
    'claude-bridge-child-pid:5678\n', ...foreign]) {
    const observed = observations(() => {}, () => 0, 'direct');
    observed.stderr(Buffer.from(pid + extra)); observed.stdout(Buffer.from(io));
    assert.equal(observed.complete(), false);
  }
  for (const text of ['', io + io, io.slice(0, -1), io + 'x', ' ' + io, io.replace('child-io', 'child-IO'),
    'ci-probe:module-control-complete\n', pid, io + 'ci-probe:ps-start\n']) {
    const observed = observations(() => {}, () => 0, 'direct');
    observed.stderr(Buffer.from(pid)); observed.stdout(Buffer.from(text));
    assert.equal(observed.complete(), false);
  }
});

test('direct sample uses production File argv and exact synthetic Node payload and stdin', async () => {
  const root = path.resolve('synthetic direct root ž'), calls = [], records = [];
  assert.equal(await sample('mock-shell', root, d => records.push(d), 'direct', fakeSpawn((child, input) => {
    assert.equal(input, 'CI_PROBE_INPUT\n');
    child.stdout.emit('data', Buffer.from(outputMarker('direct')));
    child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames('direct'))));
    child.finish(0);
  }, calls)), true);
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, 'mock-shell');
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, '../lib/windows-job-runner.ps1'), '-LaunchBase64']);
  const payload = JSON.parse(Buffer.from(args.at(-1), 'base64').toString('utf8'));
  assert.equal(Buffer.from(JSON.stringify(payload)).toString('base64'), args.at(-1));
  assert.deepEqual(Object.keys(payload).sort(), ['args', 'command', 'cwd', 'parentPid']);
  assert.equal(payload.command, process.execPath);
  assert.equal(payload.cwd, root);
  assert.equal(payload.parentPid, process.pid);
  assert.equal(payload.args.length, 2);
  assert.equal(payload.args[0], '-e');
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, root);
  assert.equal(options.env.TEMP, root);
  assert.equal(options.env.TMP, root);
  // Execute only the fixed synthetic JS in-process, never spawn a shell or CLI.
  for (const input of ['CI_PROBE_INPUT\n', '', 'CI_PROBE_INPUT', 'CI_PROBE_INPUT\r\n', 'CI_PROBE_INPUT\nextra', 'ž\n']) {
    const stdout = [], stdin = new EventEmitter();
    stdin.setEncoding = encoding => assert.equal(encoding, 'utf8');
    const childProcess = { stdin, stdout: { write: text => stdout.push(text) } };
    require('node:vm').runInNewContext(payload.args[1], { process: childProcess });
    for (const character of input) stdin.emit('data', character);
    stdin.emit('end');
    assert.equal(childProcess.exitCode, input === 'CI_PROBE_INPUT\n' ? undefined : 3);
    assert.deepEqual(stdout, input === 'CI_PROBE_INPUT\n' ? [outputMarker('direct')] : []);
  }
  assert.equal(records.at(-1).code, 'OK');
  assert.equal(records.at(-1).exit, 0);
  records.forEach(safe);
});

test('direct sample retains combined 64 KiB output bound and rejects null exit or synchronous spawn errors', async () => {
  for (const size of [65536, 65537]) {
    const records = [], pid = stderrPhases(phaseNames('direct')), io = outputMarker('direct');
    const passed = await sample('mock-shell', 'synthetic-root', d => records.push(d), 'direct', fakeSpawn(child => {
      child.stderr.emit('data', Buffer.from('x'.repeat(size - pid.length - io.length - 1) + '\n'));
      child.stderr.emit('data', Buffer.from(pid));
      child.stdout.emit('data', Buffer.from(io));
      child.finish(0);
    }));
    assert.equal(passed, size === 65536);
    assert.equal(records.at(-1).code, size === 65536 ? 'OK' : 'OUTPUT_LIMIT');
    assert.equal(records.at(-1).oversized, size !== 65536);
  }
  const records = [];
  assert.equal(await sample('mock-shell', 'synthetic-root', d => records.push(d), 'direct', fakeSpawn(child => {
    child.stderr.emit('data', Buffer.from(stderrPhases(phaseNames('direct'))));
    child.stdout.emit('data', Buffer.from(outputMarker('direct'))); child.finish(null);
  })), false);
  assert.equal(records.at(-1).code, 'EXIT_NONZERO');
  await assert.rejects(sample('mock-shell', 'synthetic-root', () => {}, 'direct', () => { throw new Error(SECRET); }));
});

test('probe CLI accepts only an absolute PS7 path and one trailing legacy flag before setup', async () => {
  const ps7 = path.resolve('synthetic-shell', 'pwsh.exe');
  assert.deepEqual(parseArgs(['--powershell7', ps7]), { ps7, legacyDiagnostics: false });
  assert.deepEqual(parseArgs(['--powershell7', ps7, '--legacy-diagnostics']), { ps7, legacyDiagnostics: true });
  for (const args of [[], ['--powershell7'], ['--powershell7', 'relative/pwsh.exe'], ['--powershell7', ''],
    ['--powershell7', null], ['--powershell7', 7], ['--unknown', ps7], ['--legacy-diagnostics', '--powershell7', ps7],
    ['--powershell7', ps7, '--unknown'], ['--powershell7', ps7, '--legacy-diagnostics', '--legacy-diagnostics'],
    ['--powershell7', ps7, '--powershell7', ps7], ['--powershell7', ps7, '--legacy-diagnostics', 'extra'], null]) {
    assert.equal(parseArgs(args), null);
    const records = [];
    assert.equal(await probe(args, d => records.push(d)), 1);
    assert.deepEqual(records, [{ stage: 'probe-setup', code: 'INVALID_RESULT' }]);
  }
});

test('production bootstrap and source pins fail closed before any shell selection', async t => {
  const supervisor = path.join(__dirname, '../lib/windows-job-runner.ps1');
  const source = (await fs.readFile(supervisor, 'utf8')).replace(/\r\n/g, '\n');
  const sourceLines = source.split('\n');
  assert.equal(sourceLines[2], 'try {');
  assert.equal(sourceLines[3], "    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop");
  assert.equal(sourceLines[4], '    $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LaunchBase64)) | ConvertFrom-Json');
  assert.equal(sourceLines[5], "    Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'windows-job-runner.cs'))");
  assert.equal(sourceLines[6], '    [ClaudeBridgeJobRunner]::Run([string]$launch.command, [string[]]$launch.args, [string]$launch.cwd, [int]$launch.parentPid)');
  assert.equal(sourceLines.slice(7).join('\n'), "    exit 0\n} catch {\n    [Console]::Error.WriteLine('Claude job supervisor failed: ' + $_.Exception.Message)\n    exit 1\n}\n");
  const readFile = fs.readFile;
  try {
    for (const changed of [null, 'windows-job-runner.ps1', 'windows-job-runner.cs']) {
      const read = t.mock.method(fs, 'readFile', async (file, ...args) => {
        const value = (await readFile(file, ...args)).replace(/\r\n/g, '\n');
        return path.basename(file) === changed ? value + '# source mismatch\n' : value.replace(/\n/g, '\r\n');
      });
      assert.equal(await inspectSources(), changed === null);
      if (changed && process.platform === 'win32') {
        const records = [];
        assert.equal(await probe(['--powershell7', path.resolve('synthetic-shell', 'pwsh.exe')], d => records.push(d)), 1);
        assert.deepEqual(records, [{ stage: 'probe-setup', code: 'SOURCE_MISMATCH' }]);
      }
      read.mock.restore();
    }
    // A missing selected executable fails before scratch creation or spawning.
    if (process.platform === 'win32') {
      t.mock.method(fs, 'stat', async () => { throw new Error(SECRET); });
      const records = [];
      assert.equal(await probe(['--powershell7', path.resolve('synthetic-shell', 'pwsh.exe')], d => records.push(d)), 1);
      assert.deepEqual(records, [{ stage: 'probe-setup', code: 'UNKNOWN' }]);
    }
  } finally { t.mock.restoreAll(); }
});

test('module and breakpoint scripts retain bounded fixed instrumentation and shell-owned import', async () => {
  const wrapper = await fs.readFile(path.join(__dirname, 'ci-supervisor-probe.ps1'), 'utf8');
  assert.ok(!/Import-Module|PSModulePath|ExecutionPolicy/i.test(wrapper));
  assert.equal((wrapper.match(/Set-PSBreakpoint/g) || []).length, 2);
  assert.equal(diagnostic('breakpoint-5-set').stage, 'unknown');
  assert.equal(diagnostic('breakpoint-6-set').stage, 'breakpoint-6-set');
  assert.equal(diagnostic('breakpoint-7-set').stage, 'breakpoint-7-set');
  const order = ["Set-PSBreakpoint -Script $Supervisor -Line 6", "ci-probe:breakpoint-6-set",
    "Set-PSBreakpoint -Script $Supervisor -Line 7", "ci-probe:breakpoint-7-set", "ci-probe:supervisor-call", '& $Supervisor -LaunchBase64 $LaunchBase64'];
  for (let i = 1; i < order.length; i++) assert.ok(wrapper.indexOf(order[i]) > wrapper.indexOf(order[i - 1]));
  const control = await fs.readFile(path.join(__dirname, 'ci-module-control.ps1'), 'utf8');
  assert.ok(control.includes("[ValidateSet('json', 'import-json')]"));
  assert.ok(control.includes("[IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')"));
  assert.ok(control.includes('Import-Module -Name $manifest -ErrorAction Stop'));
  assert.ok(control.includes("$value = '{\"value\":7}' | ConvertFrom-Json"));
  assert.ok(control.includes('if ($null -eq $value -or $value.value -ne 7) { exit 1 }'));
  assert.ok(control.indexOf('ci-probe:json-complete') > control.indexOf('$value.value -ne 7'));
  assert.ok(control.indexOf('ci-probe:module-control-complete') > control.indexOf('ci-probe:json-complete'));
  assert.ok(!/Set-PSBreakpoint|Add-Type|PSModulePath|Set-ExecutionPolicy|\.Exception|\$env:/i.test(control));
  assert.ok(!control.includes('ci-probe:child-io') && !control.includes('claude-bridge-child-pid:'));
});
