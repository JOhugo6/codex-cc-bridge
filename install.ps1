[CmdletBinding()]
param(
    [ValidateSet('Codex', 'Claude', 'Both')][string]$Target = 'Codex',
    [string]$CodexRoot = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
    [string]$SkillRoot = $(Join-Path $env:USERPROFILE '.agents\skills'),
    [string]$ClaudeSkillRoot = '',
    [string]$NativeConfigRoot = '',
    [ValidateSet('dontAsk', 'acceptEdits', 'plan', 'default', 'auto')]
    [string]$PermissionMode = 'dontAsk',
    [string[]]$AllowedTools = @(),
    [string]$Model = 'opus',
    [ValidateRange(10, 86400)][int]$TimeoutSeconds = 900,
    [switch]$SkipRegister
)
$ErrorActionPreference = 'Stop'
# Reject argv-shaped tool entries before discovering/running any installer CLI.
# Flags inside a permission rule such as Bash(git log --oneline:*) are data.
foreach ($tool in $AllowedTools) {
    if ([string]::IsNullOrWhiteSpace($tool) -or $tool.TrimStart().StartsWith('-') -or $tool -match '[\x00-\x1f\x7f]') {
        throw 'INSTALL_INVALID_OPTIONS'
    }
}
# Resolve machine-local programs, not paths copied from another PC. In particular,
# neither Claude-only nor an unregistered installation needs the Codex CLI.
# Extension-qualified discovery can return several applications. Pin the first
# PATH match before extracting Source, keeping a single literal executable path.
$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$claudeExe = (Get-Command claude.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$codexCommand = $null
if (-not $SkipRegister -and $Target -in @('Codex', 'Both')) {
    $codexCommand = (Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$major = [int]((& $nodeExe --version).TrimStart('v').Split('.')[0])
if ($LASTEXITCODE -ne 0 -or $major -lt 20) { throw 'Node.js 20 or newer is required.' }

# Base64 UTF-8 JSON travels over stdin: PowerShell 5.1 and 7 differ in
# native argv quoting and pipeline encoding (including nested script scopes).
# No environment variables (including CODEX_HOME / CLAUDE_CONFIG_DIR) are changed
# in this process. The helper gives only the Codex subprocess its selected root.
$options = @{
    target = $Target; codexRoot = $CodexRoot; skillRoot = $SkillRoot
    permissionMode = $PermissionMode; allowedTools = @($AllowedTools)
    model = $Model; timeoutSeconds = $TimeoutSeconds; skipRegister = [bool]$SkipRegister
    nodeExe = $nodeExe; npmCommand = $npmCommand; claudeExe = $claudeExe
    codexCommand = $codexCommand; sourceRoot = $PSScriptRoot
    cwd = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('.')
}
if ($PSBoundParameters.ContainsKey('NativeConfigRoot')) { $options.nativeConfigRoot = $NativeConfigRoot }
if ($ClaudeSkillRoot) { $options.claudeSkillRoot = $ClaudeSkillRoot }
$savedOutputEncoding = $OutputEncoding
try {
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $json = $options | ConvertTo-Json -Depth 10 -Compress
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) | & $nodeExe (Join-Path $PSScriptRoot 'bridge\install-config.js')
    if ($LASTEXITCODE -ne 0) { throw 'Bridge installation failed; see the sanitized diagnostic above.' }
} finally {
    $OutputEncoding = $savedOutputEncoding
}
