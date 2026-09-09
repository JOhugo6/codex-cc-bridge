param(
    [Parameter(Mandatory=$true)][string]$Supervisor,
    [Parameter(Mandatory=$true)][string]$LaunchBase64
)
$ErrorActionPreference = 'Stop'
try {
    [Console]::Error.WriteLine('ci-probe:ps-start')
    # TEST ONLY: debugger line actions bracket the original Add-Type statement.
    # Execute the inspected, hash-checked source unchanged, including its Job
    # assignment, parent HANDLE monitor, IO pumps and self-termination semantics.
    Set-PSBreakpoint -Script $Supervisor -Line 5 -Action {
        [Console]::Error.WriteLine('ci-probe:add-type-start')
    } | Out-Null
    Set-PSBreakpoint -Script $Supervisor -Line 6 -Action {
        [Console]::Error.WriteLine('ci-probe:add-type-complete')
    } | Out-Null
    & $Supervisor -LaunchBase64 $LaunchBase64
    exit $LASTEXITCODE
} catch {
    # Never serialize the PowerShell ErrorRecord, message, argv or paths.
    exit 1
}
