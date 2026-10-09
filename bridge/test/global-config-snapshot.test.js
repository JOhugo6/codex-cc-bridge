'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { MAX_BYTES, globalConfigFingerprint: hash, readGlobalConfigSnapshot: snapshot } = require('../lib/global-config-snapshot');
const { synthetic, SENTINEL } = require('./native-runtime-fixture');
const encode = value => Buffer.from(JSON.stringify(value));
const sourceError = err => err.code === 'NATIVE_SOURCE' && !err.message.includes(SENTINEL);
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'global-snapshot-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, '{}');
  return { root, file };
}

test('global projection is canonical, operational omissions are scoped, and all unknown fields remain protected', () => {
  const base = { env: { A: 'keep' }, oauthAccount: { accountUuid: SENTINEL }, projects: { p: { hasTrustDialogAccepted: true } }, unknown: { firstStartTime: 'protected' } };
  const noisy = { ...base, numStartups: 3, firstStartTime: '2026-09-14T00:00:00.000Z', firstStartVersion: '2.1.270', machineID: 'a'.repeat(64),
    tipsHistory: { tip: 4 }, seenNotifications: { notification: 1 }, cachedGrowthBookFeaturesAt: 1720000000000,
    oauthAccount: { ...base.oauthAccount, profileFetchedAt: 1720000000000 },
    projects: { p: { ...base.projects.p, lastSessionId: '11111111-1111-4111-8111-111111111111', lastCost: 1.1, lastSessionMetrics: { frames_count: 3, render_ms_p95: 12.5 }, lastModelUsage: { model: { inputTokens: 2, costUSD: 0.01 } } } } };
  assert.equal(hash(encode(noisy)), hash(encode(base)));
  assert.equal(hash(encode({ z: 1, a: { y: 2, x: 3 } })), hash(encode({ a: { x: 3, y: 2 }, z: 1 })));
  for (const [key, value] of Object.entries({ env: { A: SENTINEL }, apiKeyHelper: SENTINEL, userID: 'b'.repeat(64), migrationVersion: 14,
    cachedExtraUsageDisabledReason: null, cachedGrowthBookFeatures: {}, cachedUnknownAt: 1720000000000,
    oauthAccount: { accountUuid: 'changed' }, unknown: { firstStartTime: 'changed' }, projects: { p: { hasTrustDialogAccepted: false } } })) {
    assert.notEqual(hash(encode({ ...base, [key]: value })), hash(encode(base)), key);
  }
  assert.notEqual(hash(encode({ projects: { p: { nested: { lastCost: 1 } } } })), hash(encode({ projects: { p: { nested: { lastCost: 2 } } } })));
  assert.notEqual(hash(encode({ projects: { p: { lastNewUnknownMetric: 1 } } })), hash(encode({ projects: { p: { lastNewUnknownMetric: 2 } } })));
  assert.notEqual(hash(encode({ sequence: [1, 2] })), hash(encode({ sequence: [2, 1] })));
});

test('operational fields have exact type validation instead of arbitrary subtree exclusion', () => {
  for (const value of [{ numStartups: -1 }, { numStartups: '1' }, { machineID: SENTINEL }, { tipsHistory: { k: { secret: SENTINEL } } },
    { cachedGrowthBookFeaturesAt: 'recent' }, { projects: { p: { lastSessionMetrics: { nested: { secret: SENTINEL } } } } },
    { projects: { p: { lastSessionMetrics: { event: SENTINEL } } } }, { seenNotifications: [1] }, { firstStartVersion: {} }, { firstStartTime: SENTINEL },
    { oauthAccount: { profileFetchedAt: null } }, { projects: { p: { lastCost: SENTINEL } } },
    { projects: { p: { lastModelUsage: { model: { newRoutingField: 1 } } } } }]) {
    assert.throws(() => hash(encode(value)), sourceError);
  }
});

test('parser rejects malformed, nonobject, invalid UTF8, overlimit, nonfinite and deeply nested inputs without excerpts', () => {
  for (const value of [Buffer.from('{"secret":"' + SENTINEL), encode([]), encode(null), Buffer.from([0xff]), Buffer.alloc(MAX_BYTES + 1), Buffer.from('{"value":1e999}')]) assert.throws(() => hash(value), sourceError);
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { unknown: deep };
  assert.throws(() => hash(encode(deep)), sourceError);
});

test('regular atomic replacement and formatting changes preserve snapshot only for equivalent protected data', t => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, '{"env":{"A":"keep"},"numStartups":1}');
  const first = snapshot(file, fs);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, '{\n"numStartups":2,"env":{"A":"keep"}\n}');
  fs.renameSync(replacement, file);
  assert.equal(snapshot(file, fs), first);
  fs.writeFileSync(file, '{"env":{"A":"changed"}}');
  assert.notEqual(snapshot(file, fs), first);
  assert.ok(!first.includes('keep'));
});

test('filesystem failures, oversize and symlinks reject and opened handles close', t => {
  const { root, file } = fixture(t);
  assert.throws(() => snapshot(root, fs), sourceError);
  assert.throws(() => snapshot(path.join(root, 'missing'), fs), sourceError);
  fs.writeFileSync(file, Buffer.alloc(MAX_BYTES + 1));
  assert.throws(() => snapshot(file, fs), sourceError);
  fs.writeFileSync(file, '{bad');
  let opens = 0, closes = 0;
  const tracked = { ...fs, openSync(...args) { opens++; return fs.openSync(...args); }, closeSync(fd) { closes++; return fs.closeSync(fd); } };
  assert.throws(() => snapshot(file, tracked), sourceError);
  assert.equal(opens, 1); assert.equal(closes, 1);
  const alias = path.join(root, 'link.json');
  fs.symlinkSync(file, alias);
  assert.throws(() => snapshot(alias, fs), sourceError);
});

test('native metadata cannot change protected global fields before the initial baseline or inside doctor', async () => {
  for (const phase of ['--version', 'doctor']) {
    const f = await synthetic();
    try {
      f.beforeExecute = async (command, args) => { if (args.includes(phase)) await f.json(path.relative(f.root, f.globalFile), { unknownProtected: SENTINEL }); };
      await assert.rejects(f.runtime().preflight({ cwd: f.project }), err => err.code === 'NATIVE_DRIFT' && !err.message.includes(SENTINEL));
    } finally { await f.close(); }
  }
});

test('concurrent preparations and launch checks tolerate only operational global rewrites', async () => {
  const f = await synthetic();
  try {
    const stable = { oauthAccount: { accountUuid: 'synthetic' }, projects: { p: { hasTrustDialogAccepted: true } } };
    await f.json(path.relative(f.root, f.globalFile), stable);
    const prepared = await Promise.all(Array.from({ length: 4 }, () => f.runtime().preflight({ cwd: f.project })));
    await f.json(path.relative(f.root, f.globalFile), { ...stable, numStartups: 4,
      pluginUsage: { 'synthetic@market': { usageCount: 6, lastUsedAt: 123456, lastUsedNumStartups: 4 } },
      skillUsage: { synthetic: { usageCount: 3, lastUsedAt: 123456 } } });
    let launched = 0;
    await Promise.all(prepared.map(p => p.launch(() => { launched++; })));
    assert.equal(launched, 4);
    await f.json(path.relative(f.root, f.globalFile), { ...stable, unknownProtected: true });
    await assert.rejects(prepared[0].launch(() => assert.fail('protected change submitted')), { code: 'NATIVE_DRIFT', reason: 'GLOBAL_METADATA_CHANGED' });
  } finally { await f.close(); }
});

test('a replacement between path check and open is reread, and same-inode edits after handle stat are not accepted stale', t => {
  const { root, file } = fixture(t);
  fs.writeFileSync(file, '{"protected":1}');
  const before = snapshot(file, fs);
  let swapped = false;
  const race = { ...fs, openSync(...args) {
    if (!swapped) {
      swapped = true;
      const replacement = path.join(root, 'replacement.json');
      fs.writeFileSync(replacement, '{"protected":2}'); fs.renameSync(replacement, file);
    }
    return fs.openSync(...args);
  } };
  assert.notEqual(snapshot(file, race), before);
  const baseline = snapshot(file, fs);
  let stats = 0, closes = 0;
  const inPlace = { ...fs, fstatSync(fd) {
    const value = fs.fstatSync(fd);
    if (++stats === 2) fs.writeFileSync(file, '{"protected":333}');
    return value;
  }, closeSync(fd) { closes++; return fs.closeSync(fd); } };
  assert.notEqual(snapshot(file, inPlace), baseline);
  assert.equal(closes, 2, 'the stale handle was closed and current content reread');
});


test('plugin telemetry and skill recency churn use only their exact validated global schemas', () => {
  const baseline = { enabledPlugins: { 'example@market': true }, oauthAccount: { accountUuid: 'synthetic' } };
  const prior = { ...baseline, pluginUsage: { 'example@market': { usageCount: 0, lastUsedAt: 100 } } };
  const current = { ...baseline, pluginUsage: { 'example@market': { usageCount: 4, lastUsedAt: 200, lastUsedNumStartups: 10 }, another: { usageCount: 1, lastUsedAt: 300 } } };
  assert.equal(hash(encode(baseline)), hash(encode(prior)));
  assert.equal(hash(encode(prior)), hash(encode(current)));
  for (const pluginUsage of [null, [], { p: {} }, { p: { usageCount: -1, lastUsedAt: 2 } },
    { p: { usageCount: 1, lastUsedAt: 'now' } }, { p: { usageCount: 1, lastUsedAt: 2, lastUsedNumStartups: 1.5 } },
    { p: { usageCount: 1, lastUsedAt: 2, enabled: true } }, { p: { usageCount: { secret: SENTINEL }, lastUsedAt: 2 } }]) {
    assert.throws(() => hash(encode({ ...baseline, pluginUsage })), sourceError);
  }
  assert.notEqual(hash(encode({ ...baseline, enabledPlugins: { 'example@market': false } })), hash(encode(baseline)));
  assert.notEqual(hash(encode({ nested: { pluginUsage: prior.pluginUsage } })), hash(encode({ nested: { pluginUsage: current.pluginUsage } })));
  assert.equal(hash(encode({ skillUsage: { p: { usageCount: 1, lastUsedAt: 100 } } })), hash(encode({ skillUsage: { p: { usageCount: 2, lastUsedAt: 200 } } })));
  for (const skillUsage of [[], { p: { usageCount: 1 } }, { p: { usageCount: 1, lastUsedAt: 2, lastUsedNumStartups: 3 } }, { p: { usageCount: 1, lastUsedAt: 2, permission: SENTINEL } }]) {
    assert.throws(() => hash(encode({ skillUsage })), sourceError);
  }
  assert.notEqual(hash(encode({ projects: { p: { skillUsage: { count: 1 } } } })), hash(encode({ projects: { p: { skillUsage: { count: 2 } } } })));
});

test('only the characterized disabled feature default is equivalent to its absence', () => {
  const base = { cachedGrowthBookFeatures: { tengu_windows_credman: true, unknownFeature: { protected: true } } };
  const disabled = { cachedGrowthBookFeatures: { ...base.cachedGrowthBookFeatures, tengu_misty_aurora: 0 } };
  assert.equal(hash(encode(base)), hash(encode(disabled)));
  for (const value of [3600, -1, null, false, '0', {}, []]) {
    assert.notEqual(hash(encode(base)), hash(encode({ cachedGrowthBookFeatures: { ...base.cachedGrowthBookFeatures, tengu_misty_aurora: value } })), String(value));
  }
  for (const changed of [{ tengu_windows_credman: false }, { unknownFeature: { protected: false } }, { newFeature: 0 }]) {
    assert.notEqual(hash(encode(base)), hash(encode({ cachedGrowthBookFeatures: { ...disabled.cachedGrowthBookFeatures, ...changed } })));
  }
  for (const wrap of [v => ({ tengu_misty_aurora: v }), v => ({ unknown: { cachedGrowthBookFeatures: { tengu_misty_aurora: v } } }),
    v => ({ projects: { p: { cachedGrowthBookFeatures: { tengu_misty_aurora: v } } } }),
    v => ({ cachedGrowthBookFeatures: { nested: { tengu_misty_aurora: v } } })]) {
    assert.notEqual(hash(encode(wrap(0))), hash(encode(wrap(undefined))));
  }
  assert.notEqual(hash(encode({})), hash(encode({ cachedGrowthBookFeatures: {} })), 'cache presence stays protected');
});

test('disabled feature cache churn during metadata, recheck and atomic replacement preserves identity without accepting active changes', async () => {
  const { teamFixture } = require('./team-fixture');
  for (const createFixture of [synthetic, teamFixture]) {
    const f = await createFixture();
    try {
      const base = JSON.parse(await fs.promises.readFile(f.globalFile, 'utf8'));
      base.cachedGrowthBookFeatures = { tengu_windows_credman: true };
      await f.json(path.relative(f.root, f.globalFile), base);
      let writes = 0;
      f.beforeExecute = async () => {
        const features = { ...base.cachedGrowthBookFeatures, ...(++writes % 2 ? { tengu_misty_aurora: 0 } : {}) };
        const replacement = path.join(f.root, 'global-replacement.json');
        await fs.promises.writeFile(replacement, JSON.stringify({ ...base, cachedGrowthBookFeatures: features }));
        await fs.promises.rename(replacement, f.globalFile);
      };
      const prepared = await f.runtime().preflight({ cwd: f.project });
      const identity = prepared.identity;
      let submissions = 0;
      await prepared.launch(() => { submissions++; });
      assert.deepEqual(await prepared.recheck(), identity);
      assert.ok(writes >= 6, 'churn covers multiple metadata commands and launch rechecks');
      assert.equal(submissions, 1);
      f.beforeExecute = undefined;
      await f.json(path.relative(f.root, f.globalFile), { ...base,
        cachedGrowthBookFeatures: { ...base.cachedGrowthBookFeatures, tengu_misty_aurora: 3600 } });
      await assert.rejects(prepared.launch(() => { submissions++; }), { code: 'NATIVE_DRIFT', reason: 'GLOBAL_METADATA_CHANGED' });
      assert.equal(submissions, 1, 'active feature changes never reach the submission callback');
    } finally { await f.close(); }
  }
});
