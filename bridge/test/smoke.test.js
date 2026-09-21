'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { privateModule, profile } = require('./diagnostic-fixture');
// Capture only this private module's writes, never Node test-runner IPC stdout.
function smokeMain(replacements) {
  let stdout = '', stderr = '';
  const { main } = privateModule('live-smoke.js', '', { ...replacements,
    'node:process': { env: {}, argv: [], stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } },
  });
  return async (args, env) => { const code = await main(args, env); return { code, stdout, stderr }; };
}
const { connect } = require('../doctor');
const entry = path.join(__dirname, 'live-smoke.js');
const { rehearse } = privateModule('live-smoke.js', 'module.exports.rehearse = rehearse;');

test('diagnostic fixture canonicalizes its owned temp root before deriving the sterile profile', t => {
  const parent = profile(t);
  assert.equal(parent.root, fs.realpathSync.native(parent.root));
  const target = path.join(parent.root, 'temp-target'), alias = path.join(parent.root, 'temp-alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, 'junction');
  // A real owned filesystem alias also exercises this regression without 8.3 names.
  const fixture = privateModule('diagnostic-fixture.js', '', { 'node:os': { tmpdir: () => alias } });
  const before = { ...process.env };
  const f = fixture.profile(t);
  assert.equal(f.root, fs.realpathSync.native(f.root));
  assert.equal(path.dirname(f.root), target);
  for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP']) assert.equal(f.env[name], f.root);
  for (const [name, leaf] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'],
    ['CLAUDE_BRIDGE_COMMAND', 'missing-claude.exe'], ['CLAUDE_BRIDGE_STATE_DIR', 'state']]) {
    assert.equal(f.env[name], path.join(f.root, leaf));
  }
  assert.equal(fs.existsSync(f.env.CLAUDE_BRIDGE_COMMAND), false);
  assert.deepEqual({ ...process.env }, before);
});

test('smoke import is inert; no opt-in or invalid arguments never start any task', t => {
  const f = profile(t);
  const imported = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(entry)})`], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout + imported.stderr, '');
  const before = fs.readdirSync(f.root);
  for (const [args, extra, code] of [
    [[], {}, 'SMOKE_OPT_IN_REQUIRED'], [[], { CLAUDE_BRIDGE_LIVE: 'true' }, 'SMOKE_OPT_IN_REQUIRED'],
    [['--live', '--live'], {}, 'SMOKE_ARGUMENTS'], [['--provider', 'SYNTHETIC_SECRET'], {}, 'SMOKE_ARGUMENTS'],
    [['--model', 'opus'], {}, 'SMOKE_ARGUMENTS'], [['--help', '--live'], {}, 'SMOKE_ARGUMENTS'],
  ]) {
    const r = spawnSync(process.execPath, [entry, ...args], { env: { ...f.env, ...extra }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1); assert.equal(r.stdout, '');
    const out = JSON.parse(r.stderr);
    assert.equal(out.code, code); assert.equal(out.model, 'claude-opus-5[1m]'); assert.equal(out.task_submitted, false);
    assert.ok(!r.stderr.includes('SYNTHETIC_SECRET'));
  }
  const help = spawnSync(process.execPath, [entry, '--help'], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0); assert.match(help.stdout, /full native tools, configured MCP and hooks/); assert.match(help.stdout, /transcripts/);
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.deepEqual(Object.keys(require('./live-smoke')), ['main']);
});

test('offline protocol rehearsal verifies actual MCP process restart, exact replay and structured evidence', async t => {
  const f = profile(t);
  let connections = 0;
  const open = async () => { connections++; return connect(path.join(__dirname, 'smoke-fixture.js'), { ...f.env, SMOKE_FIXTURE_ROOT: f.root }); };
  const result = await rehearse(open, f.root, 'synthetic-marker-123');
  assert.equal(connections, 2); assert.equal(result.turns, 2); assert.equal(result.exact_cached_replay, true);
  assert.equal(result.live_entitlement_verified, false); assert.equal(result.mode, 'offline-protocol-rehearsal');
  const pids = fs.readFileSync(path.join(f.root, 'processes'), 'utf8').trim().split('\n').map(Number);
  assert.equal(new Set(pids).size, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'smoke-state.json'))).turn, 2);
});

test('offline harness rejects missing evidence, changed identities/replay/status, denial and raw errors', async t => {
  const f = profile(t);
  // Protocol fault injection occurs only around an offline synthetic MCP peer.
  const scenarios = [
    ['SMOKE_MODEL_EVIDENCE', (out, n) => { if (n === 1) out.model_evidence = []; }],
    ['SMOKE_MODEL_EVIDENCE', (out, n) => { if (n === 1) out.model_evidence = ['self-described-opus']; }],
    ['SMOKE_IDENTITY', (out, n) => { if (n === 1) out.runtime.accountFingerprint = 'bad'; }],
    ['SMOKE_TOOL_DENIAL', (out, n) => { if (n === 1) out.permission_denials = [{ tool_name: 'Bash' }]; }],
    ['SMOKE_FIRST', (out, n) => { if (n === 1) out.turn = 2; }],
    ['SMOKE_REPLAY', (out, n) => { if (n === 2) out.reply = 'changed'; }],
    ['SMOKE_CONTINUITY', (out, n) => { if (n === 3) out.runtime.accountFingerprint = 'c'.repeat(64); }],
    ['SMOKE_CONTINUITY', (out, n) => { if (n === 3) out.reply = 'lost context'; }],
    ['SMOKE_STATUS', (out, n) => { if (n === 4) out.status = 'uncertain'; }],
    ['SMOKE_TOOL_POLICY', (out, n) => { if (n === 4) out.policy.disableTools = true; }],
    ['SMOKE_CALL', () => {}],
  ];
  for (const [code, mutate] of scenarios) {
    fs.rmSync(path.join(f.root, 'smoke-state.json'), { force: true });
    let calls = 0, opened = 0, closed = 0;
    const open = async () => {
      const client = await connect(path.join(__dirname, 'smoke-fixture.js'), { ...f.env, SMOKE_FIXTURE_ROOT: f.root });
      opened++;
      return {
        async callTool(...args) {
          calls++;
          if (code === 'SMOKE_CALL') return { isError: true, content: [{ type: 'text', text: 'SYNTHETIC_SECRET' }] };
          const r = await client.callTool(...args); mutate(r.structuredContent, calls); return r;
        },
        async close() { closed++; await client.close(); },
      };
    };
    await assert.rejects(rehearse(open, f.root, 'synthetic-marker'), e => e.code === code && !e.message.includes('SYNTHETIC_SECRET'));
    assert.equal(closed, opened);
  }
});

test('opt-in main uses private offline MCP, forces narrow policy, cleans only owned files', async t => {
  const f = profile(t);
  fs.writeFileSync(path.join(f.root, 'unrelated'), 'preserve');
  for (const [args, opt] of [[['--live'], {}], [[], { CLAUDE_BRIDGE_LIVE: '1' }]]) {
    fs.rmSync(path.join(f.root, 'smoke-state.json'), { force: true });
    let connections = 0;
    const main = smokeMain({
      'node:os': { tmpdir: () => f.root },
      '../doctor': { connect: async (entry, env) => {
        connections++;
        assert.equal(path.basename(entry), 'index.js');
        assert.equal(env.CLAUDE_BRIDGE_DISABLE_TOOLS, '0');
        assert.equal(env.CLAUDE_BRIDGE_ALLOWED_TOOLS, '[]');
        assert.equal(env.CLAUDE_BRIDGE_PERMISSION_MODE, 'bypassPermissions');
        assert.equal(env.CLAUDE_BRIDGE_MODEL, 'opus');
        assert.equal(env.CLAUDE_BRIDGE_CONFIG_DIR, path.join(f.root, 'synthetic-existing-profile'));
        return connect(path.join(__dirname, 'smoke-fixture.js'), { ...f.env, SMOKE_FIXTURE_ROOT: f.root });
      } },
    });
    const env = { ...f.env, ...opt, CLAUDE_BRIDGE_DISABLE_TOOLS: '0', CLAUDE_BRIDGE_MODEL: 'unsupported',
      CLAUDE_BRIDGE_CONFIG_DIR: path.join(f.root, 'synthetic-existing-profile') };
    const snapshot = { ...env };
    const out = await main(args, env);
    assert.equal(out.code, 0); assert.equal(connections, 2); assert.deepEqual(env, snapshot);
    assert.equal(JSON.parse(out.stdout).tools_disabled, false);
    assert.match(out.stderr, /LIVE_USAGE_AND_NATIVE_TRANSCRIPTS/);
    assert.ok(!fs.readdirSync(f.root).some(name => name.startsWith('claude-bridge-smoke-')));
    assert.equal(fs.readFileSync(path.join(f.root, 'unrelated'), 'utf8'), 'preserve');
  }
});

test('opt-in offline failure preserves only smoke state and sanitizes raw native error', async t => {
  const f = profile(t);
  const main = smokeMain({
    'node:os': { tmpdir: () => f.root },
    '../doctor': { connect: async () => ({
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'NATIVE_AUTH', message: 'RAW_SECRET' }) }] }),
      close: async () => {},
    }) },
  });
  const out = await main(['--live'], f.env);
  assert.equal(out.code, 1); assert.equal(out.stdout, ''); assert.ok(!out.stderr.includes('RAW_SECRET'));
  const error = JSON.parse(out.stderr.trim().split('\n').at(-1));
  assert.equal(error.code, 'NATIVE_AUTH'); assert.equal(path.dirname(error.retained_smoke_directory), f.root);
  assert.equal(fs.existsSync(path.join(error.retained_smoke_directory, 'project')), true);
});

test('offline smoke failures retain only allowlisted bridge reasons through MCP and final JSON', async t => {
  const f = profile(t);
  for (const [code, reason, expected] of [
    ['NATIVE_DRIFT', 'GLOBAL_METADATA_CHANGED', 'GLOBAL_METADATA_CHANGED'],
    ['NATIVE_POLICY', 'POLICY_UNATTESTED', 'POLICY_UNATTESTED'],
    ['NATIVE_DRIFT', 'RAW_SECRET', undefined],
    ['NATIVE_AUTH', 'GLOBAL_METADATA_CHANGED', undefined],
    ['RAW_SECRET', 'GLOBAL_METADATA_CHANGED', undefined],
  ]) {
    let calls = 0, closed = 0;
    const main = smokeMain({
      'node:os': { tmpdir: () => f.root },
      '../doctor': { connect: async () => ({
        callTool: async () => {
          calls++;
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, reason, message: 'RAW_SECRET', extra: 'RAW_SECRET' }) }] };
        },
        close: async () => { closed++; },
      }) },
    });
    const out = await main(['--live'], f.env);
    assert.equal(out.code, 1);
    assert.equal(calls, 1, 'diagnostic propagation must never retry');
    assert.equal(closed, 1);
    assert.ok(!out.stderr.includes('RAW_SECRET'));
    const error = JSON.parse(out.stderr.trim().split('\n').at(-1));
    assert.equal(error.code, code === 'RAW_SECRET' ? 'SMOKE_CALL' : code);
    assert.equal(error.reason, expected);
    if (expected) assert.equal(error.message, require('../lib/config').safeError({ code, reason }).message);
    else assert.equal(error.message, undefined);
    assert.equal(error.task_submitted, 'unknown');
    assert.equal(path.dirname(error.retained_smoke_directory), f.root);
  }
});
