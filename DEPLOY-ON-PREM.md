# Running Karman Business Metrics on an on-prem Windows Server

This app talks directly to Manufacturo (internet-reachable Azure SQL), Jira Cloud (internet),
and Teamcenter (`10.10.4.174` — only reachable from inside Karman's network). Running it on
a Windows Server that's already on the same internal network as Teamcenter means **all four
metrics work with no VPN/ExpressRoute needed** — that's the whole reason to run it here
instead of (or in addition to) the Azure Container App.

## 1. Copy the app to the server

Copy the entire `business-metrics-dashboard` folder to the server, **excluding `node_modules`**
(it'll be rebuilt there). Easiest options:
- Zip the folder (minus `node_modules`) and copy over SMB/RDP clipboard/USB, or
- If the server has git access to wherever this project is version-controlled, clone it there.

Make sure `.env` comes along — it holds the DB/Jira credentials and is gitignored, so a plain
`git clone` won't include it; copy it separately if you go the git route.

## 2. Install Node.js

Install Node.js 20 LTS on the server from https://nodejs.org (or your usual internal software
deployment method). Verify:

```powershell
node -v
npm -v
```

## 3. Install dependencies

From inside the copied folder:

```powershell
cd C:\path\to\business-metrics-dashboard
npm install --omit=dev
```

## 4. Quick manual test (before installing as a service)

```powershell
node server.js
```

Then from the server itself (or another machine on the network), check:
- `http://localhost:4100/api/health` → `{"ok":true}`
- `http://localhost:4100/api/metrics/engineering/release-status` → should return real numbers,
  not a connection error (this is the one that proves Teamcenter is reachable from here)

Ctrl+C to stop once confirmed, then move to installing it as a proper service.

## 5. Install NSSM (Non-Sucking Service Manager)

NSSM turns a plain `node server.js` process into a real Windows Service (auto-start on boot,
auto-restart on crash). Download from https://nssm.cc/download, extract, and either:
- put `nssm.exe` somewhere on the system `PATH`, or
- edit `$nssm = "nssm"` at the top of `install-service.ps1` to the full path of `nssm.exe`.

## 6. Install the service

In an **elevated** (Run as Administrator) PowerShell, from inside the app folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\install-service.ps1
```

This registers a service named `KarmanBusinessMetrics`, set to auto-start, logging to
`logs\stdout.log` / `logs\stderr.log` in the app folder.

Check it's running:

```powershell
nssm status KarmanBusinessMetrics
# or
Get-Service KarmanBusinessMetrics
```

Then browse to `http://<server-name-or-ip>:4100` from any machine on the network.

## 7. Firewall

If you want other machines on the network to reach it (not just localhost on the server),
allow inbound TCP 4100 in Windows Defender Firewall on the server:

```powershell
New-NetFirewallRule -DisplayName "Karman Business Metrics" -Direction Inbound -Protocol TCP -LocalPort 4100 -Action Allow
```

## 8. Manufacturo firewall note

Manufacturo's Azure SQL replica only accepts connections from allowed IPs. If this server's
outbound internet IP differs from this desktop's (different site/office), the Ops tab will show
a connection error until that new IP is added to the Manufacturo firewall allowlist — same kind
of request as the one already granted for `karman-procurement-api`'s NAT IP. Jira and Teamcenter
don't have this restriction.

## Updating the app later

```powershell
nssm stop KarmanBusinessMetrics
# copy over updated files (keep .env)
npm install --omit=dev   # only if package.json changed
nssm start KarmanBusinessMetrics
```

## Uninstalling

```powershell
.\uninstall-service.ps1
```
