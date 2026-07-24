<#
.SYNOPSIS
    Install/update the "LifeContext Consolidate" Windows Scheduled Task that runs
    `npm run consolidate` nightly (docs/06-consolidation.md).

.DESCRIPTION
    Registers a Windows Scheduled Task via `schtasks /Create /F` — force-overwrite makes
    this idempotent: re-running after moving the repo or changing the schedule updates the
    existing task definition in place instead of failing with "task already exists".

    The task runs as -RunAs (default SYSTEM) so it fires nightly whether or not an
    interactive session is logged in; consolidate.js's only network call is loopback to
    local Ollama, which SYSTEM's context can reach.

    This script only touches Task Scheduler on the machine it's run on — it does not run
    consolidate.js itself and must be run once, manually, as Administrator on the box that
    hosts the live server (docs/windows-service-winsw.md sec 6 documents the same
    one-time-setup posture for the restart-service self-hosted runner).

.PARAMETER TaskName
    Scheduled task name. Default "LifeContext Consolidate".

.PARAMETER RepoPath
    Repo root the task `cd`s into before `npm run consolidate`. Default: resolved from this
    script's own location ($PSScriptRoot\..), so the script is portable across checkouts.

.PARAMETER StartTime
    Daily trigger time, schtasks /ST format (HH:mm). Default 02:00.

.PARAMETER RunAs
    Account the task runs as, schtasks /RU format. Default SYSTEM.

.EXAMPLE
    powershell -File scripts\install-consolidate-task.ps1
    powershell -File scripts\install-consolidate-task.ps1 -StartTime 03:30 -RunAs SYSTEM
#>
param(
    [string] $TaskName  = 'LifeContext Consolidate',
    [string] $RepoPath  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string] $StartTime = '02:00',
    [string] $RunAs     = 'SYSTEM'
)

$ErrorActionPreference = 'Stop'

# Resolve npm up front so a missing PATH entry fails clearly instead of registering a task
# that would silently no-op every night.
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) { throw 'npm not found on PATH -- install Node.js (with npm) before installing this task.' }

$logDir = Join-Path $RepoPath 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'consolidate-task.log'

# Task Scheduler's own run history doesn't capture npm/node console output, so redirect it
# to a plain append-only log next to the repo (design tenet 4: log every step).
$action = "cmd /c cd /d `"$RepoPath`" && `"$($npmCmd.Source)`" run consolidate >> `"$logPath`" 2>&1"

Write-Host "Registering scheduled task '$TaskName': daily at $StartTime as $RunAs"
Write-Host "  action: $action"

schtasks /Create /F /TN $TaskName /SC DAILY /ST $StartTime /RU $RunAs /TR $action
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed with exit code $LASTEXITCODE" }

Write-Host "Installed. Output will append to: $logPath"
