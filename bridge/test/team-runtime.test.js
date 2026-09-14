'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { teamFixture, TEAM_DOCTOR, TEAM_DEBUG, REMOTE, POLICY } = require('./team-fixture');
const { SENTINEL } = require('./native-runtime-fixture');
const rejects = (...codes) => e => codes.includes(e.code) && !e.message.includes(SENTINEL);
const TEAM_PENDING = TEAM_DOCTOR.replace('Managed settings (remote): loaded',
  'Managed settings (remote): checking… (fetch in progress; re-run in a moment)');

test('Team completed 304 attestation supersedes early pending snapshot through launch and continuation', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  f.doctorOutput = TEAM_PENDING;
  const p = await f.runtime().preflight({ cwd: f.project });
  assert.equal(f.calls.filter(x => x.kind === 'doctor').length, 1, 'does not restart a completed doctor');
  let submitted = false;
  await p.launch(() => { submitted = true; });
  assert.equal(submitted, true);
  assert.equal(f.calls.filter(x => x.kind === 'doctor').length, 2, 'launch freshly attests once');
  const again = await f.runtime().preflight({ cwd: f.project, expectedIdentity: p.identity });
  assert.deepEqual(again.identity, p.identity);
});

test('Team early pending snapshot never substitutes for complete fresh cache evidence', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  const markers = TEAM_DEBUG.trimEnd().split('\n');
  for (const stderr of ['', ...markers.map(m => TEAM_DEBUG.replace(m + '\n', '')),
    TEAM_DEBUG + '[DEBUG] Policy limits: Failed to load restrictions\n',
    TEAM_DEBUG + '[DEBUG] Remote settings: Fetched settings from server (200)\n',
    TEAM_DEBUG + markers[0] + '\n']) {
    const p = await f.runtime().preflight({ cwd: f.project });
    f.doctorOutput = TEAM_PENDING; f.doctorStderr = stderr;
    let submitted = false;
    const before = f.calls.filter(x => x.kind === 'doctor').length;
    await assert.rejects(p.launch(() => { submitted = true; }), rejects('NATIVE_POLICY'));
    assert.equal(submitted, false);
    assert.equal(f.calls.filter(x => x.kind === 'doctor').length, before + 1, 'no retry after incomplete/failed evidence');
    f.doctorOutput = TEAM_DOCTOR; f.doctorStderr = TEAM_DEBUG;
  }
  const p = await f.runtime().preflight({ cwd: f.project });
  f.doctorOutput = TEAM_PENDING;
  f.beforeExecute = async (_command, args) => {
    if (args.includes('doctor')) await f.json('config/remote-settings.json', { ...REMOTE, permissions: { deny: ['Read'] } });
  };
  await assert.rejects(p.launch(() => assert.fail('unexpected submission')), rejects('NATIVE_DRIFT'));
});

test('Team policy diagnostic reasons distinguish status, failed refresh, incomplete evidence and missing caches', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  for (const [stdout, stderr, reason] of [
    [TEAM_DOCTOR.replace('Loaded from api.anthropic.com', 'unknown'), TEAM_DEBUG, 'POLICY_STATUS'],
    [TEAM_PENDING, TEAM_DEBUG + `[DEBUG] Remote settings: Failed ${SENTINEL}\n`, 'POLICY_FAILED'],
    [TEAM_PENDING, '', 'POLICY_UNATTESTED'],
  ]) {
    f.doctorOutput = stdout; f.doctorStderr = stderr;
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), e =>
      e.code === 'NATIVE_POLICY' && e.reason === reason && !JSON.stringify(e).includes(SENTINEL) && !e.message.includes(SENTINEL));
  }
  f.doctorOutput = TEAM_DOCTOR; f.doctorStderr = TEAM_DEBUG;
  await fs.unlink(path.join(f.config, 'remote-settings.json'));
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_POLICY', reason: 'POLICY_CACHE_MISSING' });
});

test('saved Team account requires attested restrictions and preserves identity through recheck and continuation', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  const p = await f.runtime().preflight({ cwd: f.project });
  assert.equal(p.identity.model, 'claude-opus-5[1m]');
  assert.equal(p.identity.version, '2.1.264');
  assert.notEqual(p.identity.contract, 'native-windows-personal/2.1.263/v1');
  await assert.rejects(f.runtime().preflight({ cwd: f.project,
    expectedIdentity: { ...p.identity, contract: 'native-windows-personal/2.1.263/v1' } }), rejects('NATIVE_DRIFT'));
  assert.deepEqual(await p.recheck(), p.identity);
  const again = await f.runtime().preflight({ cwd: f.project, expectedIdentity: p.identity });
  assert.deepEqual(again.identity, p.identity);
  const before = f.calls.filter(x => x.kind === 'doctor').length;
  let submitted = false;
  await p.launch(() => { submitted = true; });
  assert.equal(submitted, true);
  assert.ok(f.calls.filter(x => x.kind === 'doctor').length > before, 'launch re-attests remote policy');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'remote-settings.json'))), REMOTE);
  assert.ok(!f.reads.some(p => /\.credentials\.json$/.test(p)));
});

test('Team rejects incomplete, failed, contradictory and unattested metadata without submission', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  const failures = [
    ['Managed settings (remote): checking\nOrganization policy: Loaded from api.anthropic.com', TEAM_DEBUG],
    ['Managed settings (remote): loaded\nOrganization policy: Could not load organization policy', TEAM_DEBUG],
    [TEAM_DOCTOR + 'Managed settings (remote): failed\n', TEAM_DEBUG],
    [TEAM_DOCTOR + 'Organization policy: not applicable to Pro and Max accounts\n', TEAM_DEBUG],
    [TEAM_DOCTOR, ''],
    [TEAM_DOCTOR, TEAM_DEBUG.replace('[DEBUG] Policy limits: Cache still valid (304 Not Modified)\n', '')],
    [TEAM_DOCTOR, TEAM_DEBUG + '[DEBUG] Remote settings: Fetched settings from server (200)\n'],
    [TEAM_DOCTOR, TEAM_DEBUG + '[DEBUG] Remote settings: Applied new settings successfully\n'],
    [TEAM_DOCTOR, TEAM_DEBUG + '[DEBUG] Remote settings: User rejected new settings, using cached settings\n'],
    [TEAM_DOCTOR, TEAM_DEBUG + '[DEBUG] Remote settings: Using cached settings (304)\n'],
    ['Managed settings (remote): not fetched — requires an Enterprise or Team subscription\nOrganization policy: not applicable to Pro and Max accounts\n', TEAM_DEBUG],
  ];
  for (const [stdout, stderr] of failures) {
    f.doctorOutput = stdout; f.doctorStderr = stderr;
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejects('NATIVE_POLICY'));
  }
});

test('Team requires both validated caches and refuses managed routing, helpers, host policy and unknown restrictions', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  for (const name of ['remote-settings.json', 'policy-limits.json']) {
    const filename = path.join(f.config, name), bytes = await fs.readFile(filename);
    await fs.unlink(filename);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejects('NATIVE_POLICY'));
    await fs.writeFile(filename, bytes);
  }
  for (const bad of [{ ...REMOTE, env: { ANTHROPIC_BASE_URL: SENTINEL } }, { ...REMOTE, apiKeyHelper: SENTINEL },
    { ...REMOTE, model: 'claude-sonnet-4-6' }, { ...REMOTE, unknown: true }]) {
    await f.json('config/remote-settings.json', bad);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejects('NATIVE_CONFLICT'));
  }
  await f.json('config/remote-settings.json', REMOTE);
  await f.json('config/policy-limits.json', { ...POLICY, restrictions: { unknown: { allowed: true } } });
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejects('NATIVE_CONFLICT'));
  await f.json('config/policy-limits.json', POLICY);
  await assert.rejects(f.runtime({ parentEnv: { ...f.parentEnv, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' } }).preflight({ cwd: f.project }), rejects('NATIVE_CONFLICT'));
});

test('Team detects account, remote policy and policy-limit changes before launch', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  for (const mutate of [async () => { f.account = { ...f.account, orgId: 'changed-org' }; },
    async () => f.json('config/remote-settings.json', { ...REMOTE, permissions: { deny: ['Read'] } }),
    async () => f.json('config/policy-limits.json', { ...POLICY, restrictions: {} }),
    async () => { f.doctorOutput = 'Managed settings (remote): loaded\nOrganization policy: Failed to load\n'; }]) {
    const p = await f.runtime().preflight({ cwd: f.project });
    await mutate();
    let submitted = false;
    await assert.rejects(p.launch(() => { submitted = true; }), rejects('NATIVE_DRIFT', 'NATIVE_POLICY'));
    assert.equal(submitted, false);
    f.doctorOutput = TEAM_DOCTOR;
  }
});

test('Team permits native policy-cache timestamp touches but rejects same-size edits during global snapshot refresh', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  const filename = path.join(f.config, 'policy-limits.json');
  f.beforeExecute = async (_command, args) => {
    if (args.includes('doctor')) { const now = new Date(); await fs.utimes(filename, now, now); }
  };
  await fs.mkdir(path.join(f.managed, 'managed-settings.d'), { recursive: true });
  const p = await f.runtime().preflight({ cwd: f.project });
  await p.launch(() => {});
  const bytes = await fs.readFile(filename, 'utf8');
  const changedBytes = bytes.replace('"allowed":false', '"allowed":true ');
  assert.equal(Buffer.byteLength(changedBytes), Buffer.byteLength(bytes));
  assert.notEqual(changedBytes, bytes);
  let afterDoctor = false, validations = 0, changed = false, submitted = false;
  f.beforeExecute = async (_command, args) => { if (args.includes('doctor')) afterDoctor = true; };
  const readdir = f.deps.syncFs.readdirSync;
  f.deps.syncFs.readdirSync = dir => {
    const names = readdir(dir);
    // Change bytes after the nonglobal comparison, before a refreshed global
    // snapshot is recorded. Refreshing global metadata must not adopt this edit.
    if (afterDoctor && ++validations === 2) queueMicrotask(() => {
      require('node:fs').writeFileSync(filename, changedBytes); changed = true;
    });
    return names;
  };
  await assert.rejects(p.launch(() => { submitted = true; }), rejects('NATIVE_DRIFT'));
  assert.equal(changed, true);
  assert.equal(submitted, false);
});

test('Team accepts operational global metadata but never adopts protected doctor or external edits', async t => {
  const f = await teamFixture(); t.after(() => f.close());
  let writes = 0;
  const global = JSON.parse(await fs.readFile(f.globalFile, 'utf8'));
  f.beforeExecute = async (_command, args) => {
    if (args.includes('doctor')) await f.json(path.relative(f.root, f.globalFile), { ...global, numStartups: ++writes });
  };
  const p = await f.runtime().preflight({ cwd: f.project });
  await p.launch(() => {});
  await p.launch(() => {});
  assert.equal(writes, 3);
  assert.ok(f.reads.includes(f.globalFile), 'global protected semantics are checked internally');
  await f.json(path.relative(f.root, f.globalFile), { outsideDoctor: true });
  await assert.rejects(p.launch(() => assert.fail('unexpected submission')), rejects('NATIVE_DRIFT'));
  assert.equal(writes, 3, 'preexisting global edit is rejected before doctor');
});

test('Team cannot adopt account, provider, organization or nonglobal mutations during doctor', async () => {
  for (const mutation of ['account', 'provider', 'org', 'ordinary', 'remote', 'credentials']) {
    const f = await teamFixture();
    try {
      const p = await f.runtime().preflight({ cwd: f.project });
      f.beforeExecute = async (_command, args) => {
        if (!args.includes('doctor')) return;
        const global = JSON.parse(await fs.readFile(f.globalFile, 'utf8'));
        await f.json(path.relative(f.root, f.globalFile), { ...global, numStartups: 42 });
        if (mutation === 'account') f.account = { ...f.account, email: 'changed@example.invalid' };
        if (mutation === 'provider') f.account = { ...f.account, apiProvider: 'gateway' };
        if (mutation === 'org') f.account = { ...f.account, orgId: 'changed-org' };
        if (mutation === 'ordinary') await f.json('config/settings.json', { permissions: { allow: ['Read'] } });
        if (mutation === 'remote') await f.json('config/remote-settings.json', { ...REMOTE, permissions: { deny: ['Read'] } });
        if (mutation === 'credentials') await f.login('team');
      };
      let submitted = false;
      await assert.rejects(p.launch(() => { submitted = true; }), rejects('NATIVE_DRIFT', 'NATIVE_AUTH'));
      assert.equal(submitted, false, mutation);
    } finally { await f.close(); }
  }
});

test('Team final synchronous ledger catches global and same-size policy edits after stable second auth', async () => {
  for (const kind of ['global', 'policy']) {
    const f = await teamFixture();
    try {
      await fs.mkdir(path.join(f.managed, 'managed-settings.d'), { recursive: true });
      const p = await f.runtime().preflight({ cwd: f.project });
      const file = kind === 'global' ? f.globalFile : path.join(f.config, 'policy-limits.json');
      const bytes = await fs.readFile(file, 'utf8');
      const edited = kind === 'global' ? JSON.stringify({ ...JSON.parse(bytes), unknownProtectedField: true }) : bytes.replace('"allowed":false', '"allowed":true ');
      let doctorSeen = false, secondAuth = false, validations = 0, changed = false, submitted = false;
      f.beforeExecute = async (_command, args) => {
        if (args.includes('doctor')) doctorSeen = true;
        if (doctorSeen && args.includes('auth')) secondAuth = true;
      };
      const readdir = f.deps.syncFs.readdirSync;
      f.deps.syncFs.readdirSync = dir => {
        const names = readdir(dir);
        // After second auth: the full scan inventories once, then recheck's
        // final ledger inventories again. Mutate after recheck resolves and
        // before launch's last synchronous ledger check / submission.
        if (secondAuth && ++validations === 2) queueMicrotask(() => {
          require('node:fs').writeFileSync(file, edited); changed = true;
        });
        return names;
      };
      await assert.rejects(p.launch(() => { submitted = true; }), rejects('NATIVE_DRIFT'));
      assert.equal(changed, true, kind);
      assert.equal(submitted, false, kind);
    } finally { await f.close(); }
  }
});

test('Team uses the existing default login namespace and rejects missing organization identity', async t => {
  const f = await teamFixture({ defaultRoot: true }); t.after(() => f.close());
  const p = await f.runtime().preflight({ cwd: f.project });
  assert.equal(p.identity.configRootMode, 'default');
  assert.equal(p.identity.nativeConfigRoot, null);
  await p.launch(l => {
    assert.equal(Object.hasOwn(l.env, 'CLAUDE_CONFIG_DIR'), false);
    assert.equal(l.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
  });
  for (const orgId of [null, '', undefined]) {
    f.account = { ...f.account, orgId };
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejects('NATIVE_AUTH'));
  }
});
