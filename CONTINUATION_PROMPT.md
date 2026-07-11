# Continuation Prompt: EC Coverage Command Center

You are continuing work on a dark command-center web map in `C:\Users\Dollentas\Documents\maps`.

## Current app
- Static frontend: `index.html`, `app.js`, `styles.css`.
- Data: `data/coverage-map.json` and `data/weather-signals.json`.
- Run locally with a static server, for example `python -m http.server 4173 --bind 127.0.0.1`.
- Current URL version: `http://127.0.0.1:4173/?v=windy-leaflet-13`.
- Windy key is intentionally not committed. Copy `config.example.js` to `config.js` and add the local key.

## Existing behavior
- EC mode renders the 121 EC polygons only.
- Weather mode embeds the Windy forecast layer underneath the EC coverage.
- The app has a soft-black dark UI shared by EC and Weather modes.
- Clicking an EC focuses it, zooms/flys to it, elevates it with an animated shadow/tilt, keeps its signal/EC color, dims surrounding polygons, and opens a modern detail card.
- Weather selection now follows the same focus treatment: selected polygon keeps its TCWS signal color, surrounding coverage and labels fade gray, the selected SVG path receives a lift animation, Windy stays underneath, and the detail card updates automatically.
- Clicking the map background resets the selection and filters.
- Windy controls remain visible in Weather mode; the local duplicate map toolbar/coordinate strip is hidden there.

## Files to inspect first
- `app.js`: state, `weatherFeatureStyle`, `setWeatherSelectionClass`, `refreshWindyCoverage`, `selectWeatherFeature`, EC canvas rendering.
- `styles.css`: dark UI, detail card, `.weather-selected-path` animation, Windy labels.
- `index.html`: app structure and cache-busting query versions.

## Next-agent task
Visually test Weather mode in the browser and refine the selected-polygon elevation if needed. Confirm that:
1. Clicking a weather polygon or EC label zooms/flys to it.
2. The selected polygon preserves the correct TCWS signal fill color.
3. Non-selected polygons and labels become gray.
4. The selected polygon shows a visible lift/shadow/tilt animation.
5. The info card opens and shows EC name, status, province, and TCWS signal.
6. Clicking the map background resets the search, selection, card, and gray focus state.

Keep the UI restrained, dark, readable, and operational. Do not expose the Windy API key in commits.