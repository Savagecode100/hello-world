import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18787;
const BASE = `http://localhost:${PORT}`;

let serverProc;

// Test users registered in before(); unique per run since the DB persists.
const RUN = Date.now();
const userA = { email: `owner-${RUN}@test.dev`, password: 'password-123', name: 'Owner' };
const userB = { email: `other-${RUN}@test.dev`, password: 'password-456', name: 'Other' };

async function register(user) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user: created } = await res.json();
  return { cookie, apiKey: created.apiKey, user: created };
}

function authed(creds, extra = {}) {
  return { Cookie: creds.cookie, 'Content-Type': 'application/json', ...extra };
}

let credsA;
let credsB;

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
  credsA = await register(userA);
  credsB = await register(userB);
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
    headers: authed(credsA),
    body: JSON.stringify({ id: 'test-suite-ds', name: 'Test dataset', geojson })
  });
  assert.equal(createRes.status, 201);
  const { dataset: meta } = await createRes.json();
  assert.equal(meta.id, 'test-suite-ds');
  assert.equal(meta.featureCount, 1);
  assert.equal(meta.owner, userA.email);

  const { dataset } = await (await fetch(`${BASE}/api/datasets/test-suite-ds`)).json();
  assert.equal(dataset.geojson.features[0].properties.name, 'A');

  const delRes = await fetch(`${BASE}/api/datasets/test-suite-ds`, { method: 'DELETE', headers: authed(credsA) });
  assert.equal(delRes.status, 200);
  const missing = await fetch(`${BASE}/api/datasets/test-suite-ds`);
  assert.equal(missing.status, 404);
});

test('rejects invalid GeoJSON uploads', async () => {
  const res = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: authed(credsA),
    body: JSON.stringify({ geojson: { type: 'NotGeoJSON' } })
  });
  assert.equal(res.status, 400);
});

test('publishing and deleting require authentication', async () => {
  const geojson = { type: 'FeatureCollection', features: [] };
  const anon = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson })
  });
  assert.equal(anon.status, 401);

  const anonDelete = await fetch(`${BASE}/api/datasets/acme-locations`, { method: 'DELETE' });
  assert.equal(anonDelete.status, 401);
});

test('auth flow: me, API key bearer auth, owner-only delete, logout', async () => {
  // Session cookie identifies the user
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: credsA.cookie } })).json();
  assert.equal(me.user.email, userA.email);

  // API key works as a Bearer token (server-to-server / SDK usage)
  const viaKey = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credsA.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'owned-ds', geojson: { type: 'FeatureCollection', features: [] } })
  });
  assert.equal(viaKey.status, 201);

  // Another user cannot delete a dataset they don't own
  const forbidden = await fetch(`${BASE}/api/datasets/owned-ds`, { method: 'DELETE', headers: authed(credsB) });
  assert.equal(forbidden.status, 403);

  // The owner can
  const ok = await fetch(`${BASE}/api/datasets/owned-ds`, { method: 'DELETE', headers: authed(credsA) });
  assert.equal(ok.status, 200);

  // Wrong password is rejected
  const badLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userA.email, password: 'wrong-password' })
  });
  assert.equal(badLogin.status, 401);

  // Logout invalidates the session
  const fresh = await register({ email: `logout-${RUN}@test.dev`, password: 'password-789' });
  await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: fresh.cookie } });
  const after = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: fresh.cookie } });
  assert.equal(after.status, 401);
});

test('registration validates email and password', async () => {
  const badEmail = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'password-123' })
  });
  assert.equal(badEmail.status, 400);

  const shortPw = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `short-${RUN}@test.dev`, password: 'short' })
  });
  assert.equal(shortPw.status, 400);

  const dupe = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userA)
  });
  assert.equal(dupe.status, 409);
});

test('database logging: request log stats require auth and count traffic', async () => {
  const anon = await fetch(`${BASE}/api/stats`);
  assert.equal(anon.status, 401);

  const res = await fetch(`${BASE}/api/stats`, { headers: { Cookie: credsA.cookie } });
  assert.equal(res.status, 200);
  const { stats } = await res.json();
  assert.ok(stats.totalRequests > 0, 'request log should have entries');
  assert.ok(stats.totalUsers >= 2, 'users should be counted');
  assert.ok(Array.isArray(stats.recentRequests) && stats.recentRequests.length > 0);
  assert.ok(stats.recentRequests[0].path.startsWith('/api/'));
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

test('landing, studio, docs, data catalog, and SDK are served', async () => {
  const landing = await fetch(`${BASE}/`);
  assert.equal(landing.status, 200);
  const landingHTML = await landing.text();
  assert.ok(landingHTML.includes('Atlas'));
  assert.ok(landingHTML.includes('/studio'), 'landing should link to the studio');

  const studio = await fetch(`${BASE}/studio`);
  assert.equal(studio.status, 200);
  const studioHTML = await studio.text();
  assert.ok(studioHTML.includes('basemap-picker'));
  assert.ok(studioHTML.includes('auth-dialog'), 'studio should include the auth dialog');

  const docs = await fetch(`${BASE}/docs`);
  assert.equal(docs.status, 200);
  const docsHTML = await docs.text();
  assert.ok(docsHTML.includes('REST API reference'));
  assert.ok(docsHTML.includes('SDK reference'));

  const data = await fetch(`${BASE}/data`);
  assert.equal(data.status, 200);
  assert.ok((await data.text()).includes('Open Data Catalog'));

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

test('datasets are open data: default license, public log, raw download', async () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [0, 0] } }
    ]
  };
  const createRes = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: authed(credsA),
    body: JSON.stringify({ id: 'opendata-test', name: 'Open data test', geojson })
  });
  const { dataset: meta } = await createRes.json();
  assert.equal(meta.license, 'CC BY 4.0');

  // Raw GeoJSON download with attachment headers
  const dl = await fetch(`${BASE}/api/datasets/opendata-test/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /opendata-test\.geojson/);
  const raw = await dl.json();
  assert.equal(raw.type, 'FeatureCollection');
  assert.equal(raw.features.length, 1);

  await fetch(`${BASE}/api/datasets/opendata-test`, { method: 'DELETE', headers: authed(credsA) });

  // Both events are recorded in the database-backed public activity log,
  // attributed to the publishing user.
  const { events } = await (await fetch(`${BASE}/api/log`)).json();
  const created = events.find((e) => e.event === 'dataset.created' && e.dataset === 'opendata-test');
  const deleted = events.find((e) => e.event === 'dataset.deleted' && e.dataset === 'opendata-test');
  assert.ok(created, 'dataset.created not logged');
  assert.equal(created.license, 'CC BY 4.0');
  assert.equal(created.user, userA.email);
  assert.ok(deleted, 'dataset.deleted not logged');
  assert.ok(events.some((e) => e.event === 'user.registered'), 'registrations should be logged');
});

test('custom license is respected on upload', async () => {
  const geojson = { type: 'FeatureCollection', features: [] };
  const res = await fetch(`${BASE}/api/datasets`, {
    method: 'POST',
    headers: authed(credsA),
    body: JSON.stringify({ id: 'license-test', geojson, license: 'ODbL' })
  });
  const { dataset } = await res.json();
  assert.equal(dataset.license, 'ODbL');
  await fetch(`${BASE}/api/datasets/license-test`, { method: 'DELETE', headers: authed(credsA) });
});

test('embed page passes legend and title options to the SDK', async () => {
  const res = await fetch(`${BASE}/embed?dataset=acme-locations&legend=false&title=Quarterly+Footprint`);
  const html = await res.text();
  assert.ok(html.includes('"legend":false'));
  assert.ok(html.includes('"title":"Quarterly Footprint"'));

  const defaults = await (await fetch(`${BASE}/embed?dataset=acme-locations`)).text();
  assert.ok(defaults.includes('"legend":true'), 'legend should default to on');
});

test('open data catalog page is served', async () => {
  const res = await fetch(`${BASE}/data.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Open Data Catalog'));
  assert.ok(html.includes('/api/log'));
});

test('SDK buildLegend produces correct models per map type', async () => {
  await import('../sdk/atlas-sdk.js');
  const { buildLegend } = globalThis.Atlas.utils;
  const points = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { revenue: 10 }, geometry: { type: 'Point', coordinates: [0, 0] } },
      { type: 'Feature', properties: { revenue: 5000 }, geometry: { type: 'Point', coordinates: [1, 1] } }
    ]
  };

  const pins = buildLegend({ geojson: points, mapType: 'pins', name: 'Stores' });
  assert.equal(pins.title, 'Stores');
  assert.equal(pins.items[0].kind, 'dot');
  assert.match(pins.items[0].label, /2 locations/);

  const clusters = buildLegend({ geojson: points, mapType: 'clusters' });
  assert.equal(clusters.items.length, 4);
  assert.ok(clusters.items.every((i) => i.kind === 'dot'));

  const bubble = buildLegend({ geojson: points, mapType: 'bubble', valueProperty: 'revenue' });
  assert.equal(bubble.items[0].kind, 'circles');
  assert.equal(bubble.items[0].from, '10');
  assert.equal(bubble.items[0].to, '5,000');
  assert.match(bubble.subtitle, /revenue/);

  const heat = buildLegend({ geojson: points, mapType: 'heatmap' });
  assert.equal(heat.items[0].kind, 'gradient');
  assert.ok(heat.items[0].colors.length >= 2);

  const choropleth = buildLegend({ geojson: points, mapType: 'choropleth', valueProperty: 'revenue' });
  assert.equal(choropleth.items[0].kind, 'gradient');
  assert.equal(choropleth.items[0].to, '5,000');
});
