'use strict';
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { fail } = require('./config');

const NAME = '.claude-bridge-runtime.lock';
const WAIT_MS = 30000;
const cancelled = () => fail('CANCELLED', 'Claude call cancelled.');
const lockError = () => fail('NATIVE_PROFILE_LOCK', 'Native profile lock could not be safely acquired or released.');

// A physical profile owns shared caches even when its default/explicit login
// namespaces differ. Keep this lock outside conversation state directories so
// independent MCP servers coordinate too. Never create or repair a profile.
async function acquireProfileLock(root, signal) {
  if (signal?.aborted) throw cancelled();
  let resolved;
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error();
    resolved = await fs.realpath(root);
    const s = await fs.lstat(root);
    const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!s.isDirectory() || s.isSymbolicLink() || resolved !== resolved.normalize('NFC')
        || canonical(path.resolve(root)) !== canonical(resolved)) throw new Error();
  } catch { throw fail('NATIVE_ROOT', 'Native profile root is unsupported.'); }
  const file = path.join(resolved, NAME);
  const deadline = performance.now() + WAIT_MS;
  let handle;
  while (!handle) {
    if (signal?.aborted) throw cancelled();
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw lockError();
      // A stale lock remains an operator recovery decision. PID reuse and
      // surviving native children make automatic lock stealing unsafe.
      if (performance.now() >= deadline) throw fail('NATIVE_PROFILE_BUSY', 'Native profile is busy. No task submitted.');
      try { await delay(Math.min(100, Math.max(1, deadline - performance.now())), undefined, { signal }); }
      catch { throw cancelled(); }
    }
  }
  let identity;
  const marker = JSON.stringify({ pid: process.pid, nonce: randomUUID(), created_at: new Date().toISOString() }) + '\n';
  try {
    identity = await handle.stat();
    await handle.writeFile(marker);
    await handle.sync();
  } catch {
    await handle.close().catch(() => {});
    // Only remove our still-identical file; never a replacement or a link.
    if (identity) {
      try {
        const current = syncFs.lstatSync(file);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino)
          syncFs.unlinkSync(file);
      } catch { /* Preserve recovery state if cleanup cannot establish ownership. */ }
    }
    throw lockError();
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { await handle.close(); } catch { throw lockError(); }
    // No JS yield between the ownership check and unlink. This coordinates
    // bridge processes, not hostile concurrent OS writes to the profile.
    try {
      const current = syncFs.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
          || current.size !== Buffer.byteLength(marker) || syncFs.readFileSync(file, 'utf8') !== marker) throw lockError();
      syncFs.unlinkSync(file);
    } catch { throw lockError(); }
  };
  if (signal?.aborted) { await release(); throw cancelled(); }
  return release;
}

module.exports = { acquireProfileLock };
