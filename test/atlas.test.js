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
