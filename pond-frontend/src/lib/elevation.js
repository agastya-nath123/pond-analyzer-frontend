// Builds an elevation grid over a drawn polygon from public terrain data.
//
// Primary source: AWS Terrain Tiles (Terrarium PNG, open data, CORS enabled).
//   elevation = (R * 256 + G + B / 256) - 32768
// Fallback:       Open-Meteo Elevation API (Copernicus GLO-90, 100 points
//                 per request), used when tiles can't be read.

import { LIMITS } from "../config.js";
import { boundsOf, makeLocalProjection, pointInRing } from "./geo.js";

const TERRARIUM_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation";
const TILE = 256;

// Decoded tiles are shared across analyses (key "z/x/y").
const tileCache = new Map();

// ---------------------------------------------------------------------------
// Grid layout
// ---------------------------------------------------------------------------

function layoutGrid(polygon, spacing, maxNodes) {
  const b = boundsOf(polygon);
  const proj = makeLocalProjection((b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
  const ring = polygon.map(([lat, lon]) => proj.toXY(lat, lon));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const s = Math.max(spacing, Math.sqrt((width * height) / maxNodes));

  // Two cells of margin so contours reach the polygon edge.
  const x0 = minX - 2 * s;
  const y0 = maxY + 2 * s;
  const cols = Math.ceil((width + 4 * s) / s) + 1;
  const rows = Math.ceil((height + 4 * s) / s) + 1;

  // Nodes inside the polygon, dilated by one node.
  const inside = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const y = y0 - r * s;
    for (let c = 0; c < cols; c++) {
      if (pointInRing(x0 + c * s, y, ring)) inside[r * cols + c] = 1;
    }
  }

  const mask = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside[r * cols + c]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) mask[rr * cols + cc] = 1;
        }
      }
    }
  }

  return { rows, cols, spacing: s, x0, y0, proj, mask };
}

function nodeLatLon(grid, r, c) {
  return grid.proj.toLatLon(grid.x0 + c * grid.spacing, grid.y0 - r * grid.spacing);
}

// ---------------------------------------------------------------------------
// Terrarium tiles
// ---------------------------------------------------------------------------

const lonToPx = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToPx = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * TILE * 2 ** z;
};

async function decodePng(blob) {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(TILE, TILE)
      : Object.assign(document.createElement("canvas"), { width: TILE, height: TILE });

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const { data } = ctx.getImageData(0, 0, TILE, TILE);
  const out = new Float32Array(TILE * TILE);

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }
  return out;
}

function loadTile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const url = TERRARIUM_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const promise = fetch(url, { signal, mode: "cors" })
    .then((res) => {
      if (!res.ok) throw new Error(`Terrain tile ${key} returned ${res.status}`);
      return res.blob();
    })
    .then(decodePng);

  tileCache.set(key, promise);
  promise.catch(() => tileCache.delete(key));
  return promise;
}

async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function sampleTerrarium(grid, polygon, signal, onStatus) {
  const b = boundsOf(polygon);

  // Highest zoom (15, ~4.5 m pixels here) whose tile count stays in budget.
  const tileCount = (zoom) => {
    const x0 = Math.floor(lonToPx(b.minLon, zoom) / TILE);
    const x1 = Math.floor(lonToPx(b.maxLon, zoom) / TILE);
    const y0 = Math.floor(latToPx(b.maxLat, zoom) / TILE);
    const y1 = Math.floor(latToPx(b.minLat, zoom) / TILE);
    return (x1 - x0 + 2) * (y1 - y0 + 2);
  };
  let zoom = 15;
  while (zoom > 11 && tileCount(zoom) > LIMITS.maxTiles) zoom--;

  // Only request tiles that some masked node actually needs.
  const needed = new Set();
  const { rows, cols, mask } = grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      const [lat, lon] = nodeLatLon(grid, r, c);
      const px = lonToPx(lon, zoom) - 0.5;
      const py = latToPx(lat, zoom) - 0.5;
      for (const tx of [Math.floor(px / TILE), Math.floor((px + 1) / TILE)]) {
        for (const ty of [Math.floor(py / TILE), Math.floor((py + 1) / TILE)]) {
          needed.add(`${tx}/${ty}`);
        }
      }
    }
  }

  const keys = [...needed];
  let done = 0;
  onStatus?.(`Downloading ${keys.length} terrain tile${keys.length === 1 ? "" : "s"}`);

  const decoded = await runLimited(
    keys.map((key) => async () => {
      const [tx, ty] = key.split("/").map(Number);
      const data = await loadTile(zoom, tx, ty, signal);
      done++;
      onStatus?.(`Downloaded ${done} of ${keys.length} terrain tiles`);
      return data;
    }),
    6
  );

  const tileData = new Map(keys.map((key, i) => [key, decoded[i]]));
  const pixel = (ix, iy) => {
    const tx = Math.floor(ix / TILE);
    const ty = Math.floor(iy / TILE);
    const tile = tileData.get(`${tx}/${ty}`);
    return tile ? tile[(iy - ty * TILE) * TILE + (ix - tx * TILE)] : NaN;
  };

  const z = new Float32Array(rows * cols).fill(NaN);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!mask[i]) continue;

      const [lat, lon] = nodeLatLon(grid, r, c);
      const px = lonToPx(lon, zoom) - 0.5;
      const py = latToPx(lat, zoom) - 0.5;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const fx = px - ix;
      const fy = py - iy;

      const v =
        pixel(ix, iy) * (1 - fx) * (1 - fy) +
        pixel(ix + 1, iy) * fx * (1 - fy) +
        pixel(ix, iy + 1) * (1 - fx) * fy +
        pixel(ix + 1, iy + 1) * fx * fy;

      // Reject no-data and values altered by canvas privacy protection.
      if (!(v > -500 && v < 9000)) {
        throw new Error("Terrain tiles returned implausible elevations.");
      }
      z[i] = v;
    }
  }

  return { z, source: `AWS Terrain Tiles (zoom ${zoom})` };
}

// ---------------------------------------------------------------------------
// Open-Meteo fallback
// ---------------------------------------------------------------------------

async function sampleOpenMeteo(grid, signal, onStatus) {
  const { rows, cols, mask } = grid;
  const indices = [];
  for (let i = 0; i < rows * cols; i++) if (mask[i]) indices.push(i);

  const batches = [];
  for (let i = 0; i < indices.length; i += 100) batches.push(indices.slice(i, i + 100));

  const z = new Float32Array(rows * cols).fill(NaN);
  let done = 0;

  await runLimited(
    batches.map((batch) => async () => {
      const lats = [];
      const lons = [];
      for (const i of batch) {
        const [lat, lon] = nodeLatLon(grid, Math.floor(i / cols), i % cols);
        lats.push(lat.toFixed(6));
        lons.push(lon.toFixed(6));
      }

      const url = `${OPEN_METEO_URL}?latitude=${lats.join(",")}&longitude=${lons.join(",")}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Open-Meteo elevation returned ${res.status}`);
      const { elevation } = await res.json();
      batch.forEach((i, k) => { z[i] = elevation[k]; });

      done++;
      onStatus?.(`Fetched elevation batch ${done} of ${batches.length}`);
    }),
    3
  );

  return { z, source: "Open-Meteo Elevation API (Copernicus GLO-90)" };
}

// ---------------------------------------------------------------------------

export async function fetchElevationGrid(polygon, { signal, onStatus } = {}) {
  const grid = layoutGrid(polygon, LIMITS.elevationSpacingM, LIMITS.maxElevationNodes);

  try {
    const { z, source } = await sampleTerrarium(grid, polygon, signal, onStatus);
    return { ...grid, z, source };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn("Terrain tiles unavailable, falling back to Open-Meteo:", error);
  }

  // GLO-90 is a 90 m product; ~45 m spacing is plenty and keeps requests low.
  onStatus?.("Terrain tiles unavailable, using Open-Meteo instead");
  const coarse = layoutGrid(polygon, 45, 1500);
  const { z, source } = await sampleOpenMeteo(coarse, signal, onStatus);
  return { ...coarse, z, source };
}
