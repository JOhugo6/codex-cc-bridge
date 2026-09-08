param([Parameter(Mandatory=$true)][string]$LaunchBase64)
$ErrorActionPreference = 'Stop'
try {
    $launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LaunchBase64)) | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-job-runner.cs')
    [ClaudeBridgeJobRunner]::Run([string]$launch.command, [string[]]$launch.args, [string]$launch.cwd, [int]$launch.parentPid)
    exit 0
} catch {
    [Console]::Error.WriteLine('Claude job supervisor failed: ' + $_.Exception.Message)
    exit 1
}
