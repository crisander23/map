# NEA DDCC Map

## Requirements

- Node.js 18 or newer
- Internet access for PHIVOLCS and HazardHunterPH live earthquake data

## Run Locally

Open PowerShell in this folder and run:

```powershell
node server.js
```

Then open:

```text
http://127.0.0.1:4173/
```

For a one-click Windows launch, double-click `run-neaddcc.cmd`. It starts the required server and opens the map automatically.

The server refreshes the official PAGASA Tropical Cyclone Wind Signal bulletin every 5 minutes. The browser checks the cached result on the same cadence, so TCWS colors and timestamps update without restarting the map. To refresh once manually, run `node tools/update-pagasa-tcws.js`.

## Portable Windows EXE

The client package includes `NEA-DDCC-Map-Client/NEA-DDCC-Map.exe`. Copy that EXE to a Windows PC and double-click it; Node.js is not required. It contains the map files and starts the local server on port `4173`.

To rebuild it from the client package folder:

```powershell
npx --yes @yao-pkg/pkg@latest . --targets node22-win-x64 --output NEA-DDCC-Map.exe --compress GZip
```

The server listens on all network interfaces by default. To open it from another device on the same network, run `ipconfig` on the Windows PC, find its IPv4 address, and open:

```text
http://YOUR_WINDOWS_IPV4:4173/
```

If Windows Firewall blocks the connection, run PowerShell as Administrator once:

```powershell
New-NetFirewallRule -DisplayName "NEA DDCC Map 4173" -Direction Inbound -Protocol TCP -LocalPort 4173 -Action Allow
```

On Ubuntu, run:

```bash
chmod +x run-neaddcc.sh
./run-neaddcc.sh
```

Use the `DRRMD` mode and enable `Show live earthquakes`.

## Important

Do not use `python -m http.server 4173`. The map needs `server.js` because it provides the local `/api/phivolcs-earthquakes` proxy required to load live PHIVOLCS earthquake reports.

## Update From GitHub

```powershell
git pull origin master
node server.js
```
