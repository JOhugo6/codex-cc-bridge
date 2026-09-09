'use strict';
const { randomUUID } = require('node:crypto');
const { TestBackend } = require('./helpers');
new TestBackend({ timeoutMs: 60000 }, 'hang')
  .run({ sessionId: randomUUID(), resume: false, message: 'hang', cwd: process.argv[2], model: 'claude-opus-5[1m]', permissionMode: 'dontAsk', allowedTools: [] })
  .catch(() => { process.stderr.write('Test worker failed.\n'); process.exitCode = 1; });
