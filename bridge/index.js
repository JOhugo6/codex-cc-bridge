#!/usr/bin/env node
'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { config, safeError } = require('./lib/config');
const { ClaudeBackend } = require('./lib/claude-backend');
const { ClaudeBridge } = require('./lib/bridge');

async function main(createBackend = settings => new ClaudeBackend(settings), createRuntime) {
  const settings = config();
  const backend = createBackend(settings);
  const bridge = new ClaudeBridge(backend, settings, createRuntime);
  const server = new McpServer({ name: 'claude-bridge', version: '1.0.0' }, {
    instructions: 'Use claude_turn to delegate a bounded task to Claude Code CLI. Keep conversation_id stable for follow-ups. Supply an absolute working_dir for a new conversation. Claude has its own persistent context; send the task and relevant context explicitly. Inspect permission_denials. Use claude_status after an interrupted call; never automatically start a replacement conversation.',
  });
  const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
  const wrap = fn => async (input, extra) => {
    try {
      const output = await fn(input, extra);
      return { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] };
    } catch (err) {
      err = safeError(err);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: err.code || 'BRIDGE_ERROR', message: err.message, ...(err.reason ? { reason: err.reason } : {}) }) }] };
    }
  };
  server.registerTool('claude_turn', {
    title: 'Claude Code subagent',
    description: 'Send a task or follow-up to Claude Code CLI, which can read or edit the project according to the configured permissions. Persists and resumes a separate Claude session. Use a stable conversation_id and an absolute working_dir on the first call. Supply a unique request_id per turn; reuse it only to retrieve the same completed request safely.',
    inputSchema: z.object({
      conversation_id: id, message: z.string().min(1).max(100000),
      working_dir: z.string().min(1).max(4096).optional(), request_id: id.optional(),
      model: z.string().min(1).max(200).optional().describe('Optional verified native model alias or ID, fixed at session creation. Defaults to Opus (or CLAUDE_BRIDGE_MODEL); existing sessions retain their pinned model.'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, wrap((input, extra) => bridge.turn(input, extra.signal)));
  server.registerTool('claude_status', {
    title: 'Claude conversation status',
    description: 'Read persisted conversation status and the last completed result without launching Claude. Use after a timeout or disconnection.',
    inputSchema: z.object({ conversation_id: id }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, wrap(input => bridge.status(input.conversation_id)));
  const transport = new StdioServerTransport();
  const shutdown = () => backend.close();
  server.server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGINT', () => { shutdown(); server.close().catch(() => {}); });
  process.on('SIGTERM', () => { shutdown(); server.close().catch(() => {}); });
  await server.connect(transport);
}
if (require.main === module) main().catch(err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; });
module.exports = { main };
