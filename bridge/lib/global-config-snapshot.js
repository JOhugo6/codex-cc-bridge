'use strict';
const crypto = require('node:crypto');
const { fail } = require('./config');

// Claude Code 2.1.270, 2.1.272 and 2.1.293 writers were characterized from the
// installed executable and disposable profiles. Unknown fields remain protected.
// This digest is transient launch state: never export it in runtime identities,
// errors, logs, or persisted conversation state. Global JSON can contain secrets.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100000;
const bad = () => fail('NATIVE_SOURCE', 'Native global configuration is malformed, unreadable, or unsupported.');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = v => nonnegative(v) && Number.isSafeInteger(v);
const numericMap = v => object(v) && Object.values(v).every(count);
const version = v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const pluginUsage = value => object(value) && Object.values(value).every(row => object(row)
  && Object.hasOwn(row, 'usageCount') && count(row.usageCount)
  && Object.hasOwn(row, 'lastUsedAt') && nonnegative(row.lastUsedAt)
  && Object.keys(row).every(key => ['usageCount', 'lastUsedAt', 'lastUsedNumStartups'].includes(key))
  && (!Object.hasOwn(row, 'lastUsedNumStartups') || count(row.lastUsedNumStartups)));
const skillUsage = value => object(value) && Object.values(value).every(row => object(row)
  && Object.hasOwn(row, 'usageCount') && count(row.usageCount)
  && Object.hasOwn(row, 'lastUsedAt') && nonnegative(row.lastUsedAt)
  && Object.keys(row).every(key => ['usageCount', 'lastUsedAt'].includes(key)));
const top = new Map([
  // 2.1.272 flushes plugin dispatch/LSP usage into these rows. Readers report
  // plugin-loaded telemetry and disuse suggestions, never enabled-plugin policy.
  ['pluginUsage', pluginUsage],
  // Skill use also affects recency-weighted prompt-description ranking and UI.
  // This contract does not freeze incidental prompt ordering or project content;
  // skill usage never selects account, provider, trust, or permission policy.
  ['skillUsage', skillUsage],
  ...`numStartups memoryUsageCount promptQueueUseCount btwUseCount queuedCommandUpHintCount lspRecommendationIgnoredCount`.split(' ').map(k => [k, count]),
  ...['tipsHistory', 'tipLifetimeShownCounts', 'seenNotifications'].map(k => [k, numericMap]),
  ['firstStartTime', iso], ['firstStartVersion', version],
  // Native writes Date.now() alongside feature data; its only reader renders
  // diagnostic 'last fetched ... ago'. Actual feature/cache values stay protected.
  ['cachedGrowthBookFeaturesAt', nonnegative],
  // Native bOe generates a random identifier used as a redacted telemetry host.
  // userID is deliberately protected: it also participates in feature targeting.
  ['machineID', v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)],
]);
const metricNames = new Set(`inputTokens outputTokens thinkingTokens cacheReadInputTokens cacheCreationInputTokens webSearchRequests costUSD`.split(' '));
const modelUsage = v => object(v) && Object.values(v).every(row => object(row)
  && Object.entries(row).every(([key, value]) => metricNames.has(key) && nonnegative(value)));
const project = new Map([
  ...`lastCost lastAPIDuration lastAPIDurationWithoutRetries lastToolDuration lastDuration lastStartTime lastLinesAdded lastLinesRemoved lastTotalInputTokens lastTotalOutputTokens lastTotalCacheCreationInputTokens lastTotalCacheReadInputTokens lastTotalWebSearchRequests lastFpsAverage lastFpsLow1Pct`.split(' ').map(k => [k, nonnegative]),
  ['lastSessionId', uuid], ['lastGracefulShutdown', v => typeof v === 'boolean'],
  ['lastVersionBase', version], ['lastModelUsage', modelUsage],
  // djt().getAll() emits flat session telemetry (counters/gauges/percentiles).
  // The sole native reader forwards it to the previous-session telemetry event.
  ['lastSessionMetrics', v => object(v) && Object.values(v).every(n => typeof n === 'number' && Number.isFinite(n))],
]);

function globalConfigFingerprint(bytes) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes)) || Buffer.byteLength(bytes) > MAX_BYTES) throw bad();
  let value;
  try { value = JSON.parse(Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes); }
  catch { throw bad(); }
  if (!object(value)) throw bad();
  let nodes = 0;
  function canonical(v, scope, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw bad();
    if (typeof v === 'number' && !Number.isFinite(v)) throw bad();
    if (Array.isArray(v)) return '[' + v.map(item => canonical(item, 'protected', depth + 1)).join(',') + ']';
    if (!object(v)) return JSON.stringify(v);
    const entries = [];
    for (const key of Object.keys(v).sort()) {
      // Traverse omitted values too, so malformed/oversize structures do not
      // escape bounds merely by sitting below a recognized operational key.
      const next = scope === 'top' && key === 'projects' ? 'projects'
        : scope === 'projects' ? 'project'
        : scope === 'top' && key === 'oauthAccount' ? 'account'
        : scope === 'top' && key === 'cachedGrowthBookFeatures' ? 'features' : 'protected';
      const child = canonical(v[key], next, depth + 1);
      // 2.1.293 doctor alternates this cache entry between absent and 0. Its
      // native reader uses a default of 0 (disabled remote permission timeout),
      // so only the explicit default is equivalent to absence. Nonzero values
      // and every other feature remain protected, including credential routing.
      if (scope === 'features' && key === 'tengu_misty_aurora' && v[key] === 0) continue;
      const validator = scope === 'top' ? top.get(key) : scope === 'project' ? project.get(key)
        : scope === 'account' && key === 'profileFetchedAt' ? nonnegative : undefined;
      if (validator) {
        if (!validator(v[key])) throw bad();
        continue;
      }
      entries.push(JSON.stringify(key) + ':' + child);
    }
    return '{' + entries.join(',') + '}';
  }
  return crypto.createHash('sha256').update(canonical(value, 'top', 0)).digest('hex');
}

// Read at most MAX_BYTES + 1 through a handle, validating both the handle and
// current pathname. Native atomic replacement is allowed; a torn/replaced read
// gets at most three immediate attempts. Symlinks are never followed knowingly.
function readGlobalConfigSnapshot(file, io) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      const before = io.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw bad();
      fd = io.openSync(file, 'r');
      const opened = io.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_BYTES) throw bad();
      if (before.dev !== opened.dev || before.ino !== opened.ino) continue;
      const bytes = Buffer.alloc(Math.min(opened.size + 1, MAX_BYTES + 1));
      let length = 0;
      while (length < bytes.length) {
        const read = io.readSync(fd, bytes, length, bytes.length - length, length);
        if (!read) break;
        length += read;
      }
      const after = io.fstatSync(fd), current = io.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink()) throw bad();
      if (opened.dev !== current.dev || opened.ino !== current.ino || opened.size !== after.size
          || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
          || opened.mode !== after.mode || after.mode !== current.mode || after.size !== current.size
          || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs || length !== opened.size) continue;
      const fingerprint = globalConfigFingerprint(bytes.subarray(0, length));
      // File mode remains protected; inode/timestamps/content formatting do not.
      return [current.mode, fingerprint].join(':');
    } catch { throw bad(); }
    finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { throw bad(); } } }
  }
  throw bad();
}
module.exports = { MAX_BYTES, globalConfigFingerprint, readGlobalConfigSnapshot };
