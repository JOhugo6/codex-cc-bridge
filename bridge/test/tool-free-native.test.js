'use strict';
const test = require('node:test');
const { isSupportedVersion } = require('../lib/native-version');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture, printArgs } = require('./native-contract-fixture');
const { sharedContext, attack, results } = require('./tool-free-fixture');

test('actual pinned native empty --tools offers no tools and cannot execute injected Read/Write/Skill', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const marks = await sharedContext(f);
    f.setResponder(attack(f));
    const out = await f.run(printArgs(['--tools', '', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Write', 'Skill']));
    assert.equal(out.timedOut, false); assert.equal(out.oversized, false); assert.equal(out.code, 0);
    const wire = f.requests.filter(r => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'));
    assert.equal(wire.length, 2);
    for (const r of wire) assert.deepEqual(r.body.tools || [], []);
    const toolResults = results(wire);
    for (const id of ['read_probe', 'write_probe', 'skill_probe']) {
      assert.ok(toolResults.some(r => r.tool_use_id === id && r.is_error && /No such tool available/.test(JSON.stringify(r.content))));
    }
    assert.ok(!JSON.stringify(wire).includes(marks.sentinel));
    for (const file of [marks.marker, marks.mcpMarker, marks.writeMarker]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await f.close(); }
});

const path = require('node:path');
const { synthetic, inference, assertWire, reply } = require('./native-runtime-fixture');
const { connectNative } = require('./runtime-integration-fixture');
const { privateModule } = require('./diagnostic-fixture');

test('actual native tool-free v2 pin survives MCP restart and attempted config widening', { timeout: 180000 }, async () => {
  const f = await synthetic({ native: true });
  let connection;
  try {
    const marks = await sharedContext(f);
    f.base.setResponder(attack(f));
    connection = await connectNative(f, { CLAUDE_BRIDGE_DISABLE_TOOLS: '1', CLAUDE_BRIDGE_ALLOWED_TOOLS: '["Read","Write","Skill"]' });
    const input = { conversation_id: 'free', request_id: 'one', working_dir: f.project, message: 'TINY_TOOL_FREE_TASK' };
    const one = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.ok(!one.isError, JSON.stringify(one)); assertWire(f, 2);
    await connection.close(); connection = null;
    connection = await connectNative(f, { CLAUDE_BRIDGE_DISABLE_TOOLS: '0' });
    const replay = await connection.client.callTool({ name: 'claude_turn', arguments: input });
    assert.deepEqual(replay.structuredContent, { ...one.structuredContent, replayed: true }); assertWire(f, 2);
    f.base.setResponder(attack(f));
    const two = await connection.client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'free', message: 'TINY_SECOND_TASK' } });
    assert.ok(!two.isError, JSON.stringify(two)); assertWire(f, 4);
    assert.equal(two.structuredContent.session_id, one.structuredContent.session_id);
    for (const r of inference(f)) assert.deepEqual(r.body.tools || [], []);
    const rejected = results(inference(f));
    for (const id of ['read_probe', 'write_probe', 'skill_probe']) {
      assert.ok(rejected.some(r => r.tool_use_id === id && r.is_error && /No such tool available/.test(JSON.stringify(r.content))));
    }
    assert.ok(!JSON.stringify(inference(f)).includes(marks.sentinel));
    for (const file of [marks.marker, marks.mcpMarker, marks.writeMarker]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const status = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'free' } });
    assert.equal(status.structuredContent.policy.disableTools, true);
  } finally { await connection?.close(); await f.close(); }
});

test('actual normal native mode still offers and executes shared-allowed Read with skills present', { timeout: 90000 }, async () => {
  const f = await synthetic({ native: true });
  let connection;
  try {
    const marks = await sharedContext(f);
    let sent = false;
    f.base.setResponder((r, res) => {
      if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || sent) return false;
      sent = true;
      reply(res, r.body.model, [{ type: 'tool_use', id: 'positive_read', name: 'Read', input: { file_path: path.join(f.project, 'private.txt') } }]);
      return true;
    });
    connection = await connectNative(f);
    const out = await connection.client.callTool({ name: 'claude_turn', arguments: {
      conversation_id: 'normal', working_dir: f.project, message: 'TINY_NORMAL_CONTROL' } });
    assert.ok(!out.isError, JSON.stringify(out)); assertWire(f, 2);
    assert.ok(inference(f)[0].body.tools.some(x => x.name === 'Read'));
    assert.ok(inference(f)[0].body.tools.some(x => x.name === 'Skill'));
    assert.ok(JSON.stringify(inference(f)[0].body).includes('synthetic-skill'));
    assert.ok(results(inference(f)).some(r => r.tool_use_id === 'positive_read' && !r.is_error && JSON.stringify(r.content).includes(marks.sentinel)));
    for (const file of [marks.marker, marks.mcpMarker, marks.writeMarker]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const st = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'normal' } });
    assert.equal(st.structuredContent.policy.disableTools, false);
  } finally { await connection?.close(); await f.close(); }
});

test('actual native offline smoke protocol has two messages, restart, exact replay and structured Opus identity', { timeout: 180000 }, async () => {
  const f = await synthetic({ native: true, defaultRoot: true });
  try {
    await sharedContext(f);
    let calls = 0;
    f.base.setResponder((r, res) => {
      if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens')) return false;
      reply(res, r.body.model, [{ type: 'text', text: ++calls === 1 ? 'ACK' : 'tiny-synthetic-marker' }]);
      return true;
    });
    const { rehearse } = privateModule('live-smoke.js', 'module.exports.rehearse = rehearse;');
    const result = await rehearse(async () => (await connectNative(f, { CLAUDE_BRIDGE_DISABLE_TOOLS: '1' })).client,
      f.project, 'tiny-synthetic-marker');
    assert.equal(result.tools_disabled, true); assert.equal(result.exact_cached_replay, true);
    assert.equal(result.live_entitlement_verified, false); assert.ok(isSupportedVersion(result.version));
    assertWire(f, 2);
    for (const r of inference(f)) assert.deepEqual(r.body.tools || [], []);
    assert.ok(JSON.stringify(inference(f).at(-1).body.messages).includes('Remember this synthetic marker: tiny-synthetic-marker.'));
  } finally { await f.close(); }
});
