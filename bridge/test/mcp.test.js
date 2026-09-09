'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { connect } = require('../doctor');
const { fixture } = require('./helpers');
const { setTimeouts } = require('../configure-timeout');

test('stdio MCP handshake, tool schemas, status and input errors', async t => {
  const { settings } = await fixture(t);
  const client = await connect(undefined, {
    CLAUDE_BRIDGE_STATE_DIR: settings.stateDir, CLAUDE_BRIDGE_COMMAND: 'nonexistent-native-executable',
    CLAUDE_BRIDGE_CONFIG_DIR: 'nonexistent-native-profile', CLAUDE_BRIDGE_MODEL: 'invalid-default',
  });
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['claude_status', 'claude_turn']);
  const status = await client.callTool({ name: 'claude_status', arguments: { conversation_id: 'unknown' } });
  assert.deepEqual(status.structuredContent, { exists: false, conversation_id: 'unknown' });
  const invalid = await client.callTool({ name: 'claude_turn', arguments: { conversation_id: '../escape', message: 'x' } });
  assert.equal(invalid.isError, true);
  for (const extra of [{ bypass: true }, { env: { ANTHROPIC_API_KEY: 'synthetic' } }, { provider: 'other' },
    { auth: 'synthetic' }, { createRuntime: 'fakeRuntime' }, { configRoot: 'child-root' }, { command: 'other' }]) {
    const response = await client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'x', message: 'x', ...extra } });
    assert.equal(response.isError, true);
  }
});

test('timeout configuration preserves other servers and is idempotent', () => {
  const source = '# top\r\nmodel = "unchanged"\r\n[mcp_servers.other]\r\ncommand = "other"\r\n[mcp_servers.claude_bridge]\r\ncommand = "node"\r\ntool_timeout_sec = 60\r\n[mcp_servers.claude_bridge.env]\r\nA = "B"\r\n[profiles.test]\r\nmodel = "another"\r\n';
  const result = setTimeouts(source, 960);
  assert.ok(result.startsWith(source.split('[mcp_servers.claude_bridge]')[0]));
  assert.ok(result.endsWith(source.slice(source.indexOf('[mcp_servers.claude_bridge.env]'))));
  assert.equal((result.match(/tool_timeout_sec/g) || []).length, 1);
  assert.equal(setTimeouts(result, 960), result);
  assert.throws(() => setTimeouts('[mcp_servers.other]\n', 960));
});

test('MCP round trip resumes the CLI after server restart and replays without another model turn', async t => {
  const { cwd, settings } = await fixture(t);
  const entry = path.join(__dirname, 'stub-server.js');
  const env = { CLAUDE_BRIDGE_STATE_DIR: settings.stateDir };
  let client = await connect(entry, env);
  const input = { conversation_id: 'roundtrip', request_id: 'first', working_dir: cwd, message: 'first\r\n\nž🧪' };
  let first;
  try {
    const response = await client.callTool({ name: 'claude_turn', arguments: input });
    assert.ok(!response.isError, JSON.stringify(response));
    first = response.structuredContent;
    assert.equal(first.reply, input.message);
  } finally { await client.close(); }
  client = await connect(entry, env);
  try {
    const replay = await client.callTool({ name: 'claude_turn', arguments: input });
    assert.equal(replay.structuredContent.replayed, true);
    const next = await client.callTool({ name: 'claude_turn', arguments: { conversation_id: 'roundtrip', request_id: 'second', message: 'second' } });
    assert.ok(!next.isError, JSON.stringify(next));
    assert.equal(next.structuredContent.session_id, first.session_id);
    assert.equal(next.structuredContent.reply, input.message + '\n---\nsecond');
    assert.equal(next.structuredContent.turn, 2);
  } finally { await client.close(); }
});
