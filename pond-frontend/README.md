# Pond Site Selection (frontend)

React + Leaflet frontend for the pond-planning backend (`POST /analyzeContour`, `POST /findCatchment`).

## Run

1. Backend, from the folder that contains `app/`:

   ```
   uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 4
   ```

   (Backends before v1.1 also need an `uploads/` folder and must run with
   one worker.)

2. Frontend:

   ```
   npm install
   npm run dev
   ```

   Open http://localhost:5173. Requests to `/api/*` are proxied to the backend
   (see `vite.config.js`), so no CORS change is needed on the server. To use a
   backend elsewhere, start Vite with `BACKEND_URL=http://host:port npm run dev`,
   or build with `VITE_API_URL` pointing at a server that allows CORS.

## Using it

- **Draw on map**: draw the land boundary. Elevation comes from AWS Terrain
  Tiles (Open-Meteo as a fallback), is traced into 1 m contours and sent to the
  backend as KML in the same format as the sample map.
- **Use a contour file**: upload a KML/KMZ contour map. Optionally draw a
  boundary to analyse only part of it.

The best depression (largest storage) is shown with its pond outline, catchment,
outlet and expected yearly water. Other depressions are measured when clicked.

Expected water = min(storage volume, catchment area × annual rainfall × runoff
coefficient). Rainfall is the 5-year average from Open-Meteo (ERA5) and can be
edited.

## Notes

- `src/config.js` holds all limits (max 12 km² bounding box, 450k contour
  vertices, timeouts) and `CATCHMENT_SOURCE`.
- With backend v1.1, `/findCatchment` returns the real catchment and outlet.
  The map outline is still traced in the browser from the same contours
  (`CATCHMENT_SOURCE = "traced"`), and the server's figure is shown beside
  it. The two can differ by 10–20% where flat ground could drain either
  way. Set `CATCHMENT_SOURCE` to `"api"` to use the server's figure for the
  water estimate.

Data: © OpenStreetMap contributors; Esri World Imagery; AWS Terrain Tiles
(Mapzen/SRTM); Open-Meteo (Copernicus DEM, ERA5), CC BY 4.0.
