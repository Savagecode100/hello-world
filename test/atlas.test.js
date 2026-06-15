import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18787;
const BASE = `http://localhost:${PORT}`;

let serverProc;

before(async () => {
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Atlas is running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProc.on('exit', (code) => reject(new Error(`Server exited early (${code})`)));
  });
});

after(() => {
  serverProc?.kill();
});

test('health endpoint responds', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'atlas');
});

test('styles catalog includes the preloaded basemaps', async () => {
  const { styles } = await (await fetch(`${BASE}/api/styles`)).json();
  const ids = styles.map((s) => s.id);
  for (const expected of ['streets', 'light', 'dark', 'satellite', 'terrain']) {
    assert.ok(ids.includes(expected), `missing style: ${expected}`);
  }
  for (const s of styles) {
    assert.ok(s.name && s.style, `style ${s.id} missing name or style`);
  }
});

test('map type catalog includes the preloaded map types', async () => {
  const { mapTypes } = await (await fetch(`${BASE}/api/maptypes`)).json();
  const ids = mapTypes.map((t) => t.id);
  for (const expected of ['pins', 'clusters', 'heatmap', 'bubble', 'choropleth', 'route']) {
    assert.ok(ids.includes(expected), `missing map type: ${expected}`);
  }
});

test('sample dataset is seeded and retrievable', async () => {
  const { datasets } = await (await fetch(`${BASE}/api/datasets`)).json();
  assert.ok(datasets.some((d) => d.id === 'acme-locations'), 'acme-locations not seeded');

  const { dataset } = await (await fetch(`${BASE}/api/datasets/acme-locations`)).json();
  assert.equal(dataset.geojson.type, 'FeatureCollection');
  assert.ok(dataset.geojson.features.length >= 30);
});

test('dataset create, fetch, and delete round-trip', async () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A', value: 10 }, geometry: { type: 'Point', coordinates: [-73.9, 40.7] } }
    ]
  };
  const createRes = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'test-suite-ds', name: 'Test dataset', geojson })
  });
  assert.equal(createRes.status, 201);
  const { dataset: meta } = await createRes.json();
  assert.equal(meta.id, 'test-suite-ds');
  assert.equal(meta.featureCount, 1);

  const { dataset } = await (await fetch(`${BASE}/api/datasets/test-suite-ds`)).json();
  assert.equal(dataset.geojson.features[0].properties.name, 'A');

  const delRes = await fetch(`${BASE}/api/datasets/test-suite-ds`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const missing = await fetch(`${BASE}/api/datasets/test-suite-ds`);
  assert.equal(missing.status, 404);
});

test('rejects invalid GeoJSON uploads', async () => {
  const res = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson: { type: 'NotGeoJSON' } })
  });
  assert.equal(res.status, 400);
});

test('map spec endpoint composes style + map type + dataset', async () => {
  const res = await fetch(`${BASE}/api/map?style=dark&maptype=bubble&dataset=acme-locations&value=revenue_musd&center=-96,38&zoom=4`);
  assert.equal(res.status, 200);
  const { map } = await res.json();
  assert.equal(map.styleId, 'dark');
  assert.equal(map.mapType, 'bubble');
  assert.equal(map.valueProperty, 'revenue_musd');
  assert.equal(map.dataUrl, '/api/datasets/acme-locations');
  assert.deepEqual(map.center, [-96, 38]);
});

test('map spec endpoint rejects unknown presets', async () => {
  assert.equal((await fetch(`${BASE}/api/map?style=nope`)).status, 400);
  assert.equal((await fetch(`${BASE}/api/map?maptype=nope`)).status, 400);
});

test('embed page renders HTML wired to the SDK', async () => {
  const res = await fetch(`${BASE}/embed?dataset=acme-locations&maptype=clusters&style=light`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('/sdk/atlas-sdk.js'));
  assert.ok(html.includes('Atlas.createMap'));
  assert.ok(html.includes('"dataset":"acme-locations"'));
});

test('studio app and SDK are served', async () => {
  const app = await fetch(`${BASE}/`);
  assert.equal(app.status, 200);
  assert.ok((await app.text()).includes('Atlas'));
  const sdk = await fetch(`${BASE}/sdk/atlas-sdk.js`);
  assert.equal(sdk.status, 200);
});

test('SDK utilities: CSV with lat/lng auto-detection converts to GeoJSON', async () => {
  await import('../sdk/atlas-sdk.js');
  const Atlas = globalThis.Atlas;
  const csv = 'name,latitude,longitude,revenue\n"Store, One",40.7,-74.0,12\nStore Two,34.05,-118.24,30\nbad row,,,\n';
  const fc = Atlas.csvToGeoJSON(csv);
  assert.equal(fc.features.length, 2);
  assert.deepEqual(fc.features[0].geometry.coordinates, [-74.0, 40.7]);
  assert.equal(fc.features[0].properties.name, 'Store, One');
  assert.equal(fc.features[1].properties.revenue, 30);

  const bounds = Atlas.utils.dataBounds(fc);
  assert.deepEqual(bounds, [[-118.24, 34.05], [-74.0, 40.7]]);

  assert.deepEqual(Atlas.utils.numericProperties(fc), ['revenue']);
});

test('SDK utilities: CSV without coordinates throws a helpful error', async () => {
  await import('../sdk/atlas-sdk.js');
  assert.throws(() => globalThis.Atlas.csvToGeoJSON('a,b\n1,2\n'), /latitude\/longitude/);
});

// ---------------------------------------------------------------------------
// Time-series / time-lapse
// ---------------------------------------------------------------------------

const TEMPORAL_FC = {
  type: 'FeatureCollection',
  temporal: { property: 'timestamp', interpolate: 'linear' },
  features: [
    {
      type: 'Feature',
      properties: { name: 'A' },
      geometry: { type: 'Point', coordinates: [-74, 40.7] },
      timeSeries: [
        { timestamp: '2024-01-01', properties: { value: 100 } },
        { timestamp: '2024-03-01', properties: { value: 200 } }
      ]
    },
    {
      type: 'Feature',
      properties: { name: 'B (born later)' },
      geometry: { type: 'Point', coordinates: [-118, 34] },
      timeSeries: [
        { timestamp: '2024-02-01', properties: { value: 50 } }
      ]
    }
  ]
};

test('timeseries module: detects temporal data and enumerates frames', async () => {
  const { isTemporal, collectTimestamps } = await import('../server/timeseries.js');
  assert.equal(isTemporal(TEMPORAL_FC), true);
  assert.equal(isTemporal({ type: 'FeatureCollection', features: [] }), false);
  assert.deepEqual(collectTimestamps(TEMPORAL_FC), ['2024-01-01', '2024-02-01', '2024-03-01']);
});

test('timeseries module: validation catches bad timestamps and shapes', async () => {
  const { validateTimeSeries } = await import('../server/timeseries.js');
  assert.equal(validateTimeSeries(TEMPORAL_FC), null);
  const bad = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: null, timeSeries: [{ properties: {} }] }
    ]
  };
  assert.match(validateTimeSeries(bad), /missing timestamp/);
});

test('timeseries module: frameAt excludes unborn features and interpolates', async () => {
  const { frameAt } = await import('../server/timeseries.js');
  // Before B is born: only A present.
  const early = frameAt(TEMPORAL_FC, '2024-01-01', 'linear');
  assert.equal(early.features.length, 1);
  assert.equal(early.features[0].properties.value, 100);
  // 2024-02-01 is roughly halfway between A's Jan and Mar snapshots: value ~150.
  const mid = frameAt(TEMPORAL_FC, '2024-02-01', 'linear');
  assert.equal(mid.features.length, 2); // B now present
  const a = mid.features.find((f) => f.properties.name === 'A');
  assert.ok(Math.abs(a.properties.value - 150) < 2, `expected ~150, got ${a.properties.value}`);
});

test('timeseries module: step interpolation holds the last value', async () => {
  const { frameAt } = await import('../server/timeseries.js');
  const mid = frameAt(TEMPORAL_FC, '2024-02-15', 'step');
  const a = mid.features.find((f) => f.properties.name === 'A');
  assert.equal(a.properties.value, 100); // holds Jan value until Mar
});

test('temporal sample datasets are seeded with frame metadata', async () => {
  const { datasets } = await (await fetch(`${BASE}/api/datasets`)).json();
  const growth = datasets.find((d) => d.id === 'acme-growth');
  assert.ok(growth, 'acme-growth not seeded');
  assert.equal(growth.temporal, true);
  assert.ok(growth.frameCount >= 6);
});

test('frames endpoint lists ordered timestamps', async () => {
  const res = await fetch(`${BASE}/api/datasets/acme-growth/frames`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.timestamps));
  assert.equal(body.frameCount, body.timestamps.length);
  const sorted = [...body.timestamps].sort();
  assert.deepEqual(body.timestamps, sorted);
});

test('frame endpoint returns a flattened FeatureCollection at a timestamp', async () => {
  const { timestamps } = await (await fetch(`${BASE}/api/datasets/acme-growth/frames`)).json();
  const at = timestamps[0];
  const res = await fetch(`${BASE}/api/datasets/acme-growth/frame?at=${encodeURIComponent(at)}`);
  assert.equal(res.status, 200);
  const { geojson } = await res.json();
  assert.equal(geojson.type, 'FeatureCollection');
  assert.ok(geojson.features.length > 0);
  assert.ok(geojson.features.every((f) => !Array.isArray(f.timeSeries)));
  assert.ok(geojson.features.every((f) => typeof f.properties.employees === 'number'));
});

test('expansion dataset progressively reveals features over time', async () => {
  const { timestamps } = await (await fetch(`${BASE}/api/datasets/acme-expansion/frames`)).json();
  const firstUrl = `${BASE}/api/datasets/acme-expansion/frame?at=${encodeURIComponent(timestamps[0])}`;
  const lastUrl = `${BASE}/api/datasets/acme-expansion/frame?at=${encodeURIComponent(timestamps[timestamps.length - 1])}`;
  const first = await (await fetch(firstUrl)).json();
  const last = await (await fetch(lastUrl)).json();
  assert.ok(
    last.geojson.features.length > first.geojson.features.length,
    'later frame should reveal more features'
  );
});

test('frames endpoint rejects non-temporal datasets', async () => {
  const res = await fetch(`${BASE}/api/datasets/acme-locations/frames`);
  assert.equal(res.status, 400);
});

test('CSV converter groups long-format rows into per-feature snapshots', async () => {
  const { csvToTimeSeries } = await import('../server/converters.js');
  const csv = [
    'id,timestamp,lat,lng,sales',
    'Store A,2024-01-01,40.7,-74.0,10',
    'Store A,2024-02-01,40.7,-74.0,20',
    'Store B,2024-01-01,34.0,-118.2,5'
  ].join('\n');
  const fc = csvToTimeSeries(csv, { interpolate: 'linear' });
  assert.equal(fc.features.length, 2);
  const a = fc.features.find((f) => f.properties.name === 'Store A');
  assert.equal(a.timeSeries.length, 2);
  assert.equal(a.timeSeries[0].properties.sales, 10);
  assert.equal(fc.temporal.interpolate, 'linear');
});

test('SDK exposes time-series helpers and client-side CSV grouping', async () => {
  await import('../sdk/atlas-sdk.js');
  const Atlas = globalThis.Atlas;
  assert.equal(typeof Atlas.TimeSeriesPlayer, 'function');
  assert.equal(typeof Atlas.csvToTimeSeries, 'function');
  assert.equal(Atlas.utils.isTemporal(TEMPORAL_FC), true);
  assert.deepEqual(Atlas.utils.collectTimestamps(TEMPORAL_FC), ['2024-01-01', '2024-02-01', '2024-03-01']);

  const csv = 'name,date,lat,lng,v\nX,2024-01-01,1,2,3\nX,2024-02-01,1,2,9\n';
  const fc = Atlas.csvToTimeSeries(csv);
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].timeSeries.length, 2);
});
