'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { fail } = require('./config');

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function validateId(id, name = 'conversation_id') {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw fail('INVALID_INPUT', `${name} must start with a letter or digit and contain at most 200 letters, digits, dots, underscores or hyphens.`);
  }
}

class Store {
  constructor(root) { this.root = path.resolve(root); }
  file(id) { validateId(id); return path.join(this.root, hash(id) + '.json'); }
  async lock(id) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = this.file(id) + '.lock';
    let handle;
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (err) {
      if (err.code === 'EEXIST') throw fail('CONVERSATION_BUSY', `Conversation is locked: ${lockPath}. Wait for the active call. After a crash, inspect the lock and session before manual recovery.`);
      throw err;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), created_at: new Date().toISOString() }));
      await handle.sync();
    } catch (err) { await handle.close(); await fs.unlink(lockPath); throw err; }
    return async () => { await handle.close(); await fs.unlink(lockPath); };
  }
  async load(id) {
    let raw;
    try { raw = await fs.readFile(this.file(id), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    try {
      const st = JSON.parse(raw);
      if (st.version !== 1 || st.conversation_id !== id ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(st.session_id) || !path.isAbsolute(st.working_dir) ||
          !Number.isInteger(st.turn) || st.turn < 0 ||
          !['ready', 'pending', 'uncertain'].includes(st.status) ||
          !Array.isArray(st.requests) || !st.policy ||
          !['dontAsk', 'acceptEdits', 'plan', 'default', 'auto'].includes(st.policy.permissionMode) ||
          !Array.isArray(st.policy.allowedTools) || st.policy.allowedTools.some(rule => typeof rule !== 'string') ||
          !(st.model === null || typeof st.model === 'string') ||
          (st.status !== 'ready' && !st.pending)) throw new Error('Invalid state fields');
      for (const request of st.requests) {
        validateId(request.id, 'request_id');
        if (typeof request.hash !== 'string' || typeof request.output?.reply !== 'string' ||
            request.output.session_id !== st.session_id || !Number.isInteger(request.output.turn)) throw new Error('Invalid request cache');
      }
      return st;
    } catch (err) { throw fail('CORRUPT_STATE', `Cannot read ${this.file(id)}: ${err.message}. State was preserved.`); }
  }
  async save(id, st) {
    const file = this.file(id);
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(st, null, 2) + '\n', 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
  }
}
module.exports = { Store, hash, validateId };
