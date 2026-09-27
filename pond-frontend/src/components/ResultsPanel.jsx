import { useEffect, useRef } from "react";
import { RUNOFF_PRESETS } from "../config.js";
import {
  fmtEstimate,
  fmtHa,
  fmtLatLon,
  fmtNumber,
  fmtSeconds,
  litresPhrase,
} from "../lib/format.js";

function Progress({ run, onCancel }) {
  return (
    <section className="panel-section" aria-live="polite">
      <h2>Working on it</h2>
      <ol className="steps">
        {run.steps.map((step) => (
          <li key={step.id} className={`step step-${step.status}`}>
            <span className="step-label">{step.label}</span>
            {step.detail && <span className="step-detail">{step.detail}</span>}
            {step.ms != null && <span className="step-time">{fmtSeconds(step.ms)}</span>}
          </li>
        ))}
      </ol>
      {run.status === "running" && (
        <button type="button" className="button button-quiet" onClick={onCancel}>
          Cancel
        </button>
      )}
    </section>
  );
}

function WaterGauge({ runoffM3, capacityM3 }) {
  const ratio = capacityM3 > 0 ? runoffM3 / capacityM3 : 0;
  const fill = Math.min(1, ratio);

  return (
    <div className="gauge" role="img" aria-label={`Average-year runoff fills ${Math.round(ratio * 100)}% of the pond`}>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${fill * 100}%` }} />
        {ratio > 1 && <div className="gauge-overflow">{fmtNumber(ratio, 1)}× capacity</div>}
      </div>
      <div className="gauge-scale">
        <span>Empty</span>
        <span>Full</span>
      </div>
    </div>
  );
}

function Fact({ label, children }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function SiteTable({ sites, selectedId, suggestedId, busyId, errors, onSelect, hiddenCount }) {
  return (
    <section className="panel-section" aria-labelledby="sites-heading">
      <h2 id="sites-heading">Other depressions found</h2>
      <p className="note">
        Ranked by how much water each can store. Choosing one asks the server
        for its outlet and catchment.
      </p>
      <div className="table-scroll">
        <table className="sites">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col" className="num">Area (ha)</th>
              <th scope="col" className="num">Deepest (m)</th>
              <th scope="col" className="num">Storage (m³)</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => {
              const id = site.pond_id;
              const isSelected = id === selectedId;
              return (
                <tr key={id} className={isSelected ? "is-selected" : ""}>
                  <th scope="row">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onSelect(id)}
                      disabled={busyId != null || isSelected}
                      aria-pressed={isSelected}
                    >
                      {busyId === id ? "Loading…" : `Pond ${id}`}
                    </button>
                    {id === suggestedId && <span className="tag">suggested</span>}
                    {errors[id] && <span className="field-error"> {errors[id]}</span>}
                  </th>
                  <td className="num">{fmtHa(site.pond_area_ha)}</td>
                  <td className="num">{fmtNumber(site.max_depth_m, 1)}</td>
                  <td className="num">{fmtEstimate(site.volume_m3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 && (
        <p className="note">
          {hiddenCount} smaller depression{hiddenCount === 1 ? "" : "s"} not listed.
        </p>
      )}
    </section>
  );
}

export default function ResultsPanel({
  run,
  analysis,
  selected,
  water,
  rainfall,
  rainfallMm,
  onRainfallChange,
  runoffId,
  onRunoffChange,
  sites,
  hiddenCount,
  busySiteId,
  siteErrors,
  onSelectSite,
  onCancel,
  onDownloadKml,
}) {
  const leadRef = useRef(null);
  const selectedPondId = selected?.pond.pond_id;

  // When a site's results arrive, bring them into view in the side panel.
  // Skipped on narrow screens, where the page scrolls and the map would
  // be pushed out of sight.
  useEffect(() => {
    if (selectedPondId == null || !leadRef.current) return;
    if (!window.matchMedia("(min-width: 901px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    leadRef.current.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [selectedPondId]);

  if (!run && !analysis) {
    return (
      <section className="panel-section empty-state">
        <h2>How it works</h2>
        <ol className="how">
          <li>Draw the boundary of the land you are considering.</li>
          <li>Find pond site traces the terrain and looks for ground where water naturally collects.</li>
          <li>The best site is shown on the map with the land that drains into it and the water it can hold.</li>
        </ol>
      </section>
    );
  }

  return (
    <>
      {run && run.status !== "done" && <Progress run={run} onCancel={onCancel} />}

      {run?.status === "error" && (
        <div className="error" role="alert">
          <p>{run.error}</p>
        </div>
      )}

      {analysis?.ponds && analysis.ponds.length === 0 && (
        <section className="panel-section">
          <h2>No pond site in this area</h2>
          <p>
            No depression at least 1 m deep was found inside the boundary.
            Select a larger area that includes low ground, such as land along
            a stream or below a slope.
          </p>
        </section>
      )}

      {selected && water && (
        <>
          <section ref={leadRef} className="panel-section result-lead" aria-labelledby="water-heading">
            <h2 id="water-heading">
              <span className="swatch swatch-water" aria-hidden="true" />
              Water this pond can collect
            </h2>
            <p className="big-figure">
              {fmtEstimate(water.expectedM3)} <span className="unit">m³ a year</span>
            </p>
            <p className="big-figure-sub">{litresPhrase(water.expectedM3)}</p>

            <WaterGauge runoffM3={water.runoffM3} capacityM3={water.capacityM3} />

            <p className="explain">
              {water.runoffM3 >= water.capacityM3 ? (
                <>
                  In an average year about {fmtEstimate(water.runoffM3)} m³ runs
                  off the catchment, more than the {fmtEstimate(water.capacityM3)} m³
                  the depression can hold, so the pond fills and the rest spills
                  at the outlet.
                </>
              ) : (
                <>
                  In an average year about {fmtEstimate(water.runoffM3)} m³ runs
                  off the catchment, filling {Math.round((water.runoffM3 / water.capacityM3) * 100)}%
                  of the {fmtEstimate(water.capacityM3)} m³ the depression can hold.
                </>
              )}
            </p>
          </section>

          <section className="panel-section" aria-labelledby="pond-heading">
            <h2 id="pond-heading">Suggested pond location</h2>
            <dl className="facts">
              <Fact label="Deepest point">{fmtLatLon(selected.center)}</Fact>
              <Fact label="Pond area">{fmtHa(selected.pond.pond_area_ha)} ha, 1 m deep or more</Fact>
              <Fact label="Greatest depth">{fmtNumber(selected.pond.max_depth_m, 1)} m</Fact>
              <Fact label="Storage">{fmtEstimate(selected.pond.volume_m3)} m³</Fact>
              <Fact label="Outlet">
                {fmtLatLon(selected.spill)}, at {fmtNumber(selected.spillElevation, 1)} m
              </Fact>
            </dl>
          </section>

          <section className="panel-section" aria-labelledby="catchment-heading">
            <h2 id="catchment-heading">
              <span className="swatch swatch-catchment" aria-hidden="true" />
              Catchment area
            </h2>
            <p className="mid-figure">
              {fmtHa(water.catchmentHa)} <span className="unit">ha</span>
            </p>
            <p className="note">
              {water.catchmentSource === "traced" ? (
                <>
                  All land whose runoff reaches this depression, traced in the
                  browser from the same contours sent to the server
                  {water.pondRatio > 0 && <> ({fmtNumber(water.pondRatio, 1)} times the pond area)</>}.
                  The server calculates {fmtHa(selected.api.catchment_area_ha)} ha
                  on its own grid; where flat ground could drain either way,
                  the two can differ.
                </>
              ) : (
                <>All land whose runoff reaches this depression, calculated by the server.</>
              )}
            </p>
          </section>

          <section className="panel-section" aria-labelledby="assumptions-heading">
            <h2 id="assumptions-heading">Rainfall and land cover</h2>
            <div className="field">
              <label htmlFor="rainfall">Average rainfall (mm a year)</label>
              <input
                id="rainfall"
                type="number"
                inputMode="numeric"
                min="0"
                max="12000"
                step="10"
                value={rainfallMm}
                onChange={(e) => onRainfallChange(e.target.value)}
              />
              <p className="note">
                {rainfall?.status === "loading" && "Looking up rainfall for this place…"}
                {rainfall?.status === "ready" &&
                  `${fmtNumber(rainfall.data.annualMm)} mm is the ${rainfall.data.period} average from ${rainfall.data.source}. Wettest day: ${fmtNumber(rainfall.data.wettestDayMm)} mm.`}
                {rainfall?.status === "error" &&
                  "Rainfall lookup failed, so a typical figure for central India is filled in. Enter the local figure if you have it."}
              </p>
            </div>
            <div className="field">
              <label htmlFor="runoff">Land cover in the catchment</label>
              <select id="runoff" value={runoffId} onChange={(e) => onRunoffChange(e.target.value)}>
                {RUNOFF_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label} ({preset.coefficient.toFixed(2)} of rain runs off)
                  </option>
                ))}
              </select>
            </div>
          </section>
        </>
      )}

      {sites.length > 0 && (
        <SiteTable
          sites={sites}
          selectedId={selected?.pond.pond_id}
          suggestedId={analysis?.ponds?.[0]?.pond_id}
          busyId={busySiteId}
          errors={siteErrors}
          onSelect={onSelectSite}
          hiddenCount={hiddenCount}
        />
      )}

      {analysis?.kml && (
        <section className="panel-section sources">
          <p className="note">
            Terrain: {analysis.source}. {fmtNumber(analysis.contourCount)} contour
            lines{analysis.interval ? ` at ${analysis.interval} m intervals` : ""} were
            sent to the server.
          </p>
          <button type="button" className="button button-quiet" onClick={onDownloadKml}>
            Download contour KML
          </button>
        </section>
      )}
    </>
  );
}
