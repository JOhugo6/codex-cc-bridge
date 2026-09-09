'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { fail, validateAllowedTools } = require('./config');

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function validateId(id, name = 'conversation_id') {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw fail('INVALID_INPUT', `${name} must start with a letter or digit and contain at most 200 letters, digits, dots, underscores or hyphens.`);
  }
}

const { validateIdentity, resolveModel } = require('./native-runtime');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Pure on-disk validation: never instantiate or query the native runtime here.
function validateState(st, id) {
  if (!object(st) || ![1, 2].includes(st.version) || st.conversation_id !== id ||
      typeof st.session_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(st.session_id) ||
      typeof st.working_dir !== 'string' || !path.isAbsolute(st.working_dir) ||
      !Number.isSafeInteger(st.turn) || st.turn < 0 || !['ready', 'pending', 'uncertain'].includes(st.status) ||
      !Array.isArray(st.requests) || !object(st.policy) ||
      !['dontAsk', 'acceptEdits', 'plan', 'default', 'auto'].includes(st.policy.permissionMode) ||
      !Array.isArray(st.policy.allowedTools) || st.policy.allowedTools.some(rule => typeof rule !== 'string' || !rule.trim() || rule.length > 500) ||
      !(st.model === null || typeof st.model === 'string')) throw new Error('Invalid state');
  if (st.status === 'ready') {
    if (st.pending != null) throw new Error('Ready state has a pending request');
  } else {
    if (!object(st.pending) || !digest(st.pending.message_hash) || !timestamp(st.pending.started_at)) throw new Error('Invalid pending request');
    if (st.pending.request_id !== null) validateId(st.pending.request_id, 'request_id');
  }
  if (st.version === 2) {
    // V1 is replay-only: do not reinterpret or rewrite its historical policy.
    validateAllowedTools(st.policy.allowedTools);
    validateIdentity(st.runtime);
    const keys = ['contract', 'version', 'executable', 'model', 'configRoot', 'configRootMode', 'nativeConfigRoot', 'home', 'cwd', 'executableFingerprint', 'accountFingerprint'];
    if (Object.keys(st.runtime).length !== keys.length || Object.keys(st.runtime).some(k => !keys.includes(k)) ||
        resolveModel(st.model) !== st.model || st.runtime.model !== st.model || st.runtime.cwd !== st.working_dir ||
        !timestamp(st.created_at) || (st.updated_at !== undefined && !timestamp(st.updated_at))) throw new Error('Invalid native state');
    if (Object.keys(st.policy).some(k => !['permissionMode', 'allowedTools', 'disableTools'].includes(k)) ||
        (Object.hasOwn(st.policy, 'disableTools') && typeof st.policy.disableTools !== 'boolean')) throw new Error('Invalid policy');
  }
  function output(value) {
    if (!object(value) || typeof value.reply !== 'string' || value.session_id !== st.session_id ||
        !Number.isSafeInteger(value.turn) || value.turn < 1 || value.turn > st.turn ||
        value.working_dir !== st.working_dir || value.replayed !== false) throw new Error('Invalid completed result');
    if (st.version === 2 && (value.model !== st.model || !object(value.runtime) ||
        Object.keys(value.runtime).length !== Object.keys(st.runtime).length ||
        Object.keys(st.runtime).some(k => value.runtime[k] !== st.runtime[k]))) throw new Error('Invalid result identity');
  }
  const ids = new Set();
  for (const request of st.requests) {
    if (!object(request)) throw new Error('Invalid request cache');
    validateId(request.id, 'request_id');
    if (ids.has(request.id) || !digest(request.hash)) throw new Error('Invalid request cache');
    ids.add(request.id);
    output(request.output);
  }
  if (st.last_result != null) {
    output(st.last_result);
    if (st.last_result.turn !== st.turn) throw new Error('Invalid last result');
  } else if (st.turn > 0) throw new Error('Missing last result');
  if (st.last_error != null && (!object(st.last_error) || typeof st.last_error.code !== 'string' || typeof st.last_error.message !== 'string')) throw new Error('Invalid error');
  return st;
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
    try { return validateState(JSON.parse(raw), id); }
    catch { throw fail('CORRUPT_STATE', 'Invalid or unsupported persisted state. State was preserved.'); }
  }
  async save(id, st) {
    try { validateState(st, id); }
    catch { throw fail('CORRUPT_STATE', 'Refusing invalid persisted state. Existing state was preserved.'); }
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
