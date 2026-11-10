'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { synthetic } = require('./native-runtime-fixture');

const KEY = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const policy = allowed => ({ restrictions: {
  allow_connector_file_downloads: { allowed }, allow_quick_web_setup: { allowed: !allowed },
  enforce_web_search_mcp_isolation: { allowed },
}, compliance_taints: [], monitoring_notice: null, defaults: { remote_control_at_startup: false } });
const conflict = (reason, source) => err => {
  assert.equal(err.code, 'NATIVE_CONFLICT');
  assert.equal(err.reason, reason); assert.equal(err.source, source);
  assert.ok(!JSON.stringify(err).includes(KEY));
  return true;
};

test('legacy native schema still requires manual settings cleanup and preserves policy booleans', async t => {
  for (const allowed of [false, true]) {
    const f = await synthetic(); t.after(() => f.close());
    const original = { theme: 'dark', permissions: { deny: ['Read(./private.txt)'], ask: ['Bash(git push *)'] },
      env: { ISSUE2_RETAINED: 'retained', [KEY]: '1' } };
    await f.json('config/settings.json', original);
    await f.json('config/policy-limits.json', policy(allowed));
    const policyFile = path.join(f.config, 'policy-limits.json');
    const policyBytes = await fs.readFile(policyFile);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS'));
    assert.deepEqual(f.calls, [{ kind: 'version' }], 'legacy refusal follows only the guarded version probe');
    // This is the documented operator action on a synthetic file, not an
    // automatic migration or a production validator exception.
    const cleaned = structuredClone(original); delete cleaned.env[KEY];
    await f.json('config/settings.json', cleaned);
    const prepared = await f.runtime().preflight({ cwd: f.project });
    assert.equal(prepared.identity.model, 'claude-opus-5[1m]');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'settings.json'), 'utf8')), {
      theme: original.theme, permissions: original.permissions, env: { ISSUE2_RETAINED: 'retained' },
    });
    assert.deepEqual(await fs.readFile(policyFile), policyBytes);
    assert.deepEqual(original.env, { ISSUE2_RETAINED: 'retained', [KEY]: '1' });
  }
});

test('settings cleanup does not admit malformed policy, replacement controls or malformed env', async t => {
  const f = await synthetic(); t.after(() => f.close());
  const original = { env: { [KEY]: '1' } };
  await f.json('config/settings.json', original);
  const cleaned = structuredClone(original); delete cleaned.env[KEY];
  await f.json('config/settings.json', cleaned);
  for (const allowed of [false, true]) {
    const malformed = policy(false); malformed.restrictions.allow_cobalt_plinth_alkanet = { allowed, unsupported: true };
    await f.json('config/policy-limits.json', malformed);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('POLICY_CACHE_RESTRICTION', 'POLICY_CACHE'));
  }
  await f.json('config/policy-limits.json', policy(false));
  for (const env of [{ [KEY + '_TYPO']: '1' }, { CLAUDE_CODE_NEW_CONTROL: '1' }]) {
    await f.json('config/settings.json', { env });
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), conflict('SETTINGS_PROHIBITED_ENV', 'USER_SETTINGS'));
  }
  for (const value of [null, false, true, 0, {}, [], 'contains\0nul']) {
    await f.json('config/settings.json', { env: { [KEY]: value } });
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), { code: 'NATIVE_SOURCE' });
  }
  assert.equal(f.calls.length, 0, 'every unsafe source fails before native metadata or task launch');
});

test('launch environment still rejects every value and case before a native process', async t => {
  const f = await synthetic(); t.after(() => f.close());
  for (const name of [KEY, KEY.toLowerCase()]) for (const value of ['', '0', '1', 'false', 'synthetic']) {
    await assert.rejects(f.runtime({ parentEnv: { ...f.parentEnv, [name]: value } }).preflight({ cwd: f.project }),
      conflict('PARENT_ENV_CONFLICT', 'PARENT_ENV'));
  }
  assert.equal(f.calls.length, 0);
});

test('reintroducing the settings control after cleanup invalidates the prepared source snapshot', async t => {
  const f = await synthetic(); t.after(() => f.close());
  await f.json('config/settings.json', { env: { ISSUE2_RETAINED: 'retained' } });
  const prepared = await f.runtime().preflight({ cwd: f.project });
  await f.json('config/settings.json', { env: { ISSUE2_RETAINED: 'retained', [KEY]: '1' } });
  await assert.rejects(prepared.launch(() => assert.fail('source drift must prevent launch')), { code: 'NATIVE_DRIFT' });
});
