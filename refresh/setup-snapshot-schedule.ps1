# Registers a 15-minute scheduled task that pulls fresh Ops/Jira/Finance/
# Engineering metrics and uploads them to Azure Blob Storage, so the Azure
# Container App (which can't reach Teamcenter or the Manufacturo firewall IP
# directly) has current data to serve.
#
# Run this in an elevated PowerShell prompt ON THE SERVER
# (C:\Apps\business-metrics-dashboard after files are copied + npm install run).

$nodeExe = (Get-Command node).Source
$scriptPath = "C:\Apps\business-metrics-dashboard\refresh\snapshot-refresh.mjs"
$workDir = "C:\Apps\business-metrics-dashboard"

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$scriptPath`"" -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName "KarmanMetricsSnapshotRefresh" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force

Write-Host "Task registered. Running it once now to confirm it works..."
Start-ScheduledTask -TaskName "KarmanMetricsSnapshotRefresh"
Start-Sleep -Seconds 8
Get-ScheduledTaskInfo -TaskName "KarmanMetricsSnapshotRefresh" | Select-Object LastRunTime, LastTaskResult
