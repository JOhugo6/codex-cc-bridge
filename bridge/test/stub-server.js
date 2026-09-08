'use strict';
// Explicit test entrypoint; production index.js has no environment-based module override.
const path = require('node:path');
const { main } = require('../index');
const { ClaudeBackend } = require('../lib/claude-backend');
main(settings => new ClaudeBackend({
  ...settings, command: process.execPath,
  prefixArgs: [path.join(__dirname, 'fake-claude.js'), '--stub-mode', process.env.TEST_CLAUDE_MODE || 'normal'],
})).catch(err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; });
