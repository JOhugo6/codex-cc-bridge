'use strict';
// CI-only downloader, never imported by the bridge. No install, login, execution,
// PATH mutation, repository-variable URL, or public test-transport override.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Official bootstrap.ps1 establishes this distribution origin/path. Independently
// checked against the pinned HTTPS manifest and its release signature (2026-09-11).
// Updates require source review, never 'latest' or a fork-supplied URL/checksum.
const ARTIFACT = Object.freeze({
  version: '2.1.268', platform: 'win32-x64',
  url: 'https://downloads.claude.ai/claude-code-releases/2.1.268/win32-x64/claude.exe',
  sha256: '1e472bcfd49449e73ef76698c87f6583055aeb88dc41ca190a9c12c6791b5eea',
  size: 221637792,
});
const failure = code => Object.assign(new Error(code), { code });

function validateArtifact(artifact) {
  if (artifact.version !== '2.1.268' || artifact.platform !== 'win32-x64'
      || artifact.url !== 'https://downloads.claude.ai/claude-code-releases/2.1.268/win32-x64/claude.exe'
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > 300 * 1024 * 1024) {
    throw failure('PROVISION_SOURCE');
  }
}

// Parameters below are private programmatic test seams, not CLI/env options.
// Tests expose this function only by compiling a private module copy.
async function provision(output, artifact = ARTIFACT, get = https.get, timeoutMs = 120000) {
  validateArtifact(artifact);
  if (typeof output !== 'string' || !path.isAbsolute(output) || /[\r\n\0]/.test(output)) throw failure('PROVISION_OUTPUT');
  // Reserve a new directory. Never overwrite or clean a pre-existing destination.
  await fsp.mkdir(output);
  const partial = path.join(output, 'claude.exe.partial');
  const executable = path.join(output, 'claude.exe');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let request;
  try {
    const response = await new Promise((resolve, reject) => {
      request = get(artifact.url, { signal: controller.signal, rejectUnauthorized: true }, resolve);
      request.once('error', reject);
    });
    // Never follow redirects, accept compressed payloads, or trust Content-Length
    // instead of the counted bytes. Explicit TLS verification cannot be disabled by
    // NODE_TLS_REJECT_UNAUTHORIZED in the invoking environment.
    if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      response.destroy(); throw failure('PROVISION_HTTP');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const check = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > artifact.size) return done(failure('PROVISION_SIZE'));
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(response, check, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
    if (bytes !== artifact.size) throw failure('PROVISION_SIZE');
    if (hash.digest('hex') !== artifact.sha256) throw failure('PROVISION_HASH');
    // Publish only verified bytes. This helper never executes even a valid binary.
    await fsp.rename(partial, executable);
    return { executable, version: artifact.version, sha256: artifact.sha256, bytes };
  } catch (error) {
    request?.destroy();
    await fsp.rm(output, { recursive: true, force: true });
    throw error;
  } finally { clearTimeout(timer); }
}

async function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 2 || args[0] !== '--output') throw failure('PROVISION_ARGUMENTS');
    if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('PROVISION_PLATFORM');
    const result = await provision(args[1]);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    return 0;
  } catch (error) {
    const known = ['PROVISION_SOURCE', 'PROVISION_OUTPUT', 'PROVISION_ARGUMENTS', 'PROVISION_PLATFORM', 'PROVISION_HTTP', 'PROVISION_SIZE', 'PROVISION_HASH'];
    const code = known.includes(error?.code) ? error.code : 'PROVISION_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, code,
      note: 'Native coverage BLOCKED. Require the reviewed pinned HTTPS artifact, an unused absolute output directory and supported Windows x64. No executable was run; no fallback.' }) + '\n');
    return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { main };
