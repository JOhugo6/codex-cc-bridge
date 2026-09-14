'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const runtime = require('../lib/native-runtime');
const { synthetic, internals, nativeExecutable, SENTINEL } = require('./native-runtime-fixture');
const { privateModule } = require('./diagnostic-fixture');
const rejection = (...codes) => e => codes.includes(e.code) && !e.message.includes(SENTINEL);

async function withFixture(fn, options) {
  const f = await synthetic(options);
  try { await fn(f); } finally { await f.close(); }
}

test('version gate compares stable releases numerically and rejects the baseline or malformed output', async () => withFixture(async f => {
  const original = f.deps.execute;
  for (const version of ['2.1.264', '2.1.268', '2.1.1000', '2.2.0', '3.0.0']) {
    f.deps.execute = (command, args, options) => args.includes('--version')
      ? Promise.resolve({ stdout: `${version} (Claude Code)\n`, stderr: '' }) : original(command, args, options);
    const p = await f.runtime().preflight({ cwd: f.project });
    assert.equal(p.identity.version, version);
    assert.equal(runtime.validateIdentity(p.identity), true);
    await p.launch(() => {});
  }
  for (const version of ['2.1.263', '2.1.262', '2.1.99', '2.0.999', '1.99.999',
    '2.1.268-beta.1', '2.1.268+build', '02.1.268', '2.1', 'garbage', '2.1.268 (Claude Code)\nextra']) {
    f.deps.execute = (command, args, options) => args.includes('--version')
      ? Promise.resolve({ stdout: `${version} (Claude Code)`, stderr: '' }) : original(command, args, options);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_COMPATIBILITY'));
  }
}));

test('runtime identity records the actual version and rejects version changes on continuation', async () => withFixture(async f => {
  const first = await f.runtime().preflight({ cwd: f.project });
  const original = f.deps.execute;
  f.deps.execute = (command, args, options) => args.includes('--version')
    ? Promise.resolve({ stdout: '2.1.268 (Claude Code)', stderr: '' }) : original(command, args, options);
  await assert.rejects(f.runtime().preflight({ cwd: f.project, expectedIdentity: first.identity }), rejection('NATIVE_DRIFT'));
  const current = await f.runtime().preflight({ cwd: f.project });
  assert.equal(current.identity.version, '2.1.268');
  for (const version of ['2.1.263', '2.0.999', '2.1.268-beta.1', null, 268]) {
    assert.throws(() => runtime.validateIdentity({ ...current.identity, version }), rejection('NATIVE_INPUT'));
  }
}));

test('pure versioned catalog: explicit precedence, aliases and invalid models; no authentication', () => {
  assert.equal(runtime.resolveModel(), 'claude-opus-5[1m]');
  assert.equal(runtime.resolveModel(undefined, 'claude-opus-5'), 'claude-opus-5');
  assert.equal(runtime.resolveModel('opus', 'claude-opus-5'), 'claude-opus-5[1m]');
  for (const [alias, canonical] of Object.entries(runtime.MODEL_CATALOG)) assert.equal(runtime.resolveModel(alias), canonical);
  for (const bad of ['gpt-5', 'inherit', 'default', 'opusplan', 'unknown', 'Opus', ' opus ', '__proto__', '', null, {}, 4]) {
    assert.throws(() => runtime.resolveModel(bad), rejection('NATIVE_MODEL'));
  }
  assert.ok(Object.isFrozen(runtime.MODEL_CATALOG));
  assert.deepEqual(Object.keys(runtime).sort(), ['MODEL_CATALOG', 'RUNTIME_CONTRACT', 'createNativeRuntime', 'resolveModel', 'validateIdentity', 'validateSettings'].sort());
  assert.throws(() => runtime.createNativeRuntime({ endpoint: 'http://127.0.0.1' }), rejection('NATIVE_INPUT'));
});

test('settings allow permissions/MCP/skills, reject nested routing and unknown/dynamic policy', () => {
  const ordinary = { model: 'opus[1m]', permissions: { allow: ['Read'], deny: ['Bash(*)'], ask: ['WebFetch'] },
    env: { PROJECT_COLOR: 'blue' }, enabledPlugins: { 'local@market': true }, skillOverrides: {},
    hooks: { Stop: [] }, enabledMcpjsonServers: ['shared'], fallbackModel: [], switchModelsOnFlag: false, modelOverrides: {} };
  const before = structuredClone(ordinary);
  assert.equal(runtime.validateSettings(ordinary), true); assert.deepEqual(ordinary, before);
  assert.equal(runtime.validateSettings({ permissions: ordinary.permissions }, { managed: true }), true);
  for (const v of [null, [], { permissions: [] }, { permissions: { deny: 'Read' } }, { env: { COLOR: null } }]) {
    assert.throws(() => runtime.validateSettings(v), rejection('NATIVE_SOURCE', 'NATIVE_INPUT'));
  }
  for (const v of [{ policyHelper: { path: SENTINEL } }, { apiKeyHelper: SENTINEL }, { modelOverrides: { 'claude-opus-5': SENTINEL } },
    { fallbackModel: ['claude-opus-5'] }, { switchModelsOnFlag: true }, { forceLoginGatewayUrl: SENTINEL },
    { processWrapper: SENTINEL }, { modelSettings: { opus: { baseUrl: SENTINEL } } }, { managedSourcesBehavior: 'merge' }, { unknown: SENTINEL }]) {
    assert.throws(() => runtime.validateSettings(v), rejection('NATIVE_CONFLICT'));
  }
  const names = ['anthropic_base_url', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_CODE_PROCESS_WRAPPER', 'CLAUDE_CONFIG_DIR',
    'HOME', 'APPDATA', 'ANTHROPIC_CONFIG_DIR', 'NODE_OPTIONS', 'HTTPS_PROXY', 'SYSTEMROOT', 'CLAUDE_CODE_NEW_UNKNOWN_SELECTOR'];
  for (const name of names) assert.throws(() => runtime.validateSettings({ env: { [name]: SENTINEL } }), rejection('NATIVE_CONFLICT'));
  assert.throws(() => runtime.validateSettings({ model: 'opus' }, { managed: true }), rejection('NATIVE_CONFLICT'));
});

test('ordinary native UI, per-model effort, agent teams and saved MCP preferences survive preflight', async () => withFixture(async f => {
  const settings = { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', MCP_TIMEOUT: '10000' },
    modelSettings: { 'gpt-5.6-sol': { effortLevel: 'high' }, 'claude-fable-5': { effortLevel: 'max' } },
    tui: 'fullscreen', theme: 'dark', skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true, agentPushNotifEnabled: false,
    mcpServers: { saved: { command: 'must-never-start', env: { ANTHROPIC_API_KEY: SENTINEL } } } };
  assert.equal(runtime.validateSettings(settings), true);
  const file = path.join(f.config, 'settings.json');
  await f.json(path.relative(f.root, file), settings);
  const prepared = await f.runtime({ parentEnv: { ...f.parentEnv, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }).preflight({ cwd: f.project });
  await prepared.launch(l => {
    assert.ok(l.args.includes('--strict-mcp-config'));
    assert.equal(l.args[l.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.equal(l.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
    assert.ok(!JSON.stringify(l).includes(SENTINEL));
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), settings);
  for (const malformed of [{ modelSettings: [] }, { modelSettings: { opus: null } },
    { modelSettings: { opus: { effortLevel: 'unrecognized' } } }, { tui: false },
    { theme: {} }, { skipAutoPermissionPrompt: 'true' }, { mcpServers: [] }]) {
    assert.throws(() => runtime.validateSettings(malformed), rejection('NATIVE_SOURCE'));
  }
  for (const field of ['env', 'model', 'apiKeyHelper', 'provider']) {
    assert.throws(() => runtime.validateSettings({ modelSettings: { opus: { [field]: SENTINEL } } }), rejection('NATIVE_CONFLICT'));
  }
  assert.throws(() => runtime.validateSettings(settings, { managed: true }), rejection('NATIVE_CONFLICT'));
}));

test('parent sanitation is case insensitive, immutable, private, and never restores deleted values', async () => withFixture(async f => {
  Object.assign(f.parentEnv, { aNtHrOpIc_ApI_kEy: SENTINEL, AnThRoPiC_BaSe_Url: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL, OpenAI_API_KEY: SENTINEL, NODE_OPTIONS: SENTINEL,
    HTTPS_PROXY: SENTINEL, ORDINARY_COLOR: 'blue', 'ProgramFiles(x86)': path.join(f.root, 'programs32') });
  const before = { ...f.parentEnv };
  const r = f.runtime();
  f.parentEnv.ORDINARY_COLOR = 'mutated-after-construction';
  const prepared = await r.preflight({ cwd: f.project });
  assert.equal(runtime.validateIdentity(prepared.identity), true);
  assert.ok(Object.isFrozen(prepared.identity));
  assert.ok(!JSON.stringify(prepared).includes(SENTINEL));
  assert.deepEqual(Object.keys(prepared), ['identity']);
  await prepared.launch(launch => {
    assert.equal(launch.env.ORDINARY_COLOR, 'blue');
    assert.equal(launch.env.ANTHROPIC_API_KEY, ''); assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, '');
    assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.ok(!Object.hasOwn(launch.env, 'NODE_OPTIONS')); assert.ok(!Object.hasOwn(launch.env, 'OPENAI_API_KEY'));
    assert.equal(launch.env.CLAUDE_BRIDGE_CHILD, '1'); assert.equal(launch.shell, false);
    assert.ok(!JSON.stringify(launch.args).includes(SENTINEL));
    assert.ok(Object.isFrozen(launch) && Object.isFrozen(launch.env) && Object.isFrozen(launch.args));
    assert.throws(() => { launch.env.ANTHROPIC_BASE_URL = SENTINEL; }, TypeError);
    const guards = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
    assert.equal(guards.env.CLAUDE_CODE_OAUTH_TOKEN, '');
    assert.deepEqual(guards.fallbackModel, []); assert.equal(guards.switchModelsOnFlag, false);
    assert.deepEqual(guards.modelOverrides, { 'claude-opus-5': 'claude-opus-5' });
  });
  delete before.ORDINARY_COLOR;
  const after = { ...f.parentEnv }; delete after.ORDINARY_COLOR;
  assert.deepEqual(after, before);
  assert.ok(!f.reads.some(p => /credentials/.test(p)));
}));

test('unit fixture canonicalizes owned roots without relaxing containment or native profile aliases', async () => withFixture(async owner => {
  assert.equal(owner.root, await fs.realpath(owner.root));
  const target = path.join(owner.root, 'temp-target'), alias = path.join(owner.root, 'temp-alias');
  await fs.mkdir(target);
  await fs.symlink(target, alias, 'junction');
  const fixture = privateModule('native-runtime-fixture.js', '', { 'node:os': { tmpdir: () => alias } });
  for (const defaultRoot of [true, false]) {
    const f = await fixture.synthetic({ native: false, defaultRoot });
    try {
      assert.equal(f.base, null);
      assert.equal(f.root, await fs.realpath(f.root));
      assert.equal(path.dirname(f.root), target);
      assert.equal(f.config, path.join(f.root, defaultRoot ? '.claude' : 'config'));
      for (const p of [f.config, f.project, f.appdata, f.executable]) assert.equal(p, await fs.realpath(p));
      for (const name of ['HOME', 'USERPROFILE']) assert.equal(f.parentEnv[name], f.root);
      assert.equal(f.deps.ancestorBoundary, f.root);
      const rejected = e => e.code === 'ERR_ASSERTION' && /non-synthetic filesystem access/.test(e.message);
      const beforeStats = [...f.stats], beforeReads = [...f.reads];
      // Neither sibling-prefix matches nor traversal may reach outside the owned root.
      for (const outside of [f.root + '-outside/settings.json', path.join(f.root, '..', 'outside', 'settings.json')]) {
        for (const method of ['stat', 'lstat', 'realpath', 'readdir', 'readFile']) await assert.rejects(f.deps.fs[method](outside), rejected);
        for (const method of ['lstatSync', 'readdirSync']) assert.throws(() => f.deps.syncFs[method](outside), rejected);
        await assert.rejects(f.json(outside, {}), rejected);
        await assert.rejects(f.text(outside, 'never written'), rejected);
      }
      for (const file of [f.globalFile, path.join(f.config, '.credentials.json')]) {
        await assert.rejects(f.deps.fs.readFile(file), /bounded handle reader|credential stores/);
      }
      assert.deepEqual(f.stats, beforeStats); assert.deepEqual(f.reads, beforeReads);
      const configAlias = path.join(f.root, 'config-alias');
      await fs.symlink(f.config, configAlias, 'junction');
      await assert.rejects(f.runtime({ configRoot: configAlias }).preflight({ cwd: f.project }), rejection('NATIVE_ROOT'));
      assert.equal(f.calls.length, 0);
      const settings = { permissions: { allow: ['Read'], deny: ['Bash(*)'] } };
      await f.json(path.relative(f.root, path.join(f.config, 'settings.json')), settings);
      await f.text('project/CLAUDE.md', 'Synthetic project context must remain unchanged.');
      const parentBefore = { ...f.parentEnv };
      const p = await f.runtime().preflight({ cwd: f.project });
      assert.equal(p.identity.configRoot, f.config);
      assert.equal(p.identity.home, f.root);
      assert.equal(p.identity.configRootMode, defaultRoot ? 'default' : 'explicit');
      assert.equal(p.identity.nativeConfigRoot, defaultRoot ? null : f.config);
      await p.launch(l => {
        assert.equal(l.cwd, f.project);
        assert.equal(Object.hasOwn(l.env, 'CLAUDE_CONFIG_DIR'), !defaultRoot);
        if (!defaultRoot) assert.equal(l.env.CLAUDE_CONFIG_DIR, f.config);
      });
      assert.deepEqual(f.parentEnv, parentBefore);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'settings.json'), 'utf8')), settings);
      assert.equal(await fs.readFile(path.join(f.project, 'CLAUDE.md'), 'utf8'), 'Synthetic project context must remain unchanged.');
      assert.ok(!f.reads.some(p => /\.credentials\.json$/.test(p)));
      assert.ok(f.reads.includes(f.globalFile), 'global configuration is inspected only within the synthetic profile');
    } finally { await f.close(); }
  }
}));

test('default root preserves unset semantics; explicit same directory has a distinct identity', async () => withFixture(async f => {
  const prepared = await f.runtime().preflight({ cwd: f.project });
  assert.equal(prepared.identity.configRootMode, 'default');
  await prepared.launch(l => assert.ok(!Object.hasOwn(l.env, 'CLAUDE_CONFIG_DIR')));
  await f.json('.claude/.claude.json', {});
  await f.allowGlobal(path.join(f.config, '.claude.json'));
  const explicit = await f.runtime({ configRoot: f.config }).preflight({ cwd: f.project });
  assert.equal(explicit.identity.configRootMode, 'explicit');
  assert.notEqual(prepared.identity.accountFingerprint, explicit.identity.accountFingerprint);
  await explicit.launch(l => assert.equal(l.env.CLAUDE_CONFIG_DIR, f.config));
  assert.throws(() => f.runtime({ parentEnv: { ...f.parentEnv, CLAUDE_CONFIG_DIR: f.config } }), rejection('NATIVE_ROOT'));
}, { defaultRoot: true }));

test('unsupported selectors fail before diagnostic execution and cannot be passed as private options', async () => withFixture(async f => {
  for (const name of ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
    'CLAUDE_CODE_HOST_MANAGED_SETTINGS', 'CLAUDE_CODE_PROCESS_WRAPPER', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY']) {
    const r = f.runtime({ parentEnv: { ...f.parentEnv, [name]: SENTINEL } });
    await assert.rejects(r.preflight({ cwd: f.project }), rejection('NATIVE_CONFLICT'));
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.runtime({ endpoint: SENTINEL }), rejection('NATIVE_INPUT'));
  assert.throws(() => f.runtime({ executable: 'claude.cmd' }), rejection('NATIVE_INPUT'));
  assert.throws(() => f.runtime({ parentEnv: { ...f.parentEnv, ANTHROPIC_CONFIG_DIR: SENTINEL } }), rejection('NATIVE_ROOT'));
  assert.throws(() => f.runtime({ parentEnv: { ...f.parentEnv, Path: 'one', PATH: 'two' } }), rejection('NATIVE_INPUT'));
}));

test('exact synthetic inventory includes ancestors, both registry views, files/drop-ins, MCP and caches', async () => withFixture(async f => {
  const nested = path.join(f.project, 'nested'); await fs.mkdir(nested);
  for (const relative of ['config/settings.json', 'config/settings.local.json', '.claude/settings.json',
    'project/.claude/settings.local.json', 'project/nested/.claude/settings.json',
    'Program Files/ClaudeCode/managed-settings.json', 'Program Files/ClaudeCode/managed-settings.d/one.json']) {
    await f.json(relative, { permissions: { deny: ['Read(./secret)'] } });
  }
  await f.json('Program Files/ClaudeCode/managed-mcp.json', { mcpServers: { shared: { command: 'never-started' } } });
  await f.json('project/.mcp.json', { mcpServers: { shared: { command: 'never-started' } } });
  f.registered[3] = { ...f.registered[3], present: true, kind: 'String', raw: '{"permissions":{"ask":["Read"]}}', value: '{"permissions":{"ask":["Read"]}}' };
  const prepared = await f.runtime().preflight({ cwd: nested });
  assert.ok(prepared.identity);
  for (const relative of ['config/remote-settings.json', 'config/policy-limits.json', 'appdata/Anthropic',
    'Program Files/ClaudeCode/managed-settings.json', 'Program Files/ClaudeCode/managed-settings.d/one.json',
    'Program Files/ClaudeCode/managed-mcp.json', 'project/.claude/settings.local.json', '.claude/settings.json']) {
    assert.ok(f.stats.includes(path.join(f.root, relative)), relative);
  }
  f.registered[0] = { ...f.registered[0], present: true, kind: 'ExpandString', raw: '{"permissions":{"deny":["Read"]}}', value: '{"permissions":{"deny":["Read"]}}' };
  await assert.rejects(prepared.recheck(), rejection('NATIVE_DRIFT'));
  f.registered[3].value = '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"' + SENTINEL + '"}}';
  await assert.rejects(f.runtime().preflight({ cwd: nested }), rejection('NATIVE_CONFLICT'));
}));

test('registry query adapter uses all four locations, documented Settings value, no shell or policy bypass', async () => {
  const { private: p } = internals();
  let called = false;
  await p.registrySettings({ SYSTEMROOT: 'C:\\synthetic\\Windows' }, async (command, args) => {
    called = true;
    assert.ok(path.isAbsolute(command));
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    assert.ok(!args.includes('-ExecutionPolicy'));
    const script = args.at(-1);
    for (const fragment of ['LocalMachine', 'CurrentUser', 'Registry64', 'Registry32', 'SOFTWARE\\Policies\\ClaudeCode', "'Settings'", 'DoNotExpandEnvironmentNames']) assert.ok(script.includes(fragment));
    return { stdout: '[]', stderr: '' };
  });
  assert.equal(called, true);
});

test('each view, malformed registry and unreadable registry fails closed', async () => withFixture(async f => {
  for (let i = 0; i < 4; i++) {
    f.registered[i] = { ...f.registered[i], present: true, kind: 'String', raw: '{"policyHelper":{"path":"' + SENTINEL + '"}}', value: '{}' };
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_CONFLICT'));
    f.registered[i].present = false;
  }
  f.deps.registry = async () => [];
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
  f.deps.registry = async () => { throw new Error(SENTINEL); };
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
  assert.equal(f.calls.length, 0);
}));

test('personal feature caches are validated, preserved and included in source drift checks', async () => withFixture(async f => {
  const remote = { channelsEnabled: true };
  const policy = { restrictions: { allow_quick_web_setup: { allowed: false }, enforce_web_search_mcp_isolation: { allowed: false } },
    compliance_taints: [], monitoring_notice: null, defaults: { remote_control_at_startup: false } };
  await f.json('config/remote-settings.json', remote);
  await f.json('config/policy-limits.json', policy);
  const p = await f.runtime().preflight({ cwd: f.project });
  await p.launch(() => {});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'policy-limits.json'), 'utf8')), policy);
  await f.json('config/remote-settings.json', { channelsEnabled: false });
  await assert.rejects(p.recheck(), rejection('NATIVE_DRIFT'));
  for (const bad of [{ channelsEnabled: true, env: { ANTHROPIC_BASE_URL: SENTINEL } }, { policyHelper: SENTINEL }, {}]) {
    await f.json('config/remote-settings.json', bad);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_CONFLICT'));
  }
  await f.json('config/remote-settings.json', remote);
  for (const bad of [{ ...policy, compliance_taints: [SENTINEL] }, { ...policy, monitoring_notice: SENTINEL },
    { ...policy, restrictions: { unknown: { allowed: true } } }, { ...policy, defaults: { remote_control_at_startup: true } },
    { ...policy, env: { ANTHROPIC_AUTH_TOKEN: SENTINEL } }, { ...policy, restrictions: { allow_quick_web_setup: { allowed: false, helper: SENTINEL } } }]) {
    await f.json('config/policy-limits.json', bad);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_CONFLICT'));
  }
  await f.text('config/policy-limits.json', '{');
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
}));

test('presence-only opaque sources reject without reading their contents', async () => withFixture(async f => {
  for (const relative of ['config/.config.json',
    'descriptor-fallback/.oauth_token', 'descriptor-fallback/.api_key']) {
    await f.text(relative, SENTINEL);
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_CONFLICT'));
    assert.ok(!f.reads.includes(path.join(f.root, relative)));
    await fs.unlink(path.join(f.root, relative));
  }
  await f.text('appdata/Anthropic/configs/default.json', SENTINEL);
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_CONFLICT'));
  assert.ok(!f.reads.some(p => p.includes('Anthropic')));
  assert.equal(f.calls.length, 0);
}));

test('malformed, unreadable, oversized and nonregular files are not mistaken for absent', async () => withFixture(async f => {
  await f.text('config/settings.json', '{' + SENTINEL);
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
  await f.text('config/settings.json', ' '.repeat(256 * 1024 + 1));
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
  await fs.unlink(path.join(f.config, 'settings.json'));
  await fs.mkdir(path.join(f.config, 'settings.json'));
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
  await fs.rmdir(path.join(f.config, 'settings.json'));
  const original = f.deps.fs.lstat;
  f.deps.fs.lstat = async p => { if (p.endsWith('settings.json')) throw Object.assign(new Error(SENTINEL), { code: 'EACCES' }); return original(p); };
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_SOURCE'));
  assert.equal(f.calls.length, 0);
}));

test('personal metadata predicates reject gateway coexistence, enterprise, unknown, env OAuth and API key', async () => withFixture(async f => {
  const saved = { ...f.account };
  for (const subscriptionType of ['pro', 'max']) {
    f.account = { ...saved, subscriptionType };
    const p = await f.runtime().preflight({ cwd: f.project });
    assert.match(p.identity.accountFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(p).includes('runtime-synthetic@'));
  }
  for (const patch of [{ apiProvider: 'gateway', authMethod: 'third_party' },
    { subscriptionType: 'enterprise' }, { subscriptionType: null }, { authMethod: 'oauth_token' },
    { authMethod: 'api_key' }, { loggedIn: false }, { email: null, orgId: null }]) {
    f.account = { ...saved, ...patch };
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_AUTH'));
  }
}));

test('version/help and doctor semantic failures reject even successful metadata processes; errors redact raw output', async () => withFixture(async f => {
  const original = f.deps.execute;
  for (const scenario of ['version', 'help', 'doctor', 'oversize', 'throw']) {
    f.deps.execute = async (command, args, options) => {
      if (scenario === 'throw') throw new Error(SENTINEL);
      if (scenario === 'oversize') return { stdout: SENTINEL.repeat(20000), stderr: '' };
      if (scenario === 'version' && args.includes('--version')) return { stdout: '2.1.262 (Claude Code)', stderr: SENTINEL };
      if (scenario === 'help' && args.includes('--help')) return { stdout: '--print --model', stderr: SENTINEL };
      if (scenario === 'doctor' && args.includes('doctor')) return { stdout: 'Organization policy: skipped custom endpoint ' + SENTINEL, stderr: '' };
      return original(command, args, options);
    };
    await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_COMPATIBILITY', 'NATIVE_DIAGNOSTIC', 'NATIVE_POLICY'));
  }
}));

test('source drift after metadata, before callback, credentials and account changes prevent submission', async () => withFixture(async f => {
  f.beforeExecute = async (command, args) => { if (args.includes('doctor')) await f.json('project/.claude/settings.json', { permissions: { deny: ['Read'] } }); };
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_DRIFT'));
  f.beforeExecute = null;
  const prepared = await f.runtime().preflight({ cwd: f.project });
  await f.json('project/.claude/settings.json', { permissions: { deny: ['Read', 'WebFetch'] } });
  let launched = false;
  await assert.rejects(prepared.launch(() => { launched = true; }), rejection('NATIVE_DRIFT'));
  assert.equal(launched, false);
  const p = await f.runtime().preflight({ cwd: f.project });
  f.account = { ...f.account, email: 'another@example.invalid' };
  await assert.rejects(p.recheck(), rejection('NATIVE_DRIFT'));
  const c = await f.runtime().preflight({ cwd: f.project });
  await f.login('pro');
  await assert.rejects(c.recheck(), rejection('NATIVE_DRIFT'));
}));

test('continuity validation is pure, canonical and independent of JSON property ordering', async () => withFixture(async f => {
  const p = await f.runtime().preflight({ cwd: f.project });
  const reversed = Object.fromEntries(Object.entries(p.identity).reverse());
  assert.equal(runtime.validateIdentity(reversed), true);
  await f.runtime().preflight({ cwd: f.project, expectedIdentity: reversed });
  await assert.rejects(f.runtime().preflight({ cwd: f.project, model: 'claude-opus-5', expectedIdentity: reversed }), rejection('NATIVE_DRIFT'));
  const before = f.calls.length;
  assert.throws(() => runtime.validateIdentity({ ...reversed, contract: 'old' }), rejection('NATIVE_INPUT'));
  assert.equal(f.calls.length, before);
}));

test('preflight snapshots cwd/options and preserves explicit native profile spelling', async () => withFixture(async f => {
  const spelling = f.config.replaceAll('\\', '/') + '/';
  const r = f.runtime({ configRoot: spelling });
  const input = { cwd: f.project };
  const original = f.deps.fs.stat;
  let first = true;
  f.deps.fs.stat = async p => { if (first) { first = false; input.cwd = SENTINEL; } return original(p); };
  const prepared = await r.preflight(input);
  assert.equal(prepared.identity.cwd, f.project);
  assert.equal(prepared.identity.nativeConfigRoot, spelling);
  await prepared.launch(l => {
    assert.equal(l.env.CLAUDE_CONFIG_DIR, spelling);
    assert.equal(l.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, spelling);
  });
}));

test('protected global config changes between metadata passes and before launch reject without exposing content', async () => withFixture(async f => {
  let authCount = 0;
  f.beforeExecute = async (command, args) => {
    if (args.includes('auth') && ++authCount === 2) await f.json('config/.claude.json', { unexpected: true });
  };
  await assert.rejects(f.runtime().preflight({ cwd: f.project }), rejection('NATIVE_DRIFT'));
  f.beforeExecute = null;
  const p = await f.runtime().preflight({ cwd: f.project });
  await f.json('config/.claude.json', { unexpected: 'another-change' });
  await assert.rejects(p.recheck(), rejection('NATIVE_DRIFT'));
  assert.ok(f.reads.includes(f.globalFile));
  assert.ok(!f.reads.some(p => p.endsWith('.credentials.json')));
}));

test('source identity catches same-content file replacement and executable changes', async () => withFixture(async f => {
  await f.json('config/settings.json', {});
  const p = await f.runtime().preflight({ cwd: f.project });
  await f.json('config/replacement.json', {});
  await fs.rename(path.join(f.config, 'replacement.json'), path.join(f.config, 'settings.json'));
  await assert.rejects(p.recheck(), rejection('NATIVE_DRIFT'));
  const ready = await f.runtime().preflight({ cwd: f.project });
  await fs.appendFile(f.executable, 'changed');
  await assert.rejects(ready.recheck(), rejection('NATIVE_DRIFT'));
  const changed = await f.runtime().preflight({ cwd: f.project });
  assert.notEqual(changed.identity.executableFingerprint, ready.identity.executableFingerprint);
}));

test('production system-root resolution inventories documented and environment-resolved Windows locations', () => {
  const p = internals().private.production;
  const roots = p.systemRoots({ SYSTEMROOT: 'D:/Windows', PROGRAMFILES: 'D:/Programs',
    PROGRAMW6432: 'D:/Programs64', 'PROGRAMFILES(X86)': 'D:/Programs32' });
  for (const target of ['C:/Program Files/ClaudeCode', 'D:/Program Files/ClaudeCode', 'D:/Programs/ClaudeCode',
    'D:/Programs64/ClaudeCode', 'D:/Programs32/ClaudeCode']) assert.ok(roots.includes(path.normalize(target)));
  assert.equal(roots.length, new Set(roots).size);
  assert.ok(roots.every(p => !p.includes('ProgramData')));
});

test('real diagnostic byte limit returns a sanitized error and the shared supervisor cleans descendants', { timeout: 20000 }, async () => withFixture(async f => {
  const pidFile = path.join(f.root, 'diagnostic-child.pid');
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
    setTimeout(()=>process.stdout.write('x'.repeat(300000)),100); setInterval(()=>{},1000);`;
  const env = { HOME: f.root, USERPROFILE: f.root, APPDATA: f.appdata,
    SYSTEMROOT: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows', TEMP: f.root, TMP: f.root };
  await assert.rejects(f.api.private.production.execute(process.execPath, ['-e', script], { cwd: f.project, env }), rejection('NATIVE_DIAGNOSTIC'));
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let alive = true;
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { alive = false; break; } throw e; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (alive) { try { process.kill(pid); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  assert.equal(alive, false, 'diagnostic descendant survived supervisor cleanup');
}));

test('private native fixture discovers alternate executables, home and PATH without native metadata', async () => withFixture(async f => {
  const alternate = path.join(f.root, 'alternate install', 'claude.exe');
  await f.text(path.relative(f.root, alternate), 'not executed');
  assert.equal(nativeExecutable({ NATIVE_CONTRACT_CLAUDE_EXE: alternate }), alternate);
  const homeExe = path.join(f.root, '.local', 'bin', 'claude.exe');
  assert.equal(nativeExecutable({}, { home: f.root, platform: 'win32', exists: p => p === homeExe }), homeExe);
  assert.equal(nativeExecutable({ Path: path.dirname(alternate) }, { home: f.root, platform: 'win32', exists: p => p === alternate }), alternate);
  assert.equal(nativeExecutable({ PATH: '"' + path.dirname(alternate) + '"' }, { home: f.root, platform: 'win32', exists: p => p === alternate }), alternate);
  // Exercise the actual fixture selection in a fresh process, not only the resolver.
  // The alternate file is deliberately non-executable: no native metadata may run.
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(k)) env[k] = v;
  env.NATIVE_CONTRACT_CLAUDE_EXE = alternate;
  const script = `const {synthetic}=require(${JSON.stringify(require.resolve('./native-runtime-fixture'))});
    (async()=>{const f=await synthetic({native:true});try{if(f.calls.length)throw Error('unexpected metadata');process.stdout.write(JSON.stringify(f.executable));}finally{await f.close();}})().catch(()=>{process.exitCode=1;});`;
  const result = await execFile(process.execPath, ['-e', script], { env, timeout: 30000 });
  assert.equal(JSON.parse(result.stdout), alternate);
  assert.equal(result.stderr, '');
}));

test('completed credential mutations during every awaited source phase reject before callback', async () => {
  for (const phase of ['file-stat', 'file-read', 'directory-read', 'registry', 'executable-stat', 'auth']) {
    await withFixture(async f => {
      await f.json('config/settings.json', { permissions: { deny: ['Read'] } });
      await fs.mkdir(path.join(f.managed, 'managed-settings.d'), { recursive: true });
      const prepared = await f.runtime().preflight({ cwd: f.project });
      let armed = false, changed = false, callback = false;
      async function mutate() { await f.login('pro'); changed = true; armed = false; }
      f.beforeExecute = async (_command, args) => {
        if (args.includes('auth')) { armed = true; if (phase === 'auth') await mutate(); }
      };
      for (const method of ['lstat', 'readFile', 'readdir']) {
        const original = f.deps.fs[method];
        f.deps.fs[method] = async (...args) => {
          const value = await original(...args);
          const file = args[0];
          if (armed && ((phase === 'file-stat' && method === 'lstat' && file === path.join(f.config, 'settings.json'))
              || (phase === 'file-read' && method === 'readFile')
              || (phase === 'directory-read' && method === 'readdir')
              || (phase === 'executable-stat' && method === 'lstat' && file === f.executable))) await mutate();
          return value;
        };
      }
      const registry = f.deps.registry;
      f.deps.registry = async (...args) => { const rows = await registry(...args); if (armed && phase === 'registry') await mutate(); return rows; };
      await assert.rejects(prepared.launch(() => { callback = true; }), rejection('NATIVE_DRIFT'));
      assert.equal(changed, true, phase); assert.equal(callback, false, phase);
      assert.ok(!f.reads.some(p => /\.credentials\.json$/.test(p)));
    });
  }
});

test('final synchronous ledger rejects source inventory, file and directory/junction substitutions', async () => {
  for (const mutation of ['ordinary-change', 'ordinary-replace', 'ordinary-remove', 'global-change', 'opaque-create',
    'dropin-add', 'dropin-replace-directory', 'dropin-junction', 'ancestor-junction', 'sync-unreadable']) {
    await withFixture(async f => {
      const settings = path.join(f.project, '.claude', 'settings.json');
      const dropins = path.join(f.managed, 'managed-settings.d');
      await f.json('project/.claude/settings.json', { permissions: { deny: ['Read'] } });
      await fs.mkdir(dropins, { recursive: true });
      const other = path.join(f.root, 'other-settings');
      await fs.mkdir(other);
      // Same inode behind the substitute junction: leaf stat alone cannot find it.
      if (mutation === 'ancestor-junction') await fs.link(settings, path.join(other, 'settings.json'));
      const p = await f.runtime().preflight({ cwd: f.project });
      let armed = false, changed = false, callback = false;
      f.beforeExecute = async (_command, args) => { if (args.includes('auth')) armed = true; };
      const registry = f.deps.registry;
      f.deps.registry = async (...args) => {
        const rows = await registry(...args);
        if (!armed) return rows;
        armed = false;
        switch (mutation) {
          case 'ordinary-change': await f.json('project/.claude/settings.json', { permissions: { deny: ['Bash'] } }); break;
          case 'ordinary-replace': {
            const bytes = await fs.readFile(settings);
            await fs.rename(settings, settings + '.old'); await fs.writeFile(settings, bytes); break;
          }
          case 'ordinary-remove': await fs.unlink(settings); break;
          case 'global-change': await f.json(path.relative(f.root, f.globalFile), { changedSyntheticAccount: true }); break;
          case 'opaque-create': await f.json('config/remote-settings.json', {}); break;
          case 'dropin-add': await f.json(path.relative(f.root, path.join(dropins, 'added.json')), {}); break;
          case 'dropin-replace-directory': await fs.rename(dropins, dropins + '.old'); await fs.mkdir(dropins); break;
          case 'dropin-junction': await fs.rename(dropins, dropins + '.old'); await fs.symlink(other, dropins, 'junction'); break;
          case 'ancestor-junction': await fs.rename(path.dirname(settings), path.dirname(settings) + '-old'); await fs.symlink(other, path.dirname(settings), 'junction'); break;
          case 'sync-unreadable': {
            const original = f.deps.syncFs.lstatSync;
            f.deps.syncFs.lstatSync = file => { if (file === settings) throw Object.assign(new Error(SENTINEL), { code: 'EACCES' }); return original(file); }; break;
          }
        }
        changed = true;
        return rows;
      };
      await assert.rejects(p.launch(() => { callback = true; }), rejection('NATIVE_DRIFT', 'NATIVE_SOURCE'));
      assert.equal(changed, true, mutation); assert.equal(callback, false, mutation);
    });
  }
});

test('non-NFC filesystem profiles reject instead of changing the saved-auth namespace', async () => withFixture(async f => {
  const nfd = path.join(f.root, 'profile-e' + String.fromCharCode(0x301)), nfc = nfd.normalize('NFC');
  await fs.cp(f.config, nfd, { recursive: true }); await fs.cp(f.config, nfc, { recursive: true });
  await f.allowGlobal(path.join(nfc, '.claude.json'));
  await assert.rejects(f.runtime({ configRoot: nfd }).preflight({ cwd: f.project }), rejection('NATIVE_ROOT'));
  assert.equal(f.calls.length, 0);
  const spelling = nfc.replaceAll('\\', '/') + '/';
  const p = await f.runtime({ configRoot: spelling }).preflight({ cwd: f.project });
  assert.equal(p.identity.nativeConfigRoot, spelling);
  await p.launch(l => {
    assert.equal(l.env.CLAUDE_CONFIG_DIR, spelling);
    assert.equal(l.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, spelling);
  });
}));

test('launch checks again after the recheck promise yields and submits without another async gap', async () => withFixture(async f => {
  await fs.mkdir(path.join(f.managed, 'managed-settings.d'), { recursive: true });
  const p = await f.runtime().preflight({ cwd: f.project });
  let afterAuth = false, validations = 0, changed = false, callback = false;
  f.beforeExecute = async (_command, args) => { if (args.includes('auth')) afterAuth = true; };
  const readdir = f.deps.syncFs.readdirSync;
  f.deps.syncFs.readdirSync = dir => {
    const names = readdir(dir);
    // One synchronous validation finishes the final scan; the next finishes
    // recheck itself. Complete the write in the microtask before launch resumes.
    if (afterAuth && ++validations === 2) queueMicrotask(() => {
      require('node:fs').writeFileSync(path.join(f.config, '.credentials.json'), 'changed synthetic saved login');
      changed = true;
    });
    return names;
  };
  await assert.rejects(p.launch(() => { callback = true; }), rejection('NATIVE_DRIFT'));
  assert.equal(changed, true); assert.equal(callback, false);
}));
