# VTC Web

Interactive web viewer for VSK5 wind + current grids. Mirrors the
rendering and tide-blending math from `VCT.ahk`.

## What it does

- Pick **one of 14 maps** (Auckland, Wight, Trapani, …) — land overlay loads
- Optionally toggle **one of 8 winds** (N/NE/E/SE/S/SW/W/NW) — wind arrows
- Optionally pick **one of 4 tide states** (Ebb/Low/Flood/High) — current arrows
- Or set **race time + high-tide time** and scrub through the 12-hour
  cycle with the ±5 min buttons or vertical slider. The current grid is
  blended between the two adjacent pure states using the same 16-point
  LERP curve the AHK app uses.

Porto Cervo has no tide data, so the four current buttons are disabled
when that map is selected.

## File layout

This folder is self-contained — the `VCT Grid` data folder is bundled
inside, so the app can be deployed anywhere (local server, GitHub Pages,
S3, etc.) without external dependencies.

```
VTC Web/
├── index.html
├── app.js
├── serve.ps1        ← built-in Windows PowerShell static server
├── serve.bat        ← double-click launcher for serve.ps1
├── README.md
└── VCT Grid/
    ├── Wight/
    │   ├── land.png
    │   ├── tide/ low.bin flood.bin high.bin ebb.bin
    │   └── wind/ north.bin north_east.bin … (8 files)
    └── … (13 more maps)
```

## Running locally (Windows)

**Easiest:** double-click `serve.bat`. A console window opens, the
default browser opens to <http://localhost:8000/> automatically. Close
the console window (or press Ctrl+C) to stop the server.

No Python or Node needed — `serve.ps1` uses
`System.Net.HttpListener`, built into Windows.

If port 8000 is in use, edit the `$port = 8000` line at the top of
`serve.ps1` and try a different port.

## Deploying to GitHub Pages

1. Push the entire `VTC Web/` folder to a GitHub repo (e.g. as the
   root, or under any path).
2. In **Settings → Pages**, set Source = `main` and the folder pointing
   at `VTC Web/` (or root if the repo IS the VTC Web folder).
3. Visit `https://<user>.github.io/<repo>/`.

> The bundled `VCT Grid/` folder is ~340 MB across ~170 binary files.
> That's well under GitHub's 1 GB soft repo limit, but the first load
> can be slow on a metered connection. The app only fetches the bin
> files it actually needs (land.png + one wind bin + the 1-2 tide bins
> being blended), so subsequent map/wind toggles are cached.

## URL parameters (for AHK integration later)

| Param   | Meaning                          | Example          |
|---------|----------------------------------|------------------|
| `map`   | Auto-select map by folder name   | `?map=Wight`     |
| `wind`  | Auto-enable wind direction       | `?wind=east`     |
| `tide`  | Pin a tide state                 | `?tide=high`     |
| `start` | Race time (HH:MM, 24h)           | `?start=14:00`   |
| `high`  | High-tide time (HH:MM, 24h)      | `?high=16:30`    |
| `t`     | Slider value, minutes 0..720     | `?t=120`         |
| `base`  | Override asset base path         | `?base=/assets`  |
| `code`  | Base64-encoded JSON of any above | (see below)      |

The `code` parameter is the placeholder for the "opaque token" the AHK
script will send. Decode rule:
`JSON.parse(atob(code.replaceAll('-','+').replaceAll('_','/')))`.

Example payload:

```json
{ "map": "Wight", "wind": "east", "tide": null, "start": "14:00", "high": "16:30", "t": 90 }
```

If a value is in `code`, it overrides the matching individual query
param.

## Math notes

- Bin format: `Float32Array` of `[mag, dir_rad, mag, dir_rad, …]` for a
  512×512 grid (2,097,152 bytes per file). Grid cell index `(gx, gy)`
  has `idx = (gy * 512 + gx) * 2`.
- Grid index 0 = world `xmin` (canvas RIGHT, since X is rendered
  flipped to match the AHK convention and land image alignment).
- Wind knots = `mag × 19.5`; current knots = `mag × 9.73`. Colors use
  the same 6-stop / 7-stop gradients as the AHK overlay.
- Tide phase 0 = LOW slack (NOT high water). The user enters HIGH
  tide time, and we internally subtract 6 hours to convert.
- 16-point LERP curve has discontinuities at phases 0.25, 0.5, 0.75
  (matches the original Vsk5 binary, extracted from `MeteoMgr+0xBC`).

## Troubleshooting

If a map is selected but the canvas is blank:

1. Press **F12** in the browser to open DevTools.
2. Look at the **Console** tab — successful loads log lines like
   `[VTC] land loaded: ./VCT Grid/Wight/land.png 1024x1024`.
3. The **Network** tab will show any 404 / failed fetches in red.
4. The on-canvas red status bar (bottom) also shows fetch errors for
   ~6 seconds.

Common causes:
- The folder structure was reorganised but `app.js`'s `ASSET_BASE` is
  out of sync (it defaults to `./VCT Grid`).
- The server isn't running, or you're accessing a stale browser tab —
  refresh with **Ctrl+F5** to bypass cache.

## Known limitations / TODO

- No pan / zoom — view is auto-fit to the map bounds.
- No hover tooltip showing wind/current at the cursor. Could be added
  by porting `sampleGrid` from `VCT.ahk`.
- No URL hash for sharable state; only query params.
