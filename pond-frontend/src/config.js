// Limits and constants in one place so they are easy to tune.
// Values were chosen from measured backend timings: the provided sample
// (about 8.5 km², 160k contour vertices) takes ~7.5 s in /analyzeContour
// and ~3.5 s per /findCatchment call at the backend's 5 m DEM resolution.

export const LIMITS = {
  // The backend rasterises the bounding box of the contours at 5 m, so its
  // run time follows bounding-box area, not polygon area.
  maxBBoxKm2: 12,
  minAreaHa: 1,

  // Elevation grid sampled from terrain tiles before tracing contours.
  elevationSpacingM: 10,
  maxElevationNodes: 160_000,
  maxTiles: 36,

  // In-browser model used to draw the pond and catchment outlines.
  modelMinSpacingM: 5,
  modelMaxCells: 220_000,

  // Refuse to upload contour sets larger than this many vertices.
  maxContourVertices: 450_000,

  // Network timeouts (ms).
  analyzeTimeoutMs: 180_000,
  catchmentTimeoutMs: 120_000,
  externalTimeoutMs: 20_000,
};

// The backend projects everything into UTM zone 44N (EPSG:32644) and
// returns spill points in that system.
export const BACKEND_UTM_ZONE = 44;
export const BACKEND_UTM_LON_RANGE = [78, 84];

// Depressions smaller than this are hidden from the "other sites" list.
export const MIN_LISTED_POND_HA = 0.05;

// How the catchment figure used for water volume is chosen:
//   "traced" - area draining into the depression, traced in the browser on
//              the same contours (matches the outline drawn on the map)
//   "api"    - the catchment calculated by the backend. Use this with
//              backend v1.1 or later; earlier versions reported far too
//              small a figure.
export const CATCHMENT_SOURCE = "traced";

export const RUNOFF_PRESETS = [
  { id: "farmland", label: "Mostly farmland", coefficient: 0.3 },
  { id: "open", label: "Open scrub or fallow", coefficient: 0.4 },
  { id: "rocky", label: "Rocky or bare laterite", coefficient: 0.55 },
  { id: "forest", label: "Forest or dense trees", coefficient: 0.15 },
];

export const DEFAULT_RAINFALL_MM = 1200;
