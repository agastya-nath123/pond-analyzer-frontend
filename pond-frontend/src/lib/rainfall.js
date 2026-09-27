// Average annual rainfall from the Open-Meteo Historical Weather API
// (ERA5 reanalysis, free for non-commercial use, no key needed).

import { LIMITS } from "../config.js";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const cache = new Map();

export async function fetchAnnualRainfall(lat, lon, { signal, years = 5 } = {}) {
  const endYear = new Date().getFullYear() - 1;
  const startYear = endYear - years + 1;

  // Rainfall varies over tens of km, so nearby selections share a lookup.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${startYear}`;
  if (cache.has(key)) return cache.get(key);

  const url =
    `${ARCHIVE_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=${startYear}-01-01&end_date=${endYear}-12-31` +
    "&daily=precipitation_sum&timezone=auto";

  const promise = (async () => {
    const timeout = AbortSignal.timeout(LIMITS.externalTimeoutMs);
    const res = await fetch(url, { signal: signal ? anySignal([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`Rainfall service returned ${res.status}`);

    const { daily } = await res.json();
    const totals = new Map();
    const days = new Map();
    let wettestDayMm = 0;

    daily.time.forEach((date, i) => {
      const mm = daily.precipitation_sum[i];
      if (mm == null) return;
      const year = Number(date.slice(0, 4));
      totals.set(year, (totals.get(year) ?? 0) + mm);
      days.set(year, (days.get(year) ?? 0) + 1);
      if (mm > wettestDayMm) wettestDayMm = mm;
    });

    const complete = [...totals].filter(([year]) => days.get(year) >= 360);
    if (complete.length === 0) throw new Error("No complete years of rainfall data");

    const annualMm = complete.reduce((sum, [, mm]) => sum + mm, 0) / complete.length;

    return {
      annualMm: Math.round(annualMm),
      wettestDayMm: Math.round(wettestDayMm),
      years: complete.map(([year, mm]) => ({ year, mm: Math.round(mm) })),
      period: `${startYear}–${endYear}`,
      source: "Open-Meteo historical weather (ERA5)",
    };
  })();

  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

// AbortSignal.any() is recent; this covers older browsers.
export function anySignal(signals) {
  if (AbortSignal.any) return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
