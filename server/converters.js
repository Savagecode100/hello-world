// CSV → time-series GeoJSON converter.
//
// Converts a "long format" CSV (one row per feature per timestamp) into the
// temporal GeoJSON schema that Atlas understands. Rows are grouped by an id
// column; each row contributes one snapshot to that feature's timeSeries.
//
// Expected columns (case-insensitive, flexible names):
//   id        — feature id        (id, key, feature_id, name)
//   timestamp — snapshot time     (timestamp, time, date, year)
//   lat / lng — coordinates       (lat|latitude|y, lng|lon|long|longitude|x)
//   ...any other columns become snapshot properties.
//
// CLI usage:
//   node server/converters.js input.csv [output.geojson] [--interpolate=linear|step]
//
// Programmatic usage:
//   import { csvToTimeSeries } from './converters.js';
//   const geojson = csvToTimeSeries(csvText, { interpolate: 'linear' });

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal RFC-4180-ish CSV parser (handles quotes, escaped quotes, CRLF). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findColumn(lowerHeader, candidates) {
  for (const cand of candidates) {
    const idx = lowerHeader.indexOf(cand);
    if (idx !== -1) return idx;
  }
  return -1;
}

function coerce(value) {
  if (value === '' || value == null) return value;
  return isFinite(Number(value)) ? Number(value) : value;
}

/**
 * Convert long-format CSV text into a temporal GeoJSON FeatureCollection.
 * options: { idColumn, timeColumn, latColumn, lngColumn, interpolate, name }
 */
export function csvToTimeSeries(text, options = {}) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim());
  const lower = header.map((h) => h.toLowerCase());

  const idIdx = options.idColumn
    ? lower.indexOf(options.idColumn.toLowerCase())
    : findColumn(lower, ['id', 'feature_id', 'key', 'name']);
  const timeIdx = options.timeColumn
    ? lower.indexOf(options.timeColumn.toLowerCase())
    : findColumn(lower, ['timestamp', 'time', 'date', 'datetime', 'year']);
  const latIdx = options.latColumn
    ? lower.indexOf(options.latColumn.toLowerCase())
    : findColumn(lower, ['lat', 'latitude', 'y']);
  const lngIdx = options.lngColumn
    ? lower.indexOf(options.lngColumn.toLowerCase())
    : findColumn(lower, ['lng', 'lon', 'long', 'longitude', 'x']);

  if (idIdx === -1) throw new Error('Could not find an id column (id / feature_id / key / name)');
  if (timeIdx === -1) throw new Error('Could not find a timestamp column (timestamp / time / date / year)');
  if (latIdx === -1 || lngIdx === -1) {
    throw new Error('Could not find latitude/longitude columns (lat/latitude and lng/lon/longitude)');
  }

  const featureMap = new Map(); // id -> feature

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const id = (cells[idIdx] || '').trim();
    const timestamp = (cells[timeIdx] || '').trim();
    const latRaw = (cells[latIdx] || '').trim();
    const lngRaw = (cells[lngIdx] || '').trim();
    if (!id || !timestamp || latRaw === '' || lngRaw === '') continue;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!isFinite(lat) || !isFinite(lng)) continue;

    const snapProps = {};
    for (let c = 0; c < header.length; c++) {
      if (c === idIdx || c === timeIdx || c === latIdx || c === lngIdx) continue;
      snapProps[header[c]] = coerce(cells[c]);
    }

    if (!featureMap.has(id)) {
      featureMap.set(id, {
        type: 'Feature',
        properties: { name: id },
        geometry: { type: 'Point', coordinates: [lng, lat] },
        timeSeries: []
      });
    }
    const feature = featureMap.get(id);
    // Keep the most recent coordinates as the base geometry.
    feature.geometry.coordinates = [lng, lat];
    feature.timeSeries.push({ timestamp, properties: snapProps });
  }

  const features = [...featureMap.values()];
  if (!features.length) throw new Error('No valid rows found (need id, timestamp, lat, lng)');

  // Sort each feature's snapshots chronologically.
  for (const f of features) {
    f.timeSeries.sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
      return String(a.timestamp).localeCompare(String(b.timestamp));
    });
  }

  return {
    type: 'FeatureCollection',
    name: options.name || 'Converted time-series',
    temporal: { property: 'timestamp', interpolate: options.interpolate || 'linear' },
    features
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else positional.push(arg);
  }
  const input = positional[0];
  if (!input) {
    console.error('Usage: node server/converters.js <input.csv> [output.geojson] [--interpolate=linear|step] [--name="My data"]');
    process.exit(1);
  }
  const output = positional[1] || input.replace(/\.csv$/i, '') + '.geojson';
  const text = await fs.readFile(input, 'utf8');
  const geojson = csvToTimeSeries(text, { interpolate: flags.interpolate, name: flags.name });
  await fs.writeFile(output, JSON.stringify(geojson, null, 2));
  console.log(`Wrote ${geojson.features.length} features → ${output}`);
}
