# Installs Karman Business Metrics as a Windows Service using NSSM.
# Run this in an elevated (Administrator) PowerShell prompt, from inside
# the business-metrics-dashboard folder on the target server.
#
# Prerequisites (see DEPLOY-ON-PREM.md for details):
#   1. Node.js 20+ installed (node -v to check)
#   2. This whole folder copied to the server (including .env, excluding node_modules)
#   3. `npm install` already run in this folder
#   4. NSSM downloaded and nssm.exe on PATH (or edit $nssm below to a full path)

$ErrorActionPreference = "Stop"

$serviceName = "KarmanBusinessMetrics"
$nssm = "nssm"  # change to full path if nssm.exe is not on PATH, e.g. "C:\nssm\nssm.exe"
$nodeExe = (Get-Command node).Source
$appDir = $PSScriptRoot
$serverJs = Join-Path $appDir "server.js"

Write-Host "Installing service '$serviceName'..."
& $nssm install $serviceName $nodeExe $serverJs
& $nssm set $serviceName AppDirectory $appDir
& $nssm set $serviceName AppStdout (Join-Path $appDir "logs\stdout.log")
& $nssm set $serviceName AppStderr (Join-Path $appDir "logs\stderr.log")
& $nssm set $serviceName AppRotateFiles 1
& $nssm set $serviceName Start SERVICE_AUTO_START

New-Item -ItemType Directory -Force -Path (Join-Path $appDir "logs") | Out-Null

Write-Host "Starting service..."
& $nssm start $serviceName

Write-Host ""
Write-Host "Done. Service '$serviceName' installed and started."
Write-Host "Check status with:  nssm status $serviceName"
Write-Host "View logs in:       $appDir\logs\"
Write-Host "App should be reachable at http://<this-server>:4100 (check .env for PORT)"
