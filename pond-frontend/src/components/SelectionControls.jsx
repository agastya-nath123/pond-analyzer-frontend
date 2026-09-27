import { useId, useRef } from "react";
import { fmtHa, fmtNumber } from "../lib/format.js";

function ModeSwitch({ mode, onChange, disabled }) {
  const options = [
    { id: "draw", label: "Draw on map" },
    { id: "file", label: "Use a contour file" },
  ];

  return (
    <div className="mode-switch" role="radiogroup" aria-label="How to get terrain">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={mode === option.id}
          className={mode === option.id ? "is-active" : ""}
          onClick={() => onChange(option.id)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function FilePicker({ file, loading, error, onFileChosen, disabled }) {
  const inputId = useId();
  const inputRef = useRef(null);

  return (
    <div className="file-picker">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
        className="visually-hidden"
        disabled={disabled || loading}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) onFileChosen(chosen);
          e.target.value = "";
        }}
      />
      <label htmlFor={inputId} className={`button button-secondary${disabled || loading ? " is-disabled" : ""}`}>
        {loading ? "Reading file…" : file ? "Choose another file" : "Choose KML or KMZ"}
      </label>

      {file && !loading && (
        <p className="note">
          <strong>{file.name}</strong>: {fmtNumber(file.contourCount)} contour lines from{" "}
          {fmtNumber(file.minZ, 0)} to {fmtNumber(file.maxZ, 0)} m, covering{" "}
          {fmtNumber(file.bboxKm2, 1)} km².
        </p>
      )}

      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

export default function SelectionControls({
  mode,
  onModeChange,
  drawing,
  draftCount,
  polygon,
  selection,
  file,
  fileLoading,
  fileError,
  onFileChosen,
  onStartDrawing,
  onFinishDrawing,
  onUndoPoint,
  onCancelDrawing,
  onClear,
  canAnalyze,
  busy,
  onAnalyze,
  hasContours,
  showContours,
  onToggleContours,
}) {
  return (
    <section className="panel-section" aria-labelledby="land-heading">
      <h2 id="land-heading">Choose the land</h2>

      <ModeSwitch mode={mode} onChange={onModeChange} disabled={busy || drawing} />

      {mode === "draw" ? (
        <p className="note">
          Draw the boundary of the land, such as a government plot. Elevation is
          read from open terrain data (about 30 m detail) and turned into
          contours for the analysis.
        </p>
      ) : (
        <>
          <p className="note">
            Upload surveyed contours. Draw a boundary to analyse only part of
            the map, or analyse the whole file.
          </p>
          <FilePicker
            file={file}
            loading={fileLoading}
            error={fileError}
            onFileChosen={onFileChosen}
            disabled={busy}
          />
        </>
      )}

      <div className="button-row">
        {!drawing && (
          <button
            type="button"
            className="button button-secondary"
            onClick={onStartDrawing}
            disabled={busy}
          >
            {polygon ? "Redraw boundary" : "Draw land boundary"}
          </button>
        )}

        {drawing && (
          <>
            <button
              type="button"
              className="button button-secondary"
              onClick={onFinishDrawing}
              disabled={draftCount < 3}
            >
              Finish boundary
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={onUndoPoint}
              disabled={draftCount === 0}
            >
              Undo corner
            </button>
            <button type="button" className="button button-quiet" onClick={onCancelDrawing}>
              Cancel
            </button>
          </>
        )}

        {!drawing && polygon && (
          <button type="button" className="button button-quiet" onClick={onClear} disabled={busy}>
            Clear
          </button>
        )}
      </div>

      {selection && (
        <div className="selection-summary">
          {selection.areaHa > 0 && (
            <p>
              <span className="swatch swatch-boundary" aria-hidden="true" />
              {fmtHa(selection.areaHa)} ha selected
              {selection.bboxKm2 > 0 && <>, analysed within a {fmtNumber(selection.bboxKm2, 2)} km² box</>}
            </p>
          )}
          {selection.problems.map((text) => (
            <p key={text} className="field-error" role="alert">{text}</p>
          ))}
          {selection.warnings.map((text) => (
            <p key={text} className="note">{text}</p>
          ))}
        </div>
      )}

      <button
        type="button"
        className="button button-primary"
        onClick={onAnalyze}
        disabled={!canAnalyze || busy}
      >
        {busy ? "Analysing…" : "Find pond site"}
      </button>

      {hasContours && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={showContours}
            onChange={(e) => onToggleContours(e.target.checked)}
          />
          Show contour lines on the map
        </label>
      )}
    </section>
  );
}
