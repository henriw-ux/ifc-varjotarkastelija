// Karttanäkymä: MapLibre + ShadeMap (mapbox-gl-shadow-simulator).
// Pohjakartta: OpenFreeMap (avoin, ei avainta, OpenStreetMap-aineisto). Rakennukset varjoja ja
// 3D-ympäristöä varten haetaan ensisijaisesti suoraan OpenStreetMapista (Overpass API, kokonaiset
// polygonit + korkeustiedot); varalla käytetään pohjakartan rakennustiiliä.
// IFC-mallin jalanjälki syötetään ShadeMapille lisärakennuksina, jolloin uuden rakennuksen
// varjot näkyvät kartalla.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import ShadeMap from 'mapbox-gl-shadow-simulator';

const EMPTY = { type: 'FeatureCollection', features: [] };
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const MODEL_RED = '#e03131';

/** Korkeus metreinä vektoritiilen (OpenMapTiles) tai OSM-tagien perusteella. */
export function buildingHeight(props) {
  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : 0;
  };
  const h = num(props.render_height) || num(props.height);
  if (h) return h;
  const lv = num(props['building:levels']) || num(props.levels);
  if (lv) return lv * 3.2 + (num(props['roof:levels']) ? num(props['roof:levels']) * 2.5 : 0);
  return 7; // oletus, kun korkeustietoa ei ole
}

/** Odottaa, että kartan tiilet on ladattu (kuten ShadeMapin MapLibre-esimerkissä). */
function mapTilesLoaded(map, timeout = 10000) {
  return new Promise((res) => {
    const t = setTimeout(done, timeout);
    function done() {
      clearTimeout(t);
      map.off('render', check);
      res();
    }
    function check() {
      if (map.loaded()) done();
    }
    map.on('render', check);
    check();
  });
}

function distM(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lng - b.lng) * 111320 * k, (a.lat - b.lat) * 110574);
}

/** OSM-rakennukset Overpass-rajapinnasta GeoJSON-polygoneina. */
async function fetchOsmBuildings(lat, lng, radius) {
  const q = `[out:json][timeout:25];(way["building"](around:${radius},${lat},${lng});relation["building"]["type"="multipolygon"](around:${radius},${lat},${lng}););out geom;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      const ring = (geom) => {
        const r = geom.map((p) => [p.lon, p.lat]);
        if (r.length < 4) return null;
        const a = r[0], b = r[r.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) r.push(a);
        return r;
      };
      const out = [];
      for (const el of json.elements || []) {
        const props = { ...el.tags, height: buildingHeight(el.tags || {}), osm: `${el.type}/${el.id}` };
        if (el.type === 'way' && el.geometry) {
          const r = ring(el.geometry);
          if (r) out.push({ type: 'Feature', id: el.id, geometry: { type: 'Polygon', coordinates: [r] }, properties: props });
        } else if (el.type === 'relation') {
          const outers = [], inners = [];
          for (const m of el.members || []) {
            if (m.type !== 'way' || !m.geometry) continue;
            const r = ring(m.geometry);
            if (!r || r[0][0] !== m.geometry[m.geometry.length - 1].lon) continue; // vain suljetut renkaat
            (m.role === 'inner' ? inners : outers).push(r);
          }
          if (outers.length)
            out.push({
              type: 'Feature', id: el.id,
              geometry: { type: 'MultiPolygon', coordinates: outers.map((o, i) => (i === 0 ? [o, ...inners] : [o])) },
              properties: props,
            });
        }
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export class MapView {
  constructor(container, { center = [24.9384, 60.1699], zoom = 14 } = {}) {
    this.shadeMap = null;
    this.modelFeatures = []; // ShadeMapille syötettävät mallin suorakaiteet
    this.matchedFeatures = [];
    this.osm = null; // {center, radius, features}
    this.isExcluded = () => false; // poistetaanko kartan rakennus (korvautuu mallilla)
    this.date = new Date();
    this.listeners = {};

    this.map = new maplibregl.Map({
      container,
      center,
      zoom,
      maxPitch: 45, // ShadeMap laskee varjot oikein vain loivilla kallistuksilla
      attributionControl: { compact: true },
      style: STYLE_URL,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.loaded = new Promise((res) => this.map.on('load', res));
    this.loaded.then(() => this._addOwnLayers());
  }

  _addOwnLayers() {
    const map = this.map;
    // pohjakartan 3D-rakennukset pois (varjot piirretään tasokarttaan)
    for (const l of map.getStyle().layers) if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', 'none');
    this.tileSource = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector')?.[0] || 'openmaptiles';
    map.addSource('osm-buildings', { type: 'geojson', data: EMPTY });
    map.addSource('excluded', { type: 'geojson', data: EMPTY });
    map.addSource('model', { type: 'geojson', data: { type: 'FeatureCollection', features: this.modelFeatures } });
    map.addSource('matched', { type: 'geojson', data: { type: 'FeatureCollection', features: this.matchedFeatures } });
    map.addLayer({
      id: 'osm-buildings-line', source: 'osm-buildings', type: 'line',
      paint: { 'line-color': '#7c746a', 'line-width': 0.6, 'line-opacity': 0.7 },
    });
    map.addLayer({
      id: 'osm-buildings-hit', source: 'osm-buildings', type: 'fill',
      paint: { 'fill-color': '#000', 'fill-opacity': 0.01 },
    });
    map.addLayer({
      id: 'excluded-fill', source: 'excluded', type: 'fill',
      paint: { 'fill-color': '#f8f9fa', 'fill-opacity': 0.75 },
    });
    map.addLayer({
      id: 'excluded-line', source: 'excluded', type: 'line',
      paint: { 'line-color': '#868e96', 'line-width': 1.5, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'matched-line', source: 'matched', type: 'line',
      paint: { 'line-color': '#1f6feb', 'line-width': 2, 'line-dasharray': [2, 1] },
    });
    map.addLayer({
      id: 'model-fill', source: 'model', type: 'fill',
      paint: { 'fill-color': MODEL_RED, 'fill-opacity': 0.6 },
    });
    map.addLayer({
      id: 'model-outline', source: 'model', type: 'line',
      paint: { 'line-color': '#a51111', 'line-width': 2 },
    });
    this._setupDrag();
    map.on('click', 'osm-buildings-hit', (e) => {
      if (this.dragEnabled) return;
      if (map.queryRenderedFeatures(e.point, { layers: ['model-fill'] }).length) return;
      const hit = e.features?.[0];
      const osmId = hit?.properties?.osm;
      const f = osmId && this.osm?.features.find((x) => x.properties.osm === osmId);
      if (f) this.emit('buildingclick', f);
    });
    map.on('mouseenter', 'osm-buildings-hit', () => {
      if (!this.dragEnabled) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'osm-buildings-hit', () => (map.getCanvas().style.cursor = ''));
  }

  setExcluded(features) {
    this.map.getSource('excluded')?.setData({ type: 'FeatureCollection', features: features || [] });
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
  }
  emit(evt, ...a) {
    (this.listeners[evt] || []).forEach((f) => f(...a));
  }

  /** Odottaa, että kartta on ladannut näkyvät tiilet (enintään timeout ms). */
  async whenIdle(timeout = 10000) {
    await Promise.race([this.loaded, new Promise((r) => setTimeout(r, timeout))]);
    if (this.map.loaded() && !this.map.isMoving()) return;
    await new Promise((r) => {
      const t = setTimeout(r, timeout);
      this.map.once('idle', () => (clearTimeout(t), r()));
    });
  }

  /** Hakee OSM-rakennukset alueelta (Overpass), ellei alue ole jo ladattu. */
  async loadOsmBuildings(center, radius = 400) {
    if (this.osm && distM(this.osm.center, center) + radius <= this.osm.radius) return this.osm.features.length;
    const r = Math.round(radius + 150);
    try {
      const features = await fetchOsmBuildings(center.lat, center.lng, r);
      this.osm = { center, radius: r, features };
      await this.loaded;
      this.map.getSource('osm-buildings')?.setData({ type: 'FeatureCollection', features });
      this.refreshShadows();
      return features.length;
    } catch (e) {
      console.warn('OSM-rakennusten haku epäonnistui, käytetään karttatiiliä', e);
      return 0;
    }
  }

  /** Rakennukset (korkeus metreinä): OSM/Overpass, jos ladattu, muuten pohjakartan tiilet. */
  getBuildings() {
    if (this.osm?.features.length) return this.osm.features;
    if (!this.tileSource) return [];
    const raw = this.map.querySourceFeatures(this.tileSource, { sourceLayer: 'building' });
    const seen = new Set();
    const out = [];
    for (const f of raw) {
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
      const c = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
      const key = `${f.id ?? ''}|${c.length}|${c[0][0].toFixed(7)}|${c[0][1].toFixed(7)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: 'Feature', geometry: g, properties: { height: buildingHeight(f.properties || {}) } });
    }
    return out;
  }

  startShadeMap(apiKey) {
    if (this.shadeMap) {
      this.shadeMap.remove();
      this.shadeMap = null;
    }
    if (!apiKey) return;
    const map = this.map;
    this.shadeMap = new ShadeMap({
      apiKey,
      date: this.date,
      color: '#01112f',
      opacity: 0.65,
      terrainSource: {
        maxZoom: 15,
        tileSize: 256,
        getSourceUrl: ({ x, y, z }) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
        getElevation: ({ r, g, b }) => r * 256 + g + b / 256 - 32768,
      },
      getFeatures: async () => {
        if (map.getZoom() < 12) return this.modelFeatures;
        await mapTilesLoaded(map);
        const buildings = this.getBuildings().filter((f) => !this.isExcluded(f));
        const all = buildings.concat(this.modelFeatures);
        // rakennukset rasteroidaan alhaalta ylös
        all.sort((a, b) => a.properties.height - b.properties.height);
        return all;
      },
      debug: () => {},
    }).addTo(map);
    this.shadeMap.on('tileloaded', (loaded, total) => this.emit('progress', loaded, total));
    // mallin ääriviiva varjokerroksen päälle
    const lift = () => {
      for (const id of ['model-fill', 'model-outline', 'matched-line']) if (map.getLayer(id)) map.moveLayer(id);
    };
    setTimeout(lift, 0);
  }

  setDate(date) {
    this.date = date;
    this.shadeMap?.setDate(date);
  }

  async setSunExposure(enabled, opts) {
    if (!this.shadeMap) return;
    await this.shadeMap.setSunExposure(enabled, opts);
  }

  /** Mallin suorakaiteet [{coords:[[lng,lat]...], height}] */
  setModel(rects) {
    this.modelFeatures = rects.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [r.coords] },
      properties: { height: r.height, model: true },
    }));
    if (this.map.getSource('model')) this.map.getSource('model').setData({ type: 'FeatureCollection', features: this.modelFeatures });
  }

  setMatched(features) {
    this.matchedFeatures = features || [];
    this.map.getSource('matched')?.setData({ type: 'FeatureCollection', features: this.matchedFeatures });
  }

  /** Pakottaa ShadeMapin hakemaan rakennukset uudelleen (esim. sijoituksen muuttuessa). */
  refreshShadows() {
    if (this.shadeMap) this.map.fire('moveend');
  }

  // --- Mallin siirto vetämällä --------------------------------------------
  _setupDrag() {
    const map = this.map;
    let dragging = null;
    map.on('mouseenter', 'model-fill', () => {
      if (this.dragEnabled) map.getCanvas().style.cursor = 'move';
    });
    map.on('mouseleave', 'model-fill', () => (map.getCanvas().style.cursor = ''));
    map.on('mousedown', 'model-fill', (e) => {
      if (!this.dragEnabled) return;
      e.preventDefault();
      dragging = { start: e.lngLat, rotate: e.originalEvent.shiftKey };
      map.dragPan.disable();
      this.emit('dragstart', dragging);
    });
    map.on('mousemove', (e) => {
      if (!dragging) return;
      this.emit('drag', dragging, e.lngLat, e.point);
    });
    const end = () => {
      if (!dragging) return;
      dragging = null;
      map.dragPan.enable();
      this.emit('dragend');
    };
    map.on('mouseup', end);
    map.getCanvas().addEventListener('mouseleave', end);
  }
}
