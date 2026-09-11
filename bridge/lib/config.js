'use strict';
const path = require('node:path');
const os = require('node:os');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// Never echo subprocess output, parser excerpts, auth diagnostics, or arbitrary
// exception messages into MCP responses or persisted errors. Codes are allowlisted too.
function safeError(err) {
  const messages = {
    INVALID_INPUT: 'Invalid conversation, request, message, or model input.',
    INVALID_CONFIG: 'Invalid bridge configuration.',
    INVALID_WORKING_DIR: 'Supply an existing absolute working_dir on the first turn.',
    WORKING_DIR_MISMATCH: 'A conversation cannot switch working_dir. Choose a new conversation_id.',
    MODEL_MISMATCH: 'The model is fixed for this conversation. Choose a new conversation_id.',
    REQUEST_ID_CONFLICT: 'request_id was already used with a different message.',
    CONVERSATION_BUSY: 'Conversation is locked. After a crash inspect its lock and session before manual recovery.',
    CORRUPT_STATE: 'Invalid or unsupported persisted state. State was preserved.',
    LEGACY_SESSION: 'Legacy v1 sessions have no verified provider identity. Only status and completed-request replay are available. Use a new conversation_id for new work; the old session is preserved.',
    TURN_UNCERTAIN: 'A previous turn is pending or uncertain. Inspect claude_status and the session before recovery. No new task was submitted.',
    CANCELLED: 'Claude call cancelled. Inspect session status before retrying.',
    CLAUDE_TIMEOUT: 'Claude exceeded its timeout. Inspect session status before retrying.',
    OUTPUT_TOO_LARGE: 'Claude output exceeded 16 MiB.',
    CLAUDE_SPAWN_FAILED: 'Could not start the supervised native executable.',
    CLAUDE_EXIT: 'Claude exited without a successful result. Inspect the native session locally.',
    CLAUDE_AUTH_FAILED: 'Native Claude authentication failed. Inspect the failed session and native login before further work.',
    CLAUDE_RESULT_ERROR: 'Native Claude returned an unsuccessful result. No fallback was attempted.',
    INVALID_RESULT: 'Claude did not return one valid successful result.',
    SESSION_ID_DRIFT: 'Claude returned a different session identity. The original session was preserved.',
    MODEL_DRIFT: 'Structured native usage reports a model other than the pinned model. No fallback is allowed.',
    NATIVE_INPUT: 'Invalid native runtime input.',
    NATIVE_MODEL: 'Unsupported model. Select a model from the verified native runtime catalog.',
    NATIVE_SOURCE: 'Native settings source is malformed, unreadable, or unsupported.',
    NATIVE_CONFLICT: 'Native routing, authentication, or dynamic policy conflicts with this runtime.',
    NATIVE_ROOT: 'Native profile root is unsupported. Preserve the standard root or explicitly select an existing native profile.',
    NATIVE_PLATFORM: 'This native runtime contract supports Windows only.',
    NATIVE_COMPATIBILITY: 'Native executable requires Claude Code newer than 2.1.263 and the supported runtime flags.',
    NATIVE_AUTH: 'An ordinary saved first-party Pro or Max login is required.',
    NATIVE_POLICY: 'Native personal-account policy eligibility could not be established.',
    NATIVE_DIAGNOSTIC: 'Native metadata command failed or exceeded its bounds.',
    NATIVE_DRIFT: 'Native sources or profile identity changed before submission. Inspect status before retrying.',
  };
  const code = err && Object.hasOwn(messages, err.code) ? err.code : 'BRIDGE_ERROR';
  return fail(code, messages[code] || 'Bridge operation failed. Inspect persisted status before retrying.');
}

// Tool rules become individual argv values for a variadic native option. Never
// accept an option/terminator here, but preserve flags inside e.g. Bash(git --version).
// Copy by index: Array#some skips holes and an overridden iterator can inject
// unchecked values during a later spread, even when every indexed value is safe.
function validateAllowedTools(value) {
  try {
    if (!Array.isArray(value)) throw new Error();
    const rules = [];
    const length = value.length;
    for (let i = 0; i < length; i++) {
      const rule = value[i];
      if (typeof rule !== 'string' || !rule.trim() || rule.length > 500 ||
          rule.trimStart().startsWith('-') || rule.includes('\0')) throw new Error();
      rules.push(rule);
    }
    return rules;
  } catch { throw fail('INVALID_CONFIG', 'Allowed tools must be an array of tool rules, not CLI options.'); }
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
  if (env.CLAUDE_BRIDGE_DISABLE_TOOLS !== undefined && !['0', '1'].includes(env.CLAUDE_BRIDGE_DISABLE_TOOLS)) {
    throw fail('INVALID_CONFIG', 'CLAUDE_BRIDGE_DISABLE_TOOLS must be 0 or 1.');
  }
  const disableTools = env.CLAUDE_BRIDGE_DISABLE_TOOLS === '1';
  let allowedTools = [];
  try {
    allowedTools = validateAllowedTools(JSON.parse(env.CLAUDE_BRIDGE_ALLOWED_TOOLS || '[]'));
  } catch { throw fail('INVALID_CONFIG', 'CLAUDE_BRIDGE_ALLOWED_TOOLS must be a JSON array of tool rules.'); }
  // Configuration is pure: status/replay must work with no executable or login.
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return {
    command: env.CLAUDE_BRIDGE_COMMAND || (process.platform === 'win32' ? path.join(home, '.local', 'bin', 'claude.exe') : 'claude'),
    stateDir: path.resolve(env.CLAUDE_BRIDGE_STATE_DIR || path.join(env.CODEX_HOME || path.join(home, '.codex'), 'state', 'claude-bridge')),
    timeoutMs, permissionMode, allowedTools, disableTools,
    model: env.CLAUDE_BRIDGE_MODEL || 'opus',
    ...(env.CLAUDE_BRIDGE_CONFIG_DIR === undefined ? {} : { configRoot: env.CLAUDE_BRIDGE_CONFIG_DIR }),
    parentEnv: { ...env },
  };
}
module.exports = { config, fail, safeError, validateAllowedTools };
