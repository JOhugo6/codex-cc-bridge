'use strict';
const fs = require('node:fs');

// codex mcp add writes a canonical table. Restrict changes to that table and
// retain every byte of other servers, profiles, comments and credential settings.
function setTimeouts(source, seconds) {
  const lines = source.split(/(?<=\n)/);
  const start = lines.findIndex(line => /^\[mcp_servers\.claude_bridge\]\s*$/.test(line.trim()));
  if (start < 0) throw new Error('Canonical [mcp_servers.claude_bridge] table not found.');
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const body = lines.slice(start + 1, end).filter(line => !/^\s*(startup_timeout_sec|tool_timeout_sec)\s*=/.test(line));
  return [...lines.slice(0, start), `[mcp_servers.claude_bridge]${newline}`, `startup_timeout_sec = 30${newline}`, `tool_timeout_sec = ${seconds}${newline}`, ...body, ...lines.slice(end)].join('');
}
if (require.main === module) {
  const [file, value] = process.argv.slice(2);
  const seconds = Number(value);
  if (!file || !Number.isInteger(seconds) || seconds < 1) throw new Error('Usage: node configure-timeout.js config.toml seconds');
  const result = setTimeouts(fs.readFileSync(file, 'utf8'), seconds);
  const temp = file + '.claude-bridge.tmp';
  fs.writeFileSync(temp, result, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
module.exports = { setTimeouts };
