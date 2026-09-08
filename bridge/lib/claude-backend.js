'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { fail } = require('./config');

function parseResult(stdout, expectedId) {
  let result;
  try {
    const parsed = JSON.parse(stdout);
    const results = Array.isArray(parsed) ? parsed.filter(r => r.type === 'result') : [parsed];
    if (results.length !== 1 || results[0]?.type !== 'result') throw new Error('Expected one result event');
    result = results[0];
  } catch (err) { throw fail('INVALID_RESULT', `Claude returned invalid JSON: ${err.message}`); }
  if (result.is_error || result.subtype !== 'success') {
    if (result.api_error_status === 401) throw fail('CLAUDE_AUTH_FAILED', 'Claude authentication failed. Run claude auth login, then retry with a new conversation_id after inspecting the failed session.');
    throw fail('CLAUDE_RESULT_ERROR', JSON.stringify({ subtype: result.subtype, errors: result.errors, result: result.result }));
  }
  if (result.session_id !== expectedId) throw fail('SESSION_ID_DRIFT', `Expected session ${expectedId}, received ${result.session_id}.`);
  if (typeof result.result !== 'string') throw fail('INVALID_RESULT', 'Claude result is missing its text.');
  return {
    reply: result.result, session_id: result.session_id,
    permission_denials: Array.isArray(result.permission_denials) ? result.permission_denials : [],
    usage: result.usage || {}, total_cost_usd: result.total_cost_usd ?? null,
  };
}

class ClaudeBackend {
  constructor(settings) { this.settings = settings; this.active = new Set(); this.closed = false; }
  async run({ sessionId, resume, message, cwd, model, permissionMode, allowedTools, signal }) {
    if (this.closed || signal?.aborted) throw fail('CANCELLED', 'Claude call cancelled.');
    const args = [
      '--print', '--output-format', 'json', '--input-format', 'text',
      resume ? '--resume' : '--session-id', sessionId,
      '--permission-mode', permissionMode,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}',
    ];
    if (model) args.push('--model', model);
    if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
    const env = { ...process.env, CLAUDE_BRIDGE_CHILD: '1' };
    delete env.CLAUDECODE;
    if (env.CLAUDE_CODE_SKIP_PROMPT_HISTORY) throw fail('INVALID_CONFIG', 'Unset CLAUDE_CODE_SKIP_PROMPT_HISTORY: bridge sessions require persistence.');
    let command = this.settings.command;
    let commandArgs = [...(this.settings.prefixArgs || []), ...args];
    if (/\.(cmd|bat|ps1)$/i.test(command)) throw fail('INVALID_CONFIG', 'Use the native claude executable, not a shell shim. Set CLAUDE_BRIDGE_COMMAND to claude.exe.');
    if (process.platform === 'win32') {
      const launch = Buffer.from(JSON.stringify({ command, args: commandArgs, cwd, parentPid: process.pid })).toString('base64');
      command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      commandArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-job-runner.ps1'), '-LaunchBase64', launch];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = [], stderr = '', size = 0, error = null;
      const stop = () => {
        if (!child.pid) return;
        try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); }
        catch (err) { if (err.code !== 'ESRCH') process.stderr.write(`Claude shutdown: ${err.message}\n`); }
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
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
      child.on('error', err => { error ||= fail('CLAUDE_SPAWN_FAILED', err.message); });
      child.stdin.on('error', err => { if (err.code !== 'EPIPE') { error ||= err; stop(); } });
      child.on('close', (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.active.delete(abort);
        if (error) return reject(error);
        if (code !== 0) {
          const diagnostics = stderr.replace(/^claude-bridge-child-pid:\d+\r?\n/gm, '').trim();
          const response = Buffer.concat(stdout).toString('utf8').slice(-16000).trim();
          try { parseResult(response, sessionId); }
          catch (err) {
            if (['CLAUDE_AUTH_FAILED', 'CLAUDE_RESULT_ERROR', 'SESSION_ID_DRIFT'].includes(err.code)) return reject(err);
          }
          return reject(fail('CLAUDE_EXIT', `Claude exited ${code ?? exitSignal}: ${[diagnostics, response].filter(Boolean).join('\n') || 'No diagnostics.'}`));
        }
        try { resolve(parseResult(Buffer.concat(stdout).toString('utf8'), sessionId)); }
        catch (err) { reject(err); }
      });
      // Prompt bytes never enter argv or a shell. Preserve CRLF, quotes and Unicode.
      child.stdin.end(message, 'utf8');
    });
  }
  close() { this.closed = true; for (const abort of this.active) abort(); }
}
module.exports = { ClaudeBackend, parseResult };
