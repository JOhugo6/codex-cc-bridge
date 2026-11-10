'use strict';

// Exact-artifact, synthetic-only characterization. The native parser/readers are
// evaluated as shipped, and real CLI tasks use disposable login plus loopback.
// This is not acceptance of a current-profile/live registered MCP request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { synthetic, inference, assertWire, reply, SENTINEL } = require('./native-runtime-fixture');
const { EXE, SYNTHETIC_OAUTH, SYNTHETIC_KEY } = require('./native-contract-fixture');
const { connectNative } = require('./runtime-integration-fixture');

module.exports = function characterizePolicy(descriptor) {
const { version, sha256: SHA256, size, utility, parserAnchor, after, ordinaryAfter, registry, declared, helperEnd, response, register, enforced, hinted, enforcedEnd, host, scan, eligible } = descriptor;
const KEY = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const REPORTED = 'allow_cobalt_plinth_alkanet';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function artifact() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.NATIVE_CONTRACT_CLAUDE_EXE && path.isAbsolute(EXE), `select the official ${version} executable explicitly`);
  const bytes = await fs.readFile(EXE);
  assert.equal(bytes.length, size, 'refuse any other native artifact size');
  assert.equal(digest(bytes), SHA256, 'refuse any other native artifact before execution');
  return bytes;
}

test(`exact native ${version} parser and readers preserve opaque restriction names and both booleans`, { timeout: 15000 }, async t => {
  const bytes = await artifact();
  const spans = [];
  function span(start, end) {
    assert.ok(start >= 0 && end > start && end - start < 100000);
    const value = bytes.subarray(start, end);
    spans.push({ start, end, sha256: digest(value) });
    return value.toString('utf8');
  }
  function take(needle, endNeedle, after) {
    const start = bytes.indexOf(needle, after);
    return span(start, bytes.indexOf(endNeedle, start + Buffer.byteLength(needle)));
  }
  function moduleAt(anchor) {
    const start = bytes.lastIndexOf('// @bun @bytecode', anchor);
    return span(start, bytes.indexOf(0, start));
  }
  function expression(source) {
    const exports = /\nexport\{([^}]+)\};\s*$/.exec(source);
    assert.ok(exports);
    return '(function(){' + source.slice(0, exports.index)
      .replace(/import\{([^}]+)\}from"B:\/~BUN\/root\/chunk-[^" ]+\.js";/,
        (_, names) => 'const {' + names + '} = deps;') + '; return {' + exports[1] + '}; })()';
  }
  const parser = vm.createContext({ URL, TextEncoder, TextDecoder });
  parser.deps = vm.runInContext(expression(moduleAt(utility)), parser, { timeout: 1000 });
  Object.assign(parser, vm.runInContext(expression(moduleAt(parserAnchor)), parser, { timeout: 1000 }));
  const schema = take('restrictions:me(o(),u({allowed:I()}))', ',compliance_taints:', after).slice('restrictions:'.length);
  parser.schema = vm.runInContext(schema, parser, { timeout: 1000 });
  const workflowSchema = take('skipWorkflowUsageWarning:()=>I().optional().describe(', ',disableAutoMode:', ordinaryAfter);
  parser.workflowField = vm.runInContext('({' + workflowSchema + '}).skipWorkflowUsageWarning()', parser, { timeout: 1000 });
  for (const [value, expected] of [[undefined, true], [false, true], [true, true],
    [null, false], [0, false], ['false', false], [{}, false], [[], false]]) {
    parser.workflowValue = value;
    assert.equal(vm.runInContext('workflowField.safeParse(workflowValue).success', parser, { timeout: 1000 }), expected);
    if (expected) assert.equal(vm.runInContext('workflowField.parse(workflowValue)', parser, { timeout: 1000 }), value);
  }
  const reader = vm.createContext({ [host]: () => false, [scan]: () => false,
    Z: () => reader.record, a: () => ({ hintedEnforcedKeys: [], sessionAttributed: true }), [eligible]: () => true });
  vm.runInContext([
    take('var ' + registry + '=', ';function ' + declared + '(', after) + ';',
    take('function ' + declared + '(', 'function ' + helperEnd + '(', after),
    take('function ' + response + '(', register + '(', after),
    take('function ' + enforced + '(', 'function ' + enforcedEnd + '(', after),
  ].join('\n'), reader, { timeout: 1000 });
  let cases = 0;
  for (const key of [REPORTED, 'allow_arbitrary_schema_key', 'opaque-policy-name', 'enforce_arbitrary_schema_key',
    'require_arbitrary_schema_key', '', 'arbitrary key', 'žluťoučký', 'constructor', 'toString']) for (const allowed of [false, true]) {
    parser.json = JSON.stringify({ [key]: { allowed } });
    const output = vm.runInContext('JSON.stringify(schema.parse(JSON.parse(json)))', parser, { timeout: 1000 });
    assert.equal(output, parser.json, 'native schema must retain every accepted key/value');
    reader.record = JSON.parse(output);
    assert.equal(reader[response]({ restrictions: reader.record, compliance_taints: [] }, key), allowed);
    assert.equal(reader[enforced](key), allowed);
    assert.equal(reader[hinted](key), allowed);
    assert.equal(JSON.stringify(reader.record), output, 'native readers must not rewrite the record');
    cases++;
  }
  parser.json = '{"__proto__":{"allowed":false}}';
  assert.equal(vm.runInContext('JSON.stringify(schema.parse(JSON.parse(json)))', parser, { timeout: 1000 }), '{}',
    'native omission is why the adapter refuses __proto__ instead of dropping it');
  t.diagnostic(JSON.stringify({ passed: true, cases, artifactSha256: SHA256, spans,
    scope: 'exact native embedded parser/reader functions; no feature alias or concrete consumer reachability inferred' }));
});

test(`exact ${version} prepared launch keeps generic policy/settings bytes, saved route/model and native permission enforcement`, { timeout: 120000 }, async t => {
  await artifact();
  for (const allowed of [false, true]) await t.test(`allowed=${allowed}`, { timeout: 55000 }, async () => {
    const f = await synthetic({ native: true });
    try {
      const policy = { restrictions: { [REPORTED]: { allowed }, opaque_policy_key: { allowed: !allowed },
        enforce_schema_control: { allowed }, require_schema_control: { allowed: !allowed } },
      compliance_taints: [], monitoring_notice: null, defaults: { remote_control_at_startup: false } };
      const settings = { skipWorkflowUsageWarning: allowed, permissions: { deny: ['Read(./denied.txt)'] },
        env: { [KEY]: '1', ISSUE2_NATIVE_ENV_CONTROL: 'retained' } };
      await f.json('config/policy-limits.json', policy);
      await f.json('config/settings.json', settings);
      await f.text('project/denied.txt', 'ISSUE2_DENIED_CONTENT_MUST_NOT_REACH_TRANSPORT');
      await f.text('project/allowed.txt', 'ISSUE2_ALLOWED_CONTENT');
      const policyFile = path.join(f.config, 'policy-limits.json');
      const settingsFile = path.join(f.config, 'settings.json');
      const policyBytes = await fs.readFile(policyFile), settingsBytes = await fs.readFile(settingsFile);
      let sent = false;
      f.base.setResponder((request, res) => {
        if (request.url.split('?')[0] !== '/v1/messages' || sent) return false;
        sent = true;
        reply(res, request.body.model, ['allowed', 'denied'].map(name => ({ type: 'tool_use', id: 'issue2_' + name,
          name: 'Read', input: { file_path: path.join(f.project, name + '.txt') } })));
        return true;
      });
      const prepared = await f.runtime().preflight({ cwd: f.project });
      assert.equal(prepared.identity.version, version);
      assert.equal(inference(f).length, 0, 'metadata/preflight is never an inference substitute');
      const run = await prepared.launch(launch => {
        assert.equal(Object.keys(launch.env).some(k => k.toUpperCase() === KEY), false);
        assert.equal(Object.keys(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]).env).some(k => k.toUpperCase() === KEY), false);
        return f.runPrepared(launch, { extraArgs: ['--permission-mode', 'bypassPermissions', '--tools', 'Read', '--max-turns', '3'] });
      });
      assert.equal(run.code, 0, 'synthetic native task must finish; raw output stays private');
      assert.ok(![SENTINEL, SYNTHETIC_OAUTH, SYNTHETIC_KEY].some(s => (run.stdout + run.stderr).includes(s)));
      let output; try { output = JSON.parse(run.stdout); } catch { assert.fail('native task did not produce JSON'); }
      assert.equal(output.is_error, false); assert.equal(output.result, 'NATIVE_CONTRACT_OK');
      assertWire(f, 2);
      const results = inference(f).flatMap(r => r.body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : [])
        .filter(block => block.type === 'tool_result');
      assert.ok(results.some(result => result.tool_use_id === 'issue2_allowed' && !result.is_error));
      assert.ok(results.some(result => result.tool_use_id === 'issue2_denied' && result.is_error));
      assert.ok(output.permission_denials.some(denial => denial.tool_use_id === 'issue2_denied'));
      assert.equal(JSON.stringify(inference(f)).includes('ISSUE2_DENIED_CONTENT_MUST_NOT_REACH_TRANSPORT'), false);
      assert.deepEqual(await fs.readFile(policyFile), policyBytes);
      assert.deepEqual(await fs.readFile(settingsFile), settingsBytes);
    } finally { await f.close(); }
  });
});

test(`exact ${version} registered synthetic MCP preserves policy, result identity, status and restart replay`, { timeout: 120000 }, async () => {
  await artifact();
  const f = await synthetic({ native: true });
  let connection;
  try {
    const policy = { restrictions: { [REPORTED]: { allowed: false }, opaque_policy_key: { allowed: true } },
      compliance_taints: [], monitoring_notice: null, defaults: { remote_control_at_startup: false } };
    const settings = { skipWorkflowUsageWarning: false, env: { [KEY]: '1' } };
    await f.json('config/policy-limits.json', policy);
    await f.json('config/settings.json', settings);
    const policyFile = path.join(f.config, 'policy-limits.json'), settingsFile = path.join(f.config, 'settings.json');
    const policyBytes = await fs.readFile(policyFile), settingsBytes = await fs.readFile(settingsFile);
    connection = await connectNative(f);
    const input = { conversation_id: 'native-schema', request_id: 'completed', working_dir: f.project,
      message: 'SYNTHETIC_POLICY_SCHEMA_MCP_TASK' };
    const one = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.ok(!one.isError, 'registered synthetic MCP task must return actual content');
    assert.equal(one.structuredContent.reply, 'NATIVE_CONTRACT_OK');
    assert.equal(one.structuredContent.runtime.version, version);
    assert.equal(one.structuredContent.model, 'claude-opus-5[1m]');
    assert.deepEqual(one.structuredContent.model_evidence, ['claude-opus-5']);
    assertWire(f, 1);
    const status = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: input.conversation_id } });
    assert.deepEqual(status.structuredContent.runtime, one.structuredContent.runtime);
    assert.deepEqual(status.structuredContent.last_result, one.structuredContent);
    await connection.close(); connection = null;
    connection = await connectNative(f);
    const replay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.deepEqual(replay.structuredContent, { ...one.structuredContent, replayed: true });
    assertWire(f, 1);
    assert.deepEqual(await fs.readFile(policyFile), policyBytes);
    assert.deepEqual(await fs.readFile(settingsFile), settingsBytes);
    await f.json('config/policy-limits.json', { ...policy, restrictions: { [REPORTED]: { allowed: false, extra: true } } });
    const refused = await connection.client.callTool({ name: 'claude_turn', arguments: { ...input, request_id: 'refused' } });
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).reason, 'POLICY_CACHE_RESTRICTION');
    assertWire(f, 1);
    const after = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: input.conversation_id } });
    assert.equal(after.structuredContent.turn, 1);
    assert.deepEqual(after.structuredContent.last_result, one.structuredContent);
    const completeReplay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.deepEqual(completeReplay.structuredContent, { ...one.structuredContent, replayed: true });
    assertWire(f, 1);
  } finally { await connection?.close(); await f.close(); }
});

};
