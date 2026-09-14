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
    await f.json(path.relative(f.root, f.globalFile), { ...stable, numStartups: 4 });
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
