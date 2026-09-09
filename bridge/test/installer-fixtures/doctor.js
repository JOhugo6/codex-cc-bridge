'use strict';
const fs = require('node:fs');
const control = JSON.parse(fs.readFileSync(process.env.INSTALLER_FIXTURE_CONTROL, 'utf8'));
const log = JSON.parse(fs.readFileSync(control.log, 'utf8'));
log.push({ actor: 'doctor', args: process.argv.slice(2), env: { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } });
fs.writeFileSync(control.log, JSON.stringify(log));
// This verifies installer control flow only, not a handshake or model call.
if (control.fail === 'doctor') {
  console.error('SYNTHETIC_SECRET_DO_NOT_LOG'); process.exit(41);
}
