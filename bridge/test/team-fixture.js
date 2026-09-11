'use strict';
const { synthetic } = require('./native-runtime-fixture');
const path = require('node:path');
const TEAM_DOCTOR = 'Managed settings (remote): loaded\nOrganization policy: Loaded from api.anthropic.com\n';
const TEAM_DEBUG = '[DEBUG] Remote settings: Using cached settings (304)\n'
  + '[DEBUG] Remote settings: Cache still valid (304 Not Modified)\n'
  + '[DEBUG] Policy limits: Using cached restrictions (304)\n'
  + '[DEBUG] Policy limits: Cache still valid (304 Not Modified)\n';
const REMOTE = { channelsEnabled: true, permissions: { deny: ['Read(./denied.txt)'] } };
const POLICY = { restrictions: { allow_quick_web_setup: { allowed: false }, enforce_web_search_mcp_isolation: { allowed: false } },
  compliance_taints: [], monitoring_notice: null, defaults: { remote_control_at_startup: false } };

async function teamFixture(options = {}) {
  const f = await synthetic({ tier: 'team', ...options });
  await f.json(path.relative(f.root, path.join(f.config, 'remote-settings.json')), REMOTE);
  await f.json(path.relative(f.root, path.join(f.config, 'policy-limits.json')), POLICY);
  f.doctorOutput = TEAM_DOCTOR;
  f.doctorStderr = TEAM_DEBUG;
  return f;
}
module.exports = { teamFixture, TEAM_DOCTOR, TEAM_DEBUG, REMOTE, POLICY };
