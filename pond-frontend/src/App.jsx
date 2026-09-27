import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import MapView from "./components/MapView";
import SelectionControls from "./components/SelectionControls";
import ResultsPanel from "./components/ResultsPanel";
import { analyzeContour, findCatchment, hashText } from "./api";
import {
  BACKEND_UTM_LON_RANGE,
  BACKEND_UTM_ZONE,
  CATCHMENT_SOURCE,
  DEFAULT_RAINFALL_MM,
  LIMITS,
  MIN_LISTED_POND_HA,
  RUNOFF_PRESETS,
} from "./config";
import {
  clipContours,
  contoursBounds,
  contoursForDisplay,
  contoursFromGrid,
  contoursToKml,
  countVertices,
  readContourFile,
} from "./lib/contours";
import { fetchElevationGrid } from "./lib/elevation";
import { boundsOf, centerOf, polygonStats, utmToLatLon } from "./lib/geo";
import { fetchAnnualRainfall } from "./lib/rainfall";
import { buildTerrainModel, delineatePond } from "./lib/terrain";
import { fmtEstimate, fmtHa, fmtNumber } from "./lib/format";

import "./App.css";

// Lets React paint the progress list before a CPU-heavy step.
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

function describeSelection(mode, polygon, draft, file) {
  const ring = polygon ?? (draft.length >= 3 ? draft : null);
  const problems = [];
  const warnings = [];
  let areaHa = 0;
  let bboxKm2 = 0;
  let lonRange = null;

  if (ring) {
    const stats = polygonStats(ring);
    areaHa = stats.areaM2 / 1e4;
    bboxKm2 = stats.bboxM2 / 1e6;
    const b = boundsOf(ring);
    lonRange = [b.minLon, b.maxLon];
  } else if (mode === "file" && file) {
    bboxKm2 = file.bboxKm2;
    lonRange = file.lonRange;
  }

  if (ring && areaHa < LIMITS.minAreaHa) {
    problems.push(`Select at least ${LIMITS.minAreaHa} ha so there is room for a pond and its catchment.`);
  }
  if (bboxKm2 > LIMITS.maxBBoxKm2) {
    problems.push(
      ring
        ? `This boundary spans ${fmtNumber(bboxKm2, 1)} km². Keep it within ${LIMITS.maxBBoxKm2} km² so the server finishes in seconds.`
        : `This contour map covers ${fmtNumber(bboxKm2, 1)} km². Draw a boundary within it of up to ${LIMITS.maxBBoxKm2} km².`
    );
  }
  if (lonRange) {
    const [lo, hi] = BACKEND_UTM_LON_RANGE;
    if (lonRange[0] < lo - 1 || lonRange[1] > hi + 1) {
      warnings.push(
        "This land is outside UTM zone 44, which the server uses for measurements, so areas may be off by a few percent."
      );
    }
  }

  if (!ring && !(mode === "file" && file)) return null;
  return { areaHa, bboxKm2, problems, warnings };
}

function rankPonds(ponds) {
  return [...ponds].sort((a, b) => b.volume_m3 - a.volume_m3);
}

export default function App() {
  const [mode, setMode] = useState("draw");
  const [polygon, setPolygon] = useState(null);
  const [draft, setDraft] = useState([]);
  const [drawing, setDrawing] = useState(false);

  const [file, setFile] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(null);

  const [run, setRun] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [pondResults, setPondResults] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [busySiteId, setBusySiteId] = useState(null);
  const [siteErrors, setSiteErrors] = useState({});

  const [rainfall, setRainfall] = useState(null);
  const [rainfallMm, setRainfallMm] = useState(String(DEFAULT_RAINFALL_MM));
  const [runoffId, setRunoffId] = useState(RUNOFF_PRESETS[0].id);
  const [showContours, setShowContours] = useState(true);
  const [fitTarget, setFitTarget] = useState(null);

  const modelRef = useRef(null);
  const abortRef = useRef(null);
  const rainfallRequestRef = useRef(0);

  const busy = run?.status === "running";

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const resetResults = useCallback(() => {
    abortRef.current?.abort();
    rainfallRequestRef.current += 1;
    setRun(null);
    setAnalysis(null);
    setPondResults({});
    setSelectedId(null);
    setSiteErrors({});
    setBusySiteId(null);
    modelRef.current = null;
  }, []);

  const startDrawing = () => {
    resetResults();
    setPolygon(null);
    setDraft([]);
    setDrawing(true);
  };

  const finishDrawing = useCallback(() => {
    setDraft((points) => {
      if (points.length >= 3) {
        setPolygon(points);
        setDrawing(false);
        return [];
      }
      return points;
    });
  }, []);

  const undoPoint = useCallback(() => setDraft((points) => points.slice(0, -1)), []);

  const cancelDrawing = useCallback(() => {
    setDraft([]);
    setDrawing(false);
  }, []);

  const clearAll = () => {
    resetResults();
    setPolygon(null);
    setDraft([]);
    setDrawing(false);
  };

  const addPoint = useCallback((point) => setDraft((points) => [...points, point]), []);

  // Keyboard: Enter finishes, Backspace undoes, Escape cancels.
  useEffect(() => {
    if (!drawing) return undefined;
    const onKey = (e) => {
      if (e.target.closest?.("input, select, textarea")) return;
      if (e.key === "Enter") finishDrawing();
      else if (e.key === "Backspace") { e.preventDefault(); undoPoint(); }
      else if (e.key === "Escape") cancelDrawing();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawing, finishDrawing, undoPoint, cancelDrawing]);

  const changeMode = (next) => {
    if (next === mode) return;
    resetResults();
    setMode(next);
    if (next === "file" && file) setFitTarget({ bounds: file.bounds });
  };

  const chooseFile = async (chosen) => {
    resetResults();
    setFileLoading(true);
    setFileError(null);
    try {
      const { contours } = await readContourFile(chosen);
      const bounds = contoursBounds(contours);
      const [[minLat, minLon], [maxLat, maxLon]] = bounds;
      const corners = [[minLat, minLon], [minLat, maxLon], [maxLat, maxLon], [maxLat, minLon]];
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const c of contours) {
        minZ = Math.min(minZ, c.elevation);
        maxZ = Math.max(maxZ, c.elevation);
      }
      setFile({
        name: chosen.name,
        contours,
        display: contoursForDisplay(contours),
        bounds,
        bboxKm2: polygonStats(corners).bboxM2 / 1e6,
        lonRange: [minLon, maxLon],
        contourCount: contours.length,
        minZ,
        maxZ,
      });
      setFitTarget({ bounds });
    } catch (error) {
      setFile(null);
      setFileError(error.message);
    } finally {
      setFileLoading(false);
    }
  };

  const selection = useMemo(
    () => describeSelection(mode, polygon, draft, file),
    [mode, polygon, draft, file]
  );

  const canAnalyze =
    !drawing &&
    !!selection &&
    selection.problems.length === 0 &&
    (mode === "draw" ? !!polygon : !!file);

  // -------------------------------------------------------------------------
  // Analysis pipeline
  // -------------------------------------------------------------------------

  const setStep = (id, patch) =>
    setRun((current) =>
      current && {
        ...current,
        steps: current.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      }
    );

  // Runs alongside the server request. The counter drops replies that
  // arrive after the user has moved on to another selection.
  const loadRainfall = (lat, lon) => {
    const request = ++rainfallRequestRef.current;
    setRainfall({ status: "loading" });
    fetchAnnualRainfall(lat, lon)
      .then((data) => {
        if (request !== rainfallRequestRef.current) return;
        setRainfall({ status: "ready", data });
        setRainfallMm(String(data.annualMm));
      })
      .catch(() => {
        if (request !== rainfallRequestRef.current) return;
        setRainfall({ status: "error" });
        setRainfallMm(String(DEFAULT_RAINFALL_MM));
      });
  };

  // Ask the server for one pond's outlet and catchment, then trace its
  // outlines in the browser.
  const evaluatePond = async (pond, { kml, hash, signal }) => {
    const catchment = await findCatchment(kml, hash, pond.pond_id, { signal });
    // Servers from v1.1 also send latitude/longitude; older ones only UTM 44N.
    const spill =
      catchment.spill.latitude != null && catchment.spill.longitude != null
        ? { lat: catchment.spill.latitude, lon: catchment.spill.longitude }
        : utmToLatLon(catchment.spill.easting, catchment.spill.northing, BACKEND_UTM_ZONE);

    let trace = null;
    if (modelRef.current) {
      try {
        trace = delineatePond(modelRef.current, spill.lat, spill.lon, pond.pond_area_ha * 1e4);
      } catch (error) {
        console.warn("Could not trace outlines:", error);
      }
    }

    const result = {
      pond,
      api: catchment,
      spill: [spill.lat, spill.lon],
      spillElevation: catchment.spill.elevation_m,
      center: trace?.center ?? [spill.lat, spill.lon],
      trace,
    };

    setPondResults((prev) => ({ ...prev, [pond.pond_id]: result }));
    return result;
  };

  const fitToResult = (result) => {
    const rings = result.trace?.catchmentRings?.length
      ? result.trace.catchmentRings
      : result.trace?.pondRings;
    const points = rings?.flat() ?? [];
    points.push(result.center, result.spill);
    const b = boundsOf(points);
    setFitTarget({ bounds: [[b.minLat, b.minLon], [b.maxLat, b.maxLon]] });
  };

  const runAnalysis = async () => {
    if (!canAnalyze) return;

    resetResults();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const steps = [
      ...(mode === "draw"
        ? [
            { id: "terrain", label: "Read elevation for the land" },
            { id: "contours", label: "Trace contour lines" },
          ]
        : [{ id: "contours", label: polygon ? "Cut contours to the boundary" : "Prepare the contour map" }]),
      { id: "ponds", label: "Find natural depressions (server)" },
      { id: "catchment", label: "Measure the best site's catchment (server)" },
    ].map((s) => ({ ...s, status: "pending" }));

    setRun({ status: "running", steps });

    let active = steps[0].id;
    let started = performance.now();
    const begin = (id, detail) => {
      active = id;
      started = performance.now();
      setStep(id, { status: "active", detail });
    };
    const end = (id, detail) =>
      setStep(id, { status: "done", ms: performance.now() - started, ...(detail ? { detail } : {}) });

    try {
      let contours;
      let source;
      let interval = null;

      if (mode === "draw") {
        begin("terrain");
        const grid = await fetchElevationGrid(polygon, {
          signal,
          onStatus: (detail) => setStep("terrain", { detail }),
        });
        source = grid.source;
        end("terrain", source);

        begin("contours");
        await nextFrame();
        const traced = contoursFromGrid(grid);
        contours = traced.contours;
        interval = traced.interval;
        if (contours.length === 0) {
          throw new Error("The land is too flat to draw contours here. Select a larger area that includes some slope.");
        }
        end("contours", `${fmtNumber(contours.length)} lines, ${fmtNumber(traced.minZ, 0)} to ${fmtNumber(traced.maxZ, 0)} m`);
      } else {
        begin("contours");
        await nextFrame();
        contours = polygon ? clipContours(file.contours, polygon) : file.contours;
        source = file.name;
        if (contours.length < 2) {
          throw new Error("No contour lines from this file fall inside the boundary. Draw it over the contours.");
        }
        end("contours", `${fmtNumber(contours.length)} lines`);
      }

      const vertices = countVertices(contours);
      if (vertices > LIMITS.maxContourVertices) {
        throw new Error(
          `These contours have ${fmtNumber(vertices)} points, more than the ${fmtNumber(LIMITS.maxContourVertices)} the server can handle quickly. Select a smaller area.`
        );
      }

      const kml = contoursToKml(contours, polygon ? "Selected land" : source);
      const hash = hashText(kml);

      setAnalysis({
        kml,
        hash,
        source,
        interval,
        contourCount: contours.length,
        display: mode === "draw" ? contoursForDisplay(contours) : null,
        ponds: null,
      });

      const [lat, lon] = polygon ? centerOf(polygon) : centerOf(file.bounds);
      loadRainfall(lat, lon);

      begin("ponds", "Building a 5 m elevation model on the server");
      const pondsRequest = analyzeContour(kml, hash, { signal });

      // Build the drawing model while the server works.
      await nextFrame();
      try {
        modelRef.current = buildTerrainModel(contours);
      } catch (error) {
        console.warn("Terrain model failed; outlines will be skipped:", error);
        modelRef.current = null;
      }

      const { ponds } = await pondsRequest;
      const ranked = rankPonds(ponds);
      setAnalysis((a) => ({ ...a, ponds: ranked }));
      end("ponds", `${ranked.length} depression${ranked.length === 1 ? "" : "s"} found`);

      if (ranked.length === 0) {
        setStep("catchment", { status: "skipped", detail: "Nothing to measure" });
        setRun((r) => ({ ...r, status: "done" }));
        if (polygon) {
          const b = boundsOf(polygon);
          setFitTarget({ bounds: [[b.minLat, b.minLon], [b.maxLat, b.maxLon]] });
        }
        return;
      }

      begin("catchment");
      const result = await evaluatePond(ranked[0], { kml, hash, signal });
      setSelectedId(ranked[0].pond_id);
      end("catchment");
      setRun((r) => ({ ...r, status: "done" }));
      fitToResult(result);
    } catch (error) {
      if (signal.aborted) {
        setRun(null);
        return;
      }
      console.error(error);
      setStep(active, { status: "error" });
      setRun((r) => r && { ...r, status: "error", error: error.message });
    }
  };

  const cancelRun = () => {
    abortRef.current?.abort();
    setRun(null);
  };

  // Other candidates are evaluated only when asked for: each call rebuilds
  // the DEM on the server, so doing all of them up front would take minutes.
  const selectSite = async (id) => {
    if (pondResults[id]) {
      setSelectedId(id);
      fitToResult(pondResults[id]);
      return;
    }
    if (busySiteId != null || !analysis) return;

    const pond = analysis.ponds.find((p) => p.pond_id === id);
    setBusySiteId(id);
    setSiteErrors((e) => ({ ...e, [id]: null }));
    try {
      const result = await evaluatePond(pond, { kml: analysis.kml, hash: analysis.hash });
      setSelectedId(id);
      fitToResult(result);
    } catch (error) {
      setSiteErrors((e) => ({ ...e, [id]: error.message }));
    } finally {
      setBusySiteId(null);
    }
  };

  const downloadKml = () => {
    if (!analysis?.kml) return;
    const url = URL.createObjectURL(new Blob([analysis.kml], { type: "application/vnd.google-earth.kml+xml" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `contours-${analysis.hash}.kml` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // -------------------------------------------------------------------------
  // Derived results
  // -------------------------------------------------------------------------

  const selected = selectedId != null ? pondResults[selectedId] : null;
  const coefficient = RUNOFF_PRESETS.find((p) => p.id === runoffId)?.coefficient ?? 0.3;
  // The world's wettest places get about 12,000 mm; anything above that is a typo.
  const rainfallValue = Math.min(12000, Math.max(0, Number(rainfallMm) || 0));

  const water = useMemo(() => {
    if (!selected) return null;
    const useTraced = CATCHMENT_SOURCE === "traced" && selected.trace;
    const catchmentM2 = useTraced ? selected.trace.catchmentAreaM2 : selected.api.catchment_area_m2;
    const capacityM3 = selected.pond.volume_m3;
    const runoffM3 = catchmentM2 * (rainfallValue / 1000) * coefficient;
    return {
      catchmentSource: useTraced ? "traced" : "api",
      catchmentHa: catchmentM2 / 1e4,
      pondRatio: selected.pond.pond_area_ha > 0 ? catchmentM2 / 1e4 / selected.pond.pond_area_ha : 0,
      capacityM3,
      runoffM3,
      expectedM3: Math.min(capacityM3, runoffM3),
    };
  }, [selected, rainfallValue, coefficient]);

  const mapResult = useMemo(() => {
    if (!selected || !water) return null;
    return {
      center: selected.center,
      spill: selected.spill,
      pondRings: selected.trace?.pondRings ?? [],
      catchmentRings: selected.trace?.catchmentRings ?? [],
      pondLabel: `Pond ${selected.pond.pond_id}: ${fmtHa(selected.pond.pond_area_ha)} ha, up to ${fmtNumber(selected.pond.max_depth_m, 1)} m deep`,
      catchmentLabel: `Catchment: ${fmtHa(water.catchmentHa)} ha`,
      spillLabel: `Outlet at ${fmtNumber(selected.spillElevation, 1)} m`,
    };
  }, [selected, water]);

  const volumeLabel = water ? `${fmtEstimate(water.expectedM3)} m³ a year` : "";

  const listed = useMemo(() => {
    const ponds = analysis?.ponds ?? [];
    const big = ponds.filter((p) => p.pond_area_ha >= MIN_LISTED_POND_HA);
    const pool = big.length > 0 ? big : ponds;
    const top = pool.slice(0, 6);
    if (selectedId != null && !top.some((p) => p.pond_id === selectedId)) {
      const extra = ponds.find((p) => p.pond_id === selectedId);
      if (extra) top.push(extra);
    }
    return { sites: top, hidden: ponds.length - top.length };
  }, [analysis?.ponds, selectedId]);

  const displayContours = mode === "file" ? file?.display ?? null : analysis?.display ?? null;

  return (
    <div className="app">
      <aside className="panel">
        <header className="panel-header">
          <h1>Pond Site Selection</h1>
          <p>
            Mark a piece of village land to find where rainwater naturally
            collects, how much land drains into it, and how much it can hold.
          </p>
        </header>

        <SelectionControls
          mode={mode}
          onModeChange={changeMode}
          drawing={drawing}
          draftCount={draft.length}
          polygon={polygon}
          selection={selection}
          file={file}
          fileLoading={fileLoading}
          fileError={fileError}
          onFileChosen={chooseFile}
          onStartDrawing={startDrawing}
          onFinishDrawing={finishDrawing}
          onUndoPoint={undoPoint}
          onCancelDrawing={cancelDrawing}
          onClear={clearAll}
          canAnalyze={canAnalyze}
          busy={busy}
          onAnalyze={runAnalysis}
          hasContours={!!displayContours}
          showContours={showContours}
          onToggleContours={setShowContours}
        />

        <ResultsPanel
          run={run}
          analysis={analysis}
          selected={selected}
          water={water}
          rainfall={rainfall}
          rainfallMm={rainfallMm}
          onRainfallChange={setRainfallMm}
          runoffId={runoffId}
          onRunoffChange={setRunoffId}
          sites={listed.sites}
          hiddenCount={listed.hidden}
          busySiteId={busySiteId}
          siteErrors={siteErrors}
          onSelectSite={selectSite}
          onCancel={cancelRun}
          onDownloadKml={downloadKml}
        />
      </aside>

      <main className="map-area">
        <MapView
          polygon={polygon}
          draft={draft}
          drawing={drawing}
          onAddPoint={addPoint}
          onClosePolygon={finishDrawing}
          contours={displayContours}
          showContours={showContours}
          result={mapResult}
          volumeLabel={volumeLabel}
          fitTarget={fitTarget}
        />
      </main>
    </div>
  );
}
