#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function connect(entry = path.join(__dirname, 'index.js'), env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry],
    env: { ...process.env, ...env }, stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  const client = new Client({ name: 'claude-bridge-doctor', version: '1.0.0' });
  try { await client.connect(transport); }
  catch (err) { await transport.close(); throw new Error(`${err.message}\n${diagnostics}`); }
  return client;
}
async function main() {
  const client = await connect(process.argv[2]);
  try {
    const { tools } = await client.listTools();
    for (const name of ['claude_turn', 'claude_status']) {
      if (!tools.some(tool => tool.name === name)) throw new Error(`Missing tool: ${name}`);
    }
    process.stdout.write('OK: MCP handshake; claude_turn and claude_status available. No Claude model call made.\n');
  } finally { await client.close(); }
}
if (require.main === module) main().catch(err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; });
module.exports = { connect };
