'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { acquireProfileLock } = require('../lib/profile-lock');
const { ClaudeBridge } = require('../lib/bridge');
const { fixture, fakeRuntime } = require('./helpers');
const lockName = '.claude-bridge-runtime.lock';

async function profile(t) {
  const f = await fixture(t);
  f.profile = path.join(f.dir, 'native-profile');
  await fs.mkdir(f.profile);
  f.lock = path.join(f.profile, lockName);
  return f;
}

function privateLock({ waitMs = 200, filesystem = fs } = {}) {
  const filename = require.resolve('../lib/profile-lock');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:fs/promises' ? filesystem : original(name);
  loaded._compile(syncFs.readFileSync(filename, 'utf8').replace('const WAIT_MS = 30000;', `const WAIT_MS = ${waitMs};`), filename);
  return loaded.exports.acquireProfileLock;
}

// Children run real bridge/store/profile-lock code in independent processes with
// distinct state directories. Only native metadata and inference are synthetic.
function childMain() {
  const { ClaudeBridge } = require(process.argv[1]);
  const { acquireProfileLock } = require(process.argv[2]);
  const { fakeRuntime } = require(process.argv[3]);
  const { config } = require(process.argv[4]);
  const [root, cwd, stateDir] = process.argv.slice(5);
  const gate = phase => new Promise(resolve => {
    process.once('message', resolve);
    process.send({ phase });
  });
  const runtime = options => {
    const base = fakeRuntime(options);
    return {
      acquire: async signal => {
        process.send({ phase: 'attempting' });
        const release = await acquireProfileLock(root, signal);
        process.send({ phase: 'acquired' });
        return release;
      },
      preflight: async input => { await gate('preflight'); return base.preflight(input); },
    };
  };
  const backend = { run: async i => { await gate('backend'); return { reply: 'ok', session_id: i.sessionId }; } };
  const bridge = new ClaudeBridge(backend, { ...config({}), stateDir, configRoot: root }, runtime);
  bridge.turn({ conversation_id: 'shared-id', working_dir: cwd, message: 'synthetic' })
    .then(() => { process.send({ phase: 'done' }); process.disconnect(); })
    .catch(e => { process.send({ phase: 'error', code: e.code }); process.exitCode = 1; process.disconnect(); });
}

function startChild(t, f, stateName) {
  const child = spawn(process.execPath, ['-e', `(${childMain.toString()})()`,
    require.resolve('../lib/bridge'), require.resolve('../lib/profile-lock'), require.resolve('./helpers'),
    require.resolve('../lib/config'), f.profile, f.cwd, path.join(f.dir, stateName)],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const events = [], listeners = new Set();
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  child.on('message', value => { events.push(value); for (const listener of listeners) listener(); });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  const wait = phase => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`child timeout ${phase}: ${stderr}`)); }, 5000);
    const check = () => {
      const error = events.find(e => e.phase === 'error');
      if (error || events.some(e => e.phase === phase)) {
        clearTimeout(timer); listeners.delete(check);
        if (error) reject(new Error(`child error ${error.code}`)); else resolve();
      }
    };
    listeners.add(check); check();
  });
  return { child, events, wait, closed };
}

test('profile lock serializes independent bridge processes through preflight and backend across state dirs', { timeout: 15000 }, async t => {
  const f = await profile(t);
  const a = startChild(t, f, 'state-a');
  await a.wait('preflight');
  assert.equal(JSON.parse(await fs.readFile(f.lock)).pid, a.child.pid);
  const b = startChild(t, f, 'state-b');
  await b.wait('attempting');
  await delay(150);
  assert.equal(b.events.some(e => e.phase === 'acquired'), false);
  a.child.send('continue');
  await a.wait('backend');
  await delay(150);
  assert.equal(b.events.some(e => e.phase === 'acquired'), false, 'backend retains profile ownership');
  assert.equal(JSON.parse(await fs.readFile(f.lock)).pid, a.child.pid);
  a.child.send('finish');
  await a.wait('done');
  await b.wait('preflight');
  assert.equal(JSON.parse(await fs.readFile(f.lock)).pid, b.child.pid);
  b.child.send('continue'); await b.wait('backend'); b.child.send('finish');
  await b.wait('done');
  assert.equal(await a.closed, 0); assert.equal(await b.closed, 0);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

test('profile lock cancellation preserves incumbent and does not acquire an already aborted request', async t => {
  const f = await profile(t);
  const release = await acquireProfileLock(f.profile);
  const bytes = await fs.readFile(f.lock, 'utf8');
  const controller = new AbortController();
  const waiting = acquireProfileLock(f.profile, controller.signal);
  const rejected = assert.rejects(waiting, { code: 'CANCELLED' });
  await delay(50); controller.abort(); await rejected;
  assert.equal(await fs.readFile(f.lock, 'utf8'), bytes);
  await release();
  await assert.rejects(acquireProfileLock(f.profile, controller.signal), { code: 'CANCELLED' });
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

test('distinct profiles can hold locks concurrently and release is idempotent', async t => {
  const f = await profile(t);
  const other = path.join(f.dir, 'other'); await fs.mkdir(other);
  const releases = await Promise.all([acquireProfileLock(f.profile), acquireProfileLock(other)]);
  await fs.stat(f.lock); await fs.stat(path.join(other, lockName));
  await Promise.all(releases.map(release => release()));
  await releases[0]();
});

test('profile lock refuses absent, relative, file and linked roots without creating profiles', async t => {
  const f = await profile(t);
  const absent = path.join(f.dir, 'absent'), file = path.join(f.dir, 'file'), link = path.join(f.dir, 'linked');
  await fs.writeFile(file, 'x');
  await fs.symlink(f.profile, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [undefined, 'relative-profile', absent, file, link]) {
    await assert.rejects(acquireProfileLock(root), { code: 'NATIVE_ROOT' });
  }
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

test('stale lock files and lock directories time out without deletion or takeover', async t => {
  const f = await profile(t);
  const acquire = privateLock();
  const bytes = '{"pid":999999999,"nonce":"orphaned","created_at":"2000-01-01"}\n';
  await fs.writeFile(f.lock, bytes);
  await assert.rejects(acquire(f.profile), { code: 'NATIVE_PROFILE_BUSY' });
  assert.equal(await fs.readFile(f.lock, 'utf8'), bytes);
  await fs.unlink(f.lock);
  // A directory in place of the lock is also never treated as reclaimable.
  await fs.mkdir(f.lock);
  await assert.rejects(acquire(f.profile), { code: 'NATIVE_PROFILE_BUSY' });
  assert.equal((await fs.stat(f.lock)).isDirectory(), true);
});

test('release preserves a foreign replacement lock', async t => {
  const f = await profile(t);
  const release = await acquireProfileLock(f.profile);
  await fs.rename(f.lock, path.join(f.profile, 'original-lock'));
  await fs.writeFile(f.lock, 'foreign');
  await assert.rejects(release(), { code: 'NATIVE_PROFILE_LOCK' });
  assert.equal(await fs.readFile(f.lock, 'utf8'), 'foreign');
});

test('release preserves foreign replacements introduced while asynchronous close completes', async t => {
  const f = await profile(t);
  const acquire = privateLock({ filesystem: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return {
      stat: () => handle.stat(), writeFile: marker => handle.writeFile(marker), sync: () => handle.sync(),
      close: async () => {
        await handle.close();
        await fs.rename(f.lock, path.join(f.profile, 'original-lock'));
        await fs.writeFile(f.lock, 'replacement-during-close');
      },
    };
  } } });
  const release = await acquire(f.profile);
  await assert.rejects(release(), { code: 'NATIVE_PROFILE_LOCK' });
  assert.equal(await fs.readFile(f.lock, 'utf8'), 'replacement-during-close');
});

test('release preserves an in-place same-size foreign nonce rewrite', async t => {
  const f = await profile(t);
  const release = await acquireProfileLock(f.profile);
  const original = await fs.readFile(f.lock, 'utf8');
  const changed = original.replace(/("nonce":")[^"]/, (_s, prefix) => prefix + 'x');
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(changed));
  assert.notEqual(changed, original);
  await fs.writeFile(f.lock, changed);
  await assert.rejects(release(), { code: 'NATIVE_PROFILE_LOCK' });
  assert.equal(await fs.readFile(f.lock, 'utf8'), changed);
});

test('failed marker persistence cleans up the owned lock and returns a bounded public error', async t => {
  const f = await profile(t);
  const acquire = privateLock({ filesystem: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: () => handle.stat(), writeFile: marker => handle.writeFile(marker),
      sync: async () => { throw new Error('PRIVATE_FILE_ERROR'); }, close: () => handle.close() };
  } } });
  await assert.rejects(acquire(f.profile), e => e.code === 'NATIVE_PROFILE_LOCK' && !e.message.includes('PRIVATE_FILE_ERROR'));
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  const release = await acquireProfileLock(f.profile); await release();
});

test('bridge cancellation waiting for a profile never enters metadata or creates conversation state', async t => {
  const f = await profile(t);
  const release = await acquireProfileLock(f.profile);
  const controller = new AbortController();
  let attempted;
  const attempt = new Promise(resolve => { attempted = resolve; });
  const bridge = new ClaudeBridge({ run: () => assert.fail('cancelled call must not submit') }, f.settings, () => ({
    acquire: signal => { attempted(); return acquireProfileLock(f.profile, signal); },
    preflight: () => assert.fail('cancelled waiter must not start metadata'),
  }));
  const turn = bridge.turn({ conversation_id: 'cancelled-waiter', message: 'x', working_dir: f.cwd }, controller.signal);
  const rejected = assert.rejects(turn, { code: 'CANCELLED' });
  await attempt; controller.abort(); await rejected;
  assert.equal((await bridge.status('cancelled-waiter')).exists, false);
  await fs.stat(f.lock); await release();
  // The outer finally releases the conversation lock too.
  const unlockConversation = await bridge.store.lock('cancelled-waiter'); await unlockConversation();
});

test('bridge releases profile on metadata, launch and backend failure and skips acquisition for cached replay', async t => {
  const f = await profile(t);
  let mode = 'ok', acquired = 0;
  const runtime = options => {
    const base = fakeRuntime(options);
    return {
      acquire: async signal => { acquired++; return acquireProfileLock(f.profile, signal); },
      preflight: async input => {
        await fs.stat(f.lock);
        if (mode === 'preflight') throw Object.assign(new Error('metadata'), { code: 'NATIVE_POLICY' });
        const prepared = await base.preflight(input);
        return { identity: prepared.identity, launch: async submit => {
          await fs.stat(f.lock);
          if (mode === 'launch') throw Object.assign(new Error('launch'), { code: 'NATIVE_DRIFT' });
          return prepared.launch(submit);
        } };
      },
    };
  };
  const backend = { run: async i => {
    await fs.stat(f.lock);
    if (mode === 'backend') throw Object.assign(new Error('backend'), { code: 'CLAUDE_TIMEOUT' });
    return { reply: 'ok', session_id: i.sessionId };
  } };
  const bridge = new ClaudeBridge(backend, { ...f.settings, configRoot: f.profile }, runtime);
  for (const [failure, code] of [['preflight', 'NATIVE_POLICY'], ['launch', 'NATIVE_DRIFT'], ['backend', 'CLAUDE_TIMEOUT']]) {
    mode = failure;
    await assert.rejects(bridge.turn({ conversation_id: failure, message: 'x', working_dir: f.cwd }), { code });
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  }
  mode = 'ok';
  const input = { conversation_id: 'success', request_id: 'r1', message: 'x', working_dir: f.cwd };
  await bridge.turn(input);
  const before = acquired;
  const release = await acquireProfileLock(f.profile);
  try { assert.equal((await bridge.turn(input)).replayed, true); assert.equal(acquired, before); }
  finally { await release(); }
});
