// Indian digit grouping (1,24,000) reads naturally for village records.
const LOCALE = "en-IN";

export function fmtNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "–";
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Rounds to 3 significant figures so estimates don't look over-precise.
export function fmtEstimate(value) {
  if (!Number.isFinite(value)) return "–";
  if (value === 0) return "0";
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(value))) - 2);
  return fmtNumber(Math.round(value / magnitude) * magnitude);
}

export function fmtHa(ha) {
  if (!Number.isFinite(ha)) return "–";
  if (ha > 0 && ha < 0.01) return "under 0.01";
  if (ha < 10) return fmtNumber(ha, 2);
  if (ha < 100) return fmtNumber(ha, 1);
  return fmtNumber(ha, 0);
}

// Three significant figures, keeping decimals for small values (56.7, 4.25).
function sig3(value) {
  const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value))));
  return value.toLocaleString(LOCALE, { maximumFractionDigits: digits });
}

export function litresPhrase(m3) {
  const litres = m3 * 1000;
  if (!Number.isFinite(litres) || litres <= 0) return "";
  if (litres >= 1e7) return `about ${sig3(litres / 1e7)} crore litres`;
  if (litres >= 1e5) return `about ${sig3(litres / 1e5)} lakh litres`;
  return `about ${fmtEstimate(litres)} litres`;
}

export function fmtLatLon([lat, lon], digits = 5) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

export function fmtSeconds(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
