// Client for the Pond Planning API (app/routes/contour.py).
//
// Both routes take multipart/form-data with the KML in a field named
// "contour_map"; /findCatchment also takes "pond_id". pond_id values are
// labels from that exact KML, so the same bytes must be sent to both.
//
// In development, Vite proxies /api to the FastAPI server (see
// vite.config.js), which avoids CORS without changing the backend.

import { LIMITS } from "./config.js";
import { anySignal } from "./lib/rainfall.js";

const API_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/+$/, "");

// Results are cached per KML content, so re-running the same area or
// re-opening a candidate never hits the server twice.
const cache = new Map();

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// FNV-1a; crypto.subtle is unavailable on plain-http LAN addresses.
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

async function post(path, form, { signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      body: form,
      signal: signal ? anySignal([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new ApiError(
        `The analysis server took longer than ${Math.round(timeoutMs / 1000)} s. Try a smaller area.`
      );
    }
    throw new ApiError(
      `Can't reach the analysis server at ${API_URL}. Check that uvicorn is running on port 8000.`
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new ApiError(detail || `Server error ${response.status}`, response.status);
  }

  return response.json();
}

function kmlForm(kml, hash) {
  const form = new FormData();
  // A content-based name keeps uploads from different users apart on
  // backends before v1.1, which saved files in uploads/ under this name.
  form.append(
    "contour_map",
    new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }),
    `area-${hash}.kml`
  );
  return form;
}

function cached(key, run) {
  if (cache.has(key)) return cache.get(key);
  const promise = run();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

// -> { ponds: [{ pond_id, pond_area_ha, max_depth_m, volume_m3 }] }
export function analyzeContour(kml, hash, { signal } = {}) {
  return cached(`analyze:${hash}`, () =>
    post("/analyzeContour", kmlForm(kml, hash), {
      signal,
      timeoutMs: LIMITS.analyzeTimeoutMs,
    })
  );
}

// -> { pond_id, spill: { easting, northing, elevation_m },
//      flow_accumulation_cells, catchment_area_m2, catchment_area_ha,
//      catchment_pond_ratio }
export function findCatchment(kml, hash, pondId, { signal } = {}) {
  return cached(`catchment:${hash}:${pondId}`, () => {
    const form = kmlForm(kml, hash);
    form.append("pond_id", String(pondId));
    return post("/findCatchment", form, {
      signal,
      timeoutMs: LIMITS.catchmentTimeoutMs,
    });
  });
}
