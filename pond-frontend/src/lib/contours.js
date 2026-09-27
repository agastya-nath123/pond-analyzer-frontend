// Contour tracing (marching squares) and KML reading/writing.
//
// The backend's parse_kml() expects:
//   <Placemark><name>ELEVATION</name>
//     <LineString><coordinates>lon,lat lon,lat ...</coordinates></LineString>
//   </Placemark>
// Everything here produces or normalises into exactly that shape.

import { makeLocalProjection, pointInRing, boundsOf } from "./geo.js";

// ---------------------------------------------------------------------------
// Marching squares
// ---------------------------------------------------------------------------

// Trace iso-lines of a row-major grid (row 0 = north) at `level`.
// NaN nodes are treated as "no data": cells touching them are skipped.
// Returns polylines as flat arrays [col0, row0, col1, row1, ...] in
// fractional grid coordinates. Lines are stitched across cells, so each
// polyline is either open (ends at the data edge) or a closed ring.
export function traceIsolines(z, rows, cols, level) {
  const hBase = 0;
  const vBase = rows * cols;
  const segA = [];
  const segB = [];

  for (let r = 0; r < rows - 1; r++) {
    const top = r * cols;
    const bottom = top + cols;

    for (let c = 0; c < cols - 1; c++) {
      const tl = z[top + c];
      const tr = z[top + c + 1];
      const br = z[bottom + c + 1];
      const bl = z[bottom + c];

      // NaN check (NaN !== NaN)
      if (tl !== tl || tr !== tr || br !== br || bl !== bl) continue;

      const code =
        (tl >= level ? 8 : 0) |
        (tr >= level ? 4 : 0) |
        (br >= level ? 2 : 0) |
        (bl >= level ? 1 : 0);

      if (code === 0 || code === 15) continue;

      const eTop = hBase + top + c;
      const eBottom = hBase + bottom + c;
      const eLeft = vBase + top + c;
      const eRight = vBase + top + c + 1;

      switch (code) {
        case 1: case 14: segA.push(eLeft); segB.push(eBottom); break;
        case 2: case 13: segA.push(eBottom); segB.push(eRight); break;
        case 3: case 12: segA.push(eLeft); segB.push(eRight); break;
        case 4: case 11: segA.push(eTop); segB.push(eRight); break;
        case 6: case 9: segA.push(eTop); segB.push(eBottom); break;
        case 7: case 8: segA.push(eLeft); segB.push(eTop); break;
        case 5:
        case 10: {
          // Saddle: resolve with the cell-centre value.
          const centreAbove = (tl + tr + br + bl) / 4 >= level;
          const cutTopLeft = (code === 5) === centreAbove;

          if (cutTopLeft) {
            segA.push(eLeft, eBottom); segB.push(eTop, eRight);
          } else {
            segA.push(eLeft, eTop); segB.push(eBottom, eRight);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const count = segA.length;
  if (count === 0) return [];

  // Each edge crossing is shared by at most two segments.
  const adjacency = new Map();
  for (let s = 0; s < count; s++) {
    for (const key of [segA[s], segB[s]]) {
      const list = adjacency.get(key);
      if (list) list.push(s);
      else adjacency.set(key, [s]);
    }
  }

  const used = new Uint8Array(count);

  const edgePoint = (key, out) => {
    let r0, c0, r1, c1;
    if (key < vBase) {
      r0 = Math.floor(key / cols); c0 = key % cols; r1 = r0; c1 = c0 + 1;
    } else {
      const k = key - vBase;
      r0 = Math.floor(k / cols); c0 = k % cols; r1 = r0 + 1; c1 = c0;
    }
    const z0 = z[r0 * cols + c0];
    const z1 = z[r1 * cols + c1];
    const t = (level - z0) / (z1 - z0);
    const col = c0 + t * (c1 - c0);
    const row = r0 + t * (r1 - r0);
    const n = out.length;
    if (n >= 2 && out[n - 2] === col && out[n - 1] === row) return;
    out.push(col, row);
  };

  const walk = (startKey, startSeg) => {
    const line = [];
    edgePoint(startKey, line);
    let key = startKey;
    let seg = startSeg;

    while (seg !== -1) {
      used[seg] = 1;
      key = segA[seg] === key ? segB[seg] : segA[seg];
      edgePoint(key, line);

      seg = -1;
      for (const next of adjacency.get(key)) {
        if (!used[next]) { seg = next; break; }
      }
    }
    return line;
  };

  const lines = [];

  for (const [key, list] of adjacency) {
    if (list.length === 1 && !used[list[0]]) lines.push(walk(key, list[0]));
  }
  for (let s = 0; s < count; s++) {
    if (!used[s]) lines.push(walk(segA[s], s));
  }

  return lines.filter((line) => line.length >= 4);
}

export function pickContourInterval(minZ, maxZ) {
  const relief = maxZ - minZ;
  if (relief > 250) return 5;
  if (relief > 100) return 2;
  return 1;
}

// grid: { rows, cols, spacing, x0, y0, proj, z }
// Returns [{ elevation, coords: [[lon, lat], ...] }]
export function contoursFromGrid(grid, interval) {
  const { rows, cols, spacing, x0, y0, proj, z } = grid;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const v of z) {
    if (v !== v) continue;
    if (v < minZ) minZ = v;
    if (v > maxZ) maxZ = v;
  }
  if (!Number.isFinite(minZ)) return { contours: [], interval: 1, minZ, maxZ };

  const step = interval ?? pickContourInterval(minZ, maxZ);
  const contours = [];

  for (
    let level = Math.ceil(minZ / step) * step;
    level <= maxZ;
    level += step
  ) {
    for (const line of traceIsolines(z, rows, cols, level)) {
      const coords = [];
      for (let i = 0; i < line.length; i += 2) {
        const [lat, lon] = proj.toLatLon(
          x0 + line[i] * spacing,
          y0 - line[i + 1] * spacing
        );
        coords.push([lon, lat]);
      }
      contours.push({ elevation: level, coords });
    }
  }

  return { contours, interval: step, minZ, maxZ };
}

export function countVertices(contours) {
  let n = 0;
  for (const c of contours) n += c.coords.length;
  return n;
}

// ---------------------------------------------------------------------------
// KML writing (backend format)
// ---------------------------------------------------------------------------

const escapeXml = (s) =>
  String(s).replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function contoursToKml(contours, documentName = "Selected area") {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n',
    `<name>${escapeXml(documentName)}</name>\n`,
  ];

  for (const { elevation, coords } of contours) {
    if (coords.length < 2) continue;

    let text = "";
    for (const [lon, lat] of coords) {
      text += `${lon.toFixed(7)},${lat.toFixed(7)} `;
    }

    parts.push(
      `<Placemark><name>${Number(elevation).toFixed(1)}</name>` +
        `<LineString><coordinates>${text.trim()}</coordinates></LineString>` +
        "</Placemark>\n"
    );
  }

  parts.push("</Document>\n</kml>\n");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// KML / KMZ reading (normalises other contour KML flavours)
// ---------------------------------------------------------------------------

const PLACEMARK_RE = /<(?:\w+:)?Placemark\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Placemark>/g;
const NAME_RE = /<(?:\w+:)?name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?name>/;
const LINESTRING_RE =
  /<(?:\w+:)?LineString\b[^>]*>[\s\S]*?<(?:\w+:)?coordinates\b[^>]*>([\s\S]*?)<\/(?:\w+:)?coordinates>[\s\S]*?<\/(?:\w+:)?LineString>/g;
const DATA_RE =
  /<(?:\w+:)?(?:SimpleData|Data)\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:SimpleData|Data)>/g;
const ELEV_FIELD_RE = /^(elev|elevation|height|contour|level|alt|altitude|z)$/i;

function readNumber(text) {
  if (text == null) return NaN;
  const cleaned = text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<(?:\w+:)?value>|<\/(?:\w+:)?value>/g, "")
    .trim();
  const match = cleaned.match(/^-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

// Reads contour lines from KML text. Elevation is taken from <name>
// (what the backend uses), then from an elevation-like ExtendedData field,
// then from the LineString's coordinate altitude. Only LineStrings are read
// (like the backend), so boundary polygons and label points are ignored.
// Every LineString becomes its own contour, so MultiGeometry placemarks are
// not truncated to their first line as they are in parse_kml().
export function parseContourKml(text) {
  const contours = [];
  let skipped = 0;

  for (const [, body] of text.matchAll(PLACEMARK_RE)) {
    let elevation = readNumber(body.match(NAME_RE)?.[1]);

    if (!Number.isFinite(elevation)) {
      for (const [, field, value] of body.matchAll(DATA_RE)) {
        if (ELEV_FIELD_RE.test(field)) {
          elevation = readNumber(value);
          if (Number.isFinite(elevation)) break;
        }
      }
    }

    for (const [, raw] of body.matchAll(LINESTRING_RE)) {
      const coords = [];
      let altitude = NaN;

      for (const token of raw.trim().split(/\s+/)) {
        const parts = token.split(",");
        if (parts.length < 2) continue;
        const lon = Number(parts[0]);
        const lat = Number(parts[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (parts.length > 2 && !Number.isFinite(altitude)) {
          altitude = Number(parts[2]);
        }
        coords.push([lon, lat]);
      }

      const z = Number.isFinite(elevation)
        ? elevation
        : altitude !== 0 ? altitude : NaN;

      if (coords.length >= 2 && Number.isFinite(z)) {
        contours.push({ elevation: z, coords });
      } else {
        skipped++;
      }
    }
  }

  return { contours, skipped };
}

// Minimal ZIP reader for KMZ (uses the browser's DecompressionStream).
async function unzipFirstKml(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Find the end-of-central-directory record.
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This KMZ file is not a valid ZIP archive.");

  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let n = 0; n < entries; n++) {
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (!name.toLowerCase().endsWith(".kml")) continue;

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + compressedSize);

    if (method === 0) return decoder.decode(data);
    if (method !== 8) throw new Error("This KMZ uses an unsupported compression method.");
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser can't open KMZ files. Unzip it and upload the .kml inside.");
    }

    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }

  throw new Error("No .kml file was found inside this KMZ.");
}

export async function readContourFile(file) {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;

  const text = isZip
    ? await unzipFirstKml(buffer)
    : new TextDecoder().decode(buffer);

  const { contours, skipped } = parseContourKml(text);

  if (contours.length === 0) {
    throw new Error(
      "No contour lines with elevations were found. Each line needs its elevation in <name>, for example <name>280.0</name>."
    );
  }

  return { contours, skipped };
}

// ---------------------------------------------------------------------------
// Clipping and display helpers
// ---------------------------------------------------------------------------

// Keeps the runs of each contour that fall inside the polygon.
// polygon: [[lat, lon], ...]
export function clipContours(contours, polygon) {
  const b = boundsOf(polygon);
  const proj = makeLocalProjection((b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
  const ring = polygon.map(([lat, lon]) => proj.toXY(lat, lon));

  const out = [];

  for (const { elevation, coords } of contours) {
    let run = [];

    for (const point of coords) {
      const [lon, lat] = point;
      const outsideBox =
        lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon;
      const inside = !outsideBox && pointInRing(...proj.toXY(lat, lon), ring);

      if (inside) {
        run.push(point);
      } else {
        if (run.length >= 2) out.push({ elevation, coords: run });
        run = [];
      }
    }

    if (run.length >= 2) out.push({ elevation, coords: run });
  }

  return out;
}

// Thins vertices for drawing only (the backend always gets full detail).
// Returns { minor: [[[lat, lon]...]...], major: [...] } for Leaflet.
export function contoursForDisplay(contours, minSpacingM = 8, majorEvery = 5) {
  const minor = [];
  const major = [];
  if (contours.length === 0) return { minor, major };

  const lat0 = contours[0].coords[0][1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const min2 = minSpacingM * minSpacingM;

  for (const { elevation, coords } of contours) {
    const line = [[coords[0][1], coords[0][0]]];
    let [plon, plat] = coords[0];

    for (let i = 1; i < coords.length; i++) {
      const [lon, lat] = coords[i];
      const dx = (lon - plon) * kx;
      const dy = (lat - plat) * ky;
      if (dx * dx + dy * dy >= min2 || i === coords.length - 1) {
        line.push([lat, lon]);
        plon = lon;
        plat = lat;
      }
    }

    const isMajor = Math.abs(elevation / majorEvery - Math.round(elevation / majorEvery)) < 1e-6;
    (isMajor ? major : minor).push(line);
  }

  return { minor, major };
}

export function contoursBounds(contours) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const { coords } of contours) {
    for (const [lon, lat] of coords) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}
