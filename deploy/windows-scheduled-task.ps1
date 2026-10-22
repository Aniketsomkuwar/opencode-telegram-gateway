<#
.SYNOPSIS
  Registers a logon task that keeps the gateway running.

.DESCRIPTION
  Prefer the built-in installer, which does the same thing and knows where the
  build output is:

      node dist/index.js install

  This script exists for people who want to see the task definition. It calls
  node.exe directly: a cmd.exe wrapper inherits a console and dies with Ctrl+C
  when the parent shell exits.

.PARAMETER HomePath
  Gateway home containing config.json. Defaults to the repository root.

.PARAMETER TaskName
  Scheduled task name.

.EXAMPLE
  pwsh -File deploy/windows-scheduled-task.ps1 -HomePath "$env:USERPROFILE\opencode-telegram"
#>
param(
  [string]$HomePath = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = 'OpenCodeTelegramBridge'
)

$ErrorActionPreference = 'Stop'

$entry = Join-Path $HomePath 'dist\index.js'
if (-not (Test-Path $entry)) { throw "dist\index.js not found in $HomePath. Run: npm run build" }
if (-not (Test-Path (Join-Path $HomePath 'config.json'))) {
  throw "config.json not found in $HomePath. Run: node dist/index.js setup"
}

$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $entry + '" run') -WorkingDirectory $HomePath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ("$env:USERDOMAIN\$env:USERNAME")
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Telegram gateway for OpenCode (outbound only)' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Registered and started task '$TaskName' using $node"
