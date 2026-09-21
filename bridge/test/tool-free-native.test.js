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

test('actual bridge ignores legacy tool restrictions across MCP restart and replay', { timeout: 180000 }, async () => {
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
    for (const r of inference(f)) assert.ok(r.body.tools.some(t => t.name === 'Read'));
    const executed = results(inference(f));
    for (const id of ['read_probe', 'write_probe', 'skill_probe']) {
      assert.ok(executed.some(r => r.tool_use_id === id && !r.is_error));
    }
    assert.ok(JSON.stringify(inference(f)).includes(marks.sentinel));
    assert.equal(await fs.readFile(marks.marker, 'utf8'), 'ran');
    assert.equal(await fs.readFile(marks.writeMarker, 'utf8'), 'ran');
    const status = await connection.client.callTool({ name: 'claude_status', arguments: { conversation_id: 'free' } });
    assert.equal(status.structuredContent.policy.disableTools, false);
    assert.equal(status.structuredContent.policy.permissionMode, 'bypassPermissions');
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
    assert.equal(await fs.readFile(marks.marker, 'utf8'), 'ran');
    await assert.rejects(fs.stat(marks.writeMarker), { code: 'ENOENT' });
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
    assert.equal(result.tools_disabled, false); assert.equal(result.exact_cached_replay, true);
    assert.equal(result.live_entitlement_verified, false); assert.ok(isSupportedVersion(result.version));
    assertWire(f, 2);
    for (const r of inference(f)) assert.ok(r.body.tools.some(t => t.name === 'Read'));
    assert.ok(JSON.stringify(inference(f).at(-1).body.messages).includes('Remember this synthetic marker: tiny-synthetic-marker.'));
  } finally { await f.close(); }
});


test('actual bridge discovers and executes a native project MCP tool and SessionStart hook', { timeout: 120000 }, async () => {
  const f = await synthetic({ native: true });
  let connection;
  try {
    const server = path.join(f.project, 'offline-mcp.cjs');
    await f.text('project/offline-mcp.cjs', `
      const readline = require('node:readline');
      const fs = require('node:fs');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') result = {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'offline-native-probe', version: '1.0.0' }
        };
        else if (request.method === 'tools/list') result = { tools: [{
          name: 'probe', description: 'Local offline regression probe',
          inputSchema: { type: 'object', properties: {} }
        }] };
        else if (request.method === 'tools/call') {
          fs.writeFileSync('mcp-executed', 'ran');
          result = { content: [{ type: 'text', text: 'NATIVE_MCP_EXECUTION_CONFIRMED' }] };
        } else result = {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      });
    `);
    await f.json('project/.mcp.json', { mcpServers: { offline_probe: { command: process.execPath, args: [server] } } });
    await f.json('project/.claude/settings.local.json', {
      enableAllProjectMcpServers: true,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" -e "require('fs').writeFileSync('native-hook-executed','ran')"` }] }] },
    });
    let sent = false;
    f.base.setResponder((r, res) => {
      if (!r.url.startsWith('/v1/messages') || r.url.includes('count_tokens') || sent) return false;
      sent = true;
      // Request the exact configured tool; missing discovery/execution is a failure.
      reply(res, r.body.model, [{ type: 'tool_use', id: 'native_mcp_probe', name: 'mcp__offline_probe__probe', input: {} }]);
      return true;
    });
    connection = await connectNative(f, { CLAUDE_BRIDGE_PERMISSION_MODE: 'dontAsk', CLAUDE_BRIDGE_DISABLE_TOOLS: '1' });
    const out = await connection.client.callTool({ name: 'claude_turn', arguments: {
      conversation_id: 'native-mcp', working_dir: f.project, message: 'OFFLINE_NATIVE_MCP_TASK' } });
    assert.ok(!out.isError, JSON.stringify(out)); assertWire(f, 2);
    assert.ok(inference(f)[0].body.tools.some(t => t.name === 'mcp__offline_probe__probe'));
    assert.ok(results(inference(f)).some(r => r.tool_use_id === 'native_mcp_probe' && !r.is_error && JSON.stringify(r.content).includes('NATIVE_MCP_EXECUTION_CONFIRMED')));
    assert.equal(await fs.readFile(path.join(f.project, 'mcp-executed'), 'utf8'), 'ran');
    assert.equal(await fs.readFile(path.join(f.project, 'native-hook-executed'), 'utf8'), 'ran');
  } finally { await connection?.close(); await f.close(); }
});
