# Stops and removes the KarmanBusinessMetrics Windows Service.
# Run in an elevated PowerShell prompt.

$serviceName = "KarmanBusinessMetrics"
$nssm = "nssm"

& $nssm stop $serviceName
& $nssm remove $serviceName confirm
Write-Host "Service '$serviceName' removed."
