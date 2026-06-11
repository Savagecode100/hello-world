// Using the Atlas SDK from Node (server-to-server): geocode places and
// publish a dataset, then print an embed URL you can drop into any app.
//
// Run the server first (`npm start`), then: node examples/node-client.mjs

await import('../sdk/atlas-sdk.js'); // registers globalThis.Atlas
const atlas = new globalThis.Atlas.Client({ baseUrl: 'http://localhost:8787' });

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
