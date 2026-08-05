$ErrorActionPreference = "Stop"

$cohall = (Get-Command cohall -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $cohall -Argument "device"
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

Start-ScheduledTask -TaskName "Cohall Device"
Write-Output "Cohall Device scheduled task installed."
