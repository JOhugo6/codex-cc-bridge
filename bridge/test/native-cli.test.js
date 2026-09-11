'use strict';

// Characterization of the actual native executable, not fake-claude.
// PASS here means the stated observation reproduced. The full runtime contract
// remains BLOCKED; see the final test. Never use this fixture as a production
// preflight, installer interface, credential migration, or an auth-status probe
// against a real user's profile. All credentials and task text are synthetic.
const test = require('node:test');
const { isSupportedVersion } = require('../lib/native-version');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, printArgs, reply, MODEL, SUPPORTED_VERSION, REQUIRED_FLAGS, SYNTHETIC_KEY, SYNTHETIC_OAUTH } = require('./native-contract-fixture');
const INITIALIZE_INPUT = JSON.stringify({ type: 'control_request', request_id: 'native-contract-init', request: { subtype: 'initialize' } }) + '\n';

function jsonResult(run) {
  assert.equal(run.timedOut, false, 'Native probe exceeded its bounded deadline');
  assert.equal(run.oversized, false, 'Native output exceeded its bound');
  // Do not include raw auth output or stderr in assertion diagnostics.
  assert.equal(run.stdout.includes(SYNTHETIC_KEY) || run.stdout.includes(SYNTHETIC_OAUTH), false, 'Synthetic credential appeared on stdout');
  assert.equal(run.stderr.includes(SYNTHETIC_KEY) || run.stderr.includes(SYNTHETIC_OAUTH), false, 'Synthetic credential appeared on stderr');
  let parsed;
  try { parsed = JSON.parse(run.stdout); } catch { assert.fail('Native CLI did not return the required JSON shape'); }
  return parsed;
}

function inferenceRequests(f) {
  return f.requests.filter(r => r.url.split('?')[0] === '/v1/messages');
}

function authProjection(auth) {
  return { loggedIn: auth.loggedIn, authMethod: auth.authMethod, apiProvider: auth.apiProvider };
}

function assertSuccess(run, f, { oauth = false } = {}) {
  const result = jsonResult(run);
  assert.equal(run.code, 0, 'Native synthetic inference did not exit successfully');
  assert.equal(result.is_error, false);
  assert.equal(result.result, 'NATIVE_CONTRACT_OK');
  assert.deepEqual(Object.keys(result.modelUsage), [MODEL]);
  assert.equal(result.modelUsage[MODEL].canonicalModel, MODEL);
  assert.equal(result.modelUsage[MODEL].provider, 'firstParty');
  const requests = inferenceRequests(f);
  assert.ok(requests.length > 0, 'No native inference reached the loopback fixture');
  assert.ok(requests.every(r => r.body.model === MODEL), 'Native request changed the canonical model');
  assert.ok(requests.every(r => oauth ? r.syntheticOAuth && !r.syntheticKey : r.syntheticKey && !r.syntheticOAuth), 'Native request used an unexpected credential source');
  return result;
}

function assertUnavailablePrimary(run, requests) {
  const result = jsonResult(run);
  assert.equal(run.code, 1, 'Expected a native model-unavailable exit');
  assert.equal(result.is_error, true);
  assert.ok(requests.length > 0, 'No canonical Opus request reached the fixture');
  assert.ok(requests.every(r => r.body.model === MODEL), 'Failure trace changed the canonical model');
  assert.ok(requests.every(r => r.syntheticError?.status === 404 && r.syntheticError.type === 'not_found_error'), 'Failure trace lacks the expected synthetic 404 response');
  assert.ok(typeof result.result === 'string' && result.result.startsWith(`There's an issue with the selected model (${MODEL}).`), 'Expected the native selected-model error, not an unrelated failure');
}

async function savedLogin(f) {
  delete f.env.ANTHROPIC_API_KEY;
  await f.json('config/.credentials.json', {
    claudeAiOauth: {
      accessToken: SYNTHETIC_OAUTH, refreshToken: 'native-contract-not-a-real-refresh-token',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
    },
  });
}

// Candidate child-only sanitation, confined to an already sterile fixture.
// It is NOT an audited exhaustive production environment contract.
function sanitizedSyntheticParent(parent) {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => !/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_API_KEY_HELPER_|CLAUDECODE$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(name)));
}

// Deliberately limited: these three known files are NOT all effective settings.
// Detect conflicts instead of guessing that empty overrides remove them.
async function knownFixtureConflicts(f) {
  const conflicts = [];
  for (const file of ['config/settings.json', 'project/.claude/settings.json', 'project/.claude/settings.local.json']) {
    let data;
    try { data = JSON.parse(await fs.readFile(path.join(f.root, file), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const key of ['apiKeyHelper', 'modelOverrides', 'fallbackModel', 'forceLoginGatewayUrl']) {
      if (Object.hasOwn(data, key)) conflicts.push(`${file}:${key}`);
    }
    for (const key of Object.keys(data.env || {})) {
      if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) conflicts.push(`${file}:env:${key}`);
    }
    if (data.forceLoginMethod === 'gateway') conflicts.push(`${file}:forceLoginMethod`);
  }
  return conflicts;
}

function initArgs() {
  return ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}'];
}

function unavailablePrimary(f) {
  f.setResponder((request, response) => {
    if (request.url.split('?')[0] === '/v1/messages' && request.body.model === MODEL) {
      request.syntheticError = { status: 404, type: 'not_found_error' };
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Synthetic model unavailable' } }));
      return true;
    }
    return false;
  });
}

test('native executable/version exceeds baseline and required flags remain available', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const compatibility = await f.verifyCompatibility();
  assert.ok(isSupportedVersion(compatibility.version, SUPPORTED_VERSION));
  assert.deepEqual(compatibility.flags, [...REQUIRED_FLAGS]);
  assert.equal(f.requests.length, 0);
  t.diagnostic(`PASS actual native ${compatibility.version}; canonical probe model ${MODEL}; Node ${process.version}`);
});

test('compatibility prerequisite rejects unsupported version or flags before every task launch', { timeout: 60000 }, async t => {
  for (const [contract, stage] of [
    [{ supportedVersion: '0.0.0-review-sentinel' }, 'version'],
    [{ requiredFlags: [...REQUIRED_FLAGS, '--native-contract-missing-flag'] }, 'flags'],
  ]) {
    const f = await fixture(contract); t.after(() => f.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.run(printArgs()), {
        code: 'NATIVE_CONTRACT_INCOMPATIBLE',
        message: `Native CLI compatibility prerequisite failed (${stage}); no task launched.`,
      });
      assert.equal(f.requests.length, 0, 'An incompatible executable must not receive a model task');
    }
  }
});

test('explicit child environment does not restore a removed API key or mutate either source', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const defaultBefore = { ...f.env };
  const prepared = { ...f.env }; delete prepared.ANTHROPIC_API_KEY;
  Object.freeze(prepared);
  const suppliedBefore = { ...prepared };
  const missingAuthRun = await f.run(printArgs(), { env: prepared });
  const missingAuth = jsonResult(missingAuthRun);
  assert.equal(missingAuthRun.code, 1);
  assert.equal(missingAuth.is_error, true);
  assert.equal(inferenceRequests(f).length, 0, 'Deleted API key was restored or another credential unexpectedly inferred');
  assert.deepEqual(prepared, suppliedBefore);
  assert.deepEqual(f.env, defaultBefore);
  // Omission still selects a copy of the unmodified fixture default.
  assertSuccess(await f.run(printArgs()), f);
  assert.deepEqual(prepared, suppliedBefore);
  assert.deepEqual(f.env, defaultBefore);
});

test('positive API-key transport: canonical Opus, child-only sanitation, parent unchanged', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const parent = { ...f.env, anthropic_base_url: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'gpt-native-contract-poison',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-native-contract-poison', ANTHROPIC_AUTH_TOKEN: 'native-contract-parent-token',
    OPENAI_API_KEY: 'native-contract-parent-key', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: 'native-contract-parent', NATIVE_CONTRACT_UNRELATED: 'retained' };
  const before = { ...parent };
  const child = sanitizedSyntheticParent(parent);
  assert.deepEqual(parent, before);
  assert.equal(child.NATIVE_CONTRACT_UNRELATED, 'retained');
  assert.equal(Object.keys(child).some(k => /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDECODE$)/i.test(k)), false);
  // Reinsert ONLY the private fixture transport after the candidate sanitation.
  Object.assign(child, { ANTHROPIC_BASE_URL: f.base, ANTHROPIC_API_KEY: SYNTHETIC_KEY,
    HTTP_PROXY: f.base, HTTPS_PROXY: f.base, ALL_PROXY: f.base, NO_PROXY: '127.0.0.1,localhost' });
  assertSuccess(await f.run(printArgs(), { env: child }), f);
  assert.deepEqual(parent, before);
  t.diagnostic('PASS synthetic API-key/loopback transport only; not evidence of saved-login provider attestation');
});

test('positive saved-login transport: isolated synthetic OAuth read by native CLI, never copied from a user', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); await savedLogin(f);
  const statusRun = await f.run(['auth', 'status', '--json']);
  const auth = jsonResult(statusRun);
  assert.equal(statusRun.code, 0);
  assert.deepEqual(authProjection(auth), { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  assert.equal(inferenceRequests(f).length, 0, 'Auth metadata probe must not submit a task');
  assertSuccess(await f.run(printArgs()), f, { oauth: true });
  t.diagnostic(`PASS native used a synthetic saved OAuth token for loopback inference; denied proxy attempts=${f.blocked.length}. No real login validity or effective-route attestation is proved.`);
});

test('shared settings and CLAUDE.md survive hooks override and strict empty MCP', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${path.join(f.root, 'marker.cjs').replaceAll('\\', '/')}"`;
  await f.text('marker.cjs', `require('node:fs').writeFileSync(${JSON.stringify(path.join(f.root, 'UNEXPECTED_CUSTOMIZATION_RUN'))}, 'unexpected');`);
  await f.text('observe.cjs', 'const scope = process.argv[2]; if (!["USER", "PROJECT", "LOCAL"].includes(scope)) process.exit(1); process.stdout.write(`NATIVE_CONTRACT_${scope}_ALLOWED:${process.env[`NATIVE_CONTRACT_${scope}`]}:${process.env.CLAUDE_BRIDGE_CHILD}`);');
  const observeCommand = scope => `"${process.execPath.replaceAll('\\', '/')}" "${path.join(f.root, 'observe.cjs').replaceAll('\\', '/')}" ${scope}`;
  for (const [scope, file] of [['USER', 'config/settings.json'], ['PROJECT', 'project/.claude/settings.json'], ['LOCAL', 'project/.claude/settings.local.json']]) {
    await f.json(file, { model: 'haiku', permissions: { allow: [`Bash(${observeCommand(scope)})`], deny: [`Read(./${scope.toLowerCase()}-denied.txt)`] },
      env: { [`NATIVE_CONTRACT_${scope}`]: 'retained' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } });
    await f.text(`project/${scope.toLowerCase()}-denied.txt`, `NATIVE_CONTRACT_${scope}_FILE_MUST_NOT_BE_READ`);
  }
  await f.text('config/CLAUDE.md', 'NATIVE_CONTRACT_USER_CONTEXT');
  await f.text('project/CLAUDE.md', 'NATIVE_CONTRACT_PROJECT_CONTEXT');
  await f.text('project/CLAUDE.local.md', 'NATIVE_CONTRACT_LOCAL_CONTEXT');
  await f.json('project/.mcp.json', { mcpServers: { native_contract_forbidden: { command: process.execPath, args: [path.join(f.root, 'marker.cjs')] } } });
  await f.json('config/.claude.json', {
    mcpServers: { native_contract_forbidden_user: { command: process.execPath, args: [path.join(f.root, 'marker.cjs')] } },
    // Trust only this newly created disposable project, never the real workspace.
    projects: { [f.project]: { hasTrustDialogAccepted: true }, [f.project.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
  });
  await f.text('config/skills/native-contract-user/SKILL.md', '---\nname: native-contract-user\ndescription: NATIVE_CONTRACT_USER_SKILL\n---\nSynthetic fixture. Do not delegate or call unavailable MCP tools.\n');
  await f.text('project/.claude/skills/native-contract-project/SKILL.md', '---\nname: native-contract-project\ndescription: NATIVE_CONTRACT_PROJECT_SKILL\n---\nSynthetic fixture.\n');
  let sentTools = false;
  f.setResponder((request, response) => {
    if (request.url.split('?')[0] !== '/v1/messages' || sentTools) return false;
    sentTools = true;
    reply(response, request.body.model, ['user', 'project', 'local'].flatMap((scope, i) => [
      { type: 'tool_use', id: `tool_native_contract_read_${i}`, name: 'Read', input: { file_path: path.join(f.project, `${scope}-denied.txt`) } },
      { type: 'tool_use', id: `tool_native_contract_bash_${i}`, name: 'Bash', input: { command: observeCommand(scope.toUpperCase()) } },
    ]));
    return true;
  });
  const initialization = jsonResult(await f.run(initArgs(), { input: INITIALIZE_INPUT })).response.response;
  const commandNames = initialization.commands.map(command => command.name);
  assert.ok(commandNames.includes('native-contract-user'), 'Shared user skill disappeared');
  assert.ok(commandNames.includes('native-contract-project'), 'Project skill disappeared');
  assertSuccess(await f.run(printArgs()), f);
  const toolResults = inferenceRequests(f).flatMap(r => r.body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result');
  for (let i = 0; i < 3; i++) {
    const denied = toolResults.find(r => r.tool_use_id === `tool_native_contract_read_${i}`);
    assert.equal(denied?.is_error, true, 'User/project/local Read must be denied');
    assert.ok(JSON.stringify(denied.content).includes('denied by your permission settings'), 'Read failure was not the expected permission denial');
  }
  for (const scope of ['USER', 'PROJECT', 'LOCAL']) assert.ok(JSON.stringify(toolResults).includes(`NATIVE_CONTRACT_${scope}_ALLOWED:retained:1`), `${scope} allow rule/env or child recursion sentinel did not survive`);
  const first = inferenceRequests(f)[0].body;
  const context = JSON.stringify({ system: first.system, messages: first.messages });
  for (const scope of ['USER', 'PROJECT', 'LOCAL']) assert.ok(context.includes(`NATIVE_CONTRACT_${scope}_CONTEXT`), `${scope} context missing`);
  assert.equal((first.tools || []).some(tool => tool.name.startsWith('mcp__')), false, 'Strict MCP must remove shared server tools');
  const transcript = JSON.stringify(inferenceRequests(f).map(r => r.body.messages));
  for (const scope of ['USER', 'PROJECT', 'LOCAL']) assert.equal(transcript.includes(`NATIVE_CONTRACT_${scope}_FILE_MUST_NOT_BE_READ`), false);
  await assert.rejects(fs.access(path.join(f.root, 'UNEXPECTED_CUSTOMIZATION_RUN')), { code: 'ENOENT' });
  assert.deepEqual(await knownFixtureConflicts(f), []);
  t.diagnostic('PASS shared user/project/local context, deny/allow rules and env retained; user/project skills discovered; child recursion sentinel observed by a permitted tool; hook/MCP marker never executed. This is not a proof that native Agent delegation is disabled.');
});

test('untrusted project allow rules are not silently elevated by the native probe', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.text('untrusted.cjs', `require('node:fs').writeFileSync(${JSON.stringify(path.join(f.root, 'UNTRUSTED_COMMAND_RAN'))}, 'unexpected');`);
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${path.join(f.root, 'untrusted.cjs').replaceAll('\\', '/')}"`;
  await f.json('project/.claude/settings.json', { permissions: { allow: [`Bash(${command})`] } });
  let sentTool = false;
  f.setResponder((request, response) => {
    if (request.url.split('?')[0] !== '/v1/messages' || sentTool) return false;
    sentTool = true;
    reply(response, request.body.model, [{ type: 'tool_use', id: 'tool_native_untrusted', name: 'Bash', input: { command } }]);
    return true;
  });
  const result = assertSuccess(await f.run(printArgs()), f);
  assert.ok(result.permission_denials.some(d => d.tool_use_id === 'tool_native_untrusted'));
  const results = inferenceRequests(f).flatMap(r => r.body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result');
  const denied = results.find(r => r.tool_use_id === 'tool_native_untrusted');
  assert.equal(denied?.is_error, true);
  assert.ok(JSON.stringify(denied.content).includes('requires approval'));
  await assert.rejects(fs.access(path.join(f.root, 'UNTRUSTED_COMMAND_RAN')), { code: 'ENOENT' });
});

test('known explicit settings conflicts are rejected before passing any task to the native CLI', { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.json('config/settings.json', { apiKeyHelper: 'native-contract-must-not-execute', fallbackModel: ['claude-sonnet-4-6'] });
  await f.json('project/.claude/settings.json', { modelOverrides: { [MODEL]: 'gpt-native-contract-poison' } });
  await f.json('project/.claude/settings.local.json', { env: { anthropic_base_url: 'http://127.0.0.1:1' }, forceLoginMethod: 'gateway' });
  const conflicts = await knownFixtureConflicts(f);
  assert.equal(conflicts.length, 5);
  assert.ok(conflicts.includes('config/settings.json:apiKeyHelper'));
  assert.ok(conflicts.includes('config/settings.json:fallbackModel'));
  assert.ok(conflicts.includes('project/.claude/settings.json:modelOverrides'));
  assert.ok(conflicts.includes('project/.claude/settings.local.json:env:anthropic_base_url'));
  assert.ok(conflicts.includes('project/.claude/settings.local.json:forceLoginMethod'));
  assert.equal(f.requests.length, 0);
  t.diagnostic('PASS limited known-file conflict detection only; not an authoritative effective-settings preflight');
});

test('model-unavailable assertion rejects empty traces and unrelated failure evidence', () => {
  // Assertion-unit regression only; native evidence is collected in the probes below.
  const run = {
    code: 1, timedOut: false, oversized: false, stderr: '',
    stdout: JSON.stringify({ is_error: true, result: `There's an issue with the selected model (${MODEL}).` }),
  };
  const request = { body: { model: MODEL }, syntheticError: { status: 404, type: 'not_found_error' } };
  assert.doesNotThrow(() => assertUnavailablePrimary(run, [request]));
  assert.throws(() => assertUnavailablePrimary(run, []), /No canonical Opus request/);
  assert.throws(() => assertUnavailablePrimary(run, [{ ...request, body: { model: 'claude-sonnet-4-6' } }]), /changed the canonical model/);
  assert.throws(() => assertUnavailablePrimary(run, [{ body: { model: MODEL } }]), /expected synthetic 404 response/);
  const unrelated = { ...run, stdout: JSON.stringify({ is_error: true, result: 'Synthetic unrelated startup failure' }) };
  assert.throws(() => assertUnavailablePrimary(unrelated, [request]), /Expected the native selected-model error/);
});

test('without fallback settings, unavailable canonical Opus fails instead of remapping', { timeout: 60000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); unavailablePrimary(f);
  const run = await f.run(printArgs());
  assertUnavailablePrimary(run, inferenceRequests(f));
});

test('BLOCKED boundary: auth and initialization metadata do not attest inherited fallback/effective routing', { timeout: 120000 }, async t => {
  const f = await fixture(); t.after(() => f.close()); await savedLogin(f);
  const beforeAuth = jsonResult(await f.run(['auth', 'status', '--json']));
  const beforeInit = jsonResult(await f.run(initArgs(), { input: INITIALIZE_INPUT })).response.response;
  assert.equal(inferenceRequests(f).length, 0);
  await f.json('config/settings.json', { fallbackModel: ['claude-sonnet-4-6'] });
  const afterAuth = jsonResult(await f.run(['auth', 'status', '--json']));
  const afterInit = jsonResult(await f.run(initArgs(), { input: INITIALIZE_INPUT })).response.response;
  assert.deepEqual(authProjection(afterAuth), authProjection(beforeAuth));
  assert.deepEqual(afterInit.account, beforeInit.account);
  for (const field of ['settings', 'effectiveSettings', 'fallbackModel', 'modelOverrides', 'baseUrl', 'gateway']) {
    assert.equal(Object.hasOwn(afterAuth, field), false);
    assert.equal(Object.hasOwn(afterInit, field), false);
  }
  assert.equal(inferenceRequests(f).length, 0, 'Metadata-only calls unexpectedly inferred');
  unavailablePrimary(f);
  // Canonical --model alone does not suppress the inherited fallback.
  const run = await f.run(printArgs()); const result = jsonResult(run);
  assert.equal(run.code, 0);
  assert.equal(result.is_error, false);
  const models = inferenceRequests(f).map(r => r.body.model);
  assert.ok(models.includes(MODEL));
  assert.ok(models.includes('claude-sonnet-4-6'), 'Expected inherited fallback counterexample did not reproduce');
  assert.deepEqual(Object.keys(result.modelUsage), ['claude-sonnet-4-6']);
  const previousRequests = inferenceRequests(f).length;
  const args = printArgs(); args[args.indexOf('--settings') + 1] = '{"disableAllHooks":true,"fallbackModel":[]}';
  const clearedRun = await f.run(args);
  assertUnavailablePrimary(clearedRun, inferenceRequests(f).slice(previousRequests));
  t.diagnostic(`PASS empty fallbackModel array clears this user-level fallback on native ${(await f.verifyCompatibility()).version}; this does NOT prove managed overrides are safe or permitted.`);
  t.diagnostic('BLOCKED contract for the examined interfaces, not a proof of universal impossibility: native saved-login metadata says firstParty even on loopback; initialization omits effective routing/fallback; inherited fallback executes despite canonical --model. A custom ANTHROPIC_BASE_URL disables remote-policy fetch, so these probes cannot attest remote/managed sources or cached gateway credentials. No production interface is frozen.');
});
