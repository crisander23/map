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

Use the `DRRMD` mode and enable `Show live earthquakes`.

## Important

Do not use `python -m http.server 4173`. The map needs `server.js` because it provides the local `/api/phivolcs-earthquakes` proxy required to load live PHIVOLCS earthquake reports.

## Update From GitHub

```powershell
git pull origin master
node server.js
```