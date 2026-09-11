'use strict';
const process = require('node:process');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connect } = require('../doctor');
const { safeError } = require('../lib/config');
const { resolveModel, validateIdentity } = require('../lib/native-runtime');

const MODEL = resolveModel('opus');
const HELP = `Usage: npm run smoke -- --live
Alternatively set CLAUDE_BRIDGE_LIVE=1. Without explicit opt-in this command refuses.
Runs two tiny synthetic messages across an MCP restart plus exact cached replay.
Uses native Claude Code >2.1.263 with --tools empty: no tool implementations, hooks disabled,
strict empty child MCP. dontAsk and allowedTools=[] alone are NOT tool removal.
Consumes real subscription/API usage, may cost money, and leaves native transcripts
in the selected native profile. Existing global native instructions may still apply.
Only smoke-owned temporary cwd/state are cleaned; no profile/transcript deletion.
Default model: ${MODEL}. No fallback, login, refresh, or retries.
-h, --help: show this help. Offline tests are not live entitlement proof.
`;
const failure = code => Object.assign(new Error(code), { code });

// Shared protocol verification. Offline tests expose it only in a private module
// copy; the public entry point has no transport/provider/auth override.
async function rehearse(open, cwd, marker) {
  let client;
  const requireEvidence = output => {
    try { validateIdentity(output?.runtime); } catch { throw failure('SMOKE_IDENTITY'); }
    if (output.model !== MODEL || output.runtime.model !== MODEL || output.working_dir !== cwd
        || output.runtime.cwd !== cwd || typeof output.session_id !== 'string'
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(output.session_id)) throw failure('SMOKE_IDENTITY');
    if (!Array.isArray(output.model_evidence) || !output.model_evidence.length
        || output.model_evidence.some(model => model !== MODEL && model !== MODEL.replace(/\[1m\]$/, ''))) throw failure('SMOKE_MODEL_EVIDENCE');
    if (!Array.isArray(output.permission_denials) || output.permission_denials.length) throw failure('SMOKE_TOOL_DENIAL');
  };
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    if (response.isError) {
      // Whitelist only known bridge error codes, never raw content or auth output.
      let code;
      try { code = JSON.parse(response.content?.[0]?.text).code; } catch { /* no raw diagnostic */ }
      const safe = safeError({ code });
      throw failure(safe.code === 'BRIDGE_ERROR' ? 'SMOKE_CALL' : safe.code);
    }
    if (!response.structuredContent) throw failure('SMOKE_CALL');
    return response.structuredContent;
  };
  const first = { conversation_id: 'smoke', request_id: 'one', working_dir: cwd, model: MODEL,
    message: `Remember this synthetic marker: ${marker}. Reply only ACK. Do not use tools.` };
  try {
    client = await open();
    const one = await call('claude_turn', first);
    requireEvidence(one);
    if (one.turn !== 1 || one.replayed !== false || one.reply.trim() !== 'ACK') throw failure('SMOKE_FIRST');
    await client.close(); client = undefined;
    client = await open();
    const replay = await call('claude_turn', first);
    if (!isDeepStrictEqual(replay, { ...one, replayed: true })) throw failure('SMOKE_REPLAY');
    const two = await call('claude_turn', { conversation_id: 'smoke', request_id: 'two',
      message: 'Return only the synthetic marker from the preceding message. Do not use tools.' });
    requireEvidence(two);
    if (two.turn !== 2 || two.replayed !== false || two.session_id !== one.session_id
        || !isDeepStrictEqual(two.runtime, one.runtime) || two.reply.trim() !== marker) throw failure('SMOKE_CONTINUITY');
    const status = await call('claude_status', { conversation_id: 'smoke' });
    if (status.policy?.disableTools !== true) throw failure('SMOKE_TOOL_POLICY');
    if (status.version !== 2 || status.status !== 'ready' || status.turn !== 2
        || status.session_id !== one.session_id || status.model !== MODEL
        || !isDeepStrictEqual(status.runtime, one.runtime) || !isDeepStrictEqual(status.last_result, two)) throw failure('SMOKE_STATUS');
    return { mode: 'offline-protocol-rehearsal', model: MODEL, model_evidence: two.model_evidence,
      session_id: two.session_id, contract: two.runtime.contract, version: two.runtime.version,
      account_fingerprint: two.runtime.accountFingerprint, executable_fingerprint: two.runtime.executableFingerprint,
      turns: 2, mcp_connections: 2, exact_cached_replay: true, tools_disabled: true, live_entitlement_verified: false };
  } finally { await client?.close(); }
}

async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(HELP); return 0; }
  let code;
  if (args.length && !(args.length === 1 && args[0] === '--live')) code = 'SMOKE_ARGUMENTS';
  else if (args[0] !== '--live' && env.CLAUDE_BRIDGE_LIVE !== '1') code = 'SMOKE_OPT_IN_REQUIRED';
  if (code) {
    process.stderr.write(JSON.stringify({ ok: false, code, model: MODEL, task_submitted: false }) + '\n');
    return 1;
  }
  process.stderr.write(JSON.stringify({ warning: 'LIVE_USAGE_AND_NATIVE_TRANSCRIPTS',
    note: 'Real usage/cost; native transcripts remain. Global native instructions may apply. Tools disabled; no login/refresh/retry.' }) + '\n');
  let root;
  try {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-bridge-smoke-')));
    const relative = path.relative(path.resolve(__dirname, '../..'), root);
    if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw failure('SMOKE_DIRECTORY');
    const cwd = path.join(root, 'project');
    await fs.mkdir(cwd);
    // Only these narrow server settings differ; never manufacture an auth profile
    // or strip native global context. The native adapter owns auth preflight.
    const childEnv = { ...env, CLAUDE_BRIDGE_STATE_DIR: path.join(root, 'state'),
      CLAUDE_BRIDGE_DISABLE_TOOLS: '1', CLAUDE_BRIDGE_ALLOWED_TOOLS: '[]',
      CLAUDE_BRIDGE_PERMISSION_MODE: 'dontAsk', CLAUDE_BRIDGE_MODEL: 'opus', CLAUDE_BRIDGE_TIMEOUT_MS: '120000' };
    const result = await rehearse(() => connect(path.join(__dirname, '../index.js'), childEnv), cwd, randomUUID());
    // Both clients/native children are closed before deleting only our temporary
    // project/state. Transcripts belong to the native profile and remain there.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    root = undefined;
    process.stdout.write(JSON.stringify({ ok: true, ...result, mode: 'live', live_entitlement_verified: true }) + '\n');
    return 0;
  } catch (err) {
    const knownSmoke = ['SMOKE_DIRECTORY', 'SMOKE_IDENTITY', 'SMOKE_MODEL_EVIDENCE', 'SMOKE_TOOL_DENIAL',
      'SMOKE_TOOL_POLICY', 'SMOKE_CALL', 'SMOKE_FIRST', 'SMOKE_REPLAY', 'SMOKE_CONTINUITY', 'SMOKE_STATUS'];
    code = knownSmoke.includes(err?.code) ? err.code : safeError(err).code;
    process.stderr.write(JSON.stringify({ ok: false, code, model: MODEL, task_submitted: 'unknown',
      ...(root ? { retained_smoke_directory: root } : {}),
      note: 'No retry or fallback. Inspect retained smoke state/native transcript; native profile was not cleaned.' }) + '\n');
    return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { main };
