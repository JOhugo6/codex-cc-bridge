'use strict';

// TEST ONLY. No arbitrary error/child text crosses this diagnostic boundary.
const STAGES = new Set(['unknown', 'fixture', 'cleanup', 'native-version', 'native-help',
  'probe-setup', 'probe-ps5-first', 'probe-ps5-repeat', 'probe-ps7-first', 'probe-ps7-repeat',
  'direct-ps5-first', 'direct-ps5-repeat', 'direct-ps7-first', 'direct-ps7-repeat',
  'ps-start', 'breakpoint-6-set', 'breakpoint-7-set', 'supervisor-call', 'add-type-start', 'add-type-complete',
  'child-start', 'child-io', 'probe-close', 'control-ps5-json', 'control-ps5-import-json',
  'module-ps-start', 'module-import-start', 'module-import-complete', 'json-start', 'json-complete', 'module-control-complete']);
const CODES = new Set(['OK', 'UNKNOWN', 'SPAWN_FAILED', 'TIMEOUT', 'OUTPUT_LIMIT', 'EXIT_NONZERO',
  'VERSION_MISMATCH', 'FLAGS_MISSING', 'INVALID_RESULT', 'PROBE_PROTOCOL', 'SOURCE_MISMATCH',
  'ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EAGAIN']);
const failures = new WeakMap();

function field(value, key) {
  // Do not execute getters (or propagate throwing Proxy traps) from an error.
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function diagnostic(stage, value = {}) {
  const result = { stage: STAGES.has(stage) ? stage : 'unknown' };
  const elapsedMs = field(value, 'elapsedMs');
  if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 300000) result.elapsedMs = Math.round(elapsedMs);
  const exit = field(value, 'exit');
  if (Number.isInteger(exit) && exit >= -2147483648 && exit <= 4294967295) result.exit = exit;
  const code = field(value, 'code');
  if (CODES.has(code)) result.code = code;
  for (const key of ['timedOut', 'oversized', 'ready', 'childStarted']) {
    const flag = field(value, key);
    if (typeof flag === 'boolean') result[key] = flag;
  }
  return Object.freeze(result);
}
function failure(message, code, stage, details) {
  const error = Object.assign(new Error(message), { code, diagnostic: diagnostic(stage, details) });
  failures.set(error, error.diagnostic);
  return error;
}
function failureDiagnostic(error) {
  // Only diagnostics constructed here are trusted, never lookalike properties.
  return failures.get(error) || diagnostic('unknown', { code: 'UNKNOWN' });
}
function emit(value, write = line => process.stdout.write(line + '\n')) {
  write(JSON.stringify(diagnostic(field(value, 'stage'), value)));
}
function lines(onLine, limit = 256, onDiscard = () => {}, prefixes = []) {
  if (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== 'string' || !prefix.length || !(prefix.length <= limit))) {
    throw new TypeError('Invalid line prefixes');
  }
  const tracked = [...prefixes];
  const prefixLimit = tracked.reduce((max, prefix) => Math.max(max, prefix.length), 0);
  let pending = '', discarded = false, matchedPrefix = false, discardedPrefix = false;
  const observe = chunk => {
    for (const part of chunk.toString('utf8').split(/(?<=\n)/)) {
      if (!discarded) {
        // Inspect only a bounded line prefix, before an overlong line is lost.
        if (!matchedPrefix && pending.length < prefixLimit) {
          const start = pending + part.slice(0, prefixLimit - pending.length);
          matchedPrefix = tracked.some(prefix => start.startsWith(prefix));
        }
        // Count the terminator as before, but never retain an oversized line.
        if (pending.length + part.length > limit) {
          discardedPrefix ||= matchedPrefix;
          pending = ''; discarded = true;
          onDiscard(); // Notify immediately, once per line, without raw text.
        } else pending += part;
      }
      if (part.endsWith('\n')) {
        if (!discarded) onLine(pending.replace(/\r?\n$/, ''));
        pending = ''; discarded = false; matchedPrefix = false;
      }
    }
  };
  // Strict callers can reject trailing partial input at EOF; stderr observers
  // still ignore noise and only receive complete, bounded lines by default.
  observe.atBoundary = () => pending.length === 0 && !discarded;
  // At EOF, identify tracked prefixes in discarded or unfinished lines using
  // only booleans. A later valid line cannot erase a discarded-prefix fault.
  observe.hasLostPrefix = () => discardedPrefix || matchedPrefix;
  return observe;
}
module.exports = { diagnostic, failure, failureDiagnostic, emit, field, lines };
