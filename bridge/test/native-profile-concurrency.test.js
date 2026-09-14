'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { teamFixture } = require('./team-fixture');
const { teamTlsFixture } = require('./team-tls-fixture');
const { connectNative } = require('./runtime-integration-fixture');
const { reply, assertWire } = require('./native-runtime-fixture');

async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

function result(response) {
  assert.notEqual(response.isError, true, 'native MCP turn failed: ' + (response.isError ? response.content[0].text : ''));
  assert.ok(response.structuredContent);
  return response.structuredContent;
}

test('four independent MCP processes overlap three already-active standalone Claude tasks on one Team profile', { timeout: 120000 }, async () => {
  const f = await teamFixture({ native: true });
  const tls = await teamTlsFixture();
  const connections = [], held = [];
  let pending, standalone;
  try {
    f.deps.endpoint = 'https://api.anthropic.com'; f.deps.transportEnv = tls.transportEnv;
    const initialized = JSON.parse(await fs.readFile(f.globalFile, 'utf8'));
    const initializedUserID = 'a'.repeat(64);
    initialized.userID = initializedUserID; initialized.cachedExtraUsageDisabledReason = null;
    await fs.writeFile(f.globalFile, JSON.stringify(initialized));
    let metadata;
    f.beforeExecute = async (command, args, options) => { if (args.includes('doctor')) metadata = [command, args, options]; };
    const prepared = await f.runtime().preflight({ cwd: f.project });
    const launch = await prepared.launch(descriptor => descriptor);
    assert.ok(metadata);
    // Each connection is an independent MCP server with a separate Store.
    // All use exactly the same explicit native profile and existing login.
    connections.push(...await Promise.all(Array.from({ length: 4 }, (_, i) => connectNative(f, {
      CLAUDE_BRIDGE_STATE_DIR: path.join(f.root, `parallel-state-${i}`), CLAUDE_BRIDGE_DISABLE_TOOLS: '1',
    }))));
    let arrived, standaloneArrived;
    const allArrived = new Promise(resolve => { arrived = resolve; });
    const firstThreeArrived = new Promise(resolve => { standaloneArrived = resolve; });
    tls.setResponder((request, response) => {
      if (!request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) return false;
      held.push({ request, response });
      if (held.length === 3) standaloneArrived();
      if (held.length === 7) arrived();
      return true;
    });
    // These native task processes do not pass through ClaudeBridge or its
    // Store. All three must be active before any MCP turn starts preflight.
    const standaloneIds = Array.from({ length: 3 }, () => randomUUID());
    standalone = Promise.all(standaloneIds.map((sessionId, i) => f.runPrepared(launch, {
      input: `SYNTHETIC_STANDALONE_REVIEW_${i}`, timeoutMs: 60000,
      extraArgs: ['--session-id', sessionId, '--tools', '', '--permission-mode', 'dontAsk'],
    })));
    const earlyStandaloneExit = standalone.then(() => { throw new Error('standalone tasks completed before all seven inference arrivals'); });
    await within(Promise.race([firstThreeArrived, earlyStandaloneExit]), 15000, 'three standalone native tasks did not reach inference');
    assert.equal(held.length, 3);
    assert.ok(held.every(({ response }) => !response.writableEnded), 'standalone tasks are already active before MCP preflight');
    assert.equal(JSON.parse(await fs.readFile(f.globalFile, 'utf8')).userID, initializedUserID,
      'standalone startup preserves the valid initialized native user identity');
    const inputs = connections.map((_connection, i) => ({ conversation_id: 'parallel-review', request_id: 'first',
      working_dir: f.project, message: `SYNTHETIC_PARALLEL_REVIEW_${i}` }));
    pending = Promise.all(connections.map((connection, i) => connection.client.callTool({ name: 'claude_turn', arguments: inputs[i] }).then(result)));
    await within(Promise.race([allArrived, earlyStandaloneExit,
      pending.then(() => { throw new Error('MCP tasks completed before all seven inference arrivals'); })]),
      30000, 'four MCP native tasks did not overlap the three active standalone tasks');
    assert.equal(held.length, 7);
    assert.ok(held.every(({ response }) => !response.writableEnded), 'no task receives a response before all seven arrive');
    const doctors = await Promise.all(Array.from({ length: 3 }, () => f.api.private.production.execute(...metadata)));
    for (const doctor of doctors) {
      for (const marker of ['Remote settings: Using cached settings (304)', 'Remote settings: Cache still valid (304 Not Modified)',
        'Policy limits: Using cached restrictions (304)', 'Policy limits: Cache still valid (304 Not Modified)']) assert.ok(doctor.stderr.includes(marker));
    }
    assert.ok(held.every(({ response }) => !response.writableEnded), 'all tasks remain active during the three native doctors');
    tls.setResponder(() => false);
    for (const { request, response } of held) reply(response, request.body.model);
    const [outputs, standaloneOutputs] = await Promise.all([pending, standalone]);
    for (const [i, output] of standaloneOutputs.entries()) {
      assert.equal(output.code, 0);
      const parsed = JSON.parse(output.stdout);
      assert.equal(parsed.session_id, standaloneIds[i]); assert.equal(parsed.is_error, false);
    }
    assert.equal(new Set([...standaloneIds, ...outputs.map(output => output.session_id)]).size, 7);
    assert.equal(JSON.parse(await fs.readFile(f.globalFile, 'utf8')).userID, initializedUserID);
    assert.ok(outputs.every(output => output.turn === 1 && output.runtime.configRoot === f.config));
    assertWire({ base: tls }, 7);
    const replay = result(await connections[0].client.callTool({ name: 'claude_turn', arguments: inputs[0] }));
    assert.equal(replay.replayed, true); assert.equal(replay.session_id, outputs[0].session_id);
    assertWire({ base: tls }, 7);
    const continuation = result(await connections[0].client.callTool({ name: 'claude_turn', arguments: {
      conversation_id: 'parallel-review', request_id: 'second', message: 'SYNTHETIC_PARALLEL_CONTINUATION',
    } }));
    assert.equal(continuation.turn, 2); assert.equal(continuation.session_id, outputs[0].session_id);
    assertWire({ base: tls }, 8);
  } finally {
    for (const { response } of held) if (!response.writableEnded) response.destroy();
    await Promise.allSettled(connections.map(connection => connection.close()));
    if (pending) await pending.catch(() => {});
    await tls.close(); await f.close();
    if (standalone) await standalone.catch(() => {});
  }
});

test('native Team tolerates operational global writes during preflight but rejects protected project trust drift before launch', { timeout: 120000 }, async () => {
  const f = await teamFixture({ native: true });
  const tls = await teamTlsFixture();
  try {
    f.deps.endpoint = 'https://api.anthropic.com'; f.deps.transportEnv = tls.transportEnv;
    const execute = f.deps.execute;
    let writes = 0;
    f.deps.execute = async (...args) => {
      const output = await execute(...args);
      if (args[1].includes('doctor')) {
        const global = JSON.parse(await fs.readFile(f.globalFile, 'utf8'));
        global.numStartups = ++writes;
        await fs.writeFile(f.globalFile, JSON.stringify(global));
      }
      return output;
    };
    const prepared = await f.runtime().preflight({ cwd: f.project });
    await prepared.launch(() => {});
    assert.ok(writes >= 2, 'native doctor overlap changed operational metadata during preflight and launch');
    const global = JSON.parse(await fs.readFile(f.globalFile, 'utf8'));
    global.projects[f.project].hasTrustDialogAccepted = false;
    await fs.writeFile(f.globalFile, JSON.stringify(global));
    await assert.rejects(prepared.launch(() => assert.fail('protected project trust edit submitted')), { code: 'NATIVE_DRIFT' });
    assertWire({ base: tls }, 0);
  } finally { await tls.close(); await f.close(); }
});
