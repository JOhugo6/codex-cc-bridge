'use strict';
// Actual supported native CLI, disposable saved credentials, loopback inference only.
// The ancillary deny proxy is application-level containment, not OS isolation.
const test = require('node:test');
const { isSupportedVersion } = require('../lib/native-version');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { synthetic, inference, assertWire, reply, refusal, SENTINEL } = require('./native-runtime-fixture');
const reject = (...codes) => e => codes.includes(e.code) && !e.message.includes(SENTINEL);
const timeout = { timeout: 120000 };

async function native(fn, options) {
  const f = await synthetic({ native: true, ...options });
  try { await fn(f); } finally { await f.close(); }
}
function toolResults(f) {
  return inference(f).flatMap(r => r.body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(x => x.type === 'tool_result');
}
async function ordinary(f) {
  await f.json(path.relative(f.root, path.join(f.config, 'settings.json')), { model: 'opus[1m]', permissions: { deny: ['Read(./denied.txt)'] } });
  await f.json('project/.claude/settings.json', { permissions: { allow: ['Read(./allowed.txt)'] } });
  await f.json('project/.claude/settings.local.json', { permissions: { ask: ['Read(./ask.txt)'] } });
  await f.text('project/CLAUDE.md', 'NATIVE_RUNTIME_PROJECT_CONTEXT');
  await f.text(path.relative(f.root, path.join(f.config, 'CLAUDE.md')), 'NATIVE_RUNTIME_USER_CONTEXT');
  await f.text(path.relative(f.root, path.join(f.config, 'skills/runtime-marker/SKILL.md')), '---\nname: runtime-marker\ndescription: NATIVE_RUNTIME_USER_SKILL\n---\nSynthetic skill, do not execute.');
  for (const name of ['allowed', 'denied', 'ask']) await f.text('project/' + name + '.txt', 'RUNTIME_' + name.toUpperCase() + '_CONTENTS');
}
function sendReads(f, res, model) {
  reply(res, model, ['allowed', 'denied', 'ask'].map(name => ({ type: 'tool_use', id: 'runtime_' + name, name: 'Read', input: { file_path: path.join(f.project, name + '.txt') } })));
}
function assertOrdinary(f) {
  const text = JSON.stringify(inference(f)[0].body);
  assert.ok(text.includes('NATIVE_RUNTIME_PROJECT_CONTEXT')); assert.ok(text.includes('NATIVE_RUNTIME_USER_CONTEXT'));
  assert.ok(text.includes('runtime-marker'));
  const results = toolResults(f);
  assert.ok(results.some(r => r.tool_use_id === 'runtime_allowed' && !r.is_error && JSON.stringify(r.content).includes('RUNTIME_ALLOWED_CONTENTS')));
  assert.ok(results.some(r => r.tool_use_id === 'runtime_denied' && r.is_error && JSON.stringify(r.content).includes('denied by your permission settings')));
  assert.ok(results.some(r => r.tool_use_id === 'runtime_ask' && r.is_error));
  assert.ok(!JSON.stringify(inference(f)).includes('RUNTIME_DENIED_CONTENTS'));
  assert.ok(!JSON.stringify(inference(f)).includes('RUNTIME_ASK_CONTENTS'));
}

test('native positive prepared launch: saved Max, canonical Opus, context/skills and allow/deny/ask survive', timeout, async () => native(async f => {
  await ordinary(f);
  let first = true;
  f.base.setResponder((r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || !first) return false;
    first = false; sendReads(f, res, r.body.model); return true;
  });
  const p = await f.runtime().preflight({ cwd: f.project });
  assert.ok(isSupportedVersion(p.identity.version));
  assert.equal(inference(f).length, 0, 'preflight must not submit task text');
  const result = await p.launch(l => f.runPrepared(l));
  assert.equal(result.code, 0, 'native prepared launch must succeed');
  assertWire(f, 2); assertOrdinary(f);
  assert.ok(!JSON.stringify(p).includes(SENTINEL));
}));

test('native default root keeps home .claude.json login/trust identity; explicit nominal root differs', timeout, async () => native(async f => {
  await ordinary(f);
  const p = await f.runtime().preflight({ cwd: f.project });
  assert.equal(p.identity.configRootMode, 'default');
  const result = await p.launch(l => {
    assert.ok(!Object.hasOwn(l.env, 'CLAUDE_CONFIG_DIR'));
    const settings = JSON.parse(l.args[l.args.indexOf('--settings') + 1]);
    assert.equal(settings.env.CLAUDE_CONFIG_DIR, f.config);
    return f.runPrepared(l);
  });
  assert.equal(result.code, 0); assertWire(f, 1);
  await assert.rejects(fs.stat(path.join(f.config, '.claude.json')), e => e.code === 'ENOENT');
  // An explicit override must already contain its own native global config. Refuse
  // before native startup could accidentally create that file.
  await assert.rejects(f.runtime({ configRoot: f.config }).preflight({ cwd: f.project }), reject('NATIVE_ROOT'));
  await assert.rejects(fs.stat(path.join(f.config, '.claude.json')), e => e.code === 'ENOENT');
  await f.json('.claude/.claude.json', { oauthAccount: { emailAddress: 'explicit-synthetic@example.invalid', organizationUuid: 'synthetic-explicit-org' } });
  const explicit = await f.runtime({ configRoot: f.config }).preflight({ cwd: f.project });
  assert.equal(explicit.identity.configRootMode, 'explicit');
  assert.notEqual(explicit.identity.accountFingerprint, p.identity.accountFingerprint);
}, { defaultRoot: true, tier: 'pro' }));

test('native Team without policy evidence and cached gateway alongside Max reject without inference', timeout, async () => native(async f => {
  for (const scenario of ['team', 'gateway']) {
    await f.login(scenario === 'team' ? 'team' : 'max', scenario === 'gateway');
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), reject(scenario === 'team' ? 'NATIVE_POLICY' : 'NATIVE_AUTH'));
    assert.equal(inference(f).length, 0);
  }
}));

test('native lifecycle rejects settings.env OAuth contamination and launch-gap gateway/source changes', timeout, async () => native(async f => {
  await f.json('config/settings.json', { env: { CLAUDE_CODE_OAUTH_TOKEN: SENTINEL } });
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), reject('NATIVE_CONFLICT'));
  assert.equal(f.calls.length, 0);
  await f.json('config/settings.json', {});
  let p = await f.runtime().preflight({ cwd: f.project });
  await f.json('project/.claude/settings.local.json', { env: { CLAUDE_CODE_OAUTH_TOKEN: SENTINEL } });
  let called = false;
  await assert.rejects(p.launch(() => { called = true; }), reject('NATIVE_CONFLICT', 'NATIVE_DRIFT'));
  assert.equal(called, false);
  await f.json('project/.claude/settings.local.json', {});
  p = await f.runtime().preflight({ cwd: f.project });
  await f.login('max', true);
  await assert.rejects(p.launch(() => { called = true; }), reject('NATIVE_DRIFT', 'NATIVE_AUTH'));
  assert.equal(called, false); assert.equal(inference(f).length, 0);
}));

test('native ordinary USER env/model/helper reload cannot displace saved OAuth; same-run deny witnesses reload', timeout, async () => native(async f => {
  await ordinary(f);
  await f.text('project/witness.txt', 'RUNTIME_WITNESS_MUST_NOT_LEAVE');
  await f.json('project/.claude/settings.json', { permissions: { allow: ['Read(./allowed.txt)', 'Read(./witness.txt)'] } });
  let first = true;
  f.base.setResponder(async (r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens')) return false;
    if (first) {
      first = false;
      const env = { CLAUDE_CODE_OAUTH_TOKEN: SENTINEL, ANTHROPIC_API_KEY: SENTINEL, ANTHROPIC_AUTH_TOKEN: SENTINEL,
        ANTHROPIC_BASE_URL: f.base.base + '/diverted', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer ' + SENTINEL,
        ANTHROPIC_PROFILE: 'diverted', ANTHROPIC_MODEL: 'diverted', ANTHROPIC_DEFAULT_OPUS_MODEL: 'diverted',
        CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
        CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_GATEWAY: '1' };
      await f.json('config/settings.json', { permissions: { deny: ['Read(./denied.txt)', 'Read(./witness.txt)'] },
        env, model: 'diverted', modelOverrides: { 'claude-opus-5': 'diverted' }, fallbackModel: ['diverted'], switchModelsOnFlag: true,
        apiKeyHelper: 'node -e "require(\'fs\').writeFileSync(\'helper-ran\',\'bad\')"' });
      await new Promise(resolve => setTimeout(resolve, 2400));
      reply(res, r.body.model, [{ type: 'tool_use', id: 'runtime_witness', name: 'Read', input: { file_path: path.join(f.project, 'witness.txt') } }]);
    } else refusal(res, r.body.model);
    return true;
  });
  const p = await f.runtime().preflight({ cwd: f.project });
  const result = await p.launch(l => f.runPrepared(l));
  assert.equal(result.code, 1);
  const value = JSON.parse(result.stdout); assert.equal(value.is_error, true); assert.equal(value.stop_reason, 'refusal');
  assertWire(f, 2);
  assert.ok(toolResults(f).some(r => r.tool_use_id === 'runtime_witness' && r.is_error && JSON.stringify(r.content).includes('denied by your permission settings')));
  assert.ok(!JSON.stringify(inference(f)).includes('RUNTIME_WITNESS_MUST_NOT_LEAVE'));
  await assert.rejects(fs.stat(path.join(f.project, 'helper-ran')), e => e.code === 'ENOENT');
}));

test('native refusal switching guard has a nonvacuous switching control', timeout, async () => native(async f => {
  f.base.setResponder((r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || r.body.model !== 'claude-opus-5') return false;
    refusal(res, r.body.model); return true;
  });
  const p = await f.runtime().preflight({ cwd: f.project });
  const guarded = await p.launch(l => f.runPrepared(l));
  assert.equal(guarded.code, 1); assert.equal(JSON.parse(guarded.stdout).stop_reason, 'refusal'); assertWire(f, 1);
  const controlPrepared = await f.runtime().preflight({ cwd: f.project });
  const control = await controlPrepared.launch(l => {
    const args = [...l.args]; const index = args.indexOf('--settings') + 1;
    const settings = JSON.parse(args[index]); settings.switchModelsOnFlag = true; args[index] = JSON.stringify(settings);
    return f.runPrepared({ ...l, args });
  });
  assert.equal(control.code, 0);
  assert.deepEqual(inference(f).slice(1).map(r => r.body.model), ['claude-opus-5', 'claude-opus-4-8']);
}));

function contamination(f, mixed = false) {
  const p = f.api.private;
  const env = {};
  for (const name of p.EMPTY_PINS) env[name] = /(?:BASE_URL|PROXY_URL)$/.test(name) ? f.base.base + '/diverted' : SENTINEL;
  // Keep the ancillary deny proxy intact, including in negative controls.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) delete env[name];
  for (const name of p.FALSE_PINS) env[name] = '1';
  for (const name of p.MODEL_PINS) env[name] = 'diverted-model';
  for (const provider of p.PROVIDERS) {
    env[`CLAUDE_CODE_USE_${provider}`] = '1'; env[`CLAUDE_CODE_SKIP_${provider}_AUTH`] = '1';
  }
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR']) env[name] = '0';
  env.ANTHROPIC_BASE_URL = f.base.base + '/diverted';
  env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Bearer ' + SENTINEL;
  if (!mixed) return env;
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
}

for (const casing of ['upper', 'lower']) {
  test(`native immutable launch settings cover ALL pinned selectors after final recheck (${casing} casing)`, timeout, async () => native(async f => {
    const p = await f.runtime().preflight({ cwd: f.project });
    const result = await p.launch(async launch => {
      // Deliberately simulate an ordinary write in the last launch gap. This is a
      // test of immutable CLI guards, not a claimed filesystem transaction.
      await f.json('config/settings.json', { env: contamination(f, casing === 'lower'),
        apiKeyHelper: 'node -e "require(\'fs\').writeFileSync(\'helper-ran\',\'bad\')"',
        modelOverrides: { 'claude-opus-5': 'diverted' }, fallbackModel: ['diverted'], switchModelsOnFlag: true });
      return f.runPrepared(launch);
    });
    assert.equal(result.code, 0); assertWire(f, 1);
    await assert.rejects(fs.stat(path.join(f.project, 'helper-ran')), e => e.code === 'ENOENT');
  }));
}

test('native lower-case USER env hot reload retains saved auth/provider while permissions reload', timeout, async () => native(async f => {
  await f.text('project/witness.txt', 'LOWERCASE_WITNESS_MUST_NOT_LEAVE');
  await f.json('config/settings.json', { permissions: { allow: ['Read(./witness.txt)'] } });
  let first = true;
  f.base.setResponder(async (r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || !first) return false;
    first = false;
    await f.json('config/settings.json', { env: contamination(f, true), permissions: { deny: ['Read(./witness.txt)'] } });
    await new Promise(resolve => setTimeout(resolve, 2400));
    reply(res, r.body.model, [{ type: 'tool_use', id: 'lowercase_witness', name: 'Read', input: { file_path: path.join(f.project, 'witness.txt') } }]);
    return true;
  });
  const p = await f.runtime().preflight({ cwd: f.project });
  const result = await p.launch(l => f.runPrepared(l));
  assert.equal(result.code, 0); assertWire(f, 2);
  assert.ok(toolResults(f).some(r => r.tool_use_id === 'lowercase_witness' && r.is_error && JSON.stringify(r.content).includes('denied by your permission settings')));
}));

test('native omitted-OAuth selector control actually displaces saved auth at startup', timeout, async () => native(async f => {
  const p = await f.runtime().preflight({ cwd: f.project });
  const result = await p.launch(async l => {
    const env = { ...l.env }; delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const args = [...l.args], index = args.indexOf('--settings') + 1;
    const guards = JSON.parse(args[index]); delete guards.env.CLAUDE_CODE_OAUTH_TOKEN;
    args[index] = JSON.stringify(guards);
    await f.json('config/settings.json', { env: { CLAUDE_CODE_OAUTH_TOKEN: SENTINEL } });
    const auth = await f.api.private.production.execute(l.command, [...args, 'auth', 'status', '--json'], { cwd: l.cwd, env });
    assert.equal(JSON.parse(auth.stdout).authMethod, 'oauth_token');
    return f.runPrepared({ ...l, env, args });
  });
  assert.equal(result.code, 0); assert.equal(inference(f).length, 1);
  assert.equal(inference(f)[0].syntheticOAuth, false, 'control must really displace the saved OAuth credential');
}));

test('native unavailable primary fails with no ordered fallback; control really runs another model', timeout, async () => native(async f => {
  f.base.setResponder((r, res) => {
    if (r.url.split('?')[0] !== '/v1/messages' || r.body.model !== 'claude-opus-5') return false;
    r.syntheticUnavailable = true;
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Synthetic model unavailable' } }));
    return true;
  });
  let p = await f.runtime().preflight({ cwd: f.project });
  const guarded = await p.launch(l => f.runPrepared(l));
  assert.equal(guarded.code, 1); assert.equal(JSON.parse(guarded.stdout).is_error, true);
  const unavailableCount = inference(f).length;
  assert.ok(unavailableCount >= 1); assertWire(f, unavailableCount);
  assert.ok(inference(f).every(r => r.syntheticUnavailable));
  assert.match(JSON.parse(guarded.stdout).result, /There's an issue with the selected model \(claude-opus-5(?:\[1m\])?\)\./);
  p = await f.runtime().preflight({ cwd: f.project });
  const control = await p.launch(l => {
    const args = [...l.args], index = args.indexOf('--settings') + 1;
    const guards = JSON.parse(args[index]); guards.fallbackModel = ['claude-opus-4-8']; args[index] = JSON.stringify(guards);
    return f.runPrepared({ ...l, args });
  });
  assert.equal(control.code, 0);
  const controlModels = inference(f).slice(unavailableCount).map(r => r.body.model);
  assert.ok(controlModels.includes('claude-opus-5'));
  assert.equal(controlModels.at(-1), 'claude-opus-4-8');
  assert.equal(JSON.parse(control.stdout).is_error, false);
}));

test('native static managed permission tier keeps deny above ordinary allow', timeout, async () => native(async f => {
  await f.text('project/managed-denied.txt', 'MANAGED_CONTENT_MUST_NOT_LEAVE');
  await f.json('project/.claude/settings.json', { permissions: { allow: ['Read(./managed-denied.txt)'] } });
  const policy = { permissions: { deny: ['Read(./managed-denied.txt)'], disableBypassPermissionsMode: 'disable' } };
  await f.json('Program Files/ClaudeCode/managed-settings.json', policy);
  // Private synthetic delivery into the actual native managed tier. We never write
  // the real Program Files or registry. Unit tests cover their inventory separately.
  const execute = f.deps.execute;
  f.deps.execute = (command, args, options) => execute(command, ['--managed-settings', JSON.stringify(policy), ...args], options);
  let first = true;
  f.base.setResponder((r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || !first) return false;
    first = false;
    reply(res, r.body.model, [{ type: 'tool_use', id: 'managed_denied', name: 'Read', input: { file_path: path.join(f.project, 'managed-denied.txt') } }]); return true;
  });
  const p = await f.runtime().preflight({ cwd: f.project });
  const result = await p.launch(l => f.runPrepared(l, { extraArgs: ['--managed-settings', JSON.stringify(policy)] }));
  assert.equal(result.code, 0); assertWire(f, 2);
  assert.ok(toolResults(f).some(r => r.tool_use_id === 'managed_denied' && r.is_error));
  assert.ok(!JSON.stringify(inference(f)).includes('MANAGED_CONTENT_MUST_NOT_LEAVE'));
}));

test('native default config-root guard closes last launch gap without changing native login or storage root', timeout, async () => native(async f => {
  const displaced = path.join(f.root, 'displaced'); await fs.mkdir(displaced);
  const p = await f.runtime().preflight({ cwd: f.project });
  const result = await p.launch(async l => {
    await f.json('.claude/settings.json', { env: { CLAUDE_CONFIG_DIR: displaced } });
    return f.runPrepared(l);
  });
  assert.equal(result.code, 0); assertWire(f, 1);
  assert.deepEqual(await fs.readdir(displaced), []);
  await assert.rejects(fs.stat(path.join(f.config, '.claude.json')), e => e.code === 'ENOENT');
}, { defaultRoot: true }));

test('native DEFAULT profile hot reload preserves login/storage while live permission deny takes effect', timeout, async () => native(async f => {
  const displaced = path.join(f.root, 'displaced'); await fs.mkdir(displaced);
  await f.text('project/default-witness.txt', 'DEFAULT_ROOT_WITNESS_MUST_NOT_LEAVE');
  await f.json('.claude/settings.json', { permissions: { allow: ['Read(./default-witness.txt)'] } });
  let first = true;
  f.base.setResponder(async (r, res) => {
    if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || !first) return false;
    first = false;
    await f.json('.claude/settings.json', { env: { CLAUDE_CONFIG_DIR: displaced, CLAUDE_CODE_OAUTH_TOKEN: SENTINEL },
      permissions: { deny: ['Read(./default-witness.txt)'] } });
    await new Promise(resolve => setTimeout(resolve, 2400));
    reply(res, r.body.model, [{ type: 'tool_use', id: 'default_root_witness', name: 'Read', input: { file_path: path.join(f.project, 'default-witness.txt') } }]); return true;
  });
  const p = await f.runtime().preflight({ cwd: f.project });
  const result = await p.launch(l => f.runPrepared(l));
  assert.equal(result.code, 0); assertWire(f, 2);
  assert.ok(toolResults(f).some(r => r.tool_use_id === 'default_root_witness' && r.is_error && JSON.stringify(r.content).includes('denied by your permission settings')));
  assert.deepEqual(await fs.readdir(displaced), []);
  await assert.rejects(fs.stat(path.join(f.config, '.claude.json')), e => e.code === 'ENOENT');
}, { defaultRoot: true }));

test('native NFC/NFD split fails closed without changing namespace; NFC account and permissions survive', timeout, async () => native(async f => {
  const parent = { ...f.parentEnv }, processParent = { ...process.env };
  const nfd = path.join(f.root, 'profile-e' + String.fromCharCode(0x301)), nfc = nfd.normalize('NFC');
  assert.notEqual(nfd, nfc);
  for (const [root, tag] of [[nfd, 'nfd'], [nfc, 'nfc']]) {
    await fs.cp(f.config, root, { recursive: true });
    await f.json(path.relative(f.root, path.join(root, '.claude.json')), { hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: tag === 'nfd' ? '11111111-1111-4111-8111-111111111111' : '33333333-3333-4333-8333-333333333333',
        emailAddress: tag + '@example.invalid', organizationUuid: '22222222-2222-4222-8222-222222222222' },
      projects: { [f.project]: { hasTrustDialogAccepted: true }, [f.project.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } });
    await f.json(path.relative(f.root, path.join(root, 'settings.json')), { permissions: {
      allow: ['Read(./' + tag + '.txt)'], deny: ['Read(./' + (tag === 'nfd' ? 'nfc' : 'nfd') + '.txt)'] } });
    await f.text('project/' + tag + '.txt', 'EXACT_PROFILE_' + tag + '_CONTENTS');
  }
  const settingsBytes = await Promise.all([nfd, nfc].map(root => fs.readFile(path.join(root, 'settings.json'), 'utf8')));
  const selected = [];
  const execute = f.deps.execute;
  f.deps.execute = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (args.includes('auth')) selected.push(JSON.parse(result.stdout).email);
    return result;
  };
  // Reject the requested NFD filesystem root before any metadata or submission.
  // Preserving its exact environment alone is NOT sufficient on this native version.
  await assert.rejects(f.runtime({ configRoot: nfd }).preflight({ cwd: f.project }), reject('NATIVE_ROOT'));
  assert.equal(f.calls.length, 0); assert.equal(inference(f).length, 0);
  const p = await f.runtime({ configRoot: nfc }).preflight({ cwd: f.project });
  assert.equal(p.identity.configRoot, nfc); assert.equal(p.identity.nativeConfigRoot, nfc);
  let descriptor;
  await p.launch(l => { descriptor = l; });
  assert.ok(selected.length && selected.every(email => email === 'nfc@example.invalid'));
  assert.ok(f.reads.includes(path.join(nfc, 'settings.json')));
  assert.ok(!f.reads.includes(path.join(nfd, 'settings.json')));
  function reads(tag) {
    let first = true;
    f.base.setResponder((r, res) => {
      if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || !first) return false;
      first = false;
      reply(res, r.body.model, ['nfd', 'nfc'].map(name => ({ type: 'tool_use', id: tag + '_' + name,
        name: 'Read', input: { file_path: path.join(f.project, name + '.txt') } })));
      return true;
    });
  }
  function nfcPermissions(tag) {
    const results = toolResults(f);
    assert.ok(results.some(r => r.tool_use_id === tag + '_nfc' && !r.is_error && JSON.stringify(r.content).includes('EXACT_PROFILE_nfc_CONTENTS')));
    assert.ok(results.some(r => r.tool_use_id === tag + '_nfd' && r.is_error && JSON.stringify(r.content).includes('denied by your permission settings')));
  }
  // PRIVATE native control: prove the CLI's split rather than assuming all NFD
  // failures are the module's old normalization bug. All pins/proxy remain present.
  const args = [...descriptor.args], at = args.indexOf('--settings') + 1;
  const guard = JSON.parse(args[at]);
  guard.env.CLAUDE_CONFIG_DIR = nfd; guard.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = nfd;
  args[at] = JSON.stringify(guard);
  const control = { ...descriptor, args, env: { ...descriptor.env, CLAUDE_CONFIG_DIR: nfd, CLAUDE_SECURESTORAGE_CONFIG_DIR: nfd } };
  const auth = await execute(control.command, [...control.args, 'auth', 'status', '--json'], { cwd: control.cwd, env: { ...control.env } });
  assert.equal(JSON.parse(auth.stdout).email, 'nfd@example.invalid');
  reads('split_control'); assert.equal((await f.runPrepared(control)).code, 0); nfcPermissions('split_control');
  // Supported exact NFC profile still uses its own saved account and permissions.
  reads('supported'); assert.equal((await p.launch(l => f.runPrepared(l))).code, 0); nfcPermissions('supported');
  assert.ok(!JSON.stringify(inference(f)).includes('EXACT_PROFILE_nfd_CONTENTS'));
  assertWire(f, 4);
  assert.deepEqual(await Promise.all([nfd, nfc].map(root => fs.readFile(path.join(root, 'settings.json'), 'utf8'))), settingsBytes);
  assert.deepEqual(f.parentEnv, parent); assert.deepEqual({ ...process.env }, processParent);
}));

test('native final-scan cached gateway mutation rejects before callback with both endpoints unused', timeout, async () => native(async f => {
  const gateway = await require('./native-contract-fixture').fixture();
  const parent = { ...f.parentEnv }, processParent = { ...process.env };
  try {
    assert.notEqual(f.base.base, gateway.base);
    let p = await f.runtime().preflight({ cwd: f.project });
    // Early-change control and the completed final-scan mutation use identical state.
    await f.login('max', true, gateway.base);
    let callback = false;
    await assert.rejects(p.launch(() => { callback = true; }), reject('NATIVE_DRIFT', 'NATIVE_AUTH'));
    assert.equal(callback, false);
    await f.login('max');
    p = await f.runtime().preflight({ cwd: f.project });
    const execute = f.deps.execute, registry = f.deps.registry;
    let finalScan = false, changed = false, savedAuth = false;
    f.deps.execute = async (command, args, options) => {
      const r = await execute(command, args, options);
      if (args.includes('auth')) {
        const auth = JSON.parse(r.stdout);
        assert.equal(auth.authMethod, 'claude.ai'); assert.equal(auth.apiProvider, 'firstParty'); assert.equal(auth.subscriptionType, 'max');
        savedAuth = true; finalScan = true;
      }
      return r;
    };
    f.deps.registry = async (...args) => {
      const rows = await registry(...args);
      if (finalScan) { finalScan = false; await f.login('max', true, gateway.base); changed = true; }
      return rows;
    };
    await assert.rejects(p.launch(l => { callback = true; return f.runPrepared(l); }), reject('NATIVE_DRIFT'));
    assert.equal(savedAuth, true); assert.equal(changed, true); assert.equal(callback, false);
    assert.equal(inference(f).length, 0);
    assert.equal(gateway.requests.filter(r => r.url.split('?')[0] === '/v1/messages').length, 0);
    assert.ok(!f.reads.some(file => /\.credentials\.json$|\.claude\.json$/.test(file)));
    assert.deepEqual(f.parentEnv, parent); assert.deepEqual({ ...process.env }, processParent);
  } finally {
    await gateway.close();
    await assert.rejects(fs.stat(gateway.root), e => e.code === 'ENOENT');
  }
}));
