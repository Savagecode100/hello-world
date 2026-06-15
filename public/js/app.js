/* Atlas Studio — UI layer on top of the Atlas SDK. */
(function () {
  'use strict';

  var client = new Atlas.Client({ baseUrl: '' });
  var atlasMap = null;
  var styles = [];
  var mapTypes = [];
  var activeStyleId = 'streets';
  var layerNames = {}; // layerset id -> display name
  var layerDatasetIds = {}; // layerset id -> server dataset id (when loaded from server)
  var activePlayer = null; // current TimeSeriesPlayer
  var activeTemporalSrc = null; // layerset id driving the timeline

  var $ = function (sel) { return document.querySelector(sel); };

  function toast(message, isError) {
    var el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.add('hidden'); }, 3500);
  }

  // --------------------------------------------------------------------
  // Basemap picker
  // --------------------------------------------------------------------

  function renderBasemapPicker() {
    var container = $('#basemap-picker');
    container.innerHTML = '';
    styles.forEach(function (style) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (style.id === activeStyleId ? ' active' : '');
      chip.textContent = style.name;
      chip.title = style.description;
      chip.addEventListener('click', function () {
        activeStyleId = style.id;
        atlasMap.setBasemap(style.id).catch(function (err) { toast(err.message, true); });
        renderBasemapPicker();
      });
      container.appendChild(chip);
    });
  }

  // --------------------------------------------------------------------
  // Geocoding search
  // --------------------------------------------------------------------

  function runSearch() {
    var query = $('#search-input').value.trim();
    if (!query) return;
    var list = $('#search-results');
    list.innerHTML = '<li>Searching…</li>';
    list.classList.remove('hidden');
    client.geocode(query, 6).then(function (results) {
      list.innerHTML = '';
      if (!results.length) {
        list.innerHTML = '<li>No results</li>';
        return;
      }
      results.forEach(function (place) {
        var li = document.createElement('li');
        li.innerHTML = '<div>' + escapeHTML(place.name) + '</div>' +
          '<div class="result-type">' + escapeHTML(place.type || '') + '</div>';
        li.addEventListener('click', function () {
          list.classList.add('hidden');
          if (place.boundingBox) {
            atlasMap.map.fitBounds(
              [[place.boundingBox[0], place.boundingBox[1]], [place.boundingBox[2], place.boundingBox[3]]],
              { padding: 40, duration: 1200 }
            );
          } else {
            atlasMap.map.flyTo({ center: [place.lng, place.lat], zoom: 10 });
          }
        });
        list.appendChild(li);
      });
    }).catch(function (err) {
      list.classList.add('hidden');
      toast('Search failed: ' + err.message, true);
    });
  }

  function escapeHTML(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // --------------------------------------------------------------------
  // Server datasets
  // --------------------------------------------------------------------

  function refreshDatasets() {
    client.listDatasets().then(function (datasets) {
      var container = $('#dataset-list');
      container.innerHTML = '';
      if (!datasets.length) {
        container.innerHTML = '<p class="empty-hint">No datasets on the server yet.</p>';
        return;
      }
      datasets.forEach(function (ds) {
        var row = document.createElement('div');
        row.className = 'dataset-row';
        row.innerHTML =
          '<div class="ds-meta"><div class="ds-name" title="' + escapeHTML(ds.name) + '">' + escapeHTML(ds.name) + '</div>' +
          '<div class="ds-count">' + ds.featureCount + ' features · id: ' + escapeHTML(ds.id) + '</div></div>';
        var btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Add';
        btn.addEventListener('click', function () { loadDataset(ds); });
        row.appendChild(btn);
        container.appendChild(row);
      });
    }).catch(function (err) { toast('Could not list datasets: ' + err.message, true); });
  }

  function loadDataset(ds) {
    if (ds.temporal) {
      atlasMap.addTimeSeriesData(ds.id, { mapType: 'bubble' }).then(function (src) {
        layerNames[src] = ds.name;
        layerDatasetIds[src] = ds.id;
        // Default the bubble size to the first numeric snapshot property.
        var layer = atlasMap.listLayersets().find(function (l) { return l.id === src; });
        if (layer && layer.numericProperties.length) {
          atlasMap.setMapType(src, 'bubble', layer.numericProperties[0]);
        }
        renderLayerList();
        activateTimeline(src);
        toast('Added time-lapse "' + ds.name + '" (' + ds.frameCount + ' frames)');
      }).catch(function (err) { toast(err.message, true); });
      return;
    }
    atlasMap.addData(ds.id, { mapType: 'clusters' }).then(function (src) {
      layerNames[src] = ds.name;
      layerDatasetIds[src] = ds.id;
      renderLayerList();
      toast('Added "' + ds.name + '" as a cluster map');
    }).catch(function (err) { toast(err.message, true); });
  }

  // --------------------------------------------------------------------
  // File import (CSV / GeoJSON)
  // --------------------------------------------------------------------

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = reader.result;
      var geojson;
      try {
        if (/\.csv$/i.test(file.name)) {
          geojson = looksLikeTimeSeriesCSV(text)
            ? Atlas.csvToTimeSeries(text, { name: file.name.replace(/\.csv$/i, '') })
            : Atlas.csvToGeoJSON(text);
        } else {
          geojson = JSON.parse(text);
        }
      } catch (err) {
        toast('Import failed: ' + err.message, true);
        return;
      }
      var fc = Atlas.utils.toFeatureCollection(geojson);
      if (Atlas.utils.isTemporal(fc)) {
        atlasMap.addTimeSeriesData(fc, { mapType: 'bubble' }).then(function (src) {
          layerNames[src] = file.name.replace(/\.(csv|geojson|json)$/i, '');
          var layer = atlasMap.listLayersets().find(function (l) { return l.id === src; });
          if (layer && layer.numericProperties.length) {
            atlasMap.setMapType(src, 'bubble', layer.numericProperties[0]);
          }
          renderLayerList();
          activateTimeline(src);
          toast('Imported time-lapse: ' + fc.features.length + ' features, ' +
            Atlas.utils.collectTimestamps(fc).length + ' frames');
          offerSaveToServer(src, fc);
        }).catch(function (err) { toast(err.message, true); });
        return;
      }
      var defaultType = guessMapType(fc);
      atlasMap.addData(fc, { mapType: defaultType }).then(function (src) {
        layerNames[src] = file.name.replace(/\.(csv|geojson|json)$/i, '');
        renderLayerList();
        toast('Imported ' + fc.features.length + ' features from ' + file.name);
        offerSaveToServer(src, fc);
      }).catch(function (err) { toast(err.message, true); });
    };
    reader.readAsText(file);
  }

  function guessMapType(fc) {
    var geomType = fc.features.length && fc.features[0].geometry && fc.features[0].geometry.type;
    if (/Polygon/.test(geomType || '')) return 'choropleth';
    if (/LineString/.test(geomType || '')) return 'route';
    return fc.features.length > 60 ? 'clusters' : 'pins';
  }

  // Detect long-format time-series CSVs: a header with both a timestamp-like
  // column and an id-like column, alongside coordinates.
  function looksLikeTimeSeriesCSV(text) {
    var nl = text.indexOf('\n');
    var headerLine = (nl === -1 ? text : text.slice(0, nl)).toLowerCase();
    var cols = headerLine.split(',').map(function (h) { return h.trim().replace(/^"|"$/g, ''); });
    var hasTime = cols.some(function (c) { return ['timestamp', 'time', 'date', 'datetime', 'year'].indexOf(c) !== -1; });
    var hasId = cols.some(function (c) { return ['id', 'feature_id', 'key', 'name'].indexOf(c) !== -1; });
    return hasTime && hasId;
  }

  function offerSaveToServer(src, fc) {
    if (!window.confirm('Save this dataset to the Atlas server so it can be used via the API and embeds?')) return;
    client.createDataset(fc, { name: layerNames[src] }).then(function (meta) {
      layerDatasetIds[src] = meta.id;
      toast('Saved to server as dataset "' + meta.id + '"');
      refreshDatasets();
      renderLayerList();
    }).catch(function (err) { toast('Save failed: ' + err.message, true); });
  }

  // --------------------------------------------------------------------
  // Layer list
  // --------------------------------------------------------------------

  function renderLayerList() {
    var container = $('#layer-list');
    var layersets = atlasMap.listLayersets();
    container.innerHTML = '';
    if (!layersets.length) {
      container.innerHTML = '<p class="empty-hint">No data layers yet. Load a dataset above or import your own file — e.g. a CSV of all your company’s locations with <code>lat</code>/<code>lng</code> columns.</p>';
      return;
    }
    layersets.forEach(function (layer) {
      container.appendChild(layerCard(layer));
    });
  }

  function layerCard(layer) {
    var card = document.createElement('div');
    card.className = 'layer-card';

    var head = document.createElement('div');
    head.className = 'layer-head';
    var name = document.createElement('div');
    name.className = 'layer-name';
    name.textContent = layerNames[layer.id] || layer.id;
    if (layer.temporal) {
      var badge = document.createElement('button');
      badge.className = 'tl-badge' + (activeTemporalSrc === layer.id ? ' active' : '');
      badge.textContent = '⏱ ' + layer.frameCount + 'f';
      badge.title = 'Time-lapse dataset — click to control on the timeline';
      badge.addEventListener('click', function () {
        if (activeTemporalSrc === layer.id) return;
        activateTimeline(layer.id);
        renderLayerList();
      });
      name.appendChild(document.createTextNode(' '));
      name.appendChild(badge);
    }
    var remove = document.createElement('button');
    remove.className = 'remove-layer';
    remove.title = 'Remove layer';
    remove.textContent = '✕';
    remove.addEventListener('click', function () {
      if (activeTemporalSrc === layer.id) deactivateTimeline();
      atlasMap.removeData(layer.id);
      delete layerNames[layer.id];
      delete layerDatasetIds[layer.id];
      renderLayerList();
    });
    head.appendChild(name);
    head.appendChild(remove);
    card.appendChild(head);

    // Map type select
    var typeRow = document.createElement('div');
    typeRow.className = 'control-row';
    var typeLabel = document.createElement('label');
    typeLabel.textContent = 'Map type';
    var typeSelect = document.createElement('select');
    mapTypes.forEach(function (mt) {
      var opt = document.createElement('option');
      opt.value = mt.id;
      opt.textContent = mt.name;
      if (mt.id === layer.mapType) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeRow.appendChild(typeLabel);
    typeRow.appendChild(typeSelect);
    card.appendChild(typeRow);

    // Value property select (used by heatmap / bubble / choropleth)
    var valueRow = document.createElement('div');
    valueRow.className = 'control-row';
    var valueLabel = document.createElement('label');
    valueLabel.textContent = 'Value property (size / shade / weight)';
    var valueSelect = document.createElement('select');
    var none = document.createElement('option');
    none.value = '';
    none.textContent = '— none (count only) —';
    valueSelect.appendChild(none);
    layer.numericProperties.forEach(function (prop) {
      var opt = document.createElement('option');
      opt.value = prop;
      opt.textContent = prop;
      if (prop === layer.valueProperty) opt.selected = true;
      valueSelect.appendChild(opt);
    });
    valueRow.appendChild(valueLabel);
    valueRow.appendChild(valueSelect);
    card.appendChild(valueRow);

    var hint = document.createElement('p');
    hint.className = 'maptype-hint';
    var mt = mapTypes.find(function (m) { return m.id === layer.mapType; });
    hint.textContent = mt ? mt.description : '';
    card.appendChild(hint);

    function rerender() {
      atlasMap.setMapType(layer.id, typeSelect.value, valueSelect.value || null);
      var current = mapTypes.find(function (m) { return m.id === typeSelect.value; });
      hint.textContent = current ? current.description : '';
    }
    typeSelect.addEventListener('change', rerender);
    valueSelect.addEventListener('change', rerender);

    return card;
  }

  // --------------------------------------------------------------------
  // Tools
  // --------------------------------------------------------------------

  function copyEmbedLink() {
    var layersets = atlasMap.listLayersets();
    var center = atlasMap.map.getCenter();
    var params = {
      style: activeStyleId,
      center: center.lng.toFixed(5) + ',' + center.lat.toFixed(5),
      zoom: atlasMap.map.getZoom().toFixed(2)
    };
    var withDataset = layersets.find(function (l) { return layerDatasetIds[l.id]; });
    if (withDataset) {
      params.dataset = layerDatasetIds[withDataset.id];
      params.maptype = withDataset.mapType;
      if (withDataset.valueProperty) params.value = withDataset.valueProperty;
    }
    var url = location.origin + '/embed?' + new URLSearchParams(params).toString();
    navigator.clipboard.writeText(url).then(function () {
      toast('Embed link copied: ' + url);
    }, function () {
      window.prompt('Embed link:', url);
    });
  }

  // --------------------------------------------------------------------
  // Time-lapse timeline
  // --------------------------------------------------------------------

  function formatTimestamp(ts) {
    if (ts == null) return '—';
    var d = new Date(ts);
    if (!isNaN(d.getTime()) && /\d{4}-\d{2}/.test(String(ts))) {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    return String(ts);
  }

  function activateTimeline(src) {
    if (activePlayer) activePlayer.pause();
    activeTemporalSrc = src;
    var player = atlasMap.createPlayer(src, {
      fps: 2,
      speed: Number($('#tl-speed').value) || 1,
      loop: true
    });
    activePlayer = player;

    var bar = $('#timeline-bar');
    var scrubber = $('#tl-scrubber');
    scrubber.min = 0;
    scrubber.max = Math.max(0, player.frameCount - 1);
    scrubber.value = player.index;
    bar.classList.remove('hidden');
    updateTimelineLabels(player.index, player.timestamps[player.index], player.frameCount);
    setPlayIcon(false);

    player.on('frame', function (info) {
      scrubber.value = info.index;
      updateTimelineLabels(info.index, info.timestamp, info.frameCount);
    });
    player.on('play', function () { setPlayIcon(true); });
    player.on('pause', function () { setPlayIcon(false); });
    player.on('complete', function () { setPlayIcon(false); });
  }

  function deactivateTimeline() {
    if (activePlayer) activePlayer.pause();
    activePlayer = null;
    activeTemporalSrc = null;
    $('#timeline-bar').classList.add('hidden');
    $('#tl-export-menu').classList.add('hidden');
  }

  function updateTimelineLabels(index, timestamp, frameCount) {
    $('#tl-timestamp').textContent = formatTimestamp(timestamp);
    $('#tl-frame').textContent = 'Frame ' + (index + 1) + ' / ' + frameCount;
  }

  function setPlayIcon(isPlaying) {
    $('#tl-play').textContent = isPlaying ? '❚❚' : '▶';
  }

  function showExportProgress(label, fraction) {
    var box = $('#tl-progress');
    box.classList.remove('hidden');
    $('#tl-progress-label').textContent = label;
    $('#tl-progress-bar').style.width = Math.round((fraction || 0) * 100) + '%';
  }

  function hideExportProgress() {
    $('#tl-progress').classList.add('hidden');
    $('#tl-progress-bar').style.width = '0%';
  }

  function runExport(format) {
    if (!activeTemporalSrc) return;
    $('#tl-export-menu').classList.add('hidden');
    if (activePlayer) activePlayer.pause();
    var name = (layerNames[activeTemporalSrc] || 'timelapse').replace(/\s+/g, '-').toLowerCase();
    var onProgress = function (p) {
      if (p.phase === 'capture') {
        showExportProgress('Capturing frame ' + p.current + ' / ' + p.total, p.current / p.total);
      } else if (p.phase === 'encode') {
        showExportProgress('Encoding…', p.progress);
      }
    };

    if (format === 'gif') {
      toast('Rendering animated GIF…');
      atlasMap.exportTimeLapseGIF(activeTemporalSrc, {
        frameDelay: 500,
        filename: name + '.gif',
        onProgress: onProgress
      }).then(function () {
        hideExportProgress();
        toast('GIF downloaded');
      }).catch(function (err) {
        hideExportProgress();
        toast('GIF export failed: ' + err.message, true);
      });
    } else {
      toast('Recording WebM video…');
      atlasMap.exportTimeLapseVideo(activeTemporalSrc, {
        frameDuration: 600,
        filename: name + '.webm',
        onProgress: onProgress
      }).then(function () {
        hideExportProgress();
        toast('Video downloaded');
      }).catch(function (err) {
        hideExportProgress();
        toast('Video export failed: ' + err.message, true);
      });
    }
  }

  function wireTimelineControls() {
    $('#tl-play').addEventListener('click', function () {
      if (activePlayer) activePlayer.toggle();
    });
    $('#tl-next').addEventListener('click', function () {
      if (activePlayer) { activePlayer.pause(); activePlayer.next(); }
    });
    $('#tl-prev').addEventListener('click', function () {
      if (activePlayer) { activePlayer.pause(); activePlayer.prev(); }
    });
    $('#tl-scrubber').addEventListener('input', function (e) {
      if (activePlayer) { activePlayer.pause(); activePlayer.setIndex(Number(e.target.value)); }
    });
    $('#tl-speed').addEventListener('change', function (e) {
      if (activePlayer) activePlayer.setSpeed(Number(e.target.value) || 1);
    });
    $('#tl-export-btn').addEventListener('click', function () {
      $('#tl-export-menu').classList.toggle('hidden');
    });
    $('#tl-export-menu').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () { runExport(btn.getAttribute('data-format')); });
    });
    // Keyboard: space toggles playback when a timeline is active.
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && activePlayer && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        activePlayer.toggle();
      }
    });
  }

  // --------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------

  Promise.all([client.getStyles(), client.getMapTypes()]).then(function (results) {
    styles = results[0];
    mapTypes = results[1];
    renderBasemapPicker();
    return Atlas.createMap('#map', {
      baseUrl: '',
      style: activeStyleId,
      center: [-96, 38.5], // continental USA
      zoom: 4
    });
  }).then(function (instance) {
    atlasMap = instance;
    refreshDatasets();

    atlasMap.map.on('move', function () {
      $('#status-zoom').textContent = 'z' + atlasMap.map.getZoom().toFixed(1);
    });

    $('#search-btn').addEventListener('click', runSearch);
    $('#search-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runSearch();
    });
    $('#refresh-datasets').addEventListener('click', refreshDatasets);
    $('#file-input').addEventListener('change', function (e) {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#fit-data').addEventListener('click', function () { atlasMap.fitToData(); });
    $('#export-png').addEventListener('click', function () {
      toast('Rendering PNG…');
      atlasMap.exportPNG('atlas-map.png');
    });
    $('#copy-embed').addEventListener('click', copyEmbedLink);
    wireTimelineControls();
  }).catch(function (err) {
    toast('Failed to start Atlas Studio: ' + err.message, true);
    console.error(err);
  });
})();
