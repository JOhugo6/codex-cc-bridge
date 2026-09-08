'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClaudeBackend } = require('../lib/claude-backend');
new ClaudeBackend({
  command: process.execPath, prefixArgs: [path.join(__dirname, 'fake-claude.js'), '--stub-mode', 'hang'], timeoutMs: 60000,
}).run({ sessionId: randomUUID(), resume: false, message: 'hang', cwd: process.argv[2], model: null, permissionMode: 'dontAsk', allowedTools: [] })
  .catch(err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; });
