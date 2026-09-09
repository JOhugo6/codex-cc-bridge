'use strict';
// Explicit test entrypoint; production index.js has no environment-based module override.
const { main } = require('../index');
const { TestBackend, fakeRuntime } = require('./helpers');
main(settings => new TestBackend(settings), fakeRuntime)
  .catch(() => { process.stderr.write('Test bridge startup failed.\n'); process.exitCode = 1; });
