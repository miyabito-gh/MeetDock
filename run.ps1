#requires -Version 5.1
<#
.SYNOPSIS
Start MeetDock development mode or build a local verification executable.
.EXAMPLE
.\run.ps1 dev
.EXAMPLE
.\run.ps1 build
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('dev', 'build')]
    [string]$Mode = 'dev'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$runExitCode = 1
Push-Location -LiteralPath $PSScriptRoot
try {
    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $null = Get-Command cargo.exe -ErrorAction Stop
    $nodeVersion = & $nodeCommand --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Node.js 22 or newer is required.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/.bin/tauri.cmd'))) {
        throw 'Node dependencies are missing. Run npm ci in the repository first.'
    }

    if ($Mode -eq 'dev') {
        Write-Host 'Starting MeetDock (Tauri + Vite). Press Ctrl+C to stop.'
        & $npmCommand run tauri -- dev
    } else {
        Write-Host 'Building MeetDock for local verification (no installer or bundle).'
        & $npmCommand run tauri -- build --no-bundle
    }
    $runExitCode = $LASTEXITCODE
    if ($runExitCode -eq 0 -and $Mode -eq 'build') {
        Write-Host 'Build complete. Default output: src-tauri/target/release/meetdock.exe'
        Write-Host 'If CARGO_TARGET_DIR is set, use that target directory instead.'
    }
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    $runExitCode = 1
} finally {
    Pop-Location
}
exit $runExitCode
