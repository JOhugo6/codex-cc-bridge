'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connect } = require('../doctor');

async function main() {
  if (process.env.CLAUDE_BRIDGE_LIVE !== '1') {
    process.stdout.write('Skipped: set CLAUDE_BRIDGE_LIVE=1 to make two authenticated Claude calls.\n');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-bridge-live-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const env = { CLAUDE_BRIDGE_STATE_DIR: path.join(root, 'state'), CLAUDE_BRIDGE_PERMISSION_MODE: 'dontAsk', CLAUDE_BRIDGE_ALLOWED_TOOLS: '[]' };
  const secret = randomUUID();
  const first = { conversation_id: 'smoke', request_id: 'one', working_dir: cwd, message: `Remember this test token for my next message: ${secret}. Do not use tools. Reply only ACK.` };
  let client;
  const call = async args => {
    const result = await client.callTool({ name: 'claude_turn', arguments: args }, undefined, { timeout: 180000 });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  try {
    client = await connect(undefined, env);
    const one = await call(first);
    assert.equal(one.turn, 1);
    await client.close();
    client = await connect(undefined, env); // Fresh MCP server, backend and Claude process.
    const replay = await call(first);
    assert.equal(replay.replayed, true);
    const two = await call({ conversation_id: 'smoke', request_id: 'two', message: 'What test token did I give you in the preceding message? Reply only with that token. Do not use tools.' });
    assert.equal(two.session_id, one.session_id);
    assert.equal(two.turn, 2);
    assert.ok(two.reply.includes(secret), 'Resumed Claude did not remember the prior token.');
    process.stdout.write(`OK: two real Claude turns across MCP restarts, cached replay and remembered context. Session ${two.session_id}\n`);
  } finally {
    await client?.close();
    // Only this generated test directory is removed. Claude owns its native session transcript.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; });
