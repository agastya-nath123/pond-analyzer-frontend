# Pond Site Selection (frontend)

A React + Leaflet web app for planning village ponds. Mark a piece of land
on the map, or upload a contour map, and it shows:

- where a pond fits: the natural depression that stores the most water;
- the catchment that drains into it;
- the water it can be expected to collect in a year.

All three are overlaid on a street or satellite map. The terrain analysis
runs on the Pond Planning API (the `backend` folder).

## Requirements

- Node.js 20.19 or later (or 22.12+), as required by Vite 8
- The backend running, by default on http://127.0.0.1:8000
- Internet access in the browser, for basemaps, terrain tiles and rainfall

## Run

Start the backend first (see its README):

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 4
```

Then, in this folder:

```bash
npm install
npm run dev
```

Open http://localhost:5173.

The development server forwards every request under `/api` to the backend,
so the backend needs no CORS settings. If the backend runs elsewhere, set
`BACKEND_URL` when starting Vite:

```bash
BACKEND_URL=http://192.168.1.20:8000 npm run dev          # macOS / Linux
$env:BACKEND_URL="http://192.168.1.20:8000"; npm run dev  # Windows PowerShell
```

## Build for deployment

```bash
npm run build      # writes the site to dist/
npm run preview    # serves dist/ locally, with the same /api forwarding
```

`dist/` is a static site. When hosting it, either:

- serve it and the backend from the same address, forwarding `/api/*` to
  the backend with the `/api` prefix removed (as `vite.config.js` does); or
- build with `VITE_API_URL=http://your-server:8000 npm run build` and add
  CORS middleware to the backend.

## Using the app

1. **Choose how to get terrain.**
   - *Draw on map:* click points around the land (for example a
     government plot) and click the first point or press Enter to finish.
     Backspace removes the last point and Escape cancels. Elevation is read
     from public terrain tiles.
   - *Use a contour file:* upload a KML or KMZ contour map. You can draw a
     boundary to analyse only part of it.
2. **Press *Find pond site*.** A progress list shows each step and how long it took.
3. **Read the results.**
   - the water the pond can collect each year, with a gauge comparing
     runoff to capacity;
   - the suggested pond: deepest point, area 1 m deep or more, depth,
     storage and outlet;
   - the catchment area;
   - annual rainfall, a five-year average you can edit, and land cover,
     which sets how much rain runs off.
4. **Compare other sites.** Click a depression in *Other depressions found*
   to show it instead. *Download contour KML* saves the contours that
   were analysed.

The expected water is:

```
expected = min(storage, catchment area × annual rainfall × runoff coefficient)
```

The runoff coefficients are 0.30 for farmland, 0.40 for open scrub or
fallow, 0.55 for rocky ground and 0.15 for forest.

## How it works

1. **Terrain (draw mode):** the browser downloads the AWS Terrain Tiles
   covering the boundary. If they can't be read, it uses the Open-Meteo
   Elevation API instead. It builds a 10 m elevation grid and traces
   contour lines at 1, 2 or 5 m intervals depending on the relief.
2. **Upload:** the contours are written as KML in the backend's format
   and sent to `POST /analyzeContour`. At the same time the browser fetches
   rainfall and builds its own terrain model for drawing outlines.
3. **Best site:** the pond with the most storage is chosen, and
   `POST /findCatchment` returns its outlet and catchment.
4. **Outlines:** starting from the outlet, the browser traces the pond and
   catchment outlines on its own model and draws them on the map.

Results are cached by the content of the KML, so reopening a site or
re-running the same land doesn't call the server again.

## Services used

| Service | Used for | Budget per selection |
| --- | --- | --- |
| Pond Planning API (backend) | ponds, outlet, catchment | 1 analysis + 1 call per site viewed |
| AWS Terrain Tiles | elevation in draw mode | up to 36 tiles, 6 at a time |
| Open-Meteo Elevation API | fallback elevation | 100 points per request, 3 at a time |
| Open-Meteo Historical Weather (ERA5) | rainfall, last 5 complete years | 1 request, reused within about 1 km |
| OpenStreetMap, Esri World Imagery | basemaps | normal map browsing |

## Configuration

All limits and presets are in `src/config.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `LIMITS.maxBBoxKm2` | 12 | largest bounding box of a selection, in km² |
| `LIMITS.minAreaHa` | 1 | smallest selection, in ha |
| `LIMITS.elevationSpacingM` / `maxElevationNodes` | 10 / 160,000 | elevation grid in draw mode |
| `LIMITS.maxTiles` | 36 | terrain tiles per selection |
| `LIMITS.modelMaxCells` | 220,000 | size of the browser's drawing model |
| `LIMITS.maxContourVertices` | 450,000 | largest contour set sent to the server |
| `LIMITS.analyzeTimeoutMs` / `catchmentTimeoutMs` | 180 s / 120 s | server timeouts |
| `CATCHMENT_SOURCE` | `"traced"` | which catchment feeds the water estimate (see below) |
| `RUNOFF_PRESETS` | 4 land covers | runoff coefficients |
| `DEFAULT_RAINFALL_MM` | 1200 | used if rainfall can't be fetched |

The map outline of the catchment is traced in the browser. With
`CATCHMENT_SOURCE = "traced"`, the water estimate uses that traced area,
so the number matches the outline, and the server's figure is shown beside
it. Set it to `"api"` to use the server's figure instead. The two are
computed on different grids and can differ by 10–20% where flat ground
could drain either way.

## Project layout

```
index.html, vite.config.js     page shell; dev server and /api forwarding
public/favicon.svg
src/
  main.jsx                     entry point
  App.jsx                      analysis pipeline, water balance, state
  App.css, index.css           styles
  api.js                       backend client (timeouts, caching)
  config.js                    limits and presets
  components/
    MapView.jsx                Leaflet map, drawing, overlays, legend
    SelectionControls.jsx      draw / upload controls and checks
    ResultsPanel.jsx           progress, results, other sites
  lib/
    elevation.js               terrain tiles and Open-Meteo elevation
    contours.js                contour tracing, KML/KMZ reading and writing
    terrain.js                 browser terrain model; pond and catchment outlines
    rainfall.js                Open-Meteo rainfall
    geo.js, format.js          projections, geometry, number formatting
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | development server on port 5173 |
| `npm run build` | production build in `dist/` |
| `npm run preview` | serve the build locally |
| `npm run lint` | check the code with oxlint |

## Compatibility

- **Backend:** works with backend 1.1. It also works with 1.0, but 1.0's
  catchment figures are far too small, and 1.0 needs an `uploads/` folder
  and a single worker.
- **Browsers:** current Chrome, Edge, Firefox and Safari. Uploading a KMZ
  needs a browser from 2023 or later. Automated tests were run in
  Chromium.

## Troubleshooting

- **"Can't reach the analysis server":** the backend isn't running, or it
  isn't where `BACKEND_URL` points.
- **"This boundary spans … km²":** the selection is larger than
  `LIMITS.maxBBoxKm2`. Draw a smaller boundary.
- **"The land is too flat to draw contours here":** select a larger area
  that includes some slope.
- **Rainfall shows 1200 mm:** the rainfall service couldn't be reached.
  Type in a local figure; for Durg the IMD normal is 1,142 mm.

## Data sources

© OpenStreetMap contributors; Esri World Imagery; AWS Terrain Tiles
(Mapzen); Open-Meteo (Copernicus DEM, ERA5 reanalysis), CC BY 4.0.
