#!/usr/bin/env pwsh
# install-tunnel-task.ps1 -- register start-tunnel.ps1 to run at user logon.
#
# Usage:
#   pwsh D:\ai-jarvis\scripts\install-tunnel-task.ps1
#
# Removes any prior task with the same name + reinstalls. Idempotent.
#
# Why "at logon" (not "at boot"): npx + node + pm2 paths are user-scoped on
# Windows; a system-account boot task can't reliably resolve them. AtLogOn
# runs as the current user and inherits PATH + npm globals.
#
# To remove later:
#   schtasks /delete /tn "JarvisTunnel" /f

[CmdletBinding()]
param(
    [string]$TaskName = 'JarvisTunnel',
    [string]$ProjectRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($ProjectRoot)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ProjectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
}

$ScriptPath = Join-Path $ProjectRoot 'scripts\start-tunnel.ps1'
if (-not (Test-Path $ScriptPath)) {
    Write-Error "Expected $ScriptPath to exist."
    exit 1
}

# Pick the available pwsh / powershell binary. Windows PowerShell 5.1
# (powershell.exe) ships with Windows; PowerShell 7+ (pwsh.exe) is optional.
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue)
if (-not $shell) {
    $shell = Get-Command powershell -ErrorAction Stop
}
$shellPath = $shell.Source

Write-Host "[install-tunnel-task] using shell: $shellPath"
Write-Host "[install-tunnel-task] script:      $ScriptPath"
Write-Host "[install-tunnel-task] task name:   $TaskName"

# Build the action: shell -ExecutionPolicy Bypass -File <script>
$action  = New-ScheduledTaskAction -Execute $shellPath -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Settings: stop if it runs more than 5 minutes (it should finish in ~30s);
# restart on failure 3x; don't run on battery without throttle.
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

# Run as the current user. LogonType Interactive = no stored password,
# task runs only when user is signed in (which is fine for AtLogOn).
# Note: NOT using `-RunLevel Highest` because that requires the installer
# itself to run elevated. Tunnel + pm2 + config-write work fine as a
# normal user, so we stay non-elevated for both install and run.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive

# Remove prior version if present.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[install-tunnel-task] removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts cloudflared, syncs config.json publicUrl, reloads ai-jarvis. Runs at user logon." | Out-Null

Write-Host ''
Write-Host "[install-tunnel-task] OK -- task registered"
Write-Host "  Verify:   schtasks /query /tn $TaskName"
Write-Host "  Run now:  schtasks /run /tn $TaskName"
Write-Host "  Remove:   schtasks /delete /tn $TaskName /f"
Write-Host ''
