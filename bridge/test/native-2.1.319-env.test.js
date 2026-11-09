'use strict';

// Optional characterization of ONE official artifact. This does not widen the
// bridge's supported env set or establish the behavior of any other build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, printArgs, reply, EXE, SYNTHETIC_KEY, SYNTHETIC_OAUTH } = require('./native-contract-fixture');

const KEY = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS';
const SHA256 = '2e055732c9d03d22700d9046251a8370b673607bfcc9e4d16a1b0e8fb1345cbd';
const inference = f => f.requests.filter(r => r.url.split('?')[0] === '/v1/messages');
const results = f => inference(f).flatMap(r => r.body.messages || [])
  .flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result');

test('official Windows x64 2.1.319 ignores this settings env entry and retains critical-path protection', { timeout: 180000 }, async t => {
  assert.equal(process.platform, 'win32', 'this characterization requires the Windows artifact');
  assert.ok(process.env.NATIVE_CONTRACT_CLAUDE_EXE && path.isAbsolute(process.env.NATIVE_CONTRACT_CLAUDE_EXE),
    'set NATIVE_CONTRACT_CLAUDE_EXE explicitly to the downloaded official 2.1.319 artifact');
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(EXE)).digest('hex'), SHA256,
    'refuse any other artifact before starting a native process');
  for (const variant of [
    { label: 'absent', env: {} },
    { label: 'settings-one', env: { [KEY]: '1' } },
    { label: 'settings-zero', env: { [KEY]: '0' } },
    { label: 'settings-empty', env: { [KEY]: '' } },
    { label: 'settings-lowercase', env: { [KEY.toLowerCase()]: '1' } },
  ]) await t.test(variant.label, { timeout: 35000 }, async () => {
    const f = await fixture();
    try {
      assert.equal(Object.keys(f.env).some(k => k.toUpperCase() === KEY), false,
        'never supply the removal waiver in a native launch environment');
      const compatibility = await f.verifyCompatibility();
      assert.equal(compatibility.version, '2.1.319');
      const user = { skipDangerousModePermissionPrompt: true, env: { ISSUE2_ENV_CONTROL: 'loaded', ...variant.env } };
      await f.json('config/settings.json', user);
      await f.json('config/.claude.json', { hasCompletedOnboarding: true,
        projects: { [f.project]: { hasTrustDialogAccepted: true }, [f.project.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } });
      // The allowed tool is read-only and emits only booleans for this control.
      // It proves native loaded settings.env without exposing an environment.
      await f.text('observe.cjs', `process.stdout.write(JSON.stringify({ control: process.env.ISSUE2_ENV_CONTROL === 'loaded', prohibited: Object.keys(process.env).some(k => k.toUpperCase() === ${JSON.stringify(KEY)}) }));`);
      const observe = `"${process.execPath.replaceAll('\\', '/')}" "${path.join(f.root, 'observe.cjs').replaceAll('\\', '/')}"`;
      // Nonrecursive rmdir of this newly owned nonempty home is physically
      // harmless even if the expected denial fails. No rm or recursive option.
      assert.equal(await fs.realpath(f.env.HOME), f.root);
      assert.ok((await fs.readdir(f.root)).includes('config'));
      const remove = `rmdir "${f.root.replaceAll('\\', '/')}"`;
      const settingsBytes = await fs.readFile(path.join(f.config, 'settings.json'));
      let sent = false;
      f.setResponder((r, res) => {
        if (r.url.split('?')[0] !== '/v1/messages' || sent) return false;
        sent = true;
        reply(res, r.body.model, [
          { type: 'tool_use', id: 'issue2_observe', name: 'Bash', input: { command: observe } },
          { type: 'tool_use', id: 'issue2_critical_path', name: 'Bash', input: { command: remove } },
        ]);
        return true;
      });
      const run = await f.run(printArgs(['--permission-mode', 'bypassPermissions', '--tools', 'Bash', '--max-turns', '3']));
      assert.equal(run.timedOut, false); assert.equal(run.oversized, false);
      assert.equal(run.code, 0, 'native synthetic task must finish without a raw diagnostic dump');
      assert.ok(![SYNTHETIC_KEY, SYNTHETIC_OAUTH].some(s => (run.stdout + run.stderr).includes(s)), 'synthetic authorization must not be emitted');
      let output; try { output = JSON.parse(run.stdout); } catch { assert.fail('native JSON output could not be parsed'); }
      assert.equal(output.is_error, false);
      assert.equal(output.result, 'NATIVE_CONTRACT_OK');
      assert.ok(inference(f).length >= 2, 'must observe the post-tool request');
      const observed = results(f).find(r => r.tool_use_id === 'issue2_observe');
      assert.ok(observed && !observed.is_error, 'ordinary read-only tool must execute');
      assert.ok(JSON.stringify(observed.content).includes('\\"control\\":true,\\"prohibited\\":false'),
        'ordinary settings env must load while this exact control stays absent');
      const denied = results(f).find(r => r.tool_use_id === 'issue2_critical_path');
      assert.equal(denied?.is_error, true);
      assert.ok(output.permission_denials.some(d => d.tool_use_id === 'issue2_critical_path'),
        'critical-path operation must be rejected by native permission checks');
      assert.deepEqual(await fs.readFile(path.join(f.config, 'settings.json')), settingsBytes);
      assert.ok((await fs.readdir(f.root)).includes('config'));
      t.diagnostic(`PASS ${variant.label}: settings control loaded; prohibited env absent; critical-path denial retained; exact native 2.1.319; loopback only`);
    } finally { await f.close(); }
  });
});
