'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store, hash, validateId } = require('./store');
const { fail } = require('./config');

async function canonicalDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw fail('INVALID_WORKING_DIR', 'Supply an absolute working_dir on the first turn.');
  try {
    const real = await fs.realpath(dir);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('Not a directory');
    return real;
  } catch (err) { throw fail('INVALID_WORKING_DIR', `${dir}: ${err.message}`); }
}
const sameDir = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

class ClaudeBridge {
  constructor(backend, settings) {
    this.backend = backend;
    this.settings = settings;
    this.store = new Store(settings.stateDir);
  }
  async turn(input, signal) {
    const { conversation_id: id, message, working_dir, request_id, model } = input;
    validateId(id);
    if (request_id !== undefined) validateId(request_id, 'request_id');
    if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw fail('INVALID_INPUT', 'message must contain 1–100000 characters and not be whitespace only.');
    if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) throw fail('INVALID_INPUT', 'Invalid model.');
    const release = await this.store.lock(id);
    try {
      let st = await this.store.load(id);
      const cwd = await canonicalDir(working_dir === undefined ? st?.working_dir : working_dir);
      if (st && !sameDir(st.working_dir, cwd)) throw fail('WORKING_DIR_MISMATCH', 'A conversation cannot switch working_dir. Choose a new conversation_id for another project.');
      if (st && model !== undefined && model !== st.model) throw fail('MODEL_MISMATCH', 'The model is fixed for this conversation. Choose a new conversation_id to change it.');
      const messageHash = hash(message);
      const cached = st?.requests.find(r => r.id === request_id);
      if (cached) {
        if (cached.hash !== messageHash) throw fail('REQUEST_ID_CONFLICT', 'request_id was already used with a different message.');
        return { ...cached.output, replayed: true };
      }
      if (st && st.status !== 'ready') throw fail('TURN_UNCERTAIN', `Previous turn is ${st.status}; session ${st.session_id} may already contain changes. Inspect claude_status and the session before recovery. No message was sent.`);
      if (signal?.aborted) throw fail('CANCELLED', 'Call cancelled before launch.');
      if (!st) st = {
        version: 1, conversation_id: id, session_id: randomUUID(), working_dir: cwd,
        model: model || this.settings.model, turn: 0, status: 'ready', requests: [],
        policy: { permissionMode: this.settings.permissionMode, allowedTools: this.settings.allowedTools },
        created_at: new Date().toISOString(),
      };
      // Persist identity BEFORE spawning. A crash must never silently create a replacement session.
      st.status = 'pending';
      st.pending = { request_id: request_id || null, message_hash: messageHash, started_at: new Date().toISOString() };
      await this.store.save(id, st);
      try {
        const result = await this.backend.run({
          sessionId: st.session_id, resume: st.turn > 0, message,
          cwd: st.working_dir, model: st.model, ...st.policy, signal,
        });
        if (result.session_id !== st.session_id) throw fail('SESSION_ID_DRIFT', `Expected ${st.session_id}, received ${result.session_id}.`);
        if (typeof result.reply !== 'string') throw fail('INVALID_RESULT', 'Claude did not return a string reply.');
        const output = { ...result, turn: st.turn + 1, working_dir: st.working_dir, replayed: false };
        const completed = { ...st, turn: output.turn, status: 'ready', pending: null, updated_at: new Date().toISOString(), last_result: output };
        if (request_id) completed.requests = [...st.requests, { id: request_id, hash: messageHash, output }];
        await this.store.save(id, completed);
        return output;
      } catch (err) {
        st.status = 'uncertain';
        st.last_error = { code: err.code || 'CLAUDE_FAILED', message: err.message };
        await this.store.save(id, st).catch(() => {}); // The durable pending marker remains on disk if saving fails.
        throw err;
      }
    } finally { await release(); }
  }
  async status(id) {
    const st = await this.store.load(id);
    if (!st) return { exists: false, conversation_id: id };
    return {
      exists: true, conversation_id: id, session_id: st.session_id, working_dir: st.working_dir,
      turn: st.turn, status: st.status, model: st.model, policy: st.policy,
      pending: st.pending || null, last_error: st.last_error || null, last_result: st.last_result || null,
      state_file: this.store.file(id),
    };
  }
}
module.exports = { ClaudeBridge, canonicalDir };
