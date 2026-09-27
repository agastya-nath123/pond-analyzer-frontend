// In-browser terrain model used only to DRAW results on the map.
//
// The backend returns a pond's spill point and figures but no geometry, so
// the outlines are traced here from the same contour lines the backend
// received. The surface is built like the backend's create_dem():
// points sampled along contours, then linear interpolation over a Delaunay
// triangulation (what scipy.griddata(method="linear") does).

import Delaunator from "delaunator";
import { LIMITS } from "../config.js";
import { makeLocalProjection } from "./geo.js";
import { traceIsolines } from "./contours.js";

const NEIGHBOURS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

// Binary min-heap on (key, insertion order); equal keys come out FIFO, which
// spreads routing evenly across flat areas.
class MinHeap {
  constructor(capacity) {
    this.idx = new Int32Array(capacity);
    this.key = new Float64Array(capacity);
    this.seq = new Float64Array(capacity);
    this.size = 0;
    this.counter = 0;
  }

  less(a, b) {
    return this.key[a] < this.key[b] || (this.key[a] === this.key[b] && this.seq[a] < this.seq[b]);
  }

  swap(a, b) {
    const { idx, key, seq } = this;
    [idx[a], idx[b]] = [idx[b], idx[a]];
    [key[a], key[b]] = [key[b], key[a]];
    [seq[a], seq[b]] = [seq[b], seq[a]];
  }

  push(index, priority) {
    let i = this.size++;
    this.idx[i] = index;
    this.key[i] = priority;
    this.seq[i] = this.counter++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop() {
    const top = this.idx[0];
    const last = --this.size;
    if (last > 0) {
      this.idx[0] = this.idx[last];
      this.key[0] = this.key[last];
      this.seq[0] = this.seq[last];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < last && this.less(l, m)) m = l;
        if (r < last && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------

export function buildTerrainModel(contours) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const { coords } of contours) {
    for (const [lon, lat] of coords) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }

  const proj = makeLocalProjection((minLat + maxLat) / 2, (minLon + maxLon) / 2);
  const [xMin, yMin] = proj.toXY(minLat, minLon);
  const [xMax, yMax] = proj.toXY(maxLat, maxLon);

  const g = Math.max(
    LIMITS.modelMinSpacingM,
    Math.sqrt(((xMax - xMin) * (yMax - yMin)) / LIMITS.modelMaxCells)
  );

  // Sample points along each contour every g metres (backend: every 5 m).
  const xs = [];
  const ys = [];
  const zs = [];

  for (const { elevation, coords } of contours) {
    let [px, py] = proj.toXY(coords[0][1], coords[0][0]);
    let carry = 0; // distance along the line to the next sample
    xs.push(px); ys.push(py); zs.push(elevation);
    carry = g;

    for (let i = 1; i < coords.length; i++) {
      const [qx, qy] = proj.toXY(coords[i][1], coords[i][0]);
      const len = Math.hypot(qx - px, qy - py);
      let d = carry;
      while (d <= len) {
        const t = d / len;
        xs.push(px + t * (qx - px));
        ys.push(py + t * (qy - py));
        zs.push(elevation);
        d += g;
      }
      carry = d - len;
      px = qx; py = qy;
    }
  }

  const n = xs.length;
  const flat = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { flat[2 * i] = xs[i]; flat[2 * i + 1] = ys[i]; }

  const cols = Math.max(2, Math.ceil((xMax - xMin) / g));
  const rows = Math.max(2, Math.ceil((yMax - yMin) / g));
  const x0 = xMin;
  const y0 = yMax;
  const size = rows * cols;
  const dem = new Float32Array(size).fill(NaN);

  const { triangles } = new Delaunator(flat);

  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b], cx = xs[c], cy = ys[c];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue;

    const c0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / g));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx, cx) - x0) / g));
    const r0 = Math.max(0, Math.ceil((y0 - Math.max(ay, by, cy)) / g));
    const r1 = Math.min(rows - 1, Math.floor((y0 - Math.min(ay, by, cy)) / g));

    for (let r = r0; r <= r1; r++) {
      const y = y0 - r * g;
      for (let col = c0; col <= c1; col++) {
        const x = x0 + col * g;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        dem[r * cols + col] = l1 * zs[a] + l2 * zs[b] + l3 * zs[c];
      }
    }
  }

  return { rows, cols, g, x0, y0, proj, dem, ...routeFlow(dem, rows, cols) };
}

// Priority-flood depression filling (Barnes et al. 2014). Also records, for
// every cell, where its water goes: steepest descent where the filled surface
// slopes, otherwise the cell that flooded it (which leads to the outlet).
function routeFlow(dem, rows, cols) {
  const size = rows * cols;
  const filled = new Float32Array(size).fill(NaN);
  const parent = new Int32Array(size).fill(-1);
  const visited = new Uint8Array(size);
  const order = new Int32Array(size);
  const heap = new MinHeap(size);
  let popped = 0;

  const valid = (i) => dem[i] === dem[i];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!valid(i)) continue;

      let edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
      for (let k = 0; !edge && k < 8; k++) {
        if (!valid((r + NEIGHBOURS[k][0]) * cols + c + NEIGHBOURS[k][1])) edge = true;
      }
      if (!edge) continue;

      visited[i] = 1;
      filled[i] = dem[i];
      heap.push(i, dem[i]);
    }
  }

  while (heap.size > 0) {
    const i = heap.pop();
    order[popped++] = i;
    const r = (i / cols) | 0;
    const c = i - r * cols;

    for (const [dr, dc] of NEIGHBOURS) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (visited[j] || !valid(j)) continue;
      visited[j] = 1;
      filled[j] = Math.max(dem[j], filled[i]);
      parent[j] = i;
      heap.push(j, filled[j]);
    }
  }

  const flowTo = new Int32Array(size).fill(-1);
  for (let k = 0; k < popped; k++) {
    const i = order[k];
    const r = (i / cols) | 0;
    const c = i - r * cols;
    let best = -1;
    let bestSlope = 0;

    for (const [dr, dc] of NEIGHBOURS) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (!visited[j]) continue;
      const drop = filled[i] - filled[j];
      if (drop <= 1e-6) continue;
      const slope = drop / (dr && dc ? Math.SQRT2 : 1);
      if (slope > bestSlope) { bestSlope = slope; best = j; }
    }

    flowTo[i] = best >= 0 ? best : parent[i];
  }

  return { filled, flowTo, order: order.subarray(0, popped) };
}

// ---------------------------------------------------------------------------

function maskToRings(mask, model) {
  const { rows, cols, g, x0, y0, proj } = model;
  const pr = rows + 2;
  const pc = cols + 2;
  const padded = new Float32Array(pr * pc);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (mask[r * cols + c]) padded[(r + 1) * pc + c + 1] = 1;
    }
  }

  return traceIsolines(padded, pr, pc, 0.5).map((line) => {
    const ring = [];
    for (let i = 0; i < line.length; i += 2) {
      ring.push(proj.toLatLon(x0 + (line[i] - 1) * g, y0 - (line[i + 1] - 1) * g));
    }
    return ring;
  });
}

// Finds the depression next to the backend's spill point and traces:
//   pond      - cells at least 1 m below the spill level (the backend's mask)
//   catchment - every cell whose water ends up in that depression
export function delineatePond(model, spillLat, spillLon, targetAreaM2) {
  const { rows, cols, g, x0, y0, proj, dem, filled, flowTo, order } = model;
  const [sx, sy] = proj.toXY(spillLat, spillLon);
  const sc = Math.round((sx - x0) / g);
  const sr = Math.round((y0 - sy) / g);

  const depth = (i) => filled[i] - dem[i];
  const isDeep = (i) => depth(i) >= 1.0;

  const isWet = (i) => depth(i) > 1e-6;

  // The spill point lies on the pond's water surface, where it overflows
  // (servers before v1.1 put it on the edge of the 1 m deep part instead).
  const radius = Math.max(3, Math.ceil(40 / g));
  const nearest = (test) => {
    let best = -1;
    let bestDist = Infinity;
    for (let r = sr - radius; r <= sr + radius; r++) {
      if (r < 0 || r >= rows) continue;
      for (let c = sc - radius; c <= sc + radius; c++) {
        if (c < 0 || c >= cols) continue;
        const i = r * cols + c;
        if (!test(i)) continue;
        const d = (r - sr) ** 2 + (c - sc) ** 2;
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    return best;
  };

  const size = rows * cols;
  const pond = new Uint8Array(size);
  const extent = new Uint8Array(size);
  const queue = new Int32Array(size);

  // Whole water surface of the depression: flooded cells connected to the
  // seed. Two depressions at different levels can't touch, so this stops
  // at the pond's own shoreline.
  const floodFrom = (seed) => {
    extent.fill(0);
    let head = 0;
    let tail = 0;
    extent[seed] = 1;
    queue[tail++] = seed;
    while (head < tail) {
      const i = queue[head++];
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (const [dr, dc] of NEIGHBOURS) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const j = rr * cols + cc;
        if (!extent[j] && isWet(j)) { extent[j] = 1; queue[tail++] = j; }
      }
    }
    return queue.subarray(0, tail);
  };

  let seed = nearest(isWet);
  if (seed < 0) return null;
  let surface = floodFrom(seed);
  let deepCells = Array.from(surface).filter(isDeep);
  if (deepCells.length === 0) {
    seed = nearest(isDeep);
    if (seed < 0) return null;
    surface = floodFrom(seed);
    deepCells = Array.from(surface).filter(isDeep);
  }

  // Pond: the parts of that surface 1 m deep or more, as the server counts
  // them. This grid differs slightly from the server's, so if it finds more
  // deep ground, the deepest cells are kept up to the server's area.
  const maxCells = targetAreaM2 ? Math.ceil((targetAreaM2 * 1.05) / (g * g)) : Infinity;
  deepCells.sort((a, b) => depth(b) - depth(a));
  const pondCells = Math.min(deepCells.length, maxCells);
  for (let k = 0; k < pondCells; k++) pond[deepCells[k]] = 1;
  const deepest = deepCells[0];

  // Downstream cells come first in `order`, so one pass decides drainage.
  const drains = new Uint8Array(size);
  let catchmentCells = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const to = flowTo[i];
    if (extent[i] || (to >= 0 && drains[to])) {
      drains[i] = 1;
      catchmentCells++;
    }
  }

  const dr = (deepest / cols) | 0;
  const dc = deepest - dr * cols;

  return {
    center: proj.toLatLon(x0 + dc * g, y0 - dr * g),
    centerDepthM: depth(deepest),
    pondAreaM2: pondCells * g * g,
    catchmentAreaM2: catchmentCells * g * g,
    pondRings: maskToRings(pond, model),
    catchmentRings: maskToRings(drains, model),
    cellSizeM: g,
  };
}
