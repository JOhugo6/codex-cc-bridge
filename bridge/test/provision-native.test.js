'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { privateModule, profile } = require('./diagnostic-fixture');
const { provision, ARTIFACT, validateArtifact } = privateModule('../ci/provision-native.js',
  'module.exports = { provision, ARTIFACT, validateArtifact };');
const body = Buffer.from('SYNTHETIC_NOT_AN_EXECUTABLE');
const artifact = { ...ARTIFACT, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };

async function transport(t, respond) {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; respond(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    get(url, options, callback) {
      assert.equal(url, ARTIFACT.url); // Production source selection is still checked.
      assert.equal(options.rejectUnauthorized, true);
      return http.get(`http://127.0.0.1:${server.address().port}/synthetic`, options, callback);
    },
    count: () => requests,
  };
}

test('provisioner pins official HTTPS version, platform, hash and size; public surface has no overrides', () => {
  assert.deepEqual(Object.keys(require('../ci/provision-native')), ['main']);
  assert.equal(ARTIFACT.version, '2.1.268'); assert.equal(ARTIFACT.platform, 'win32-x64');
  assert.equal(ARTIFACT.sha256, '1e472bcfd49449e73ef76698c87f6583055aeb88dc41ca190a9c12c6791b5eea');
  assert.equal(ARTIFACT.size, 221637792); assert.ok(Object.isFrozen(ARTIFACT));
  assert.equal(new URL(ARTIFACT.url).protocol, 'https:');
  for (const patch of [
    { version: 'latest' }, { platform: 'linux-x64' }, { sha256: 'x' }, { size: 0 },
    { size: 301 * 1024 * 1024 }, { url: ARTIFACT.url.replace('https:', 'http:') },
    { url: ARTIFACT.url + '?fork=1' }, { url: ARTIFACT.url.replace('downloads.claude.ai', 'downloads.claude.ai.evil.invalid') },
    { url: ARTIFACT.url.replace('https://', 'https://user:secret@') },
  ]) assert.throws(() => validateArtifact({ ...ARTIFACT, ...patch }), { code: 'PROVISION_SOURCE' });
});

test('private offline transport downloads, hashes and publishes only verified complete bytes', async t => {
  const f = profile(t);
  const net = await transport(t, (req, res) => { res.writeHead(200); res.write(body.subarray(0, 5)); res.end(body.subarray(5)); });
  const output = path.join(f.root, 'native Ž (safe)');
  const result = await provision(output, artifact, net.get);
  assert.equal(result.executable, path.join(output, 'claude.exe'));
  assert.deepEqual(await fs.readFile(result.executable), body); assert.equal(result.bytes, body.length);
  assert.equal(result.sha256, artifact.sha256); assert.equal(net.count(), 1);
  assert.deepEqual(await fs.readdir(output), ['claude.exe']);
  // Synthetic bytes deliberately are not an executable; provisioning must not run them.
});

test('hash mismatch, wrong size, truncated stream, redirects and HTTP errors publish nothing', async t => {
  const f = profile(t);
  const cases = [
    ['hash', (q, r) => r.end(Buffer.alloc(body.length, 65)), 'PROVISION_HASH'],
    ['short', (q, r) => r.end('short'), 'PROVISION_SIZE'],
    ['long', (q, r) => r.end(Buffer.alloc(body.length + 1)), 'PROVISION_SIZE'],
    ['redirect', (q, r) => r.writeHead(302, { location: 'https://evil.invalid/binary' }).end(), 'PROVISION_HTTP'],
    ['missing', (q, r) => r.writeHead(404).end(), 'PROVISION_HTTP'],
    ['compressed', (q, r) => r.writeHead(200, { 'content-encoding': 'gzip' }).end(body), 'PROVISION_HTTP'],
    ['truncated', (q, r) => { r.writeHead(200, { 'content-length': body.length + 10 }); r.end(body); }, null],
  ];
  for (const [name, handler, code] of cases) {
    const net = await transport(t, handler);
    const output = path.join(f.root, name);
    await assert.rejects(provision(output, artifact, net.get, 3000), code ? { code } : () => true);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' }); assert.equal(net.count(), 1);
  }
});

test('bounded transport deadline cleans its partial output without retry', async t => {
  const f = profile(t);
  const net = await transport(t, (q, r) => { r.writeHead(200); r.write(body.subarray(0, 2)); });
  const output = path.join(f.root, 'timeout');
  await assert.rejects(provision(output, artifact, net.get, 100), e => e.name === 'AbortError');
  await assert.rejects(fs.stat(output), { code: 'ENOENT' }); assert.equal(net.count(), 1);
});

test('invalid output and existing destination refuse before transport and preserve unrelated files', async t => {
  const f = profile(t);
  await fs.writeFile(path.join(f.root, 'preserve'), 'unchanged');
  const get = () => assert.fail('transport must not start');
  for (const output of ['relative', '', null, path.join(f.root, 'bad\npath')]) {
    await assert.rejects(provision(output, artifact, get), { code: 'PROVISION_OUTPUT' });
  }
  await assert.rejects(provision(f.root, artifact, get), { code: 'EEXIST' });
  await assert.rejects(provision(path.join(f.root, 'missing-parent', 'native'), artifact, get), { code: 'ENOENT' });
  await assert.rejects(provision(path.join(f.root, 'bad-source'), { ...artifact, url: 'http://localhost/' }, get), { code: 'PROVISION_SOURCE' });
  assert.equal(await fs.readFile(path.join(f.root, 'preserve'), 'utf8'), 'unchanged');
});

test('public CLI rejects absent, unknown and unsafe inputs without downloading or executing', async t => {
  const f = profile(t);
  const entry = path.resolve(__dirname, '../ci/provision-native.js');
  const before = await fs.readdir(f.root);
  for (const args of [[], ['--url', 'https://evil.invalid/'], ['--output', 'relative'], ['--output', f.root], ['--output', f.root, '--sha256', 'x']]) {
    const out = spawnSync(process.execPath, [entry, ...args], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(out.status, 1); assert.equal(out.stdout, '');
    assert.equal(JSON.parse(out.stderr).ok, false); assert.ok(!out.stderr.includes('evil.invalid'));
  }
  assert.deepEqual(await fs.readdir(f.root), before);
});
