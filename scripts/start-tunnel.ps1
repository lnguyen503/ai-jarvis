#!/usr/bin/env pwsh
# start-tunnel.ps1 -- post-reboot recovery for the Jarvis Avengers webapp.
#
# Idempotent. Safe to run multiple times. Run once on logon (via the
# scheduled task installed by install-tunnel-task.ps1) or by hand:
#
#   pwsh D:\ai-jarvis\scripts\start-tunnel.ps1
#
# What it does:
#   1. Starts pm2 + the Avengers ensemble if not running (4 bots).
#   2. Starts cloudflared in the background if not running.
#   3. Waits for the trycloudflare URL to appear in the cloudflared log.
#   4. Writes the URL to config/config.json (webapp.publicUrl) if changed.
#   5. Reloads ai-jarvis via pm2 so the new URL is consulted by the
#      Avengers Operations Dashboard webapp routes.
#
# trycloudflare quick tunnels rotate URLs on every cloudflared restart, so
# this sync step is mandatory after any reboot. A named Cloudflare tunnel
# would eliminate the URL rotation but requires a Cloudflare account plus
# a domain (see docs/INTERNAL.md for that path).

[CmdletBinding()]
param(
    [string]$BotName = 'ai-jarvis',
    [int]$Port = 7879,
    [string]$ProjectRoot = '',
    [int]$WaitForUrlSeconds = 30
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is unreliable as a param default (empty under some
# `powershell -File` invocations). Resolve it here in the body where the
# parser has already populated it.
if ([string]::IsNullOrEmpty($ProjectRoot)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ProjectRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
}

$ConfigPath        = Join-Path $ProjectRoot 'config\config.json'
$EcosystemPath     = Join-Path $ProjectRoot 'ecosystem.config.cjs'
$LogDir            = Join-Path $ProjectRoot 'logs'
$CloudflaredLog    = Join-Path $LogDir 'cloudflared.log'
$CloudflaredStderr = Join-Path $LogDir 'cloudflared.stderr'
$CloudflaredExe    = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}
if (-not (Test-Path $CloudflaredExe)) {
    Write-Error "cloudflared not found at $CloudflaredExe. Install from https://github.com/cloudflare/cloudflared/releases"
    exit 1
}

function Write-Step($msg) {
    Write-Host "[start-tunnel] $msg"
}

# ---------------------------------------------------------------------------
# Step 1: pm2 + bots
# ---------------------------------------------------------------------------
Write-Step "checking pm2 / bots..."
Push-Location $ProjectRoot
try {
    # We DON'T parse `pm2 jlist` because pm2 emits a process env block with
    # case-variant duplicate keys (USERNAME vs username) that PS 5.1's
    # ConvertFrom-Json rejects. Cheaper: count non-empty app rows from
    # `pm2 pid` output. One PID per running app; an empty result means
    # pm2 is offline or has no apps.
    $pm2Pids = & npx --no-install pm2 pid 2>$null
    $pm2HasApps = ($LASTEXITCODE -eq 0) -and ($pm2Pids -is [string] -and $pm2Pids.Trim().Length -gt 0) -or
                  ($pm2Pids -is [array] -and ($pm2Pids | Where-Object { $_ -match '\d' }).Count -gt 0)
    if (-not $pm2HasApps) {
        Write-Step "pm2 has no apps running -- starting ecosystem (4 bots)..."
        & npx pm2 start $EcosystemPath | Out-Null
    } else {
        Write-Step "pm2 already running with apps"
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# Step 2: cloudflared
# ---------------------------------------------------------------------------
$existing = Get-Process -Name cloudflared -ErrorAction SilentlyContinue
if ($existing) {
    $pids = ($existing.Id -join ',')
    Write-Step "cloudflared already running (PID $pids)"
} else {
    Write-Step "starting cloudflared..."
    # Truncate the log so URL detection finds the FRESH URL, not a stale one
    # from a prior cloudflared run.
    if (Test-Path $CloudflaredLog) { Remove-Item $CloudflaredLog -Force }
    if (Test-Path $CloudflaredStderr) { Remove-Item $CloudflaredStderr -Force }
    Start-Process -FilePath $CloudflaredExe `
        -ArgumentList @(
            'tunnel',
            '--url', "http://localhost:$Port",
            '--logfile', $CloudflaredLog,
            '--loglevel', 'info'
        ) `
        -WindowStyle Hidden `
        -RedirectStandardError $CloudflaredStderr | Out-Null
}

# ---------------------------------------------------------------------------
# Step 3: wait for the trycloudflare URL
# ---------------------------------------------------------------------------
Write-Step "waiting for tunnel URL (up to $WaitForUrlSeconds s)..."
$url = $null
$urlPattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
for ($i = 0; $i -lt $WaitForUrlSeconds; $i++) {
    if (Test-Path $CloudflaredLog) {
        $logText = Get-Content $CloudflaredLog -Raw -ErrorAction SilentlyContinue
        if ($logText) {
            $m = [regex]::Match($logText, $urlPattern)
            if ($m.Success) {
                $url = $m.Value
                break
            }
        }
    }
    Start-Sleep -Seconds 1
}

if (-not $url) {
    Write-Error "Failed to extract tunnel URL from $CloudflaredLog after $WaitForUrlSeconds s. Inspect that log for cloudflared errors."
    exit 1
}

Write-Step "tunnel URL: $url"

# ---------------------------------------------------------------------------
# Step 4: sync config/config.json
# ---------------------------------------------------------------------------
$content = Get-Content $ConfigPath -Raw
$existingMatch = [regex]::Match($content, $urlPattern)
$current = if ($existingMatch.Success) { $existingMatch.Value } else { '' }

if ($current -eq $url) {
    Write-Step "config.json already has correct publicUrl -- no change"
} else {
    Write-Step "updating config.json publicUrl: $current -> $url"
    $newContent = [regex]::Replace($content, $urlPattern, $url)
    Set-Content -Path $ConfigPath -Value $newContent -NoNewline -Encoding utf8
}

# ---------------------------------------------------------------------------
# Step 5: reload ai-jarvis so it picks up the new publicUrl
# ---------------------------------------------------------------------------
Push-Location $ProjectRoot
try {
    Write-Step "reloading $BotName via pm2..."
    & npx pm2 reload $BotName | Out-Null
} finally {
    Pop-Location
}

Write-Host ''
Write-Host "[start-tunnel] DONE"
Write-Host "  Tunnel:    $url"
Write-Host "  Webapp:    $url/webapp/avengers/"
Write-Host "  Health:    http://127.0.0.1:7878/health"
Write-Host ''
