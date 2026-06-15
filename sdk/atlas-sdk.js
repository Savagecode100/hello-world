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

  // -------------------------------------------------------------------------
  // Time-series helpers. A temporal FeatureCollection carries per-feature
  // `timeSeries` arrays of { timestamp, properties, geometry? } snapshots.
  // -------------------------------------------------------------------------

  function toTime(value) {
    if (value == null) return NaN;
    if (typeof value === 'number') return value;
    var n = Date.parse(value);
    if (!isNaN(n)) return n;
    var asNum = Number(value);
    return isNaN(asNum) ? NaN : asNum;
  }

  function isTemporal(fc) {
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return false;
    return fc.features.some(function (f) {
      return Array.isArray(f.timeSeries) && f.timeSeries.length > 0;
    });
  }

  function collectTimestamps(fc) {
    var seen = {};
    var order = [];
    (fc.features || []).forEach(function (f) {
      if (!Array.isArray(f.timeSeries)) return;
      f.timeSeries.forEach(function (snap) {
        if (!snap || snap.timestamp == null) return;
        var t = toTime(snap.timestamp);
        if (isNaN(t)) return;
        if (!(t in seen)) { seen[t] = snap.timestamp; order.push(t); }
      });
    });
    order.sort(function (a, b) { return a - b; });
    return order.map(function (t) { return seen[t]; });
  }

  // Min/max of a property across every snapshot, so styling stays stable
  // across frames during animation.
  function temporalValueStats(fc, property) {
    var min = Infinity, max = -Infinity;
    function consider(v) {
      var n = Number(v);
      if (isFinite(n)) { if (n < min) min = n; if (n > max) max = n; }
    }
    (fc.features || []).forEach(function (f) {
      if (f.properties) consider(f.properties[property]);
      if (Array.isArray(f.timeSeries)) {
        f.timeSeries.forEach(function (snap) {
          if (snap && snap.properties) consider(snap.properties[property]);
        });
      }
    });
    if (!isFinite(min)) { min = 0; max = 1; }
    if (min === max) max = min + 1;
    return { min: min, max: max };
  }

  // Numeric property names found in base properties or any snapshot.
  function temporalNumericProperties(fc) {
    var props = {};
    function scan(obj) {
      if (!obj) return;
      Object.keys(obj).forEach(function (k) {
        if (k === '__timestamp') return;
        if (isFinite(Number(obj[k])) && obj[k] !== '' && obj[k] !== null) props[k] = true;
      });
    }
    (fc.features || []).slice(0, 200).forEach(function (f) {
      scan(f.properties);
      if (Array.isArray(f.timeSeries)) {
        f.timeSeries.forEach(function (snap) { if (snap) scan(snap.properties); });
      }
    });
    return Object.keys(props);
  }

  function lerp(a, b, frac) { return a + (b - a) * frac; }  function frameFeature(feature, targetTime, interpolate) {
    var series = feature.timeSeries;
    if (!Array.isArray(series) || series.length === 0) return feature;
    var sorted = series.filter(function (s) {
      return s && s.timestamp != null && !isNaN(toTime(s.timestamp));
    }).sort(function (a, b) { return toTime(a.timestamp) - toTime(b.timestamp); });
    if (sorted.length === 0) return feature;

    var prev = null, next = null;
    sorted.forEach(function (snap) {
      var t = toTime(snap.timestamp);
      if (t <= targetTime) prev = snap;
      if (t >= targetTime && next === null) next = snap;
    });
    if (!prev) return null; // not born yet

    var props = {};
    var k;
    for (k in feature.properties) props[k] = feature.properties[k];
    var prevProps = prev.properties || {};

    if (interpolate === 'linear' && next && next !== prev) {
      var t0 = toTime(prev.timestamp), t1 = toTime(next.timestamp);
      var frac = t1 === t0 ? 0 : (targetTime - t0) / (t1 - t0);
      var nextProps = next.properties || {};
      var keys = {};
      for (k in prevProps) keys[k] = true;
      for (k in nextProps) keys[k] = true;
      for (k in keys) {
        var a = prevProps[k], b = nextProps[k];
        props[k] = (typeof a === 'number' && typeof b === 'number') ? lerp(a, b, frac)
          : (a !== undefined ? a : b);
      }
    } else {
      for (k in prevProps) props[k] = prevProps[k];
    }
    props.__timestamp = prev.timestamp;

    var geometry = prev.geometry || feature.geometry;
    if (interpolate === 'linear' && next && next !== prev &&
        prev.geometry && next.geometry &&
        prev.geometry.type === 'Point' && next.geometry.type === 'Point') {
      var g0 = toTime(prev.timestamp), g1 = toTime(next.timestamp);
      var gf = g1 === g0 ? 0 : (targetTime - g0) / (g1 - g0);
      geometry = {
        type: 'Point',
        coordinates: [
          lerp(prev.geometry.coordinates[0], next.geometry.coordinates[0], gf),
          lerp(prev.geometry.coordinates[1], next.geometry.coordinates[1], gf)
        ]
      };
    }
    return { type: 'Feature', properties: props, geometry: geometry };
  }

  function frameAt(fc, timestamp, interpolate) {
    var mode = interpolate || (fc.temporal && fc.temporal.interpolate) || 'step';
    var targetTime = toTime(timestamp);
    var features = [];
    (fc.features || []).forEach(function (feature) {
      var framed = frameFeature(feature, targetTime, mode);
      if (framed) features.push(framed);
    });
    return { type: 'FeatureCollection', features: features };
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
      stats: entry.valueProperty
        ? (entry.temporal && entry.fullData
            ? temporalValueStats(entry.fullData, entry.valueProperty)
            : valueStats(entry.geojson, entry.valueProperty))
        : { min: 0, max: 1 }
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
      layerIds: [],
      temporal: entry.temporal,
      fullData: entry.fullData,
      timestamps: entry.timestamps,
      interpolate: entry.interpolate,
      frameIndex: entry.frameIndex
    };
    this._mount(src);
  };

  AtlasMap.prototype.listLayersets = function () {
    var self = this;
    return Object.keys(this._layersets).map(function (src) {
      var e = self._layersets[src];
      var fc = e.temporal && e.fullData ? e.fullData : e.geojson;
      return {
        id: src,
        mapType: e.mapType,
        valueProperty: e.valueProperty,
        featureCount: fc.features.length,
        numericProperties: e.temporal ? temporalNumericProperties(fc) : numericProperties(fc),
        temporal: !!e.temporal,
        frameCount: e.temporal ? e.timestamps.length : 0,
        frameIndex: e.temporal ? e.frameIndex : -1
      };
    });
  };

  AtlasMap.prototype.getLayersetData = function (src) {
    var e = this._layersets[src];
    return e ? e.geojson : null;
  };

  // -----------------------------------------------------------------------
  // Time-series / time-lapse support
  // -----------------------------------------------------------------------

  /**
   * Add a temporal dataset to the map. Behaves like addData, but the source
   * is rendered one frame at a time. Returns a promise resolving to the
   * layerset id. Use createPlayer(src) to animate it.
   * options: { mapType, valueProperty, fit, id, interpolate, frameIndex }
   */
  AtlasMap.prototype.addTimeSeriesData = function (data, options) {
    options = options || {};
    var self = this;
    return this._resolveData(data).then(function (geojson) {
      var fc = toFeatureCollection(geojson);
      if (!isTemporal(fc)) {
        throw new Error('Dataset is not temporal (no feature has a timeSeries array)');
      }
      var src = options.id || 'atlas-data-' + (++self._counter);
      var timestamps = collectTimestamps(fc);
      var interpolate = options.interpolate || (fc.temporal && fc.temporal.interpolate) || 'step';
      var frameIndex = options.frameIndex != null ? options.frameIndex : 0;
      var frame = frameAt(fc, timestamps[frameIndex], interpolate);
      self._layersets[src] = {
        geojson: frame,
        fullData: fc,
        temporal: true,
        timestamps: timestamps,
        interpolate: interpolate,
        frameIndex: frameIndex,
        mapType: options.mapType || 'pins',
        valueProperty: options.valueProperty || null,
        layerIds: []
      };
      var mount = function () { self._mount(src); };
      if (self.map.isStyleLoaded()) mount();
      else self.map.once('load', mount);
      if (options.fit !== false) {
        var bounds = dataBounds(fc.features.length ? { type: 'FeatureCollection', features: fc.features.map(function (f) {
          return { type: 'Feature', geometry: f.geometry, properties: {} };
        }) } : fc);
        if (bounds) self.map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 800 });
      }
      return src;
    });
  };

  AtlasMap.prototype.isTemporalLayer = function (src) {
    var e = this._layersets[src];
    return !!(e && e.temporal);
  };

  AtlasMap.prototype.getTimestamps = function (src) {
    var e = this._layersets[src];
    return e && e.temporal ? e.timestamps.slice() : [];
  };

  AtlasMap.prototype.getFrameIndex = function (src) {
    var e = this._layersets[src];
    return e && e.temporal ? e.frameIndex : -1;
  };

  /** Render the temporal layerset at a given frame index. */
  AtlasMap.prototype.setFrame = function (src, frameIndex) {
    var e = this._layersets[src];
    if (!e || !e.temporal) return null;
    var count = e.timestamps.length;
    if (!count) return null;
    var idx = Math.max(0, Math.min(count - 1, frameIndex | 0));
    e.frameIndex = idx;
    var timestamp = e.timestamps[idx];
    var frame = frameAt(e.fullData, timestamp, e.interpolate);
    e.geojson = frame;
    var source = this.map.getSource(src);
    if (source && source.setData) source.setData(frame);
    return { index: idx, timestamp: timestamp, frameCount: count };
  };

  /** Render the temporal layerset at an arbitrary timestamp (for smooth scrubbing). */
  AtlasMap.prototype.setFrameAtTime = function (src, timestamp) {
    var e = this._layersets[src];
    if (!e || !e.temporal) return null;
    var frame = frameAt(e.fullData, timestamp, e.interpolate);
    e.geojson = frame;
    var source = this.map.getSource(src);
    if (source && source.setData) source.setData(frame);
    return { timestamp: timestamp };
  };

  /** Create a playback controller for a temporal layerset. */
  AtlasMap.prototype.createPlayer = function (src, options) {
    if (!this.isTemporalLayer(src)) {
      throw new Error('Layerset is not temporal: ' + src);
    }
    return new TimeSeriesPlayer(this, src, options);
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
  // TimeSeriesPlayer: drives frame-by-frame playback of a temporal layerset.
  // -------------------------------------------------------------------------

  function TimeSeriesPlayer(atlasMap, src, options) {
    options = options || {};
    this.atlasMap = atlasMap;
    this.src = src;
    this.timestamps = atlasMap.getTimestamps(src);
    this.frameCount = this.timestamps.length;
    this.index = atlasMap.getFrameIndex(src) || 0;
    this.fps = options.fps || 2;          // timeline frames advanced per second
    this.speed = options.speed || 1;      // playback speed multiplier
    this.loop = options.loop !== false;   // loop by default
    this.playing = false;
    this._raf = null;
    this._accum = 0;
    this._lastTs = 0;
    this._listeners = { frame: [], play: [], pause: [], complete: [] };
    // Ensure the map shows the current frame.
    this.atlasMap.setFrame(this.src, this.index);
  }

  TimeSeriesPlayer.prototype.on = function (event, cb) {
    if (this._listeners[event]) this._listeners[event].push(cb);
    return this;
  };

  TimeSeriesPlayer.prototype._emit = function (event, payload) {
    (this._listeners[event] || []).forEach(function (cb) {
      try { cb(payload); } catch (e) { /* listener error */ }
    });
  };

  TimeSeriesPlayer.prototype._apply = function () {
    var info = this.atlasMap.setFrame(this.src, this.index);
    if (info) {
      this._emit('frame', {
        index: info.index,
        timestamp: info.timestamp,
        frameCount: info.frameCount,
        fraction: info.frameCount > 1 ? info.index / (info.frameCount - 1) : 0
      });
    }
  };

  TimeSeriesPlayer.prototype.setIndex = function (index) {
    this.index = Math.max(0, Math.min(this.frameCount - 1, index | 0));
    this._apply();
    return this;
  };

  /** Seek by a 0..1 fraction of the timeline (used by the scrubber). */
  TimeSeriesPlayer.prototype.seekFraction = function (fraction) {
    var idx = Math.round(fraction * (this.frameCount - 1));
    return this.setIndex(idx);
  };

  TimeSeriesPlayer.prototype.next = function () {
    if (this.index >= this.frameCount - 1) {
      if (this.loop) return this.setIndex(0);
      return this;
    }
    return this.setIndex(this.index + 1);
  };

  TimeSeriesPlayer.prototype.prev = function () {
    return this.setIndex(this.index - 1);
  };

  TimeSeriesPlayer.prototype.play = function () {
    if (this.playing || this.frameCount < 2) return this;
    this.playing = true;
    this._lastTs = 0;
    this._accum = 0;
    this._emit('play', { index: this.index });
    var self = this;
    var raf = (typeof requestAnimationFrame !== 'undefined')
      ? requestAnimationFrame
      : function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
    function step(ts) {
      if (!self.playing) return;
      if (!self._lastTs) self._lastTs = ts;
      var dt = (ts - self._lastTs) / 1000;
      self._lastTs = ts;
      self._accum += dt * self.fps * self.speed;
      while (self._accum >= 1) {
        self._accum -= 1;
        if (self.index >= self.frameCount - 1) {
          if (self.loop) {
            self.setIndex(0);
          } else {
            self.pause();
            self._emit('complete', { index: self.index });
            return;
          }
        } else {
          self.setIndex(self.index + 1);
        }
      }
      self._raf = raf(step);
    }
    self._raf = raf(step);
    return this;
  };

  TimeSeriesPlayer.prototype.pause = function () {
    if (!this.playing) return this;
    this.playing = false;
    if (this._raf != null) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._raf);
      else clearTimeout(this._raf);
      this._raf = null;
    }
    this._emit('pause', { index: this.index });
    return this;
  };

  TimeSeriesPlayer.prototype.toggle = function () {
    return this.playing ? this.pause() : this.play();
  };

  TimeSeriesPlayer.prototype.stop = function () {
    this.pause();
    return this.setIndex(0);
  };

  TimeSeriesPlayer.prototype.setSpeed = function (speed) {
    this.speed = speed || 1;
    return this;
  };

  TimeSeriesPlayer.prototype.setFps = function (fps) {
    this.fps = fps || 2;
    return this;
  };

  // -------------------------------------------------------------------------
  // Time-lapse export. Two strategies, both capture the live map canvas:
  //   - exportTimeLapseGIF: loads gif.js from CDN, encodes an animated GIF.
  //   - exportTimeLapseVideo: uses the MediaRecorder API to produce WebM.
  // -------------------------------------------------------------------------

  var GIFJS_URL = 'https://unpkg.com/gif.js.optimized@1.0.1/dist/gif.js';
  var GIFJS_WORKER_URL = 'https://unpkg.com/gif.js.optimized@1.0.1/dist/gif.worker.js';
  var gifPromise = null;

  function loadGifJs() {
    if (global.GIF) return Promise.resolve(global.GIF);
    if (gifPromise) return gifPromise;
    gifPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = GIFJS_URL;
      script.onload = function () { resolve(global.GIF); };
      script.onerror = function () { reject(new Error('Failed to load gif.js from CDN')); };
      document.head.appendChild(script);
    });
    return gifPromise;
  }

  // Render one frame and wait for the map to settle, then run cb with the canvas.
  function renderFrameToCanvas(atlasMap, src, index) {
    return new Promise(function (resolve) {
      atlasMap.setFrame(src, index);
      var map = atlasMap.map;
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        resolve(map.getCanvas());
      };
      map.once('idle', finish);
      map.triggerRepaint();
      // Safety timeout in case 'idle' never fires.
      setTimeout(finish, 1500);
    });
  }

  function copyCanvas(srcCanvas) {
    var c = document.createElement('canvas');
    c.width = srcCanvas.width;
    c.height = srcCanvas.height;
    c.getContext('2d').drawImage(srcCanvas, 0, 0);
    return c;
  }

  /**
   * Export the temporal layerset as an animated GIF.
   * options: { player, frameDelay (ms), quality, filename, onProgress }
   * Returns a promise resolving to a Blob.
   */
  AtlasMap.prototype.exportTimeLapseGIF = function (src, options) {
    options = options || {};
    var self = this;
    var entry = this._layersets[src];
    if (!entry || !entry.temporal) {
      return Promise.reject(new Error('Layerset is not temporal: ' + src));
    }
    var count = entry.timestamps.length;
    var startIndex = entry.frameIndex;
    var frameDelay = options.frameDelay || 500;
    var onProgress = options.onProgress || function () {};

    return loadGifJs().then(function (GIF) {
      var canvas = self.map.getCanvas();
      var gif = new GIF({
        workers: 2,
        quality: options.quality || 10,
        width: canvas.width,
        height: canvas.height,
        workerScript: GIFJS_WORKER_URL
      });

      return new Promise(function (resolve, reject) {
        var i = 0;
        function addNext() {
          if (i >= count) {
            gif.on('finished', function (blob) {
              self.setFrame(src, startIndex);
              if (options.filename) downloadBlob(blob, options.filename);
              resolve(blob);
            });
            gif.render();
            return;
          }
          onProgress({ phase: 'capture', current: i + 1, total: count });
          renderFrameToCanvas(self, src, i).then(function (frameCanvas) {
            gif.addFrame(copyCanvas(frameCanvas), { delay: frameDelay, copy: true });
            i++;
            addNext();
          }).catch(reject);
        }
        gif.on('progress', function (p) {
          onProgress({ phase: 'encode', progress: p });
        });
        addNext();
      });
    });
  };

  /**
   * Export the temporal layerset as a WebM video using MediaRecorder.
   * options: { fps, frameDuration (ms), mimeType, filename, onProgress }
   * Returns a promise resolving to a Blob.
   */
  AtlasMap.prototype.exportTimeLapseVideo = function (src, options) {
    options = options || {};
    var self = this;
    var entry = this._layersets[src];
    if (!entry || !entry.temporal) {
      return Promise.reject(new Error('Layerset is not temporal: ' + src));
    }
    if (typeof MediaRecorder === 'undefined') {
      return Promise.reject(new Error('MediaRecorder API is not available in this browser'));
    }
    var count = entry.timestamps.length;
    var startIndex = entry.frameIndex;
    var frameDuration = options.frameDuration || 600;
    var onProgress = options.onProgress || function () {};

    var mimeType = options.mimeType;
    if (!mimeType) {
      var candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      for (var c = 0; c < candidates.length; c++) {
        if (MediaRecorder.isTypeSupported(candidates[c])) { mimeType = candidates[c]; break; }
      }
    }

    // Draw each captured frame onto an offscreen canvas, recording its stream.
    var srcCanvas = self.map.getCanvas();
    var out = document.createElement('canvas');
    out.width = srcCanvas.width;
    out.height = srcCanvas.height;
    var octx = out.getContext('2d');
    var stream = out.captureStream(0);
    var track = stream.getVideoTracks()[0];
    var recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

    return new Promise(function (resolve, reject) {
      recorder.onerror = function (e) { reject(e.error || new Error('Recording failed')); };
      recorder.onstop = function () {
        var blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        self.setFrame(src, startIndex);
        if (options.filename) downloadBlob(blob, options.filename);
        resolve(blob);
      };
      recorder.start();

      var i = 0;
      function drawNext() {
        if (i >= count) {
          // Give the recorder a tick to flush the last frame.
          setTimeout(function () { recorder.stop(); }, frameDuration);
          return;
        }
        onProgress({ phase: 'capture', current: i + 1, total: count });
        renderFrameToCanvas(self, src, i).then(function (frameCanvas) {
          octx.drawImage(frameCanvas, 0, 0);
          if (track.requestFrame) track.requestFrame();
          else if (stream.requestFrame) stream.requestFrame();
          i++;
          setTimeout(drawNext, frameDuration);
        }).catch(reject);
      }
      drawNext();
    });
  };

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

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

  // Convert long-format CSV (one row per feature per timestamp) into temporal
  // GeoJSON. Groups rows by an id column; each row becomes a snapshot.
  function csvToTimeSeries(text, options) {
    options = options || {};
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

    var idIdx = options.idColumn ? lower.indexOf(options.idColumn.toLowerCase())
      : findColumn(['id', 'feature_id', 'key', 'name']);
    var timeIdx = options.timeColumn ? lower.indexOf(options.timeColumn.toLowerCase())
      : findColumn(['timestamp', 'time', 'date', 'datetime', 'year']);
    var latIdx = options.latColumn ? lower.indexOf(options.latColumn.toLowerCase())
      : findColumn(['lat', 'latitude', 'y']);
    var lngIdx = options.lngColumn ? lower.indexOf(options.lngColumn.toLowerCase())
      : findColumn(['lng', 'lon', 'long', 'longitude', 'x']);

    if (idIdx === -1) throw new Error('Could not find an id column (id / feature_id / key / name)');
    if (timeIdx === -1) throw new Error('Could not find a timestamp column (timestamp / time / date / year)');
    if (latIdx === -1 || lngIdx === -1) {
      throw new Error('Could not find latitude/longitude columns (lat/latitude and lng/lon/longitude)');
    }

    var map = {};
    var orderedIds = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      var id = (cells[idIdx] || '').trim();
      var timestamp = (cells[timeIdx] || '').trim();
      var latRaw = (cells[latIdx] || '').trim();
      var lngRaw = (cells[lngIdx] || '').trim();
      if (!id || !timestamp || latRaw === '' || lngRaw === '') continue;
      var lat = Number(latRaw), lng = Number(lngRaw);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      var snapProps = {};
      for (var c = 0; c < header.length; c++) {
        if (c === idIdx || c === timeIdx || c === latIdx || c === lngIdx) continue;
        var v = cells[c];
        snapProps[header[c]] = v !== '' && isFinite(Number(v)) ? Number(v) : v;
      }
      if (!map[id]) {
        map[id] = {
          type: 'Feature',
          properties: { name: id },
          geometry: { type: 'Point', coordinates: [lng, lat] },
          timeSeries: []
        };
        orderedIds.push(id);
      }
      map[id].geometry.coordinates = [lng, lat];
      map[id].timeSeries.push({ timestamp: timestamp, properties: snapProps });
    }

    var features = orderedIds.map(function (id) { return map[id]; });
    if (!features.length) throw new Error('No valid rows found (need id, timestamp, lat, lng)');
    features.forEach(function (f) {
      f.timeSeries.sort(function (a, b) { return toTime(a.timestamp) - toTime(b.timestamp); });
    });
    return {
      type: 'FeatureCollection',
      name: options.name || 'Converted time-series',
      temporal: { property: 'timestamp', interpolate: options.interpolate || 'linear' },
      features: features
    };
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  var Atlas = {
    version: '0.1.0',
    Client: Client,
    createMap: createMap,
    csvToGeoJSON: csvToGeoJSON,
    csvToTimeSeries: csvToTimeSeries,
    TimeSeriesPlayer: TimeSeriesPlayer,
    utils: {
      toFeatureCollection: toFeatureCollection,
      numericProperties: numericProperties,
      dataBounds: dataBounds,
      parseCSV: parseCSV,
      isTemporal: isTemporal,
      collectTimestamps: collectTimestamps,
      frameAt: frameAt,
      temporalNumericProperties: temporalNumericProperties
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Atlas;
  }
  global.Atlas = Atlas;
})(typeof window !== 'undefined' ? window : globalThis);
