'use strict';

// The runtime requires a stable release strictly newer than this baseline.
// Artifact downloads may remain pinned independently for reproducible CI runs.
const MINIMUM_VERSION = '2.1.263';

function components(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
  return version.split('.').map(BigInt);
}

function isSupportedVersion(version, minimum = MINIMUM_VERSION) {
  const actual = components(version), floor = components(minimum);
  if (!actual || !floor) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== floor[i]) return actual[i] > floor[i];
  }
  return false;
}

function parseVersionOutput(output, minimum = MINIMUM_VERSION) {
  if (typeof output !== 'string') return null;
  const match = /^(\S+) \(Claude Code\)$/.exec(output.trim());
  return match && isSupportedVersion(match[1], minimum) ? match[1] : null;
}

module.exports = { MINIMUM_VERSION, isSupportedVersion, parseVersionOutput };
