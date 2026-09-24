param(
  [Parameter(Mandatory = $true)][string]$NodeExecutable,
  [Parameter(Mandatory = $true)][string]$Entrypoint,
  [Parameter(Mandatory = $true)][string]$ConfigurationPath
)

$ErrorActionPreference = "Stop"

function Quote-Literal([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

$bootstrap = @"
`$ErrorActionPreference = 'Stop'
`$env:COHALL_CONFIG = $(Quote-Literal $ConfigurationPath)
`$env:PATH = $(Quote-Literal (Split-Path -Parent $NodeExecutable)) + ';' + `$env:PATH
& $(Quote-Literal $NodeExecutable) $(Quote-Literal $Entrypoint) device
exit `$LASTEXITCODE
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
$powerShell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName "Cohall Device" `
  -Description "Connect this device to the configured Cohall relay" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Force | Out-Null

Stop-ScheduledTask -TaskName "Cohall Device" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "Cohall Device"
Write-Output "Cohall Device scheduled task installed."
