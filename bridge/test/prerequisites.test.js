'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('maintained offline aggregate requires Windows, PowerShell 5.1 and 7, and .NET compiler; never skip', () => {
  assert.equal(process.platform, 'win32', 'Windows native contract required; non-Windows coverage is unavailable, not PASS');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 20, 'Node 20+ required');
  const system = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows';
  const ps5 = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.ok(fs.existsSync(ps5), 'Windows PowerShell 5.1 prerequisite unavailable');
  assert.ok(fs.existsSync(path.join(system, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')), '.NET Framework compiler prerequisite unavailable');
  const r = spawnSync(ps5, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { exit 1 }; $p = & pwsh -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.Major'; if ($LASTEXITCODE -ne 0 -or $p -ne '7') { exit 1 }"],
  { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(r.status, 0, 'Both PowerShell 5.1 and pwsh 7 must be available; installer skips do not satisfy this gate');
});
