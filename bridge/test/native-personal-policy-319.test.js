'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { synthetic, SENTINEL } = require('./native-runtime-fixture');

const REMOTE = 'Managed settings (remote): not fetched — requires an Enterprise or Team subscription';
const LEGACY = 'Organization policy: not applicable to Pro and Max accounts';
const CURRENT = 'Organization policy: not applicable to individual subscription plans';

for (const nativeVersion of ['2.1.319', '2.1.322']) {
const nativeTest = (name, ...args) => test(`${nativeVersion}: ${name}`, ...args);
async function fixture(t, version = nativeVersion) {
  const f = await synthetic(); t.after(() => f.close());
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, options) => {
    const output = await execute(command, args, options);
    return args.includes('--version') ? { stdout: `${version} (Claude Code)\n`, stderr: '' } : output;
  };
  return f;
}
const refused = code => err => {
  assert.equal(err.code, code);
  assert.ok(!JSON.stringify(err).includes(SENTINEL));
  return true;
};

nativeTest('personal diagnostic accepts eligible Pro and Max without changing identity or launch policy', async t => {
  for (const subscriptionType of ['pro', 'max']) {
    const f = await fixture(t);
    f.account = { ...f.account, subscriptionType };
    f.doctorOutput = `${REMOTE}\n${CURRENT}\n`;
    const prepared = await f.runtime().preflight({ cwd: f.project });
    assert.equal(prepared.identity.version, nativeVersion);
    assert.equal(prepared.identity.contract, f.api.RUNTIME_CONTRACT);
    assert.equal(prepared.identity.model, 'claude-opus-5[1m]');
    assert.equal(f.calls.length, 5, 'normal metadata probes including two auth checks still run');
    await prepared.launch(launch => {
      assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
      assert.equal(launch.env.ANTHROPIC_API_KEY, '');
      assert.ok(!launch.args.includes('--permission-mode'), 'diagnostic compatibility adds no permission override');
    });
    assert.equal(f.calls.length, 6, 'launch retains the identity recheck');
  }
});

nativeTest('new wording is exact-version while established legacy contracts remain accepted', async t => {
  for (const version of ['2.1.264', '2.1.318', nativeVersion, '2.1.320', '2.1.321', '2.1.323']) {
    const f = await fixture(t, version);
    f.doctorOutput = `${REMOTE}\n${LEGACY}\n`;
    assert.equal((await f.runtime().preflight({ cwd: f.project })).identity.version, version);
    if (version !== nativeVersion) {
      f.doctorOutput = `${REMOTE}\n${CURRENT}\n`;
      await assert.rejects(f.runtime().preflight({ cwd: f.project }), refused('NATIVE_POLICY'));
    }
  }
});

nativeTest('personal status remains exact, singular and complete across stdout and stderr', async t => {
  const f = await fixture(t);
  f.doctorOutput = `\x1b[32m${REMOTE}\x1b[0m\n`;
  f.doctorStderr = `  ${CURRENT}  \n`;
  assert.equal((await f.runtime().preflight({ cwd: f.project })).identity.version, nativeVersion);
  f.doctorStderr = '';
  for (const output of [
    '', REMOTE, CURRENT,
    `${REMOTE}\n${CURRENT}!`,
    `${REMOTE}\nOrganization policy: Loaded from api.anthropic.com`,
    `${REMOTE}\nOrganization policy: loaded`,
    `${REMOTE}\nOrganization policy: unknown ${SENTINEL}`,
    `${REMOTE}\nOrganization policy: checking… (fetch in progress; re-run in a moment)`,
    `Managed settings (remote): loaded\n${CURRENT}`,
    `Managed settings (remote): checking… (fetch in progress; re-run in a moment)\n${CURRENT}`,
    `${REMOTE}\n${CURRENT}\n${CURRENT}`,
    `${REMOTE}\n${REMOTE}\n${CURRENT}`,
    `${REMOTE}\n${CURRENT}\n${LEGACY}`,
    `${REMOTE}\n${CURRENT}\nOrganization policy: failed`,
    `${REMOTE}\n${CURRENT}\nOrganization policy update failed`,
    `${REMOTE}\n${CURRENT}\nSettings error: ${SENTINEL}`,
    `${REMOTE}\n${CURRENT}\nInvalid settings: ${SENTINEL}`,
    `${REMOTE}\n${CURRENT}\nSettings failure: ${SENTINEL}`,
  ]) {
    f.doctorOutput = output;
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), refused('NATIVE_POLICY'));
  }
  f.doctorOutput = `${REMOTE}\n${CURRENT}`;
  for (const failure of ['Settings failed', 'Failed organization policy refresh', 'Organization policy failure']) {
    f.doctorStderr = failure;
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), refused('NATIVE_POLICY'));
  }
});

nativeTest('the new diagnostic never substitutes for account eligibility or Team policy attestation', async t => {
  const f = await fixture(t);
  f.doctorOutput = `${REMOTE}\n${CURRENT}`;
  const account = { ...f.account };
  for (const patch of [{ loggedIn: false }, { authMethod: 'apiKey' }, { apiProvider: 'bedrock' },
    { subscriptionType: 'enterprise' }, { subscriptionType: 'unknown' }, { email: null, orgId: null }]) {
    f.account = { ...account, ...patch };
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), refused('NATIVE_AUTH'));
  }
  f.account = { ...account, subscriptionType: 'team' };
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), refused('NATIVE_POLICY'));
});
}
