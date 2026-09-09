'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { fail, validateAllowedTools } = require('./config');

function parseResult(stdout, expectedId, expectedModel) {
  let result;
  try {
    const parsed = JSON.parse(stdout);
    const results = Array.isArray(parsed) ? parsed.filter(r => r?.type === 'result') : [parsed];
    if (results.length !== 1 || results[0]?.type !== 'result') throw new Error();
    result = results[0];
  } catch { throw fail('INVALID_RESULT', 'Claude returned invalid JSON or multiple result events.'); }
  if (result.is_error || result.subtype !== 'success') {
    if (result.api_error_status === 401) throw fail('CLAUDE_AUTH_FAILED', 'Native Claude authentication failed.');
    throw fail('CLAUDE_RESULT_ERROR', 'Native Claude returned an unsuccessful result. No fallback was attempted.');
  }
  if (result.session_id !== expectedId) throw fail('SESSION_ID_DRIFT', 'Claude returned a different session identity.');
  if (typeof result.result !== 'string') throw fail('INVALID_RESULT', 'Claude result is missing its text.');
  // [1m] is a context selector: native usage may retain it while wire metadata
  // uses the base ID. Missing usage is not proof of identity; ignore self-description.
  if (result.modelUsage !== undefined && (!result.modelUsage || typeof result.modelUsage !== 'object' || Array.isArray(result.modelUsage))) {
    throw fail('INVALID_RESULT', 'Claude returned malformed structured model usage.');
  }
  const observed = Object.keys(result.modelUsage || {});
  if (expectedModel !== undefined && observed.some(model => model !== expectedModel && model !== expectedModel.replace(/\[1m\]$/, ''))) {
    throw fail('MODEL_DRIFT', 'Structured usage reports a model other than the pinned model.');
  }
  const numeric = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([k, v]) => /^[a-z_]+$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0));
  };
  return {
    reply: result.result, session_id: result.session_id,
    permission_denials: Array.isArray(result.permission_denials) ? result.permission_denials : [],
    usage: numeric(result.usage),
    total_cost_usd: typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0 ? result.total_cost_usd : null,
    model_evidence: expectedModel === undefined ? [] : observed,
  };
}

class ClaudeBackend {
  constructor(settings) { this.settings = settings; this.active = new Set(); this.closed = false; }
  run({ launch, sessionId, resume, message, cwd, model, permissionMode, allowedTools, disableTools = false, signal }) {
    if (this.closed || signal?.aborted) throw fail('CANCELLED', 'Claude call cancelled.');
    if (!launch || launch.shell !== false || launch.cwd !== cwd || !Array.isArray(launch.args) || !launch.env) throw fail('INVALID_CONFIG', 'A prepared native launch is required.');
    // Validate and snapshot again at the direct backend boundary, before spawn.
    const toolRules = validateAllowedTools(allowedTools);
    if (typeof disableTools !== 'boolean') throw fail('INVALID_CONFIG', 'Tool-disable policy must be boolean.');
    // No environment inheritance and no duplicate model/settings/MCP guard options.
    const env = launch.env;
    let command = launch.command;
    let commandArgs = [...launch.args,
      '--print', '--output-format', 'json', '--input-format', 'text',
      resume ? '--resume' : '--session-id', sessionId, '--permission-mode', permissionMode,
    ];
    // A literal empty argument removes tool implementations, not permissions.
    // Verified on pinned 2.1.263 through the unchanged Windows Job supervisor.
    if (disableTools) commandArgs.push('--tools', '');
    if (toolRules.length) commandArgs.push('--allowedTools', ...toolRules);
    if (/\.(cmd|bat|ps1)$/i.test(command)) throw fail('INVALID_CONFIG', 'A native executable, not a shell shim, is required.');
    if (process.platform === 'win32') {
      const launch = Buffer.from(JSON.stringify({ command, args: commandArgs, cwd, parentPid: process.pid })).toString('base64');
      command = path.join(Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      commandArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-job-runner.ps1'), '-LaunchBase64', launch];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = [], size = 0, error = null;
      const stop = () => {
        if (!child.pid) return;
        try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); }
        catch { /* Process may already have exited; never log raw OS diagnostics. */ }
      };
      const abort = () => { error ||= fail('CANCELLED', 'Claude call cancelled; inspect session before retrying.'); stop(); };
      this.active.add(abort);
      const timer = setTimeout(() => { error ||= fail('CLAUDE_TIMEOUT', `Claude exceeded ${this.settings.timeoutMs} ms; inspect session before retrying.`); stop(); }, this.settings.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { error ||= fail('OUTPUT_TOO_LARGE', 'Claude output exceeded 16 MiB.'); stop(); }
        else stdout.push(chunk);
      });
      // Drain stderr, but never retain or forward possible auth/provider diagnostics.
      child.stderr.resume();
      child.on('error', err => { error ||= fail('CLAUDE_SPAWN_FAILED', 'Could not start the supervised native executable.'); });
      child.stdin.on('error', err => { if (err.code !== 'EPIPE') { error ||= fail('CLAUDE_SPAWN_FAILED', 'Could not deliver native stdin.'); stop(); } });
      child.on('close', (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.active.delete(abort);
        if (error) return reject(error);
        if (code !== 0) {
          const response = Buffer.concat(stdout).toString('utf8');
          try { parseResult(response, sessionId, model); }
          catch (err) {
            if (['CLAUDE_AUTH_FAILED', 'CLAUDE_RESULT_ERROR', 'SESSION_ID_DRIFT', 'MODEL_DRIFT'].includes(err.code)) return reject(err);
          }
          return reject(fail('CLAUDE_EXIT', 'Claude exited without a successful result. Inspect the native session locally.'));
        }
        try { resolve(parseResult(Buffer.concat(stdout).toString('utf8'), sessionId, model)); }
        catch (err) { reject(err); }
      });
      // Prompt bytes never enter argv or a shell. Preserve CRLF, quotes and Unicode.
      child.stdin.end(message, 'utf8');
    });
  }
  close() { this.closed = true; for (const abort of this.active) abort(); }
}
module.exports = { ClaudeBackend, parseResult };
