import { useEffect } from "react";
import { Circle, CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import type { LatLngTuple } from "leaflet";
import { fmtTime } from "../format";
import type { LocationPing } from "../types";

function FitBounds({ points }: { points: LatLngTuple[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 15);
    else if (points.length > 1) map.fitBounds(points, { padding: [30, 30] });
  }, [map, points]);
  return null;
}

export default function LocationMap({ pings, timezone }: { pings: LocationPing[]; timezone: string }) {
  if (pings.length === 0) return <p className="muted">No locations recorded on this day.</p>;
  const points: LatLngTuple[] = pings.map((p) => [p.latitude, p.longitude]);
  const last = pings[pings.length - 1];

  return (
    <MapContainer className="map" center={points[0]} zoom={13} scrollWheelZoom={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {points.length > 1 && <Polyline positions={points} pathOptions={{ color: "#4f46e5", weight: 2, opacity: 0.6 }} />}
      {last.accuracy_m != null && (
        <Circle
          center={[last.latitude, last.longitude]}
          radius={last.accuracy_m}
          pathOptions={{ color: "#4f46e5", weight: 1, fillOpacity: 0.08 }}
        />
      )}
      {pings.map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.latitude, p.longitude]}
          radius={p === last ? 8 : 5}
          pathOptions={{ color: "#4f46e5", fillColor: p === last ? "#4f46e5" : "#fff", fillOpacity: 1, weight: 2 }}
        >
          <Popup>
            {fmtTime(p.captured_at, timezone)}
            <br />
            {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
            {p.accuracy_m != null && <> (±{Math.round(p.accuracy_m)} m)</>}
          </Popup>
        </CircleMarker>
      ))}
      <FitBounds points={points} />
    </MapContainer>
  );
}
