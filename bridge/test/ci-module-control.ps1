param([Parameter(Mandatory=$true)][ValidateSet('json', 'import-json')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
    [Console]::Error.WriteLine('ci-probe:module-ps-start')
    if ($Mode -eq 'import-json') {
        [Console]::Error.WriteLine('ci-probe:module-import-start')
        # Use only the running shell's own built-in module, never a caller path.
        $manifest = [IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
        Import-Module -Name $manifest -ErrorAction Stop
        [Console]::Error.WriteLine('ci-probe:module-import-complete')
    }
    [Console]::Error.WriteLine('ci-probe:json-start')
    $value = '{"value":7}' | ConvertFrom-Json
    if ($null -eq $value -or $value.value -ne 7) { exit 1 }
    [Console]::Error.WriteLine('ci-probe:json-complete')
    # This validates only the module control, not supervisor or child readiness.
    [Console]::Out.WriteLine('ci-probe:module-control-complete')
    exit 0
} catch {
    # Never serialize the PowerShell ErrorRecord, message, argv or paths.
    exit 1
}
