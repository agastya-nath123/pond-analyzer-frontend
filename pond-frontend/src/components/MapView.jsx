import { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import {
  CircleMarker,
  LayersControl,
  MapContainer,
  Marker,
  Pane,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";

import "leaflet/dist/leaflet.css";

const DEFAULT_CENTER = [21.1938, 81.3509];

const MAP_COLORS = {
  boundary: "#c0392b",
  contour: "#a0522d",
  water: "#1b5e9e",
  catchment: "#4e8c3a",
};

const pondIcon = L.divIcon({
  className: "pond-pin",
  html: "<span></span>",
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

// Adds corners on click while drawing and keeps Leaflet from zooming on
// double-click, which would otherwise fight with adding points.
function DrawingHandler({ drawing, onAddPoint }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    container.classList.toggle("is-drawing", drawing);
    if (drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [drawing, map]);

  useMapEvents({
    click(e) {
      if (drawing) onAddPoint([e.latlng.lat, e.latlng.lng]);
    },
  });

  return null;
}

// Rubber-band line from the last corner to the cursor. Kept in its own
// component so mouse moves don't re-render the rest of the map.
function DraftGuide({ from }) {
  const [cursor, setCursor] = useState(null);

  useMapEvents({
    mousemove(e) {
      setCursor([e.latlng.lat, e.latlng.lng]);
    },
    mouseout() {
      setCursor(null);
    },
  });

  if (!from || !cursor) return null;

  return (
    <Polyline
      positions={[from, cursor]}
      interactive={false}
      pathOptions={{ color: MAP_COLORS.boundary, weight: 1.5, dashArray: "4 6", opacity: 0.8 }}
    />
  );
}

function FitBounds({ target }) {
  const map = useMap();

  useEffect(() => {
    if (!target?.bounds) return;
    const { x, y } = map.getSize();
    const pad = Math.min(x, y) < 520 ? 16 : 40;
    map.fitBounds(target.bounds, { padding: [pad, pad], maxZoom: 17 });
  }, [target, map]);

  return null;
}

function KeepSized() {
  const map = useMap();

  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);

  return null;
}

function Legend({ items }) {
  if (items.length === 0) return null;

  return (
    <div className="map-legend" aria-label="Map legend">
      {items.map((item) => (
        <div className="legend-row" key={item.id}>
          <span className={`legend-swatch swatch-${item.id}`} aria-hidden="true" />
          {item.label}
        </div>
      ))}
    </div>
  );
}

export default function MapView({
  polygon,
  draft,
  drawing,
  onAddPoint,
  onClosePolygon,
  contours,
  showContours,
  result,
  volumeLabel,
  fitTarget,
}) {
  // Thousands of contour lines draw fast on one canvas; the interactive
  // overlays stay SVG so each keeps its own hover tooltip.
  const contourRenderer = useMemo(() => L.canvas({ pane: "contours", padding: 0.3 }), []);

  const legendItems = useMemo(() => {
    const items = [];
    if (polygon || draft.length) items.push({ id: "boundary", label: "Selected land" });
    if (showContours && contours) items.push({ id: "contour", label: "Contours (thick every 5 m)" });
    if (result?.catchmentRings?.length) items.push({ id: "catchment", label: "Catchment draining to pond" });
    if (result?.pondRings?.length) items.push({ id: "water", label: "Pond, 1 m deep or more" });
    if (result) items.push({ id: "outlet", label: "Outlet where water spills" });
    return items;
  }, [polygon, draft.length, showContours, contours, result]);

  return (
    <div className="map-wrapper">
      <MapContainer center={DEFAULT_CENTER} zoom={13} zoomSnap={0.5} className="map">
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Street map">
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={19}
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Satellite">
            <TileLayer
              attribution="Imagery &copy; Esri, Maxar, Earthstar Geographics"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              maxZoom={19}
            />
          </LayersControl.BaseLayer>
        </LayersControl>

        <DrawingHandler drawing={drawing} onAddPoint={onAddPoint} />
        <FitBounds target={fitTarget} />
        <KeepSized />

        <Pane name="catchment" style={{ zIndex: 405 }}>
          {result?.catchmentRings?.length > 0 && (
            <Polygon
              positions={result.catchmentRings}
              pathOptions={{
                color: MAP_COLORS.catchment,
                weight: 2,
                fillColor: MAP_COLORS.catchment,
                fillOpacity: 0.16,
              }}
            >
              <Tooltip sticky>{result.catchmentLabel}</Tooltip>
            </Polygon>
          )}
        </Pane>

        <Pane name="contours" style={{ zIndex: 410 }}>
          {showContours && contours && (
            <>
              <Polyline
                positions={contours.minor}
                renderer={contourRenderer}
                interactive={false}
                pathOptions={{ color: MAP_COLORS.contour, weight: 0.8, opacity: 0.55 }}
              />
              <Polyline
                positions={contours.major}
                renderer={contourRenderer}
                interactive={false}
                pathOptions={{ color: MAP_COLORS.contour, weight: 1.8, opacity: 0.85 }}
              />
            </>
          )}
        </Pane>

        <Pane name="pond" style={{ zIndex: 420 }}>
          {result?.pondRings?.length > 0 && (
            <Polygon
              positions={result.pondRings}
              pathOptions={{
                color: MAP_COLORS.water,
                weight: 1.5,
                fillColor: MAP_COLORS.water,
                fillOpacity: 0.55,
              }}
            >
              <Tooltip sticky>{result.pondLabel}</Tooltip>
            </Polygon>
          )}
        </Pane>

        <Pane name="boundary" style={{ zIndex: 430 }}>
          {polygon && (
            <Polygon
              positions={polygon}
              interactive={false}
              pathOptions={{
                color: MAP_COLORS.boundary,
                weight: 2.5,
                dashArray: "10 5 2 5",
                fill: !result,
                fillColor: MAP_COLORS.boundary,
                fillOpacity: 0.05,
              }}
            />
          )}

          {drawing && draft.length > 0 && (
            <>
              <Polyline
                positions={draft}
                interactive={false}
                pathOptions={{ color: MAP_COLORS.boundary, weight: 2.5, dashArray: "10 5 2 5" }}
              />
              <DraftGuide from={draft[draft.length - 1]} />
              {draft.map((point, i) => (
                <CircleMarker
                  key={`${i}-${point[0]}-${point[1]}`}
                  center={point}
                  radius={i === 0 && draft.length >= 3 ? 8 : 4}
                  bubblingMouseEvents={false}
                  interactive={i === 0}
                  pathOptions={{
                    color: MAP_COLORS.boundary,
                    weight: 2,
                    fillColor: "#fff",
                    fillOpacity: 1,
                  }}
                  eventHandlers={i === 0 ? { click: onClosePolygon } : undefined}
                >
                  {i === 0 && draft.length >= 3 && (
                    <Tooltip direction="top" offset={[0, -8]}>
                      Click to close the boundary
                    </Tooltip>
                  )}
                </CircleMarker>
              ))}
            </>
          )}
        </Pane>

        {result?.spill && (
          <CircleMarker
            center={result.spill}
            radius={6}
            pane="markerPane"
            pathOptions={{
              color: "#fff",
              weight: 2,
              fillColor: MAP_COLORS.water,
              fillOpacity: 1,
            }}
          >
            <Tooltip direction="bottom" offset={[0, 6]}>
              {result.spillLabel}
            </Tooltip>
          </CircleMarker>
        )}

        {result?.center && (
          <Marker position={result.center} icon={pondIcon} keyboard={false}>
            <Tooltip permanent direction="right" offset={[12, 0]} className="volume-label">
              {volumeLabel}
            </Tooltip>
          </Marker>
        )}
      </MapContainer>

      {drawing && (
        <div className="map-hint" role="status">
          {draft.length < 3
            ? "Click the map to place the corners of the land."
            : "Click the first corner or press Enter to finish."}
        </div>
      )}

      <Legend items={legendItems} />
    </div>
  );
}
