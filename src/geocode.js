/**
 * Fully offline reverse geocoding: nearest-place lookup against a bundled GeoNames-derived
 * dataset (src/geodata/places.json, ~135k places pop >= 1000, CC BY 4.0 — see README), never
 * a network call. Core owns this (issue #67) so `place_label` resolution happens once, in one
 * place, for every current and future connector that submits raw latitude/longitude — mirrors
 * how core already owns text_repr -> embedding (doc 04 §3: connectors describe, core embeds).
 * Regenerate via `npm run geocode:build`; see scripts/build-places.js.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'geodata', 'places.json'), 'utf8'),
);

const EARTH_RADIUS_KM = 6371;
const NEARBY_KM = 50; // within this, name the place plainly
const FAR_KM = 300; // beyond this, the dataset has nothing useful to say

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns a place_label string, or null if the dataset has nothing within FAR_KM (an honest
// "don't know" rather than mislabeling an artifact with a place hundreds of km away).
export function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return null;
  let nearest = null;
  let nearestKm = Infinity;
  for (const place of PLACES) {
    const km = haversineKm(lat, lon, place.lat, place.lon);
    if (km < nearestKm) {
      nearest = place;
      nearestKm = km;
    }
  }
  if (!nearest || nearestKm > FAR_KM) return null;
  const label = nearest.region ? `${nearest.city}, ${nearest.region}` : `${nearest.city}, ${nearest.country}`;
  return nearestKm > NEARBY_KM ? `near ${label}` : label;
}
