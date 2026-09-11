'use strict';
// No upstream socket is ever opened. CONNECT for the single expected hostname is
// terminated locally using a PUBLIC, synthetic certificate trusted only by children.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { reply, SYNTHETIC_OAUTH } = require('./native-contract-fixture');

async function teamTlsFixture() {
  const requests = [], blocked = [], sockets = new Set();
  let responder;
  const certPath = path.join(__dirname, 'team-tls/cert.pem');
  const secure = https.createServer({ key: await fs.readFile(path.join(__dirname, 'team-tls/key.pem')),
    cert: await fs.readFile(certPath) }, async (req, res) => {
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) { req.destroy(); return; } chunks.push(chunk); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const row = { url: req.url, method: req.method, body, etag: req.headers['if-none-match'] || null,
        syntheticOAuth: req.headers.authorization === `Bearer ${SYNTHETIC_OAUTH}`, syntheticKey: false };
      if (requests.length >= 100) { res.writeHead(429).end(); return; }
      requests.push(row);
      if (responder && await responder(row, res)) return;
      if (req.url.startsWith('/api/claude_code/settings') || req.url.startsWith('/api/claude_code/policy_limits')) {
        if (!/^"sha256:[a-f0-9]{64}"$/.test(row.etag || '')) { res.writeHead(412).end(); return; }
        res.writeHead(304).end();
      } else if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }));
      } else if (req.url.startsWith('/v1/messages')) reply(res, body.model);
      else { res.writeHead(404, { 'content-type': 'application/json' }).end('{}'); }
    } catch { res.destroy(); }
  });
  secure.on('tlsClientError', () => {});
  const proxy = http.createServer((_req, res) => { blocked.push('http'); res.writeHead(502).end(); });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== 'api.anthropic.com:443') { blocked.push(req.url); socket.end('HTTP/1.1 502 Offline fixture\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    secure.emit('connection', socket);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${proxy.address().port}`;
  return { requests, blocked, setResponder(fn) { responder = fn; },
    transportEnv: { HTTP_PROXY: address, HTTPS_PROXY: address, ALL_PROXY: address, NO_PROXY: '', NODE_EXTRA_CA_CERTS: certPath },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); },
  };
}
module.exports = { teamTlsFixture };
