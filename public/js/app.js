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
          geojson = Atlas.csvToGeoJSON(text);
        } else {
          geojson = JSON.parse(text);
        }
      } catch (err) {
        toast('Import failed: ' + err.message, true);
        return;
      }
      var fc = Atlas.utils.toFeatureCollection(geojson);
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
    var remove = document.createElement('button');
    remove.className = 'remove-layer';
    remove.title = 'Remove layer';
    remove.textContent = '✕';
    remove.addEventListener('click', function () {
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
  }).catch(function (err) {
    toast('Failed to start Atlas Studio: ' + err.message, true);
    console.error(err);
  });
})();
