'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function config(env = process.env) {
  const timeoutMs = Number(env.CLAUDE_BRIDGE_TIMEOUT_MS || 900000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000) {
    throw fail('INVALID_CONFIG', 'CLAUDE_BRIDGE_TIMEOUT_MS must be between 1000 and 86400000.');
  }
  const permissionMode = env.CLAUDE_BRIDGE_PERMISSION_MODE || 'dontAsk';
  if (!['dontAsk', 'acceptEdits', 'plan', 'default', 'auto'].includes(permissionMode)) {
    throw fail('INVALID_CONFIG', 'Unsupported CLAUDE_BRIDGE_PERMISSION_MODE.');
  }
  let allowedTools = [];
  try {
    allowedTools = JSON.parse(env.CLAUDE_BRIDGE_ALLOWED_TOOLS || '[]');
    if (!Array.isArray(allowedTools) || allowedTools.some(t => typeof t !== 'string' || !t.trim() || t.length > 500)) throw new Error();
  } catch { throw fail('INVALID_CONFIG', 'CLAUDE_BRIDGE_ALLOWED_TOOLS must be a JSON array of tool rules.'); }
  const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  return {
    command: env.CLAUDE_BRIDGE_COMMAND || (process.platform === 'win32' && fs.existsSync(native) ? native : 'claude'),
    stateDir: path.resolve(env.CLAUDE_BRIDGE_STATE_DIR || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'state', 'claude-bridge')),
    timeoutMs, permissionMode, allowedTools,
    model: env.CLAUDE_BRIDGE_MODEL || null,
  };
}
module.exports = { config, fail };
