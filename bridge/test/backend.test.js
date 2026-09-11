'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { ClaudeBackend, parseResult } = require('../lib/claude-backend');
const { fixture, TestBackend } = require('./helpers');

// Functional IO assertions must allow hosted Windows cold supervisor startup.
// Tests of timeout/cancellation keep their explicit, shorter deadlines below.
function setup(settings, mode = 'normal', timeoutMs = 60000) {
  return new TestBackend({ ...settings, timeoutMs }, mode);
}
const input = cwd => ({ sessionId: randomUUID(), resume: false, message: 'x', cwd, model: 'claude-opus-5[1m]', permissionMode: 'dontAsk', allowedTools: [] });

test('real subprocess passes long Unicode prompts byte-for-byte via stdin and resumes in the same cwd', async t => {
  const { cwd, settings } = await fixture(t);
  const backend = setup(settings);
  t.after(() => backend.close());
  const request = { ...input(cwd), message: 'žluťoučký 🧪\r\n" & %PATH% $() ` ;\n' + 'x'.repeat(70000) };
  const first = await backend.run(request);
  assert.equal(first.reply, request.message);
  const resumed = await setup(settings).run({ ...request, message: 'next', resume: true });
  assert.equal(resumed.reply, request.message + '\n---\nnext');
  const saved = JSON.parse(await fs.readFile(path.join(cwd, request.sessionId + '.fake.json'), 'utf8'));
  assert.ok(!saved.args.includes(request.message));
  assert.ok(saved.args.includes('--strict-mcp-config'));
});

test('a missing resumed session fails rather than creating a new session', async t => {
  const { cwd, settings } = await fixture(t);
  await assert.rejects(setup(settings).run({ ...input(cwd), resume: true }), { code: 'CLAUDE_EXIT' });
});

test('invalid JSON, nonzero exit, model errors and session drift are surfaced', async t => {
  const { cwd, settings } = await fixture(t);
  for (const [mode, code] of [['invalid', 'INVALID_RESULT'], ['exit', 'CLAUDE_EXIT'], ['limit', 'CLAUDE_RESULT_ERROR'], ['drift', 'SESSION_ID_DRIFT']]) {
    await assert.rejects(setup(settings, mode).run(input(cwd)), { code });
  }
});

test('permission denials remain visible in the result', async t => {
  const { cwd, settings } = await fixture(t);
  const out = await setup(settings, 'denied').run(input(cwd));
  assert.equal(out.permission_denials[0].tool_name, 'Bash');
});

test('timeout terminates Claude and its detached descendants on Windows', { skip: process.platform !== 'win32' }, async t => {
  const { cwd, settings } = await fixture(t);
  await assert.rejects(setup(settings, 'hang', 5000).run(input(cwd)), { code: 'CLAUDE_TIMEOUT' });
  const pids = JSON.parse(await fs.readFile(path.join(cwd, 'pids.json'), 'utf8'));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('cancellation terminates an active Claude process', async t => {
  const { cwd, settings } = await fixture(t);
  const backend = setup(settings, 'hang');
  const controller = new AbortController();
  const running = backend.run({ ...input(cwd), signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 2000);
  try { await assert.rejects(running, { code: 'CANCELLED' }); }
  finally { clearTimeout(timer); backend.close(); }
});

test('result parsing does not confuse assistant text or multiple result events with a result', () => {
  assert.throws(() => parseResult('{"type":"assistant","result":"text"}', 'x'), { code: 'INVALID_RESULT' });
  assert.throws(() => parseResult('[{"type":"result"},{"type":"result"}]', 'x'), { code: 'INVALID_RESULT' });
  assert.throws(() => parseResult('{"type":"result","is_error":true,"api_error_status":401}', 'x'), { code: 'CLAUDE_AUTH_FAILED' });
});

test('force-killing the bridge owner also terminates Claude and detached descendants', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const { cwd } = await fixture(t);
  const worker = spawn(process.execPath, [path.join(__dirname, 'backend-worker.js'), cwd], { windowsHide: true, stdio: 'ignore' });
  t.after(() => worker.kill());
  let pids;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { pids = JSON.parse(await fs.readFile(path.join(cwd, 'pids.json'), 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(pids, 'Subprocess fixture did not start');
  worker.kill();
  while (Date.now() < deadline) {
    const alive = pids.some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!alive) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('A descendant survived its bridge owner');
});

test('output caps terminate the supervised child without forwarding raw output', async t => {
  const { cwd, settings } = await fixture(t);
  await assert.rejects(setup(settings, 'oversize').run(input(cwd)), { code: 'OUTPUT_TOO_LARGE' });
});

test('subprocess failure diagnostics cannot leak synthetic secrets', async t => {
  const { cwd, settings } = await fixture(t);
  await assert.rejects(setup(settings, 'secret-exit').run(input(cwd)), e => e.code === 'CLAUDE_EXIT' && !e.message.includes('SYNTHETIC_ERROR_SECRET'));
});
