'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { teamFixture, REMOTE } = require('./team-fixture');
const { teamTlsFixture } = require('./team-tls-fixture');
const { reply, assertWire, inference } = require('./native-runtime-fixture');

async function fixture(t) {
  const f = await teamFixture({ native: true });
  const tls = await teamTlsFixture();
  t.after(async () => { await tls.close(); await f.close(); });
  f.deps.endpoint = 'https://api.anthropic.com';
  f.deps.transportEnv = tls.transportEnv;
  return { f, tls };
}

test('actual native Team saved login attests both caches over local TLS and enforces managed Read denial', { timeout: 120000 }, async t => {
  const { f, tls } = await fixture(t);
  await f.json('project/.claude/settings.json', { permissions: { allow: ['Read'] } });
  await f.text('project/allowed.txt', 'TEAM_ALLOWED_CONTENT');
  await f.text('project/denied.txt', 'TEAM_DENIED_CONTENT');
  let first = true;
  tls.setResponder((r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || !first) return false;
    first = false;
    reply(res, r.body.model, ['allowed', 'denied'].map(name => ({ type: 'tool_use', id: `team_${name}`, name: 'Read',
      input: { file_path: path.join(f.project, `${name}.txt`) } })));
    return true;
  });
  const remoteBefore = await fs.readFile(path.join(f.config, 'remote-settings.json'), 'utf8');
  const p = await f.runtime().preflight({ cwd: f.project });
  assert.equal(p.identity.contract, 'native-windows-team/304-policy-snapshot/v1');
  assert.equal(inference({ base: tls }).length, 0);
  const result = await p.launch(l => f.runPrepared(l));
  assert.equal(result.code, 0);
  assertWire({ base: tls }, 2);
  const messages = inference({ base: tls }).flatMap(r => r.body.messages || []);
  const results = messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(x => x.type === 'tool_result');
  assert.ok(results.some(r => r.tool_use_id === 'team_allowed' && !r.is_error && JSON.stringify(r.content).includes('TEAM_ALLOWED_CONTENT')));
  assert.ok(results.some(r => r.tool_use_id === 'team_denied' && r.is_error && JSON.stringify(r.content).includes('denied by your permission settings')));
  assert.ok(!JSON.stringify(messages).includes('TEAM_DENIED_CONTENT'));
  assert.equal(await fs.readFile(path.join(f.config, 'remote-settings.json'), 'utf8'), remoteBefore);
  for (const endpoint of ['/api/claude_code/settings', '/api/claude_code/policy_limits']) {
    const requests = tls.requests.filter(r => r.url.startsWith(endpoint));
    assert.ok(requests.length >= 2, 'preflight and launch both require policy revalidation');
    assert.ok(requests.every(r => r.syntheticOAuth && /^"sha256:[a-f0-9]{64}"$/.test(r.etag)));
  }
});

test('actual native Team rejects missing remote freshness and never submits inference', { timeout: 120000 }, async t => {
  const { f, tls } = await fixture(t);
  tls.setResponder((r, res) => {
    if (!r.url.startsWith('/api/claude_code/settings')) return false;
    // Valid transport with no successful policy result cannot be treated as 304.
    res.writeHead(403, { 'content-type': 'application/json' }).end('{}'); return true;
  });
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), e => ['NATIVE_POLICY', 'NATIVE_DIAGNOSTIC'].includes(e.code));
  assert.equal(inference({ base: tls }).length, 0);
});

test('actual native Team completes delayed 304 policy attestation despite an early checking snapshot', { timeout: 120000 }, async t => {
  const { f, tls } = await fixture(t);
  tls.setResponder(async (r, res) => {
    if (!r.url.startsWith('/api/claude_code/settings') && !r.url.startsWith('/api/claude_code/policy_limits')) return false;
    assert.match(r.etag, /^"sha256:[a-f0-9]{64}"$/);
    // Doctor prints the remote status before awaiting organization policy.
    // Hold that wait longer so the remote 304 completes after the snapshot.
    await new Promise(resolve => setTimeout(resolve, r.url.startsWith('/api/claude_code/settings') ? 500 : 1500));
    res.writeHead(304).end();
    return true;
  });
  const execute = f.deps.execute;
  const doctors = [];
  f.deps.execute = async (...args) => {
    const result = await execute(...args);
    if (args[1].includes('doctor')) doctors.push(result);
    return result;
  };
  const p = await f.runtime().preflight({ cwd: f.project });
  await p.launch(() => {});
  assert.equal(doctors.length, 2, 'preflight and launch each complete a single fresh doctor');
  for (const result of doctors) {
    assert.match(result.stdout, /Managed settings \(remote\): checking… \(fetch in progress; re-run in a moment\)/);
    for (const marker of ['Remote settings: Using cached settings (304)', 'Remote settings: Cache still valid (304 Not Modified)',
      'Policy limits: Using cached restrictions (304)', 'Policy limits: Cache still valid (304 Not Modified)']) assert.ok(result.stderr.includes(marker));
  }
  assert.equal(inference({ base: tls }).length, 0);
});

test('actual native Team policy edits between preparation and launch prevent submission', { timeout: 120000 }, async t => {
  const { f, tls } = await fixture(t);
  const p = await f.runtime().preflight({ cwd: f.project });
  await f.json('config/remote-settings.json', { ...REMOTE, permissions: { deny: ['Read'] } });
  let submitted = false;
  await assert.rejects(p.launch(() => { submitted = true; }), { code: 'NATIVE_DRIFT' });
  assert.equal(submitted, false);
  assert.equal(inference({ base: tls }).length, 0);
});
