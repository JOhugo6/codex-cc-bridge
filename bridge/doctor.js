#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { safeError } = require('./lib/config');
const { isDeepStrictEqual } = require('node:util');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const TIMEOUT_MS = 10000;
const HELP = `Usage: node doctor.js [--native [--cwd <absolute-directory>] [--model <catalogue-model>]]
Default: bounded MCP handshake and public schemas only; no native CLI or login required.
--native: existing runtime preflight only, never task submission or inference.
Native metadata commands may contact ancillary services and update local native metadata.
Success checks compatibility/profile eligibility, not live credentials or model entitlement.
-h, --help: show this help. Native errors are sanitized; see docs/runbook.md.
`;
const NATIVE_CODES = new Set(['NATIVE_INPUT', 'NATIVE_MODEL', 'NATIVE_SOURCE', 'NATIVE_CONFLICT',
  'NATIVE_ROOT', 'NATIVE_PLATFORM', 'NATIVE_COMPATIBILITY', 'NATIVE_AUTH', 'NATIVE_POLICY',
  'NATIVE_DIAGNOSTIC', 'NATIVE_DRIFT', 'NATIVE_PROFILE_LOCK', 'NATIVE_PROFILE_BUSY']);
const failure = code => Object.assign(new Error(code), { code });

// Retained for existing MCP tests/callers, not a CLI transport override.
async function connect(entry = path.join(__dirname, 'index.js'), env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry],
    env: { ...process.env, ...env }, stderr: 'pipe',
  });
  // Drain without retaining or forwarding raw child diagnostics.
  transport.stderr?.resume();
  // The SDK may initiate close while rejecting connect. Share that promise so a
  // second close waits for its bounded termination rather than returning early.
  const closeTransport = transport.close.bind(transport);
  let closing;
  transport.close = () => (closing ||= closeTransport());
  const client = new Client({ name: 'claude-bridge-doctor', version: '1.0.0' });
  try { await client.connect(transport, { timeout: TIMEOUT_MS }); }
  catch {
    await transport.close().catch(() => {});
    throw failure('MCP_HANDSHAKE');
  }
  return client;
}

function verifyTools(tools) {
  const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$' };
  const expected = {
    claude_turn: { required: ['conversation_id', 'message'], properties: {
      conversation_id: id, message: { type: 'string', minLength: 1, maxLength: 100000 },
      working_dir: { type: 'string', minLength: 1, maxLength: 4096 }, request_id: id,
      model: { type: 'string', minLength: 1, maxLength: 200 },
    } },
    claude_status: { required: ['conversation_id'], properties: { conversation_id: id } },
  };
  if (!Array.isArray(tools) || tools.length !== 2) throw failure('MCP_SCHEMA');
  for (const [name, schema] of Object.entries(expected)) {
    const matches = tools.filter(tool => tool.name === name);
    const actual = matches[0]?.inputSchema;
    if (matches.length !== 1 || actual?.type !== 'object' || actual.additionalProperties !== false
        || !isDeepStrictEqual([...(actual.required || [])].sort(), [...schema.required].sort())
        || !isDeepStrictEqual(Object.keys(actual.properties || {}).sort(), Object.keys(schema.properties).sort())) throw failure('MCP_SCHEMA');
    for (const [key, value] of Object.entries(schema.properties)) {
      const { description, ...observed } = actual.properties[key] || {};
      if (!isDeepStrictEqual(observed, value)) throw failure('MCP_SCHEMA');
    }
  }
}

function parseArgs(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw failure('DOCTOR_ARGUMENTS');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const names = { '--native': 'native', '--cwd': 'cwd', '--model': 'model', '--help': 'help', '-h': 'help' };
    const key = Object.hasOwn(names, arg) ? names[arg] : undefined;
    if (!key || Object.hasOwn(options, key)) throw failure('DOCTOR_ARGUMENTS');
    if (key === 'cwd' || key === 'model') {
      const value = args[++i];
      if (!value || value.startsWith('-') || value.includes('\0') || value.length > (key === 'cwd' ? 4096 : 200)) throw failure('DOCTOR_ARGUMENTS');
      options[key] = value;
    } else options[key] = true;
  }
  if ((options.help && args.length !== 1) || (!options.native && (options.cwd || options.model))
      || (options.cwd && !path.isAbsolute(options.cwd))) throw failure('DOCTOR_ARGUMENTS');
  return options;
}

async function nativeDiagnostic(options, env) {
  const { config } = require('./lib/config');
  const { createNativeRuntime, resolveModel, validateIdentity } = require('./lib/native-runtime');
  const settings = config(env);
  const parentEnv = Object.fromEntries(Object.entries(settings.parentEnv)
    .filter(([key]) => key.toUpperCase() !== 'CLAUDE_CONFIG_DIR'));
  const model = resolveModel(options.model, settings.model);
  const runtime = createNativeRuntime({ executable: settings.command, parentEnv,
    ...(settings.configRoot === undefined ? {} : { configRoot: settings.configRoot }) });
  const release = await runtime.acquire?.();
  try {
    const prepared = await runtime.preflight({ cwd: options.cwd || process.cwd(), model });
    validateIdentity(prepared.identity);
    // Never call launch or recheck: no task, stdin, pending state or inference.
    const identity = prepared.identity;
    return { ok: true, mode: 'native-preflight', contract: identity.contract, version: identity.version,
      model: identity.model, profile_mode: identity.configRootMode,
      executable_fingerprint: identity.executableFingerprint, account_fingerprint: identity.accountFingerprint,
      task_submitted: false, live_credentials_verified: false, model_entitlement_verified: false,
      note: 'Compatibility, saved-login metadata, and account policy only; native ancillary network and local metadata writes are possible.' };
  } finally { if (release) await release(); }
}

async function main(args = process.argv.slice(2), env = process.env) {
  let mode = 'arguments';
  try {
    const options = parseArgs(args);
    if (options.help) { process.stdout.write(HELP); return 0; }
    mode = options.native ? 'native-preflight' : 'mcp-handshake';
    let result;
    if (options.native) result = await nativeDiagnostic(options, env);
    else {
      const client = await connect(undefined, env);
      try {
        const { tools } = await client.listTools({}, { timeout: TIMEOUT_MS });
        verifyTools(tools);
        result = { ok: true, mode, tools: ['claude_turn', 'claude_status'], native_checked: false,
          task_submitted: false, live_credentials_verified: false, model_entitlement_verified: false };
      } finally { await client.close(); }
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    // Never print exception messages/stacks, raw auth output, env values or paths.
    const code = NATIVE_CODES.has(err?.code) || ['DOCTOR_ARGUMENTS', 'MCP_SCHEMA', 'MCP_HANDSHAKE', 'INVALID_CONFIG'].includes(err?.code)
      ? err.code : 'DOCTOR_FAILED';
    process.stderr.write(JSON.stringify({ ok: false, mode, code, ...(safeError(err).reason ? { reason: safeError(err).reason, message: safeError(err).message } : {}), task_submitted: false,
      live_credentials_verified: false, model_entitlement_verified: false,
      note: 'No inference attempted. See --help and docs/runbook.md; do not bypass policy or automatically retry drift.' }) + '\n');
    return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { connect, main };
