// Atlas time-series helpers.
// Shared logic for detecting temporal datasets, enumerating frames, and
// flattening a time-series FeatureCollection to a single point in time.
//
// A temporal dataset is a GeoJSON FeatureCollection where features carry a
// `timeSeries` array of snapshots:
//
//   {
//     "type": "Feature",
//     "geometry": { ... },
//     "properties": { "name": "..." },      // static base properties
//     "timeSeries": [
//       { "timestamp": "2024-01-01", "properties": { "employees": 100 } },
//       { "timestamp": "2024-04-01", "properties": { "employees": 130 } }
//     ]
//   }
//
// Collection-level config lives under `temporal`:
//   { "property": "timestamp", "interpolate": "linear" | "step" }

/** Parse a timestamp (ISO string or number) into a sortable numeric value. */
export function toTime(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;
  const n = Date.parse(value);
  if (!Number.isNaN(n)) return n;
  const asNum = Number(value);
  return Number.isNaN(asNum) ? NaN : asNum;
}

/** True when the FeatureCollection carries per-feature time-series snapshots. */
export function isTemporal(geojson) {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    return false;
  }
  return geojson.features.some(
    (f) => Array.isArray(f.timeSeries) && f.timeSeries.length > 0
  );
}

/** Return the sorted, de-duplicated list of timestamps across all features. */
export function collectTimestamps(geojson) {
  const seen = new Map(); // numeric time -> original timestamp value
  for (const feature of geojson.features || []) {
    if (!Array.isArray(feature.timeSeries)) continue;
    for (const snap of feature.timeSeries) {
      if (snap == null || snap.timestamp == null) continue;
      const t = toTime(snap.timestamp);
      if (Number.isNaN(t)) continue;
      if (!seen.has(t)) seen.set(t, snap.timestamp);
    }
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

/**
 * Validate a temporal FeatureCollection.
 * Returns an error string, or null when valid.
 */
export function validateTimeSeries(geojson) {
  if (!geojson || geojson.type !== 'FeatureCollection') {
    return 'Temporal datasets must be a FeatureCollection';
  }
  if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
    return 'FeatureCollection must contain at least one feature';
  }
  let withSeries = 0;
  for (let i = 0; i < geojson.features.length; i++) {
    const feature = geojson.features[i];
    const series = feature.timeSeries;
    if (series === undefined) continue;
    if (!Array.isArray(series)) {
      return `Feature ${i}: timeSeries must be an array`;
    }
    withSeries++;
    for (let j = 0; j < series.length; j++) {
      const snap = series[j];
      if (!snap || typeof snap !== 'object') {
        return `Feature ${i}, snapshot ${j}: must be an object`;
      }
      if (snap.timestamp == null) {
        return `Feature ${i}, snapshot ${j}: missing timestamp`;
      }
      if (Number.isNaN(toTime(snap.timestamp))) {
        return `Feature ${i}, snapshot ${j}: invalid timestamp "${snap.timestamp}"`;
      }
    }
  }
  if (withSeries === 0) {
    return 'No features contain a timeSeries array';
  }
  return null;
}

function lerp(a, b, frac) {
  return a + (b - a) * frac;
}

/**
 * Flatten a single time-series feature to a given moment in time.
 * Returns a plain GeoJSON Feature, or null when the feature does not yet
 * exist at that time (its first snapshot is in the future).
 */
function frameFeature(feature, targetTime, interpolate) {
  const series = feature.timeSeries;
  if (!Array.isArray(series) || series.length === 0) {
    return feature; // static feature: always present
  }
  const sorted = series
    .filter((s) => s && s.timestamp != null && !Number.isNaN(toTime(s.timestamp)))
    .sort((a, b) => toTime(a.timestamp) - toTime(b.timestamp));
  if (sorted.length === 0) return feature;

  let prev = null;
  let next = null;
  for (const snap of sorted) {
    const t = toTime(snap.timestamp);
    if (t <= targetTime) prev = snap;
    if (t >= targetTime && next === null) next = snap;
  }
  if (!prev) return null; // not born yet

  const props = Object.assign({}, feature.properties);
  const prevProps = prev.properties || {};

  if (interpolate === 'linear' && next && next !== prev) {
    const t0 = toTime(prev.timestamp);
    const t1 = toTime(next.timestamp);
    const frac = t1 === t0 ? 0 : (targetTime - t0) / (t1 - t0);
    const nextProps = next.properties || {};
    const keys = new Set([...Object.keys(prevProps), ...Object.keys(nextProps)]);
    for (const k of keys) {
      const a = prevProps[k];
      const b = nextProps[k];
      props[k] = typeof a === 'number' && typeof b === 'number' ? lerp(a, b, frac) : (a !== undefined ? a : b);
    }
  } else {
    Object.assign(props, prevProps);
  }

  props.__timestamp = prev.timestamp;

  // Geometry can evolve per-snapshot (trajectories). Interpolate points.
  let geometry = prev.geometry || feature.geometry;
  if (
    interpolate === 'linear' &&
    next &&
    next !== prev &&
    prev.geometry &&
    next.geometry &&
    prev.geometry.type === 'Point' &&
    next.geometry.type === 'Point'
  ) {
    const t0 = toTime(prev.timestamp);
    const t1 = toTime(next.timestamp);
    const frac = t1 === t0 ? 0 : (targetTime - t0) / (t1 - t0);
    geometry = {
      type: 'Point',
      coordinates: [
        lerp(prev.geometry.coordinates[0], next.geometry.coordinates[0], frac),
        lerp(prev.geometry.coordinates[1], next.geometry.coordinates[1], frac)
      ]
    };
  }

  return { type: 'Feature', properties: props, geometry };
}

/**
 * Flatten a temporal FeatureCollection to a single timestamp.
 * Returns a plain GeoJSON FeatureCollection ready to render.
 */
export function frameAt(geojson, timestamp, interpolate) {
  const mode = interpolate || (geojson.temporal && geojson.temporal.interpolate) || 'step';
  const targetTime = toTime(timestamp);
  const features = [];
  for (const feature of geojson.features || []) {
    const framed = frameFeature(feature, targetTime, mode);
    if (framed) features.push(framed);
  }
  return { type: 'FeatureCollection', features };
}
