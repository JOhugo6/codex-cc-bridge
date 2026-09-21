'use strict';
// Private, entirely synthetic MCP peer. No Claude/backend/auth imports or network.
const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
async function serve() {
  const root = process.env.SMOKE_FIXTURE_ROOT;
  if (!root || !path.isAbsolute(root) || !/^bridge-diagnostic-/.test(path.basename(root))) throw new Error('Synthetic root required');
  const file = path.join(root, 'smoke-state.json');
  fs.appendFileSync(path.join(root, 'processes'), process.pid + '\n');
  const server = new McpServer({ name: 'offline-smoke-fixture', version: '1.0.0' });
  const response = output => ({ structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] });
  const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  server.registerTool('claude_turn', { inputSchema: z.object({ conversation_id: z.string(), request_id: z.string(),
    message: z.string(), model: z.string().optional(), working_dir: z.string().optional() }) }, async input => {
    let state = load();
    if (state?.requests[input.request_id]) {
      if (state.requests[input.request_id].message !== input.message) throw new Error('Synthetic request conflict');
      return response({ ...state.requests[input.request_id].output, replayed: true });
    }
    if (!state) {
      const model = 'claude-opus-5[1m]', cwd = input.working_dir;
      state = { turn: 0, requests: {}, marker: input.message.match(/marker: ([^.]+)\./)[1],
        runtime: { contract: 'native-windows-personal/2.1.263/v1', version: '2.1.264',
          executable: path.join(root, 'synthetic.exe'), model, configRoot: path.join(root, '.claude'),
          configRootMode: 'default', nativeConfigRoot: null, home: root, cwd,
          executableFingerprint: 'a'.repeat(64), accountFingerprint: 'b'.repeat(64) } };
    }
    const output = { reply: state.turn ? state.marker : 'ACK', session_id: '11111111-1111-4111-8111-111111111111',
      turn: ++state.turn, working_dir: state.runtime.cwd, replayed: false, runtime: state.runtime,
      model: state.runtime.model, model_evidence: ['claude-opus-5'], permission_denials: [], usage: { output_tokens: 1 }, total_cost_usd: 0 };
    state.requests[input.request_id] = { message: input.message, output };
    state.last_result = output;
    fs.writeFileSync(file, JSON.stringify(state));
    return response(output);
  });
  server.registerTool('claude_status', { inputSchema: z.object({ conversation_id: z.string() }) }, async () => {
    const state = load();
    return response({ version: 2, status: 'ready', turn: state.turn, model: state.runtime.model,
      policy: { disableTools: false, permissionMode: 'bypassPermissions' }, runtime: state.runtime, session_id: state.last_result.session_id, last_result: state.last_result });
  });
  await server.connect(new StdioServerTransport());
}
if (require.main === module) serve().catch(() => { process.exitCode = 1; });
