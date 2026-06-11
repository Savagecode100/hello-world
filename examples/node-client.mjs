// Using the Atlas SDK from Node (server-to-server): register an account,
// geocode places, publish a dataset with an API key, and print an embed URL
// you can drop into any app.
//
// Run the server first (`npm start`), then: node examples/node-client.mjs

await import('../sdk/atlas-sdk.js'); // registers globalThis.Atlas
const BASE = 'http://localhost:8787';

// 0. Get an API key: register an account (or sign in if it already exists).
const account = { email: 'sdk-demo@example.com', password: 'sdk-demo-password', name: 'SDK Demo' };
let res = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(account)
});
if (res.status === 409) {
  res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account)
  });
}
const { user } = await res.json();
console.log('Authenticated as:', user.email);

const atlas = new globalThis.Atlas.Client({ baseUrl: BASE, apiKey: user.apiKey });

// 1. Geocode anywhere in the world.
const [paris] = await atlas.geocode('Paris, France', 1);
console.log('Geocoded:', paris.name, '->', paris.lat, paris.lng);

// 2. Publish a dataset programmatically (e.g. straight from your CRM/ERP).
const offices = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Paris office', headcount: 42 }, geometry: { type: 'Point', coordinates: [paris.lng, paris.lat] } },
    { type: 'Feature', properties: { name: 'Berlin office', headcount: 25 }, geometry: { type: 'Point', coordinates: [13.405, 52.52] } },
    { type: 'Feature', properties: { name: 'Madrid office', headcount: 18 }, geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] } }
  ]
};
const dataset = await atlas.createDataset(offices, { id: 'eu-offices', name: 'EU Offices' });
console.log('Published dataset:', dataset.id, `(${dataset.featureCount} features)`);

// 3. Get a ready-to-embed map URL for an outside application.
const url = atlas.embedUrl({
  dataset: dataset.id,
  maptype: 'bubble',
  value: 'headcount',
  style: 'light',
  center: '8,48',
  zoom: 4
});
console.log('Embed this anywhere:', url);
