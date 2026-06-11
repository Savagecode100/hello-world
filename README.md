# Atlas — GIS & Map-Making Platform

Atlas is an intuitive, powerful map-making studio with a REST API and an embeddable
JavaScript SDK. Search any geography in the world, style your basemap, layer your own
datasets on top (e.g. every one of your company's locations), and ship the result —
as an interactive map in the studio, a PNG export, an iframe embed, or a map rendered
inside your own application via the SDK.

No API keys, no build step, zero npm dependencies. Just Node 18+.

```bash
npm start            # → http://localhost:8787
npm test             # run the API + SDK test suite
```

## What's inside

| Piece | Where | What it does |
|---|---|---|
| **Atlas Studio** | `public/` → http://localhost:8787 | The visual map-making app |
| **REST API** | `server/` → `/api/*` | Geocoding, styles, map types, datasets, map specs |
| **Atlas SDK** | `sdk/atlas-sdk.js` | Drop Atlas maps into any outside application |
| **Embed endpoint** | `/embed?…` | Zero-JS iframe maps |
| **Examples** | `examples/` | Browser embedding + Node API client |

## Atlas Studio

Open http://localhost:8787 and you can:

- **Find any place in the world** — the search box geocodes countries, cities,
  addresses, and landmarks (OpenStreetMap Nominatim) and flies the map there.
- **Switch basemap styles** at any scale: Streets, Bright, Light, Dark, Satellite,
  Terrain, and classic OSM. All open, key-free tile services.
- **Import your data** — drop in a GeoJSON file or a CSV (latitude/longitude
  columns are auto-detected). Example workflow: look at the USA, import a CSV of
  all of a company's locations, and they render instantly.
- **Pick a preloaded map type per layer** and switch between them live:

  | Map type | Use it for |
  |---|---|
  | Pin map | Small location lists with popups |
  | Cluster map | Large location lists (hundreds–thousands of points) |
  | Heatmap | Density / concentration, optionally weighted by a value |
  | Bubble map | Circles sized by revenue, headcount, sales… |
  | Choropleth | Polygons (states, counties) shaded by a value |
  | Route / network | Lines, corridors, networks |

- **Save datasets to the server** so they're available to the API, embeds, and the SDK.
- **Export PNG** of the current view, **fit to data**, and **copy an embed link**
  that reproduces the current map.

A sample dataset (`acme-locations` — 40 fictional company locations across the USA
with revenue and headcount) ships preloaded so everything is demoable immediately.

## REST API

All endpoints return JSON and send permissive CORS headers.

| Endpoint | Description |
|---|---|
| `GET /api/health` | Service status |
| `GET /api/styles` | Basemap style catalog (id, name, MapLibre style) |
| `GET /api/maptypes` | Preloaded map type catalog |
| `GET /api/geocode?q=Tokyo&limit=5` | Geocode any place in the world |
| `GET /api/datasets` | List stored datasets |
| `POST /api/datasets` | Store a dataset: `{ id?, name?, description?, geojson }` |
| `GET /api/datasets/:id` | Fetch a dataset with its GeoJSON |
| `DELETE /api/datasets/:id` | Delete a dataset |
| `GET /api/map?style=dark&maptype=bubble&dataset=acme-locations&value=revenue_musd&center=-96,38&zoom=4` | A renderable "map spec" (style + data + view) consumable by the SDK, plus its embed URL |
| `GET /embed?…` (same params) | A full HTML page rendering that map — iframe it anywhere |

Example:

```bash
curl "http://localhost:8787/api/geocode?q=Lagos,+Nigeria"
curl -X POST http://localhost:8787/api/datasets \
  -H "Content-Type: application/json" \
  -d '{"name":"My stores","geojson":{"type":"FeatureCollection","features":[...]}}'
```

## Atlas SDK — use maps in your own applications

The SDK is a single file (`/sdk/atlas-sdk.js`) that works from a plain `<script>`
tag. It loads MapLibre GL automatically.

```html
<div id="map" style="height:400px"></div>
<script src="https://your-atlas-host/sdk/atlas-sdk.js"></script>
<script>
  Atlas.createMap('#map', {
    baseUrl: 'https://your-atlas-host',
    style: 'light',                 // any preset id, style URL, or style object
    mapType: 'clusters',            // pins | clusters | heatmap | bubble | choropleth | route
    dataset: 'acme-locations',      // or data: <GeoJSON>, or dataUrl: '<url>'
    valueProperty: 'revenue_musd',  // drives bubble size / heat weight / choropleth shade
    center: [-96, 38], zoom: 4
  }).then(async (map) => {
    await map.flyToPlace('Chicago');        // geocode + fly anywhere
    map.addData(myGeoJSON, { mapType: 'heatmap' });
    map.setBasemap('dark');                 // data layers survive style switches
    map.exportPNG('map.png');               // download the current view
    map.map;                                // escape hatch: the raw MapLibre map
  });
</script>
```

From Node (server-to-server — geocode, publish datasets, mint embed URLs):

```js
await import('./sdk/atlas-sdk.js');
const atlas = new globalThis.Atlas.Client({ baseUrl: 'http://localhost:8787' });

const [place] = await atlas.geocode('Paris, France');
const ds = await atlas.createDataset(myGeoJSON, { name: 'EU Offices' });
const url = atlas.embedUrl({ dataset: ds.id, maptype: 'bubble', value: 'headcount' });
```

See it all working: http://localhost:8787/examples/embed-example.html and
`node examples/node-client.mjs`.

### SDK surface

- `Atlas.createMap(container, options) → Promise<AtlasMap>`
- `AtlasMap`: `addData`, `removeData`, `clearData`, `setMapType`, `setBasemap`,
  `flyToPlace`, `fitToData`, `exportPNG`, `listLayersets`, `remove`, `.map` (raw MapLibre)
- `Atlas.Client`: `geocode`, `getStyles`, `getMapTypes`, `listDatasets`,
  `getDataset`, `createDataset`, `deleteDataset`, `embedUrl`, `health`
- `Atlas.csvToGeoJSON(text)` — CSV → GeoJSON with lat/lng auto-detection
- `Atlas.utils` — `toFeatureCollection`, `dataBounds`, `numericProperties`, `parseCSV`

## Architecture

```
server/index.js     zero-dependency Node HTTP server: static hosting + REST API
server/presets.js   basemap style + map type catalogs (extend here)
server/seed/        built-in sample datasets, seeded into data/ on first run
public/             Atlas Studio (built on the SDK — same code paths as embedders)
sdk/atlas-sdk.js    the developer kit: API client + map renderer (MapLibre GL)
examples/           browser + Node integration examples
data/               dataset store (gitignored, created at runtime)
```

Rendering is MapLibre GL JS (open-source, vector + raster). Geocoding is proxied
through the server to OSM Nominatim with caching — please respect their
[usage policy](https://operations.osmfoundation.org/policies/nominatim/) for
production traffic, or point the proxy at your own geocoder.

## Extending Atlas

- **New basemap style** → add an entry to `BASEMAP_STYLES` in `server/presets.js`
  (a style URL or inline MapLibre style). It appears in the studio, API, and SDK.
- **New map type** → add a catalog entry in `server/presets.js` and a layer
  builder in `LAYER_BUILDERS` in `sdk/atlas-sdk.js`.
- **New API route** → add it to `handleAPI` in `server/index.js`.
