// Atlas preset catalogs: basemap styles and preloaded map types.
// All basemaps use open, key-free tile services with proper attribution.

function rasterStyle(id, tiles, attribution, maxzoom = 19) {
  return {
    version: 8,
    name: id,
    sources: {
      base: { type: 'raster', tiles, tileSize: 256, attribution, maxzoom }
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }]
  };
}

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const BASEMAP_STYLES = [
  {
    id: 'streets',
    name: 'Streets',
    description: 'General-purpose vector street map (OpenFreeMap Liberty)',
    style: 'https://tiles.openfreemap.org/styles/liberty'
  },
  {
    id: 'bright',
    name: 'Bright',
    description: 'High-contrast colorful vector map (OpenFreeMap Bright)',
    style: 'https://tiles.openfreemap.org/styles/bright'
  },
  {
    id: 'light',
    name: 'Light',
    description: 'Muted light basemap, ideal under data visualizations (Positron)',
    style: 'https://tiles.openfreemap.org/styles/positron'
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Dark basemap for dashboards and heatmaps (CARTO Dark Matter)',
    style: rasterStyle(
      'dark',
      [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
      ],
      OSM_ATTR + ' &copy; <a href="https://carto.com/attributions">CARTO</a>'
    )
  },
  {
    id: 'satellite',
    name: 'Satellite',
    description: 'World aerial imagery (Esri World Imagery)',
    style: rasterStyle(
      'satellite',
      ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    )
  },
  {
    id: 'terrain',
    name: 'Terrain',
    description: 'Topographic map with relief shading and contours (OpenTopoMap)',
    style: rasterStyle(
      'terrain',
      [
        'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'
      ],
      OSM_ATTR + ', SRTM | Map style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      17
    )
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    description: 'Classic OpenStreetMap raster tiles',
    style: rasterStyle('osm', ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], OSM_ATTR)
  }
];

// Preloaded map types. Each describes how a GeoJSON dataset is rendered.
// `layers` are MapLibre layer fragments; the client/SDK fills in source ids.
// Placeholders: {VALUE} = numeric property chosen by the user (defaults below).
export const MAP_TYPES = [
  {
    id: 'pins',
    name: 'Pin map',
    description: 'Individual point markers with popups. Best for small location lists.',
    geometry: 'point',
    recommendedBasemaps: ['streets', 'light', 'bright'],
    options: {}
  },
  {
    id: 'clusters',
    name: 'Cluster map',
    description: 'Points grouped into clusters that expand on zoom. Best for large location lists (e.g., all company locations).',
    geometry: 'point',
    recommendedBasemaps: ['light', 'streets', 'dark'],
    options: { cluster: true, clusterRadius: 45 }
  },
  {
    id: 'heatmap',
    name: 'Heatmap',
    description: 'Density surface showing concentration of points, optionally weighted by a value.',
    geometry: 'point',
    recommendedBasemaps: ['dark', 'light'],
    options: { weightProperty: null }
  },
  {
    id: 'bubble',
    name: 'Bubble map',
    description: 'Graduated circles sized by a numeric value (revenue, headcount, sales...).',
    geometry: 'point',
    recommendedBasemaps: ['light', 'dark'],
    options: { valueProperty: null }
  },
  {
    id: 'choropleth',
    name: 'Choropleth',
    description: 'Polygons (states, counties, territories) shaded by a numeric value.',
    geometry: 'polygon',
    recommendedBasemaps: ['light', 'dark'],
    options: { valueProperty: null }
  },
  {
    id: 'route',
    name: 'Route / network map',
    description: 'Line geometry rendering for routes, corridors, and networks.',
    geometry: 'line',
    recommendedBasemaps: ['streets', 'terrain'],
    options: {}
  }
];

export function getStyle(id) {
  return BASEMAP_STYLES.find((s) => s.id === id) || null;
}

export function getMapType(id) {
  return MAP_TYPES.find((t) => t.id === id) || null;
}
