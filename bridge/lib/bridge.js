'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store, hash, validateId } = require('./store');
const { fail, safeError, validateAllowedTools } = require('./config');
const { createNativeRuntime, resolveModel, validateIdentity } = require('./native-runtime');

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
  // Dependency injection is programmatic only. MCP inputs/env cannot select code.
  constructor(backend, settings, createRuntime = createNativeRuntime) {
    this.backend = backend;
    this.settings = settings;
    this.createRuntime = createRuntime;
    this.store = new Store(settings.stateDir);
  }
  async turn(input, signal) {
    let release;
    try {
      const { conversation_id: id, message, working_dir, request_id, model } = input;
      validateId(id);
      if (request_id !== undefined) validateId(request_id, 'request_id');
      if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw fail('INVALID_INPUT');
      if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) throw fail('INVALID_INPUT');
      release = await this.store.lock(id);
      let st = await this.store.load(id);
      // Replay uses the persisted selection, never today's default or native login.
      // With no explicit cwd, even a moved/deleted project does not prevent replay.
      let cwd = working_dir === undefined && st ? st.working_dir : await canonicalDir(working_dir);
      if (st && !sameDir(st.working_dir, cwd)) throw fail('WORKING_DIR_MISMATCH');
      if (st && model !== undefined && (st.version === 1 ? model : resolveModel(model)) !== st.model) throw fail('MODEL_MISMATCH');
      const messageHash = hash(message);
      const cached = request_id === undefined ? undefined : st?.requests.find(r => r.id === request_id);
      if (cached) {
        if (cached.hash !== messageHash) throw fail('REQUEST_ID_CONFLICT');
        return { ...cached.output, replayed: true };
      }
      if (st && st.status !== 'ready') throw fail('TURN_UNCERTAIN');
      if (st?.version === 1) throw fail('LEGACY_SESSION');
      if (signal?.aborted) throw fail('CANCELLED');
      cwd = await canonicalDir(cwd);
      if (st && !sameDir(st.working_dir, cwd)) throw fail('WORKING_DIR_MISMATCH');
      const selectedModel = st ? st.model : resolveModel(model, this.settings.model);
      // Programmatic callers also cross this boundary. Check before native
      // preflight/pending, but never apply today's policy to cache or legacy state.
      validateAllowedTools(st ? st.policy.allowedTools : this.settings.allowedTools);
      const allowedTools = [];
      // Old v2 states without this field retain historical normal-tool semantics.
      // Legacy policy is normalized only for new work; status/replay remain historical.
      const toolMode = st ? st.policy.disableTools : this.settings.disableTools;
      const requestedDisableTools = toolMode === undefined ? false : toolMode;
      const disableTools = false;
      if (typeof requestedDisableTools !== 'boolean') throw fail('INVALID_CONFIG', 'Tool-disable policy must be boolean.');
      // The parent's profile selector is NOT an implicit child profile setting.
      // Other root/routing conflicts remain for the native adapter to reject.
      const parentEnv = Object.fromEntries(Object.entries(this.settings.parentEnv || process.env)
        .filter(([key]) => key.toUpperCase() !== 'CLAUDE_CONFIG_DIR'));
      const runtime = this.createRuntime({ executable: this.settings.command, parentEnv,
        ...(this.settings.configRoot === undefined ? {} : { configRoot: this.settings.configRoot }) });
      const prepared = await runtime.preflight({ cwd, model: selectedModel,
        ...(st ? { expectedIdentity: st.runtime } : {}) });
      validateIdentity(prepared.identity);
      if (prepared.identity.model !== selectedModel || prepared.identity.cwd !== cwd) throw fail('NATIVE_DRIFT');
      if (st && Object.keys(st.runtime).some(k => st.runtime[k] !== prepared.identity[k])) throw fail('NATIVE_DRIFT');
      if (signal?.aborted) throw fail('CANCELLED');
      if (!st) st = {
        version: 2, conversation_id: id, session_id: randomUUID(), working_dir: cwd,
        model: selectedModel, runtime: prepared.identity, turn: 0, status: 'ready', requests: [],
        policy: { permissionMode: 'bypassPermissions', allowedTools, disableTools },
        created_at: new Date().toISOString(),
      };
      const readySnapshot = st;
      st = { ...st, policy: { permissionMode: 'bypassPermissions', allowedTools, disableTools } };
      // Retain this exact ready snapshot for demonstrably pre-submission failures.
      // Even a new turn-0 session is restored, never deleted/replaced on retry.
      const pending = { ...st, status: 'pending', pending: {
        request_id: request_id || null, message_hash: messageHash, started_at: new Date().toISOString(),
      } };
      await this.store.save(id, pending);
      let submitted = false;
      try {
        if (signal?.aborted) throw fail('CANCELLED');
        const result = await prepared.launch(launch => {
          submitted = true;
          // No await, I/O, or scheduling between the adapter's final ledger check
          // and the backend's synchronous spawn of the existing Job supervisor.
          return this.backend.run({ launch, sessionId: st.session_id, resume: st.turn > 0, message,
            cwd: st.working_dir, model: st.model, ...st.policy, allowedTools, disableTools, signal });
        });
        if (result.session_id !== st.session_id) throw fail('SESSION_ID_DRIFT');
        if (typeof result.reply !== 'string') throw fail('INVALID_RESULT');
        const output = { reply: result.reply, session_id: result.session_id,
          ...(result.permission_denials === undefined ? {} : { permission_denials: result.permission_denials }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.total_cost_usd === undefined ? {} : { total_cost_usd: result.total_cost_usd }),
          ...(result.model_evidence === undefined ? {} : { model_evidence: result.model_evidence }),
          model: st.model, runtime: st.runtime,
          turn: st.turn + 1, working_dir: st.working_dir, replayed: false };
        const completed = { ...st, turn: output.turn, status: 'ready', pending: null,
          updated_at: new Date().toISOString(), last_result: output };
        if (request_id) completed.requests = [...st.requests, { id: request_id, hash: messageHash, output }];
        await this.store.save(id, completed);
        return output;
      } catch (err) {
        const sanitized = safeError(err);
        const failed = submitted ? { ...pending, status: 'uncertain',
          last_error: { code: sanitized.code, message: sanitized.message, ...(sanitized.reason ? { reason: sanitized.reason } : {}) } } : readySnapshot;
        // If restoration itself fails, the durable pending marker remains safe.
        await this.store.save(id, failed).catch(() => {});
        throw sanitized;
      }
    } catch (err) { throw safeError(err); }
    finally { if (release) await release(); }
  }
  async status(id) {
    const st = await this.store.load(id);
    if (!st) return { exists: false, conversation_id: id };
    return {
      exists: true, conversation_id: id, session_id: st.session_id, working_dir: st.working_dir,
      version: st.version, inference_allowed: st.version === 2 && st.status === 'ready',
      turn: st.turn, status: st.status, model: st.model, policy: st.policy,
      runtime: st.version === 2 ? st.runtime : null,
      pending: st.pending || null,
      last_error: st.last_error ? { code: safeError(st.last_error).code, message: safeError(st.last_error).message, ...(safeError(st.last_error).reason ? { reason: safeError(st.last_error).reason } : {}) } : null,
      last_result: st.last_result || null,
      state_file: this.store.file(id),
    };
  }
}
module.exports = { ClaudeBridge, canonicalDir };
