# Atlas — GIS & Map-Making Platform

Atlas is an intuitive, powerful map-making studio with a REST API and an embeddable
JavaScript SDK. Search any geography in the world, style your basemap, layer your own
datasets on top (e.g. every one of your company's locations), and ship the result —
as an interactive map in the studio, a PNG export, an iframe embed, or a map rendered
inside your own application via the SDK.

No basemap API keys, no build step, zero npm dependencies. Just Node 22+
(accounts and logging use the built-in `node:sqlite` database).

```bash
npm start            # → http://localhost:8787
npm test             # run the API + SDK test suite
```

## What's inside

| Piece | Where | What it does |
|---|---|---|
| **Landing page** | `/` | Product overview with a live embedded map |
| **Atlas Studio** | `/studio` | The visual map-making app |
| **Documentation** | `/docs` | Full user + developer docs, served with the app |
| **Open data catalog** | `/data` | Every published dataset: license, download, embed |
| **REST API** | `/api/*` | Geocoding, styles, map types, datasets, auth, logs |
| **User accounts** | `server/auth.js`, `server/db.js` | Registration, sessions, API keys (SQLite) |
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

- **Automatic legends** — every map type generates a legend (cluster sizes, color
  ramps with real min/max values, bubble scales). Toggle it on the screen; it is
  **always baked into PNG exports**, along with your map title and basemap attribution.
- **Customize the output** — set a map title (shown on the map and in exports) and
  control the legend per map or per embed.
- **Publish datasets as open data** so they're available to the API, embeds, and the SDK.
- **Share & embed** — one dialog gives you a shareable link to the live interactive
  map, a copy-paste iframe snippet, and a ready-made SDK snippet, all reproducing
  your exact view, style, map type, title, and legend settings.
- **Export PNG** of the current view (legend included) and **fit to data**.

A sample dataset (`acme-locations` — 40 fictional company locations across the USA
with revenue and headcount) ships preloaded so everything is demoable immediately.

## Accounts, auth & API keys

Browsing, importing, and exporting need no account. **Publishing and deleting
datasets require sign-in**, and only a dataset's owner can delete it.

- Register/sign in from the studio sidebar, or via `POST /api/auth/register` /
  `POST /api/auth/login` (sets an HttpOnly session cookie, 30-day expiry).
- Every account gets an **API key** (shown in the studio) for server-to-server
  use: send `Authorization: Bearer <key>`, or pass `apiKey` to the SDK's `Client`.
- Passwords are scrypt-hashed with per-user salts; comparisons are timing-safe.

## Database logging (SQLite, built in)

All server state about *who did what, when* lives in `data/atlas.db`
(`node:sqlite` — still zero npm dependencies):

- **Users & sessions** — accounts, scrypt password hashes, API keys, session tokens.
- **Activity log** — every dataset publish/delete and account event, attributed
  to the acting user. Public at `GET /api/log` and on the `/data` page.
- **Request log** — every API and embed request (method, path, status, duration,
  user). Signed-in users can read aggregates at `GET /api/stats`.

## Open data by design

Every dataset published to an Atlas server is **open data**:

- **Licensed** — CC BY 4.0 by default (override with a `license` field on upload).
- **Cataloged** — http://localhost:8787/data lists every dataset with its
  license, download link, interactive map, and an "open in studio" deep link.
- **Downloadable** — raw GeoJSON at `GET /api/datasets/:id/download`, no auth, CORS open.
- **Logged** — every dataset creation and deletion is recorded in the public,
  database-backed activity log (`GET /api/log`, also rendered on the catalog page).

The studio tells users this before they publish, so nothing becomes public silently.

## REST API

All endpoints return JSON and send permissive CORS headers.

| Endpoint | Description |
|---|---|
| `GET /api/health` | Service status |
| `GET /api/styles` | Basemap style catalog (id, name, MapLibre style) |
| `GET /api/maptypes` | Preloaded map type catalog |
| `GET /api/geocode?q=Tokyo&limit=5` | Geocode any place in the world |
| `GET /api/datasets` | List stored datasets (with licenses and owners) |
| `POST /api/datasets` | 🔐 Publish a dataset: `{ id?, name?, description?, license?, source?, geojson }` |
| `GET /api/datasets/:id` | Fetch a dataset with its GeoJSON |
| `GET /api/datasets/:id/download` | Raw GeoJSON download (open data) |
| `DELETE /api/datasets/:id` | 🔐 Delete a dataset (owner only) |
| `GET /api/log?limit=100` | Public activity log of dataset & account events |
| `GET /api/stats` | 🔐 Request-log stats (totals + recent API requests) |
| `POST /api/auth/register` | Create an account: `{ email, password, name? }` |
| `POST /api/auth/login` / `POST /api/auth/logout` | Session management |
| `GET /api/auth/me` | 🔐 Current user, including your API key |

🔐 = requires a session cookie or `Authorization: Bearer <api key>`.
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
    title: 'Acme US Footprint',     // shown on the map and in PNG exports
    legend: true,                   // on-map legend (default: true)
    center: [-96, 38], zoom: 4
  }).then(async (map) => {
    await map.flyToPlace('Chicago');        // geocode + fly anywhere
    map.addData(myGeoJSON, { mapType: 'heatmap', name: 'My layer' });
    map.setBasemap('dark');                 // data layers survive style switches
    map.setTitle('Q3 Coverage');            // customize output any time
    map.setLegendVisible(false);            // hide on screen…
    map.exportPNG('map.png');               // …but PNGs always include legend,
    map.map;                                //    title, and attribution
  });
</script>
```

From Node (server-to-server — geocode, publish datasets, mint embed URLs):

```js
await import('./sdk/atlas-sdk.js');
const atlas = new globalThis.Atlas.Client({
  baseUrl: 'http://localhost:8787',
  apiKey: process.env.ATLAS_API_KEY   // from your account; needed for publishing
});

const [place] = await atlas.geocode('Paris, France');
const ds = await atlas.createDataset(myGeoJSON, { name: 'EU Offices' });
const url = atlas.embedUrl({ dataset: ds.id, maptype: 'bubble', value: 'headcount' });
```

See it all working: http://localhost:8787/examples/embed-example.html and
`node examples/node-client.mjs`.

### SDK surface

- `Atlas.createMap(container, options) → Promise<AtlasMap>` — options include
  `style`, `mapType`, `dataset`/`data`/`dataUrl`, `valueProperty`, `title`,
  `legend`, `center`, `zoom`, `interactive`, `fitData`
- `AtlasMap`: `addData`, `removeData`, `clearData`, `setMapType`, `setBasemap`,
  `setTitle`, `setLegendVisible`, `flyToPlace`, `fitToData`,
  `exportPNG(filename, { legend, title })`, `listLayersets`, `remove`, `.map` (raw MapLibre)
- `Atlas.Client` (`{ baseUrl, apiKey }`): `geocode`, `getStyles`, `getMapTypes`,
  `listDatasets`, `getDataset`, `createDataset`, `deleteDataset`, `embedUrl`,
  `health`, `me`
- `Atlas.csvToGeoJSON(text)` — CSV → GeoJSON with lat/lng auto-detection
- `Atlas.utils` — `toFeatureCollection`, `dataBounds`, `numericProperties`,
  `parseCSV`, `buildLegend`, `formatNumber`

Embed URL parameters (`/embed?…`): `dataset`, `maptype`, `value`, `style`,
`center`, `zoom`, `title`, `legend=false`, `interactive=false`.

## Architecture

```
server/index.js     zero-dependency Node HTTP server: pages + REST API
server/presets.js   basemap style + map type catalogs (extend here)
server/db.js        SQLite (node:sqlite): users, sessions, activity & request logs
server/auth.js      register / login / logout / me + request authentication
server/seed/        built-in sample datasets, seeded into data/ on first run
public/             landing (/), studio (/studio), docs (/docs), data catalog (/data)
sdk/atlas-sdk.js    the developer kit: API client + map renderer (MapLibre GL)
examples/           browser + Node integration examples
data/               runtime state: dataset files + atlas.db (gitignored)
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
