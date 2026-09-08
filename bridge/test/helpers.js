'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../lib/config');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-bridge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = path.join(dir, 'Project s mezerou ž');
  await fs.mkdir(cwd);
  return { dir, cwd, settings: { ...config({}), stateDir: path.join(dir, 'state') } };
}
module.exports = { fixture };
