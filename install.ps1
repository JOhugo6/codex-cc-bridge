[CmdletBinding()]
param(
    [string]$CodexRoot = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
    [string]$SkillRoot = $(Join-Path $env:USERPROFILE '.agents\skills'),
    [ValidateSet('dontAsk', 'acceptEdits', 'plan', 'default', 'auto')]
    [string]$PermissionMode = 'dontAsk',
    [string[]]$AllowedTools = @(),
    [string]$Model = '',
    [ValidateRange(10, 86400)][int]$TimeoutSeconds = 900,
    [switch]$SkipRegister
)
$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$claudeExe = (Get-Command claude.exe -ErrorAction Stop).Source
$codexCommand = (Get-Command codex -ErrorAction Stop).Source
$major = [int]((& $nodeExe --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

$root = [IO.Path]::GetFullPath($CodexRoot)
$destination = Join-Path $root 'bridges\claude-bridge'
$source = Join-Path $PSScriptRoot 'bridge'
if ([IO.Path]::GetFullPath($source) -eq [IO.Path]::GetFullPath($destination)) { throw 'Install destination must differ from the source directory.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
# Copy only maintained source; keep persisted state outside the installation.
foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
    if ($item.Name -in @('node_modules', '.test-output')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'NOTICE') -Destination $destination -Force
& $npmCommand --prefix $destination ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
& $nodeExe (Join-Path $destination 'doctor.js')
if ($LASTEXITCODE -ne 0) { throw 'MCP handshake failed; configuration was not changed.' }

$skillDestination = Join-Path ([IO.Path]::GetFullPath($SkillRoot)) 'claude-peer'
New-Item -ItemType Directory -Path $skillDestination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'skills\claude-peer\SKILL.md') -Destination $skillDestination -Force

if (-not $SkipRegister) {
    $configFile = Join-Path $root 'config.toml'
    if (Test-Path -LiteralPath $configFile) {
        $backup = $configFile + '.claude-bridge-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '.bak'
        Copy-Item -LiteralPath $configFile -Destination $backup
        Write-Host "Configuration backup: $backup"
    }
    $savedCodexRoot = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = $root
        $allowJson = ConvertTo-Json -InputObject @($AllowedTools) -Compress
        $arguments = @('mcp', 'add', 'claude_bridge',
            '--env', "CLAUDE_BRIDGE_COMMAND=$claudeExe",
            '--env', "CLAUDE_BRIDGE_STATE_DIR=$(Join-Path $root 'state\claude-bridge')",
            '--env', "CLAUDE_BRIDGE_PERMISSION_MODE=$PermissionMode",
            '--env', "CLAUDE_BRIDGE_ALLOWED_TOOLS=$allowJson",
            '--env', "CLAUDE_BRIDGE_TIMEOUT_MS=$($TimeoutSeconds * 1000)")
        if ($Model) { $arguments += @('--env', "CLAUDE_BRIDGE_MODEL=$Model") }
        $arguments += @('--', $nodeExe, (Join-Path $destination 'index.js'))
        & $codexCommand @arguments
        if ($LASTEXITCODE -ne 0) { throw 'codex mcp add failed.' }
        & $nodeExe (Join-Path $destination 'configure-timeout.js') $configFile ($TimeoutSeconds + 60)
        if ($LASTEXITCODE -ne 0) { throw 'Could not configure MCP timeout.' }
        & $codexCommand mcp get claude_bridge
        if ($LASTEXITCODE -ne 0) { throw 'Registered MCP configuration could not be read.' }
    } finally { $env:CODEX_HOME = $savedCodexRoot }
}
Write-Host "Installed bridge: $destination"
Write-Host "Installed skill: $skillDestination"
Write-Host "Claude permission mode: $PermissionMode"
Write-Host 'Restart Codex and use $claude-peer to delegate a task.'
