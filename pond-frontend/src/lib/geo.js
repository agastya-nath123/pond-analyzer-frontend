// Small geodesy helpers. Accurate enough for village-scale areas (a few km).

const DEG = Math.PI / 180;
const EARTH_R = 6371008.8;

// Equirectangular projection around (lat0, lon0), in metres.
export function makeLocalProjection(lat0, lon0) {
  const ky = EARTH_R * DEG;
  const kx = ky * Math.cos(lat0 * DEG);

  return {
    lat0,
    lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export function boundsOf(latlngs) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const [lat, lon] of latlngs) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  return { minLat, maxLat, minLon, maxLon };
}

export function centerOf(latlngs) {
  const b = boundsOf(latlngs);
  return [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2];
}

// Area in m² of a [lat, lon] ring, plus the area of its bounding box.
export function polygonStats(latlngs) {
  if (!latlngs || latlngs.length < 3) {
    return { areaM2: 0, bboxM2: 0 };
  }

  const [lat0, lon0] = centerOf(latlngs);
  const proj = makeLocalProjection(lat0, lon0);
  const xy = latlngs.map(([lat, lon]) => proj.toXY(lat, lon));

  let twice = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    twice += x1 * y2 - x2 * y1;
    if (x1 < minX) minX = x1;
    if (x1 > maxX) maxX = x1;
    if (y1 < minY) minY = y1;
    if (y1 > maxY) maxY = y1;
  }

  return {
    areaM2: Math.abs(twice) / 2,
    bboxM2: (maxX - minX) * (maxY - minY),
  };
}

// Ray casting on projected coordinates. ring: [[x, y], ...]
export function pointInRing(x, y, ring) {
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    if (
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

// Inverse transverse Mercator (WGS84) for UTM northern-hemisphere zones.
// Used to turn the backend's EPSG:326xx spill points back into lat/lon.
export function utmToLatLon(easting, northing, zone) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);

  const x = easting - 500000;
  const y = northing;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * DEG;

  const m = y / k0;
  const mu =
    m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));

  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const t1 = tan1 * tan1;
  const c1 = ep2 * cos1 * cos1;
  const r1 = (a * (1 - e2)) / Math.pow(1 - e2 * sin1 * sin1, 1.5);
  const d = x / (n1 * k0);

  const lat =
    phi1 -
    ((n1 * tan1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) *
          d ** 6) /
          720);

  const lon =
    lon0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) *
        d ** 5) /
        120) /
      cos1;

  return { lat: lat / DEG, lon: lon / DEG };
}
