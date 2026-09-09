'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { synthetic, inference, assertWire, reply } = require('./native-runtime-fixture');
const { connectNative } = require('./runtime-integration-fixture');

const CONTROL = 'CLAUDE_CODE_DISABLE_1M_CONTEXT';
const SETTINGS = '{"model":"opus","permissions":{"allow":["Read","Write","Skill"]}}';
async function stamp(file) {
  const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file, { bigint: true })]);
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ino: stat.ino,
    size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

test('first-use migration control is metadata-only, private, and absent from the inference contract', async () => {
  const f = await synthetic();
  try {
    let metadata = 0;
    f.beforeExecute = async (_command, args, options) => {
      metadata++;
      assert.equal(options.env[CONTROL], '1');
      assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).env[CONTROL], '1');
      assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5[1m]');
    };
    const prepared = await f.runtime().preflight({ cwd: f.project });
    const again = await f.runtime().preflight({ cwd: f.project, expectedIdentity: prepared.identity });
    assert.deepEqual(again.identity, prepared.identity);
    assert.equal(again.identity.contract, 'native-windows-personal/2.1.263/v1');
    await again.launch(launch => {
      assert.equal(Object.hasOwn(launch.env, CONTROL), false);
      assert.equal(Object.hasOwn(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]).env, CONTROL), false);
      assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'claude-opus-5[1m]');
    });
    assert.ok(metadata >= 10);
    const count = metadata;
    await assert.rejects(f.runtime({ parentEnv: { ...f.parentEnv, [CONTROL]: '1' } }).preflight({ cwd: f.project }), { code: 'NATIVE_CONFLICT' });
    assert.equal(metadata, count, 'no public environment override is added');
  } finally { await f.close(); }
});

for (const defaultRoot of [true, false]) for (const disableTools of [false, true]) {
  test(`native first-use opus preference survives MCP restart/replay (${defaultRoot ? 'default' : 'explicit'}, tools ${disableTools ? 'off' : 'on'})`, { timeout: 120000 }, async () => {
    const f = await synthetic({ native: true, defaultRoot });
    let connection;
    try {
      const settings = path.join(f.config, 'settings.json');
      await fs.writeFile(settings, SETTINGS);
      const original = await stamp(settings);
      await f.json('project/.claude/settings.local.json', { permissions: { deny: ['Read(./denied.txt)'] } });
      await f.text('project/CLAUDE.md', 'FIRST_USE_PROJECT_CONTEXT');
      await f.text(path.relative(f.root, path.join(f.config, 'CLAUDE.md')), 'FIRST_USE_USER_CONTEXT');
      await f.text(path.relative(f.root, path.join(f.config, 'skills/first-use/SKILL.md')), '---\nname: first-use\ndescription: FIRST_USE_SHARED_SKILL\n---\nSynthetic skill. Do not execute.');
      await f.text('project/allowed.txt', 'FIRST_USE_ALLOWED_CONTENT');
      await f.text('project/denied.txt', 'FIRST_USE_DENIED_CONTENT');
      let requested = false;
      f.base.setResponder((r, res) => {
        if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || requested) return false;
        requested = true;
        reply(res, r.body.model, ['allowed', 'denied'].map(name => ({ type: 'tool_use', id: 'first_use_' + name,
          name: 'Read', input: { file_path: path.join(f.project, name + '.txt') } })));
        return true;
      });
      // No native prewarming: this first MCP turn must execute the metadata sequence
      // against the original exact "opus" preference, not an already migrated file.
      connection = await connectNative(f, { CLAUDE_BRIDGE_DISABLE_TOOLS: disableTools ? '1' : '0', CLAUDE_BRIDGE_ALLOWED_TOOLS: '["Read"]' });
      const input = { conversation_id: 'first-use', request_id: 'one', working_dir: f.project, message: 'FIRST_USE_SYNTHETIC_TASK' };
      const one = await connection.client.callTool({ name: 'claude_turn', arguments: input });
      assert.ok(!one.isError, JSON.stringify(one));
      assert.equal(one.structuredContent.model, 'claude-opus-5[1m]');
      assert.deepEqual(one.structuredContent.model_evidence, ['claude-opus-5[1m]']);
      assert.equal(one.structuredContent.runtime.configRootMode, defaultRoot ? 'default' : 'explicit');
      assertWire(f, 2);
      assert.deepEqual(await stamp(settings), original);
      const wire = JSON.stringify(inference(f));
      assert.ok(wire.includes('FIRST_USE_PROJECT_CONTEXT')); assert.ok(wire.includes('FIRST_USE_USER_CONTEXT'));
      // Native intentionally omits Skill discovery when all tools are disabled.
      if (!disableTools) assert.ok(wire.includes('first-use'));
      const results = inference(f).flatMap(r => r.body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(x => x.type === 'tool_result');
      assert.ok(results.some(r => r.tool_use_id === 'first_use_allowed' && Boolean(r.is_error) === disableTools));
      assert.ok(results.some(r => r.tool_use_id === 'first_use_denied' && r.is_error));
      assert.equal(wire.includes('FIRST_USE_ALLOWED_CONTENT'), !disableTools);
      assert.ok(!wire.includes('FIRST_USE_DENIED_CONTENT'));
      await connection.close(); connection = null;
      connection = await connectNative(f, { CLAUDE_BRIDGE_DISABLE_TOOLS: disableTools ? '0' : '1',
        CLAUDE_BRIDGE_ALLOWED_TOOLS: '["Read","Write","Skill"]', CLAUDE_BRIDGE_MODEL: 'claude-opus-5' });
      const replay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
      assert.deepEqual(replay.structuredContent, { ...one.structuredContent, replayed: true }); assertWire(f, 2);
      const two = await connection.client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'first-use', request_id: 'two', message: 'FIRST_USE_SECOND_TASK' } });
      assert.ok(!two.isError, JSON.stringify(two)); assertWire(f, 3);
      assert.equal(two.structuredContent.session_id, one.structuredContent.session_id);
      assert.deepEqual(two.structuredContent.runtime, one.structuredContent.runtime);
      assert.equal(two.structuredContent.model, 'claude-opus-5[1m]');
      const status = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'first-use' } });
      assert.equal(status.structuredContent.status, 'ready');
      assert.equal(status.structuredContent.policy.disableTools, disableTools);
      assert.deepEqual(status.structuredContent.policy.allowedTools, ['Read']);
      for (const r of inference(f)) {
        if (disableTools) assert.deepEqual(r.body.tools || [], []);
        else assert.ok((r.body.tools || []).some(t => t.name === 'Read'));
        assert.ok(!(r.body.tools || []).some(t => t.name.startsWith('mcp__')));
      }
      assert.deepEqual(await stamp(settings), original);
      await connection.close(); connection = null;
      await fs.rm(path.join(f.config, '.credentials.json'));
      connection = await connectNative(f, { CLAUDE_BRIDGE_COMMAND: path.join(f.root, 'missing.exe'), CLAUDE_BRIDGE_MODEL: 'invalid-default' });
      const offlineReplay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
      assert.deepEqual(offlineReplay.structuredContent, { ...one.structuredContent, replayed: true }); assertWire(f, 3);
      assert.deepEqual(await stamp(settings), original);
    } finally { await connection?.close(); await f.close(); }
  });
}
