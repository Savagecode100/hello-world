// Atlas API + app server.
// Zero-dependency Node server: serves the studio app, the SDK, and a REST API
// for geocoding, basemap styles, map types, datasets, and embeddable maps.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASEMAP_STYLES, MAP_TYPES, getStyle, getMapType } from './presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SDK_DIR = path.join(ROOT, 'sdk');
const EXAMPLES_DIR = path.join(ROOT, 'examples');
const DATA_DIR = path.join(ROOT, 'data');
const SEED_DIR = path.join(__dirname, 'seed');

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB dataset uploads

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ---------------------------------------------------------------------------
// Dataset store: one JSON file per dataset under data/.
// ---------------------------------------------------------------------------

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Seed built-in sample datasets on first run.
  let seeds = [];
  try {
    seeds = await fs.readdir(SEED_DIR);
  } catch {
    return;
  }
  for (const file of seeds) {
    if (!file.endsWith('.json') && !file.endsWith('.geojson')) continue;
    const id = path.basename(file).replace(/\.(geo)?json$/, '');
    const target = path.join(DATA_DIR, `${id}.json`);
    try {
      await fs.access(target);
    } catch {
      const geojson = JSON.parse(await fs.readFile(path.join(SEED_DIR, file), 'utf8'));
      const record = {
        id,
        name: geojson.name || id,
        description: geojson.description || 'Built-in sample dataset',
        license: 'CC BY 4.0',
        source: 'Atlas built-in sample',
        created: new Date().toISOString(),
        featureCount: geojson.features?.length ?? 0,
        geojson
      };
      await fs.writeFile(target, JSON.stringify(record));
      await appendLog({ event: 'dataset.created', dataset: id, name: record.name, featureCount: record.featureCount, license: record.license, via: 'seed' });
    }
  }
}

// ---------------------------------------------------------------------------
// Open-data activity log: every dataset event is appended to a public,
// append-only JSONL log served at /api/log.
// ---------------------------------------------------------------------------

const LOG_FILE = () => path.join(DATA_DIR, 'activity.jsonl');

async function appendLog(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  await fs.appendFile(LOG_FILE(), line).catch((err) => console.error('log write failed:', err.message));
}

async function readLog(limit = 100) {
  let raw = '';
  try {
    raw = await fs.readFile(LOG_FILE(), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function datasetPath(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null; // prevent path traversal
  return path.join(DATA_DIR, `${id}.json`);
}

async function listDatasets() {
  const files = await fs.readdir(DATA_DIR).catch(() => []);
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
      const { geojson, ...meta } = record;
      out.push(meta);
    } catch {
      // skip unreadable files
    }
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : 1));
}

async function readDataset(id) {
  const file = datasetPath(id);
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Geocoding: proxy to OSM Nominatim with a small in-memory cache.
// ---------------------------------------------------------------------------

const geocodeCache = new Map();

async function geocode(query, limit = 5) {
  const key = `${query}|${limit}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0' +
    `&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Atlas-GIS/0.1 (https://github.com/Savagecode100/hello-world)' }
  });
  if (!res.ok) throw new Error(`Geocoder responded ${res.status}`);
  const raw = await res.json();
  const results = raw.map((r) => ({
    name: r.display_name,
    type: r.type,
    lat: Number(r.lat),
    lng: Number(r.lon),
    boundingBox: r.boundingbox
      ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])]
      : null // [west, south, east, north]
  }));
  geocodeCache.set(key, results);
  if (geocodeCache.size > 500) geocodeCache.delete(geocodeCache.keys().next().value);
  return results;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, baseDir, relPath) {
  const filePath = path.normalize(path.join(baseDir, relPath));
  if (!filePath.startsWith(baseDir)) {
    sendJSON(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  } catch {
    sendJSON(res, 404, { error: 'Not found' });
  }
}

function validateGeoJSON(geojson) {
  if (!geojson || typeof geojson !== 'object') return 'Body must be a GeoJSON object';
  if (geojson.type === 'FeatureCollection') {
    if (!Array.isArray(geojson.features)) return 'FeatureCollection must have a features array';
    return null;
  }
  if (geojson.type === 'Feature') return null;
  return 'GeoJSON must be a Feature or FeatureCollection';
}

// ---------------------------------------------------------------------------
// Embed page: renders a full-page map from query params via the SDK.
// ---------------------------------------------------------------------------

function embedPage(params) {
  const opts = {
    style: params.get('style') || 'streets',
    mapType: params.get('maptype') || params.get('mapType') || 'pins',
    zoom: params.has('zoom') ? Number(params.get('zoom')) : 2,
    center: params.has('center') ? params.get('center').split(',').map(Number) : [0, 20],
    dataset: params.get('dataset') || null,
    valueProperty: params.get('value') || null,
    interactive: params.get('interactive') !== 'false',
    legend: params.get('legend') !== 'false',
    title: params.get('title') || null
  };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas embedded map</title>
<style>html,body,#map{margin:0;height:100%;width:100%}</style>
</head>
<body>
<div id="map"></div>
<script src="/sdk/atlas-sdk.js"></script>
<script>
Atlas.createMap('#map', ${JSON.stringify(opts)}).catch(function (err) {
  document.body.textContent = 'Failed to load map: ' + err.message;
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleAPI(req, res, url) {
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (route === '/api/health') {
    sendJSON(res, 200, { ok: true, service: 'atlas', version: '0.2.0' });
    return;
  }

  if (route === '/api/styles') {
    sendJSON(res, 200, { styles: BASEMAP_STYLES });
    return;
  }

  if (route === '/api/maptypes') {
    sendJSON(res, 200, { mapTypes: MAP_TYPES });
    return;
  }

  if (route === '/api/geocode') {
    const q = url.searchParams.get('q');
    if (!q) {
      sendJSON(res, 400, { error: 'Missing required query parameter: q' });
      return;
    }
    try {
      const results = await geocode(q, Math.min(Number(url.searchParams.get('limit') || 5), 20));
      sendJSON(res, 200, { query: q, results });
    } catch (err) {
      sendJSON(res, 502, { error: `Geocoding failed: ${err.message}` });
    }
    return;
  }

  if (route === '/api/datasets' && req.method === 'GET') {
    sendJSON(res, 200, { datasets: await listDatasets() });
    return;
  }

  if (route === '/api/datasets' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJSON(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON body' });
      return;
    }
    const geojson = body.geojson || body;
    const invalid = validateGeoJSON(geojson);
    if (invalid) {
      sendJSON(res, 400, { error: invalid });
      return;
    }
    const id = body.id && /^[A-Za-z0-9_-]+$/.test(body.id) ? body.id : crypto.randomBytes(6).toString('hex');
    const record = {
      id,
      name: body.name || geojson.name || id,
      description: body.description || '',
      // All published datasets are open data: default license is CC BY 4.0.
      license: body.license || 'CC BY 4.0',
      source: body.source || '',
      created: new Date().toISOString(),
      featureCount: geojson.type === 'FeatureCollection' ? geojson.features.length : 1,
      geojson
    };
    await fs.writeFile(datasetPath(id), JSON.stringify(record));
    await appendLog({ event: 'dataset.created', dataset: id, name: record.name, featureCount: record.featureCount, license: record.license, via: 'api' });
    const { geojson: _g, ...meta } = record;
    sendJSON(res, 201, { dataset: meta });
    return;
  }

  // Public activity log: every dataset event, newest first.
  if (route === '/api/log') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 1000);
    sendJSON(res, 200, { events: await readLog(limit) });
    return;
  }

  // Raw open-data download of a dataset's GeoJSON.
  const downloadMatch = route.match(/^\/api\/datasets\/([A-Za-z0-9_-]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const record = await readDataset(downloadMatch[1]);
    if (!record) {
      sendJSON(res, 404, { error: `Dataset not found: ${downloadMatch[1]}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/geo+json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${record.id}.geojson"`,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(record.geojson));
    return;
  }

  const datasetMatch = route.match(/^\/api\/datasets\/([A-Za-z0-9_-]+)$/);
  if (datasetMatch) {
    const id = datasetMatch[1];
    if (req.method === 'GET') {
      const record = await readDataset(id);
      if (!record) {
        sendJSON(res, 404, { error: `Dataset not found: ${id}` });
        return;
      }
      sendJSON(res, 200, { dataset: record });
      return;
    }
    if (req.method === 'DELETE') {
      try {
        await fs.unlink(datasetPath(id));
        await appendLog({ event: 'dataset.deleted', dataset: id, via: 'api' });
        sendJSON(res, 200, { deleted: id });
      } catch {
        sendJSON(res, 404, { error: `Dataset not found: ${id}` });
      }
      return;
    }
  }

  // Map spec: a renderable description of a map, consumable by the SDK.
  if (route === '/api/map') {
    const styleId = url.searchParams.get('style') || 'streets';
    const mapTypeId = url.searchParams.get('maptype') || 'pins';
    const style = getStyle(styleId);
    const mapType = getMapType(mapTypeId);
    if (!style) {
      sendJSON(res, 400, { error: `Unknown style: ${styleId}` });
      return;
    }
    if (!mapType) {
      sendJSON(res, 400, { error: `Unknown map type: ${mapTypeId}` });
      return;
    }
    const datasetId = url.searchParams.get('dataset');
    const spec = {
      style: style.style,
      styleId: style.id,
      mapType: mapType.id,
      center: url.searchParams.has('center')
        ? url.searchParams.get('center').split(',').map(Number)
        : [0, 20],
      zoom: url.searchParams.has('zoom') ? Number(url.searchParams.get('zoom')) : 2,
      dataUrl: datasetId ? `/api/datasets/${datasetId}` : null,
      valueProperty: url.searchParams.get('value') || null,
      embedUrl: `/embed?${url.searchParams.toString()}`
    };
    sendJSON(res, 200, { map: spec });
    return;
  }

  sendJSON(res, 404, { error: `Unknown API route: ${route}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleAPI(req, res, url);
      return;
    }
    if (url.pathname === '/embed') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(embedPage(url.searchParams));
      return;
    }
    if (url.pathname.startsWith('/sdk/')) {
      await serveStatic(res, SDK_DIR, url.pathname.slice('/sdk/'.length));
      return;
    }
    if (url.pathname.startsWith('/examples/')) {
      await serveStatic(res, EXAMPLES_DIR, url.pathname.slice('/examples/'.length));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    await serveStatic(res, PUBLIC_DIR, rel);
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

await ensureDataDir();
server.listen(PORT, () => {
  console.log(`Atlas is running:
  Studio app : http://localhost:${PORT}/
  REST API   : http://localhost:${PORT}/api/health
  SDK        : http://localhost:${PORT}/sdk/atlas-sdk.js
  Embed demo : http://localhost:${PORT}/embed?dataset=acme-locations&maptype=clusters&style=light&center=-96,38&zoom=4`);
});
