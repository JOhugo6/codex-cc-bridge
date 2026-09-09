'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, TestBridge: ClaudeBridge } = require('./helpers');

test('continuity survives a bridge restart; request replay does not invoke Claude twice', async t => {
  const { cwd, settings } = await fixture(t);
  const calls = [];
  const backend = { run: async input => { calls.push(input); return { reply: input.message, session_id: input.sessionId }; } };
  const a = new ClaudeBridge(backend, settings);
  const first = { conversation_id: 'Review', request_id: 'req1', message: 'A\r\n\nž', working_dir: cwd };
  const one = await a.turn(first);
  const b = new ClaudeBridge(backend, settings);
  const replay = await b.turn(first);
  assert.equal(replay.replayed, true);
  assert.equal(replay.reply, first.message);
  assert.equal(calls.length, 1);
  const two = await b.turn({ conversation_id: 'Review', request_id: 'req2', message: 'follow-up' });
  assert.equal(two.session_id, one.session_id);
  assert.equal(two.turn, 2);
  assert.equal(calls[1].resume, true);
  assert.equal(calls[1].cwd, await fs.realpath(cwd));
  await assert.rejects(b.turn({ ...first, message: 'different' }), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(calls.length, 2);
});

test('working directory and model are pinned; different case IDs remain separate on Windows', async t => {
  const { cwd, settings, dir } = await fixture(t);
  const b = new ClaudeBridge({ run: async i => ({ reply: 'ok', session_id: i.sessionId }) }, settings);
  const first = await b.turn({ conversation_id: 'Review', message: 'x', working_dir: cwd, model: 'opus' });
  await assert.rejects(b.turn({ conversation_id: 'Review', message: 'x', working_dir: dir }), { code: 'WORKING_DIR_MISMATCH' });
  await assert.rejects(b.turn({ conversation_id: 'Review', message: 'x', model: 'claude-opus-5' }), { code: 'MODEL_MISMATCH' });
  const other = await b.turn({ conversation_id: 'review', message: 'x', working_dir: cwd });
  assert.notEqual(other.session_id, first.session_id);
});

test('cross-instance overlapping calls fail visibly before sending another message', async t => {
  const { cwd, settings } = await fixture(t);
  let finish, started;
  const start = new Promise(resolve => { started = resolve; });
  const a = new ClaudeBridge({ run: i => { started(); return new Promise(resolve => { finish = () => resolve({ reply: 'ok', session_id: i.sessionId }); }); } }, settings);
  const b = new ClaudeBridge({ run: () => assert.fail('must not launch') }, settings);
  const input = { conversation_id: 'locked', message: 'x', working_dir: cwd };
  const running = a.turn(input);
  await start;
  try { await assert.rejects(b.turn(input), { code: 'CONVERSATION_BUSY' }); }
  finally { finish(); await running; }
});

test('failed calls retain the allocated session and block automatic retries after restart', async t => {
  const { cwd, settings } = await fixture(t);
  let calls = 0;
  const backend = { run: async () => { calls++; throw Object.assign(new Error('lost reply'), { code: 'CLAUDE_TIMEOUT' }); } };
  const a = new ClaudeBridge(backend, settings);
  const input = { conversation_id: 'uncertain', message: 'write a file', working_dir: cwd };
  await assert.rejects(a.turn(input), { code: 'CLAUDE_TIMEOUT' });
  const b = new ClaudeBridge(backend, settings);
  const status = await b.status('uncertain');
  assert.equal(status.status, 'uncertain');
  assert.equal(status.turn, 0);
  assert.ok(status.session_id);
  await assert.rejects(b.turn(input), { code: 'TURN_UNCERTAIN' });
  assert.equal(calls, 1);
});

test('corrupt state, unsafe IDs, missing directories and empty messages never launch Claude', async t => {
  const { cwd, settings } = await fixture(t);
  const b = new ClaudeBridge({ run: () => assert.fail('must not launch') }, settings);
  for (const conversation_id of ['../x', '', '.hidden', 'x/y', 'a'.repeat(201)]) {
    await assert.rejects(b.turn({ conversation_id, message: 'x', working_dir: cwd }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(b.turn({ conversation_id: 'x', message: '  ', working_dir: cwd }), { code: 'INVALID_INPUT' });
  await assert.rejects(b.turn({ conversation_id: 'x', message: 'x' }), { code: 'INVALID_WORKING_DIR' });
  await assert.rejects(b.turn({ conversation_id: 'x', message: 'x', working_dir: path.join(cwd, 'missing') }), { code: 'INVALID_WORKING_DIR' });
  await fs.writeFile(b.store.file('corrupt'), '{"session_id":"partial"}');
  await assert.rejects(b.turn({ conversation_id: 'corrupt', message: 'x', working_dir: cwd }), { code: 'CORRUPT_STATE' });
});

test('session drift cannot be committed as a successful turn', async t => {
  const { cwd, settings } = await fixture(t);
  const b = new ClaudeBridge({ run: async () => ({ reply: 'x', session_id: 'wrong' }) }, settings);
  await assert.rejects(b.turn({ conversation_id: 'x', message: 'x', working_dir: cwd }), { code: 'SESSION_ID_DRIFT' });
  assert.equal((await b.status('x')).status, 'uncertain');
});

test('changed server permissions are not silently applied to existing sessions', async t => {
  const { cwd, settings } = await fixture(t);
  const calls = [];
  const backend = { run: async i => { calls.push(i); return { reply: 'ok', session_id: i.sessionId }; } };
  await new ClaudeBridge(backend, settings).turn({ conversation_id: 'policy', message: 'x', working_dir: cwd });
  await new ClaudeBridge(backend, { ...settings, permissionMode: 'acceptEdits', allowedTools: ['Bash'] }).turn({ conversation_id: 'policy', message: 'x' });
  assert.equal(calls[1].permissionMode, 'dontAsk');
  assert.deepEqual(calls[1].allowedTools, []);
});
