'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { synthetic, assertWire } = require('./native-runtime-fixture');

test('native ordinary preferences and personal feature caches preserve guards and saved settings', { timeout: 120000 }, async t => {
  const f = await synthetic({ native: true });
  t.after(() => f.close());
  const marker = path.join(f.project, 'mcp-started');
  const settings = {
    model: 'claude-sonnet-4-6', modelSettings: { 'claude-fable-5': { effortLevel: 'high' } },
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    tui: 'fullscreen', theme: 'dark', skipDangerousModePermissionPrompt: true,
    // Native migrates skipAutoPermissionPrompt away during first startup. Its
    // admission is unit-tested; keep this launch fixture already migrated.
    agentPushNotifEnabled: false,
    mcpServers: { saved: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`] } },
  };
  const saved = path.relative(f.root, path.join(f.config, 'settings.json'));
  await f.json(saved, settings);
  await f.json(path.relative(f.root, path.join(f.config, 'remote-settings.json')), { channelsEnabled: true });
  await f.json(path.relative(f.root, path.join(f.config, 'policy-limits.json')), {
    restrictions: { allow_quick_web_setup: { allowed: false }, enforce_web_search_mcp_isolation: { allowed: false } },
    compliance_taints: [], monitoring_notice: null, defaults: { remote_control_at_startup: false },
  });
  const prepared = await f.runtime().preflight({ cwd: f.project });
  const result = await prepared.launch(l => f.runPrepared(l));
  assert.equal(result.code, 0);
  assertWire(f, 1);
  await assert.rejects(fs.stat(marker), e => e.code === 'ENOENT');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, saved), 'utf8')), settings);
});
