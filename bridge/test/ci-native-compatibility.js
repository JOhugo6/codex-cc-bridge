'use strict';
const { performance } = require('node:perf_hooks');
const { diagnostic, failure, field } = require('./ci-diagnostics');
const { parseVersionOutput } = require('../lib/native-version');

// Kept outside the fixture solely for deterministic tests. The fixture's raw
// native launcher remains private, and still checks BOTH stages before EVERY run.
async function checkCompatibility(launch, options, supportedVersion, requiredFlags, observe = () => {}) {
  const probeOptions = { ...options, input: '' };
  let version;
  for (const stage of ['version', 'help']) {
    const started = performance.now();
    let result;
    const fail = (code, details = {}) => {
      throw failure(`Native CLI compatibility prerequisite failed (${stage === 'help' ? 'flags' : stage}); no task launched.`,
        'NATIVE_CONTRACT_INCOMPATIBLE', `native-${stage}`, { ...details, elapsedMs: performance.now() - started, code });
    };
    try { result = await launch([`--${stage}`], probeOptions); }
    catch { fail('SPAWN_FAILED'); }
    const details = {
      exit: field(result, 'code'), timedOut: field(result, 'timedOut'),
      oversized: field(result, 'oversized'), childStarted: field(result, 'childStarted'),
    };
    if (details.timedOut === true) fail('TIMEOUT', details);
    if (details.oversized === true) fail('OUTPUT_LIMIT', details);
    if (!Number.isInteger(details.exit)) fail('INVALID_RESULT', details);
    if (details.exit !== 0) fail('EXIT_NONZERO', details);
    const stdout = field(result, 'stdout');
    if (typeof stdout !== 'string') fail('INVALID_RESULT', details);
    if (stage === 'version') {
      version = parseVersionOutput(stdout, supportedVersion);
      if (!version) fail('VERSION_MISMATCH', details);
    }
    if (stage === 'help') {
      const flags = new Set(stdout.split(/\s+/));
      if (!requiredFlags.every(flag => flags.has(flag))) fail('FLAGS_MISSING', details);
    }
    observe(diagnostic(`native-${stage}`, { ...details, elapsedMs: performance.now() - started, code: 'OK', ready: true }));
  }
  return { version, flags: [...requiredFlags] };
}
module.exports = { checkCompatibility };
