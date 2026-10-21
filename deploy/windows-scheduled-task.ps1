<#
.SYNOPSIS
  Registers a logon task that keeps the gateway running.

.DESCRIPTION
  Calls node.exe directly. A cmd.exe wrapper inherits a console and dies with
  Ctrl+C when the parent shell exits, which is why this script avoids it.

.PARAMETER BridgePath
  Folder containing bridge.mjs. Defaults to the repository root.

.PARAMETER TaskName
  Scheduled task name.
#>
param(
  [string]$BridgePath = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = 'OpenCodeTelegramGateway'
)

$ErrorActionPreference = 'Stop'

$script = Join-Path $BridgePath 'bridge.mjs'
if (-not (Test-Path $script)) { throw "bridge.mjs not found in $BridgePath" }
if (-not (Test-Path (Join-Path $BridgePath 'config.json'))) { throw "config.json not found in $BridgePath" }

$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '"') -WorkingDirectory $BridgePath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ("$env:USERDOMAIN\$env:USERNAME")
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Telegram gateway for OpenCode' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Registered and started task '$TaskName' using $node"
