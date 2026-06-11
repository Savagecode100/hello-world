/*!
 * Atlas SDK v0.1.0
 * Embeddable maps + API client for the Atlas GIS platform.
 *
 * Browser usage:
 *   <script src="http://localhost:8787/sdk/atlas-sdk.js"></script>
 *   <script>
 *     Atlas.createMap('#map', {
 *       baseUrl: 'http://localhost:8787',
 *       style: 'light',
 *       mapType: 'clusters',
 *       dataset: 'acme-locations',   // or data: <GeoJSON> / dataUrl: <url>
 *       fitData: true
 *     });
 *   </script>
 *
 * Node usage (API client only):
 *   const { Client } = require('./sdk/atlas-sdk.js');
 *   const atlas = new Client({ baseUrl: 'http://localhost:8787' });
 *   const places = await atlas.geocode('Tokyo');
 */
(function (global) {
  'use strict';

  var MAPLIBRE_VERSION = '4.7.1';
  var MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@' + MAPLIBRE_VERSION + '/dist/maplibre-gl.js';
  var MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@' + MAPLIBRE_VERSION + '/dist/maplibre-gl.css';

  var COLORS = {
    pin: '#e63946',
    cluster: ['#74c0e8', '#3a86c8', '#1d3557'],
    rampLow: '#cfe8f3',
    rampHigh: '#08306b',
    line: '#3a86c8'
  };

  // -------------------------------------------------------------------------
  // API client (works in browsers and Node 18+)
  // -------------------------------------------------------------------------

  function Client(options) {
    options = options || {};
    this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
  }

  Client.prototype._fetch = function (path, init) {
    var url = this.baseUrl + path;
    return fetch(url, init).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ('Atlas API error ' + res.status));
        return body;
      });
    });
  };

  Client.prototype.health = function () {
    return this._fetch('/api/health');
  };

  Client.prototype.geocode = function (query, limit) {
    return this._fetch(
      '/api/geocode?q=' + encodeURIComponent(query) + (limit ? '&limit=' + limit : '')
    ).then(function (body) { return body.results; });
  };

  Client.prototype.getStyles = function () {
    return this._fetch('/api/styles').then(function (body) { return body.styles; });
  };

  Client.prototype.getMapTypes = function () {
    return this._fetch('/api/maptypes').then(function (body) { return body.mapTypes; });
  };

  Client.prototype.listDatasets = function () {
    return this._fetch('/api/datasets').then(function (body) { return body.datasets; });
  };

  Client.prototype.getDataset = function (id) {
    return this._fetch('/api/datasets/' + encodeURIComponent(id)).then(function (body) {
      return body.dataset;
    });
  };

  Client.prototype.createDataset = function (geojson, meta) {
    meta = meta || {};
    return this._fetch('/api/datasets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: meta.id, name: meta.name, description: meta.description, geojson: geojson })
    }).then(function (body) { return body.dataset; });
  };

  Client.prototype.deleteDataset = function (id) {
    return this._fetch('/api/datasets/' + encodeURIComponent(id), { method: 'DELETE' });
  };

  Client.prototype.embedUrl = function (params) {
    var qs = new URLSearchParams(params).toString();
    return this.baseUrl + '/embed?' + qs;
  };

  // -------------------------------------------------------------------------
  // MapLibre loader
  // -------------------------------------------------------------------------

  var maplibrePromise = null;

  function loadMapLibre() {
    if (global.maplibregl) return Promise.resolve(global.maplibregl);
    if (maplibrePromise) return maplibrePromise;
    maplibrePromise = new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
      var script = document.createElement('script');
      script.src = MAPLIBRE_JS;
      script.onload = function () { resolve(global.maplibregl); };
      script.onerror = function () { reject(new Error('Failed to load MapLibre GL JS from CDN')); };
      document.head.appendChild(script);
    });
    return maplibrePromise;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function toFeatureCollection(geojson) {
    if (!geojson) return { type: 'FeatureCollection', features: [] };
    if (geojson.type === 'FeatureCollection') return geojson;
    if (geojson.type === 'Feature') return { type: 'FeatureCollection', features: [geojson] };
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geojson }] };
  }

  function valueStats(fc, property) {
    var min = Infinity, max = -Infinity;
    fc.features.forEach(function (f) {
      var v = f.properties && Number(f.properties[property]);
      if (isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    if (!isFinite(min)) { min = 0; max = 1; }
    if (min === max) max = min + 1;
    return { min: min, max: max };
  }

  function numericProperties(fc) {
    var props = {};
    fc.features.slice(0, 200).forEach(function (f) {
      Object.keys(f.properties || {}).forEach(function (k) {
        if (isFinite(Number(f.properties[k])) && f.properties[k] !== '' && f.properties[k] !== null) {
          props[k] = true;
        }
      });
    });
    return Object.keys(props);
  }

  function dataBounds(fc) {
    var w = 180, s = 90, e = -180, n = -90, found = false;
    function visit(coords) {
      if (typeof coords[0] === 'number') {
        found = true;
        if (coords[0] < w) w = coords[0];
        if (coords[0] > e) e = coords[0];
        if (coords[1] < s) s = coords[1];
        if (coords[1] > n) n = coords[1];
      } else {
        coords.forEach(visit);
      }
    }
    fc.features.forEach(function (f) { if (f.geometry) visit(f.geometry.coordinates); });
    return found ? [[w, s], [e, n]] : null;
  }

  function popupHTML(properties) {
    var rows = Object.keys(properties || {}).map(function (k) {
      return '<tr><td style="padding:2px 8px 2px 0;color:#666;vertical-align:top">' + escapeHTML(k) +
        '</td><td style="padding:2px 0">' + escapeHTML(String(properties[k])) + '</td></tr>';
    });
    return '<table style="font:12px/1.5 system-ui,sans-serif;border-collapse:collapse">' + rows.join('') + '</table>';
  }

  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------------------------------------------------------------------------
  // Map-type layer builders. Each returns an array of MapLibre layer specs
  // for a given source id; `ctx` carries data-driven styling context.
  // -------------------------------------------------------------------------

  var LAYER_BUILDERS = {
    pins: function (src) {
      return [
        {
          id: src + '-pins',
          type: 'circle',
          source: src,
          paint: {
            'circle-radius': 7,
            'circle-color': COLORS.pin,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
          },
          meta: { clickable: true }
        }
      ];
    },

    clusters: function (src) {
      return [
        {
          id: src + '-cluster-circles',
          type: 'circle',
          source: src,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': ['step', ['get', 'point_count'], COLORS.cluster[0], 10, COLORS.cluster[1], 50, COLORS.cluster[2]],
            'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 30],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
          },
          meta: { clusterZoom: true }
        },
        {
          id: src + '-cluster-count',
          type: 'symbol',
          source: src,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 12,
            'text-font': ['Noto Sans Regular']
          },
          paint: { 'text-color': '#ffffff' }
        },
        {
          id: src + '-unclustered',
          type: 'circle',
          source: src,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': 6,
            'circle-color': COLORS.pin,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
          },
          meta: { clickable: true }
        }
      ];
    },

    heatmap: function (src, ctx) {
      var weight = 1;
      if (ctx.valueProperty) {
        weight = ['interpolate', ['linear'], ['to-number', ['get', ctx.valueProperty], 0], ctx.stats.min, 0.2, ctx.stats.max, 1];
      }
      return [
        {
          id: src + '-heat',
          type: 'heatmap',
          source: src,
          paint: {
            'heatmap-weight': weight,
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 9, 2.2],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 14, 9, 36],
            'heatmap-color': [
              'interpolate', ['linear'], ['heatmap-density'],
              0, 'rgba(33,102,172,0)',
              0.2, '#4393c3',
              0.4, '#92c5de',
              0.6, '#fddbc7',
              0.8, '#ef8a62',
              1, '#b2182b'
            ],
            'heatmap-opacity': 0.85
          }
        },
        {
          id: src + '-heat-points',
          type: 'circle',
          source: src,
          minzoom: 8,
          paint: {
            'circle-radius': 4,
            'circle-color': '#b2182b',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0, 10, 1]
          },
          meta: { clickable: true }
        }
      ];
    },

    bubble: function (src, ctx) {
      var prop = ctx.valueProperty || 'value';
      return [
        {
          id: src + '-bubbles',
          type: 'circle',
          source: src,
          paint: {
            'circle-radius': [
              'interpolate', ['linear'],
              ['to-number', ['get', prop], 0],
              ctx.stats.min, 5,
              ctx.stats.max, 32
            ],
            'circle-color': [
              'interpolate', ['linear'],
              ['to-number', ['get', prop], 0],
              ctx.stats.min, COLORS.rampLow,
              ctx.stats.max, COLORS.rampHigh
            ],
            'circle-opacity': 0.78,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#ffffff'
          },
          meta: { clickable: true }
        }
      ];
    },

    choropleth: function (src, ctx) {
      var prop = ctx.valueProperty || 'value';
      return [
        {
          id: src + '-fills',
          type: 'fill',
          source: src,
          paint: {
            'fill-color': [
              'interpolate', ['linear'],
              ['to-number', ['get', prop], 0],
              ctx.stats.min, COLORS.rampLow,
              ctx.stats.max, COLORS.rampHigh
            ],
            'fill-opacity': 0.72
          },
          meta: { clickable: true }
        },
        {
          id: src + '-outlines',
          type: 'line',
          source: src,
          paint: { 'line-color': '#ffffff', 'line-width': 1 }
        }
      ];
    },

    route: function (src) {
      return [
        {
          id: src + '-casing',
          type: 'line',
          source: src,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 7 }
        },
        {
          id: src + '-line',
          type: 'line',
          source: src,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': COLORS.line, 'line-width': 4 },
          meta: { clickable: true }
        },
        {
          id: src + '-stops',
          type: 'circle',
          source: src,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 6,
            'circle-color': COLORS.pin,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
          },
          meta: { clickable: true }
        }
      ];
    }
  };

  // -------------------------------------------------------------------------
  // AtlasMap
  // -------------------------------------------------------------------------

  function AtlasMap(map, client, maplibregl) {
    this.map = map;             // underlying MapLibre map (escape hatch)
    this.client = client;
    this._maplibregl = maplibregl;
    this._layersets = {};       // sourceId -> { geojson, mapType, valueProperty, layerIds }
    this._counter = 0;

    var self = this;
    // Re-add data layers whenever the basemap style is replaced.
    map.on('styledata', function () {
      Object.keys(self._layersets).forEach(function (src) {
        if (!map.getSource(src)) self._mount(src);
      });
    });
  }

  AtlasMap.prototype._mount = function (src) {
    var entry = this._layersets[src];
    var map = this.map;
    if (!entry || map.getSource(src)) return;

    var sourceSpec = { type: 'geojson', data: entry.geojson };
    if (entry.mapType === 'clusters') {
      sourceSpec.cluster = true;
      sourceSpec.clusterRadius = 45;
      sourceSpec.clusterMaxZoom = 13;
    }
    map.addSource(src, sourceSpec);

    var builder = LAYER_BUILDERS[entry.mapType] || LAYER_BUILDERS.pins;
    var ctx = {
      valueProperty: entry.valueProperty,
      stats: entry.valueProperty ? valueStats(entry.geojson, entry.valueProperty) : { min: 0, max: 1 }
    };
    var layers = builder(src, ctx);
    var self = this;
    entry.layerIds = layers.map(function (layer) {
      var meta = layer.meta || {};
      delete layer.meta;
      map.addLayer(layer);
      if (meta.clickable) self._wirePopup(layer.id);
      if (meta.clusterZoom) self._wireClusterZoom(layer.id, src);
      return layer.id;
    });
  };

  AtlasMap.prototype._wirePopup = function (layerId) {
    var map = this.map;
    var maplibregl = this._maplibregl;
    map.on('click', layerId, function (e) {
      var feature = e.features && e.features[0];
      if (!feature) return;
      var lngLat = feature.geometry.type === 'Point' ? feature.geometry.coordinates : e.lngLat;
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(lngLat)
        .setHTML(popupHTML(feature.properties))
        .addTo(map);
    });
    map.on('mouseenter', layerId, function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, function () { map.getCanvas().style.cursor = ''; });
  };

  AtlasMap.prototype._wireClusterZoom = function (layerId, src) {
    var map = this.map;
    map.on('click', layerId, function (e) {
      var feature = e.features && e.features[0];
      if (!feature) return;
      map.getSource(src).getClusterExpansionZoom(feature.properties.cluster_id).then(function (zoom) {
        map.easeTo({ center: feature.geometry.coordinates, zoom: zoom + 0.5 });
      });
    });
    map.on('mouseenter', layerId, function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, function () { map.getCanvas().style.cursor = ''; });
  };

  /**
   * Add a dataset to the map.
   * data: GeoJSON object | dataset id string | URL string
   * options: { mapType, valueProperty, fit, id }
   * Returns a promise resolving to the layerset id.
   */
  AtlasMap.prototype.addData = function (data, options) {
    options = options || {};
    var self = this;
    return this._resolveData(data).then(function (geojson) {
      var fc = toFeatureCollection(geojson);
      var src = options.id || 'atlas-data-' + (++self._counter);
      self._layersets[src] = {
        geojson: fc,
        mapType: options.mapType || 'pins',
        valueProperty: options.valueProperty || null,
        layerIds: []
      };
      var mount = function () { self._mount(src); };
      if (self.map.isStyleLoaded()) mount();
      else self.map.once('load', mount);
      if (options.fit !== false) {
        var bounds = dataBounds(fc);
        if (bounds) self.map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 800 });
      }
      return src;
    });
  };

  AtlasMap.prototype._resolveData = function (data) {
    if (!data) return Promise.resolve(null);
    if (typeof data === 'object') return Promise.resolve(data);
    if (/^https?:\/\//.test(data) || data.indexOf('/') === 0) {
      return fetch(data).then(function (r) { return r.json(); }).then(function (body) {
        return body.dataset ? body.dataset.geojson : body;
      });
    }
    return this.client.getDataset(data).then(function (record) { return record.geojson; });
  };

  AtlasMap.prototype.removeData = function (src) {
    var entry = this._layersets[src];
    if (!entry) return;
    var map = this.map;
    entry.layerIds.forEach(function (id) {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(src)) map.removeSource(src);
    delete this._layersets[src];
  };

  AtlasMap.prototype.clearData = function () {
    Object.keys(this._layersets).forEach(this.removeData, this);
  };

  /** Re-render an existing layerset with a different map type / value property. */
  AtlasMap.prototype.setMapType = function (src, mapType, valueProperty) {
    var entry = this._layersets[src];
    if (!entry) return;
    var geojson = entry.geojson;
    this.removeData(src);
    this._layersets[src] = {
      geojson: geojson,
      mapType: mapType,
      valueProperty: valueProperty !== undefined ? valueProperty : entry.valueProperty,
      layerIds: []
    };
    this._mount(src);
  };

  AtlasMap.prototype.listLayersets = function () {
    var self = this;
    return Object.keys(this._layersets).map(function (src) {
      var e = self._layersets[src];
      return {
        id: src,
        mapType: e.mapType,
        valueProperty: e.valueProperty,
        featureCount: e.geojson.features.length,
        numericProperties: numericProperties(e.geojson)
      };
    });
  };

  AtlasMap.prototype.getLayersetData = function (src) {
    var e = this._layersets[src];
    return e ? e.geojson : null;
  };

  /** Switch basemap by preset id, style URL, or style object. Data layers persist. */
  AtlasMap.prototype.setBasemap = function (style) {
    var self = this;
    if (typeof style === 'string' && !/^https?:\/\//.test(style) && style.indexOf('{') !== 0) {
      return this.client.getStyles().then(function (styles) {
        var preset = styles.find(function (s) { return s.id === style; });
        if (!preset) throw new Error('Unknown basemap style: ' + style);
        self.map.setStyle(preset.style, { diff: false });
      });
    }
    this.map.setStyle(style, { diff: false });
    return Promise.resolve();
  };

  /** Geocode a place name and fly there. */
  AtlasMap.prototype.flyToPlace = function (query) {
    var map = this.map;
    return this.client.geocode(query, 1).then(function (results) {
      if (!results.length) throw new Error('No results for "' + query + '"');
      var place = results[0];
      if (place.boundingBox) {
        map.fitBounds(
          [[place.boundingBox[0], place.boundingBox[1]], [place.boundingBox[2], place.boundingBox[3]]],
          { padding: 40, duration: 1200 }
        );
      } else {
        map.flyTo({ center: [place.lng, place.lat], zoom: 10 });
      }
      return place;
    });
  };

  AtlasMap.prototype.fitToData = function () {
    var all = { type: 'FeatureCollection', features: [] };
    var self = this;
    Object.keys(this._layersets).forEach(function (src) {
      all.features = all.features.concat(self._layersets[src].geojson.features);
    });
    var bounds = dataBounds(all);
    if (bounds) this.map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
  };

  /** Export the current view as a PNG data URL (or trigger a download). */
  AtlasMap.prototype.exportPNG = function (filename) {
    var map = this.map;
    return new Promise(function (resolve) {
      map.once('idle', function () {
        var dataUrl = map.getCanvas().toDataURL('image/png');
        if (filename) {
          var a = document.createElement('a');
          a.href = dataUrl;
          a.download = filename;
          a.click();
        }
        resolve(dataUrl);
      });
      map.triggerRepaint();
    });
  };

  AtlasMap.prototype.remove = function () {
    this.map.remove();
  };

  // -------------------------------------------------------------------------
  // createMap entry point
  // -------------------------------------------------------------------------

  function createMap(container, options) {
    options = options || {};
    var client = new Client({ baseUrl: options.baseUrl || '' });

    return loadMapLibre().then(function (maplibregl) {
      var styleInput = options.style || 'streets';
      var stylePromise;
      if (typeof styleInput === 'string' && !/^https?:\/\//.test(styleInput)) {
        stylePromise = client.getStyles().then(function (styles) {
          var preset = styles.find(function (s) { return s.id === styleInput; });
          return preset ? preset.style : styleInput;
        });
      } else {
        stylePromise = Promise.resolve(styleInput);
      }

      return stylePromise.then(function (style) {
        var el = typeof container === 'string' ? document.querySelector(container) : container;
        if (!el) throw new Error('Map container not found: ' + container);
        var map = new maplibregl.Map({
          container: el,
          style: style,
          center: options.center || [0, 20],
          zoom: options.zoom !== undefined ? options.zoom : 2,
          interactive: options.interactive !== false,
          preserveDrawingBuffer: true,
          attributionControl: { compact: true }
        });
        if (options.interactive !== false) {
          map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
          map.addControl(new maplibregl.ScaleControl({ unit: options.units || 'imperial' }), 'bottom-left');
        }

        var atlasMap = new AtlasMap(map, client, maplibregl);

        var data = options.data || options.dataset || options.dataUrl;
        var ready = new Promise(function (resolve) { map.once('load', resolve); });
        return ready.then(function () {
          if (!data) return atlasMap;
          return atlasMap
            .addData(data, {
              mapType: options.mapType || 'pins',
              valueProperty: options.valueProperty || null,
              fit: options.fitData !== false
            })
            .then(function () { return atlasMap; });
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // CSV utilities (lat/lng auto-detection) — used by the studio and embedders
  // -------------------------------------------------------------------------

  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
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

  function csvToGeoJSON(text) {
    var rows = parseCSV(text);
    if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
    var header = rows[0].map(function (h) { return h.trim(); });
    var lower = header.map(function (h) { return h.toLowerCase(); });

    function findColumn(candidates) {
      for (var i = 0; i < candidates.length; i++) {
        var idx = lower.indexOf(candidates[i]);
        if (idx !== -1) return idx;
      }
      return -1;
    }

    var latIdx = findColumn(['lat', 'latitude', 'y']);
    var lngIdx = findColumn(['lng', 'lon', 'long', 'longitude', 'x']);
    if (latIdx === -1 || lngIdx === -1) {
      throw new Error('Could not find latitude/longitude columns. Expected headers like lat/latitude and lng/lon/longitude.');
    }

    var features = [];
    for (var r = 1; r < rows.length; r++) {
      var latRaw = (rows[r][latIdx] || '').trim();
      var lngRaw = (rows[r][lngIdx] || '').trim();
      if (latRaw === '' || lngRaw === '') continue;
      var lat = Number(latRaw);
      var lng = Number(lngRaw);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      var props = {};
      for (var c = 0; c < header.length; c++) {
        if (c === latIdx || c === lngIdx) continue;
        var v = rows[r][c];
        props[header[c]] = v !== '' && isFinite(Number(v)) ? Number(v) : v;
      }
      features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } });
    }
    if (!features.length) throw new Error('No rows with valid coordinates found');
    return { type: 'FeatureCollection', features: features };
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  var Atlas = {
    version: '0.1.0',
    Client: Client,
    createMap: createMap,
    csvToGeoJSON: csvToGeoJSON,
    utils: {
      toFeatureCollection: toFeatureCollection,
      numericProperties: numericProperties,
      dataBounds: dataBounds,
      parseCSV: parseCSV
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Atlas;
  }
  global.Atlas = Atlas;
})(typeof window !== 'undefined' ? window : globalThis);
