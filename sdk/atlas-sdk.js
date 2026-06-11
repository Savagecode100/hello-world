/*!
 * Atlas SDK v0.3.0
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
    // API key for authenticated calls (publishing datasets, /api/stats, ...).
    // Browsers signed in to the studio can omit it: the session cookie is used.
    this.apiKey = options.apiKey || null;
  }

  Client.prototype._fetch = function (path, init) {
    var url = this.baseUrl + path;
    init = init || {};
    if (this.apiKey) {
      init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + this.apiKey });
    }
    return fetch(url, init).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ('Atlas API error ' + res.status));
        return body;
      });
    });
  };

  /** Current authenticated user (requires apiKey or a studio session cookie). */
  Client.prototype.me = function () {
    return this._fetch('/api/auth/me').then(function (body) { return body.user; });
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
      body: JSON.stringify({
        id: meta.id, name: meta.name, description: meta.description,
        license: meta.license, source: meta.source, geojson: geojson
      })
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

  function formatNumber(v) {
    if (!isFinite(v)) return String(v);
    if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-US');
    return String(Math.round(v * 100) / 100);
  }

  // -------------------------------------------------------------------------
  // Legends. buildLegend() turns a layerset into a renderer-agnostic model;
  // renderLegendDOM() shows it on the map, drawLegendOnCanvas() bakes it
  // into PNG exports.
  // -------------------------------------------------------------------------

  var HEATMAP_RAMP = ['#4393c3', '#92c5de', '#fddbc7', '#ef8a62', '#b2182b'];

  function buildLegend(entry) {
    var fc = toFeatureCollection(entry.geojson);
    var n = fc.features.length;
    var prop = entry.valueProperty;
    var stats = prop ? valueStats(fc, prop) : null;
    var legend = { title: entry.name || 'Data layer', subtitle: null, items: [] };
    switch (entry.mapType) {
      case 'clusters':
        legend.subtitle = n + ' locations';
        legend.items = [
          { kind: 'dot', color: COLORS.pin, size: 5, label: 'Single location' },
          { kind: 'dot', color: COLORS.cluster[0], size: 7, label: '2–9 grouped' },
          { kind: 'dot', color: COLORS.cluster[1], size: 9, label: '10–49 grouped' },
          { kind: 'dot', color: COLORS.cluster[2], size: 11, label: '50+ grouped' }
        ];
        break;
      case 'heatmap':
        legend.subtitle = prop ? 'Density, weighted by ' + prop : 'Density of ' + n + ' locations';
        legend.items = [{ kind: 'gradient', colors: HEATMAP_RAMP, from: 'Low', to: 'High' }];
        break;
      case 'bubble':
        legend.subtitle = prop ? 'Sized by ' + prop : 'No value property selected';
        legend.items = [{
          kind: 'circles',
          color: COLORS.rampHigh,
          minR: 5,
          maxR: 16,
          from: stats ? formatNumber(stats.min) : 'Low',
          to: stats ? formatNumber(stats.max) : 'High'
        }];
        break;
      case 'choropleth':
        legend.subtitle = prop ? 'Shaded by ' + prop : 'No value property selected';
        legend.items = [{
          kind: 'gradient',
          colors: [COLORS.rampLow, COLORS.rampHigh],
          from: stats ? formatNumber(stats.min) : 'Low',
          to: stats ? formatNumber(stats.max) : 'High'
        }];
        break;
      case 'route':
        legend.items = [
          { kind: 'line', color: COLORS.line, label: 'Route' },
          { kind: 'dot', color: COLORS.pin, size: 5, label: 'Stop' }
        ];
        break;
      default: // pins
        legend.items = [{ kind: 'dot', color: COLORS.pin, size: 6, label: n + ' location' + (n === 1 ? '' : 's') }];
    }
    return legend;
  }

  function legendItemHTML(item) {
    if (item.kind === 'dot') {
      return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0">' +
        '<span style="width:' + item.size * 2 + 'px;height:' + item.size * 2 + 'px;border-radius:50%;background:' +
        item.color + ';border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15);flex:none"></span>' +
        '<span>' + escapeHTML(item.label) + '</span></div>';
    }
    if (item.kind === 'line') {
      return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0">' +
        '<span style="width:22px;height:4px;border-radius:2px;background:' + item.color + ';flex:none"></span>' +
        '<span>' + escapeHTML(item.label) + '</span></div>';
    }
    if (item.kind === 'gradient') {
      return '<div style="margin:4px 0 2px">' +
        '<div style="height:9px;border-radius:4px;background:linear-gradient(to right,' + item.colors.join(',') + ')"></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:#555;margin-top:2px">' +
        '<span>' + escapeHTML(item.from) + '</span><span>' + escapeHTML(item.to) + '</span></div></div>';
    }
    if (item.kind === 'circles') {
      return '<div style="display:flex;align-items:flex-end;gap:10px;margin:4px 0 2px">' +
        '<span style="text-align:center"><span style="display:block;margin:0 auto;width:' + item.minR * 2 + 'px;height:' + item.minR * 2 +
        'px;border-radius:50%;background:' + item.color + ';opacity:.78"></span>' +
        '<span style="font-size:10px;color:#555">' + escapeHTML(item.from) + '</span></span>' +
        '<span style="text-align:center"><span style="display:block;margin:0 auto;width:' + item.maxR * 2 + 'px;height:' + item.maxR * 2 +
        'px;border-radius:50%;background:' + item.color + ';opacity:.78"></span>' +
        '<span style="font-size:10px;color:#555">' + escapeHTML(item.to) + '</span></span></div>';
    }
    return '';
  }

  function legendHTML(models) {
    return models.map(function (m) {
      return '<div style="margin-bottom:8px">' +
        '<div style="font-weight:600;font-size:12px">' + escapeHTML(m.title) + '</div>' +
        (m.subtitle ? '<div style="font-size:10.5px;color:#555">' + escapeHTML(m.subtitle) + '</div>' : '') +
        m.items.map(legendItemHTML).join('') +
        '</div>';
    }).join('');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var LEGEND_W = 195;

  function legendModelHeight(m) {
    var h = 18 + (m.subtitle ? 14 : 0);
    m.items.forEach(function (item) {
      if (item.kind === 'gradient') h += 28;
      else if (item.kind === 'circles') h += item.maxR * 2 + 18;
      else h += 19;
    });
    return h + 8;
  }

  function drawLegendOnCanvas(ctx, models, x, bottomY) {
    if (!models.length) return;
    var pad = 10;
    var height = models.reduce(function (sum, m) { return sum + legendModelHeight(m); }, 0) + pad * 2 - 8;
    var top = bottomY - height;

    ctx.fillStyle = 'rgba(255,255,255,0.93)';
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    roundRect(ctx, x, top, LEGEND_W, height, 8);
    ctx.fill();
    ctx.stroke();

    var y = top + pad;
    var left = x + pad;
    var innerW = LEGEND_W - pad * 2;

    models.forEach(function (m) {
      ctx.fillStyle = '#1f2937';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(m.title, left, y, innerW);
      y += 18;
      if (m.subtitle) {
        ctx.fillStyle = '#555';
        ctx.font = '10.5px system-ui, sans-serif';
        ctx.fillText(m.subtitle, left, y - 3, innerW);
        y += 14;
      }
      m.items.forEach(function (item) {
        if (item.kind === 'dot') {
          ctx.beginPath();
          ctx.arc(left + 11, y + 9, item.size, 0, Math.PI * 2);
          ctx.fillStyle = item.color;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = '#1f2937';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(item.label, left + 28, y + 4, innerW - 28);
          y += 19;
        } else if (item.kind === 'line') {
          ctx.fillStyle = item.color;
          roundRect(ctx, left + 1, y + 7, 20, 4, 2);
          ctx.fill();
          ctx.fillStyle = '#1f2937';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(item.label, left + 28, y + 4, innerW - 28);
          y += 19;
        } else if (item.kind === 'gradient') {
          var grad = ctx.createLinearGradient(left, 0, left + innerW, 0);
          item.colors.forEach(function (color, i) {
            grad.addColorStop(i / (item.colors.length - 1), color);
          });
          ctx.fillStyle = grad;
          roundRect(ctx, left, y + 2, innerW, 9, 4);
          ctx.fill();
          ctx.fillStyle = '#555';
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillText(item.from, left, y + 14);
          var toW = ctx.measureText(item.to).width;
          ctx.fillText(item.to, left + innerW - toW, y + 14);
          y += 28;
        } else if (item.kind === 'circles') {
          var cy = y + item.maxR;
          [{ r: item.minR, label: item.from, cx: left + item.minR + 4 },
           { r: item.maxR, label: item.to, cx: left + item.minR * 2 + item.maxR + 24 }].forEach(function (c) {
            ctx.beginPath();
            ctx.arc(c.cx, cy + (item.maxR - c.r), c.r, 0, Math.PI * 2);
            ctx.fillStyle = item.color;
            ctx.globalAlpha = 0.78;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#555';
            ctx.font = '10px system-ui, sans-serif';
            var lw = ctx.measureText(c.label).width;
            ctx.fillText(c.label, c.cx - lw / 2, y + item.maxR * 2 + 4);
          });
          y += item.maxR * 2 + 18;
        }
      });
      y += 8;
    });
  }

  function attributionText(map) {
    try {
      var style = map.getStyle();
      var parts = [];
      Object.keys(style.sources || {}).forEach(function (key) {
        var attr = style.sources[key].attribution;
        if (attr) parts.push(attr.replace(/<[^>]*>/g, ''));
      });
      var text = parts.join(' ')
        .replace(/&copy;/g, '©').replace(/&mdash;/g, '—').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
      return text || '© OpenStreetMap contributors';
    } catch (err) {
      return '© OpenStreetMap contributors';
    }
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
    this._layersets = {};       // sourceId -> { geojson, name, mapType, valueProperty, layerIds }
    this._counter = 0;
    this._legendVisible = true;
    this._legendEl = null;
    this._title = null;
    this._titleEl = null;

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
    this._updateLegend();
  };

  AtlasMap.prototype._legendModels = function () {
    var self = this;
    return Object.keys(this._layersets).map(function (src) {
      return buildLegend(self._layersets[src]);
    });
  };

  AtlasMap.prototype._updateLegend = function () {
    var container = this.map.getContainer();
    if (!this._legendVisible) {
      if (this._legendEl) { this._legendEl.remove(); this._legendEl = null; }
      return;
    }
    var models = this._legendModels();
    if (!models.length) {
      if (this._legendEl) { this._legendEl.remove(); this._legendEl = null; }
      return;
    }
    if (!this._legendEl) {
      this._legendEl = document.createElement('div');
      this._legendEl.className = 'atlas-legend';
      this._legendEl.style.cssText =
        'position:absolute;left:10px;bottom:34px;z-index:5;width:' + LEGEND_W + 'px;' +
        'background:rgba(255,255,255,0.93);border:1px solid rgba(0,0,0,0.18);border-radius:8px;' +
        'padding:10px 10px 4px;font:11px/1.4 system-ui,sans-serif;color:#1f2937;' +
        'box-shadow:0 1px 4px rgba(0,0,0,0.12);max-height:55%;overflow-y:auto';
      container.appendChild(this._legendEl);
    }
    this._legendEl.innerHTML = legendHTML(models);
  };

  /** Show or hide the on-map legend (PNG exports control theirs separately). */
  AtlasMap.prototype.setLegendVisible = function (visible) {
    this._legendVisible = !!visible;
    this._updateLegend();
  };

  /** Set a map title, shown on the map and included in PNG exports. */
  AtlasMap.prototype.setTitle = function (title) {
    this._title = title || null;
    var container = this.map.getContainer();
    if (!this._title) {
      if (this._titleEl) { this._titleEl.remove(); this._titleEl = null; }
      return;
    }
    if (!this._titleEl) {
      this._titleEl = document.createElement('div');
      this._titleEl.className = 'atlas-title';
      this._titleEl.style.cssText =
        'position:absolute;left:10px;top:10px;z-index:5;max-width:60%;' +
        'background:rgba(255,255,255,0.93);border:1px solid rgba(0,0,0,0.18);border-radius:8px;' +
        'padding:7px 12px;font:600 15px/1.3 system-ui,sans-serif;color:#1f2937;' +
        'box-shadow:0 1px 4px rgba(0,0,0,0.12)';
      container.appendChild(this._titleEl);
    }
    this._titleEl.textContent = this._title;
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
   * options: { mapType, valueProperty, fit, id, name }
   * Returns a promise resolving to the layerset id.
   */
  AtlasMap.prototype.addData = function (data, options) {
    options = options || {};
    var self = this;
    return this._resolveData(data).then(function (resolved) {
      var fc = toFeatureCollection(resolved.geojson);
      var src = options.id || 'atlas-data-' + (++self._counter);
      self._layersets[src] = {
        geojson: fc,
        name: options.name || resolved.name || 'Data layer',
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
    if (!data) return Promise.resolve({ geojson: null, name: null });
    if (typeof data === 'object') return Promise.resolve({ geojson: data, name: data.name || null });
    if (/^https?:\/\//.test(data) || data.indexOf('/') === 0) {
      return fetch(data).then(function (r) { return r.json(); }).then(function (body) {
        var record = body.dataset || body;
        return { geojson: record.geojson || record, name: record.name || null };
      });
    }
    return this.client.getDataset(data).then(function (record) {
      return { geojson: record.geojson, name: record.name || data };
    });
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
    this._updateLegend();
  };

  AtlasMap.prototype.clearData = function () {
    Object.keys(this._layersets).forEach(this.removeData, this);
  };

  /** Re-render an existing layerset with a different map type / value property. */
  AtlasMap.prototype.setMapType = function (src, mapType, valueProperty) {
    var entry = this._layersets[src];
    if (!entry) return;
    var geojson = entry.geojson;
    var name = entry.name;
    this.removeData(src);
    this._layersets[src] = {
      geojson: geojson,
      name: name,
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
        name: e.name,
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

  /**
   * Export the current view as a PNG data URL (or trigger a download).
   * Every export includes the legend (when data layers exist), the map
   * title, and basemap attribution. options: { legend, title }.
   */
  AtlasMap.prototype.exportPNG = function (filename, options) {
    options = options || {};
    var self = this;
    var map = this.map;
    return new Promise(function (resolve) {
      map.once('idle', function () {
        var mapCanvas = map.getCanvas();
        var out = document.createElement('canvas');
        out.width = mapCanvas.width;
        out.height = mapCanvas.height;
        var ctx = out.getContext('2d');
        ctx.drawImage(mapCanvas, 0, 0);

        // Draw annotations in CSS pixels regardless of devicePixelRatio.
        var scale = mapCanvas.width / map.getContainer().clientWidth || 1;
        var w = mapCanvas.width / scale;
        var h = mapCanvas.height / scale;
        ctx.save();
        ctx.scale(scale, scale);

        var title = options.title !== undefined ? options.title : self._title;
        if (title) {
          ctx.font = '600 16px system-ui, sans-serif';
          var titleW = ctx.measureText(title).width;
          ctx.fillStyle = 'rgba(255,255,255,0.93)';
          ctx.strokeStyle = 'rgba(0,0,0,0.18)';
          roundRect(ctx, 10, 10, titleW + 24, 34, 8);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#1f2937';
          ctx.textBaseline = 'middle';
          ctx.fillText(title, 22, 27);
          ctx.textBaseline = 'alphabetic';
        }

        if (options.legend !== false) {
          ctx.textBaseline = 'top';
          drawLegendOnCanvas(ctx, self._legendModels(), 10, h - 12);
          ctx.textBaseline = 'alphabetic';
        }

        var attribution = attributionText(map);
        ctx.font = '10px system-ui, sans-serif';
        var attrW = ctx.measureText(attribution).width;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(w - attrW - 12, h - 16, attrW + 12, 16);
        ctx.fillStyle = '#333';
        ctx.fillText(attribution, w - attrW - 6, h - 5);

        ctx.restore();
        var dataUrl = out.toDataURL('image/png');
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
        atlasMap._legendVisible = options.legend !== false;
        if (options.title) atlasMap.setTitle(options.title);

        var data = options.data || options.dataset || options.dataUrl;
        var ready = new Promise(function (resolve) { map.once('load', resolve); });
        return ready.then(function () {
          if (!data) return atlasMap;
          return atlasMap
            .addData(data, {
              mapType: options.mapType || 'pins',
              valueProperty: options.valueProperty || null,
              name: options.dataName || null,
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
    version: '0.3.0',
    Client: Client,
    createMap: createMap,
    csvToGeoJSON: csvToGeoJSON,
    utils: {
      toFeatureCollection: toFeatureCollection,
      numericProperties: numericProperties,
      dataBounds: dataBounds,
      parseCSV: parseCSV,
      buildLegend: buildLegend,
      formatNumber: formatNumber
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Atlas;
  }
  global.Atlas = Atlas;
})(typeof window !== 'undefined' ? window : globalThis);
