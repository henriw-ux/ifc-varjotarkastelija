// Karttanäkymä: MapLibre + ShadeMap (mapbox-gl-shadow-simulator).
// Pohjakartta ja rakennusaineisto tulevat ShadeMapin omista tiilipalveluista (kuten ShadeMapin
// omassa MapLibre-esimerkissä); IFC-mallin jalanjälki syötetään ShadeMapille lisärakennuksina,
// jolloin uuden rakennuksen varjot näkyvät kartalla.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import ShadeMap from 'mapbox-gl-shadow-simulator';
import layers from 'protomaps-themes-base';

const EMPTY = { type: 'FeatureCollection', features: [] };

export function buildingHeight(props) {
  // ShadeMapin rakennustiilien korkeus on desimetreinä (vrt. ShadeMapin esimerkki)
  const h = Number(props.height) / 10;
  if (h > 0) return h;
  const lv = Number(props.levels || props['building:levels']);
  return lv > 0 ? lv * 3.04 : 3.1;
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

export class MapView {
  constructor(container, { center = [24.9384, 60.1699], zoom = 14 } = {}) {
    this.shadeMap = null;
    this.modelFeatures = []; // ShadeMapille syötettävät mallin suorakaiteet
    this.isExcluded = () => false; // poistetaanko kartan rakennus (korvautuu mallilla)
    this.date = new Date();
    this.listeners = {};

    this.map = new maplibregl.Map({
      container,
      center,
      zoom,
      maxPitch: 45, // ShadeMap laskee varjot oikein vain loivilla kallistuksilla
      attributionControl: { compact: true },
      style: {
        version: 8,
        glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
        sources: {
          protomaps: {
            type: 'vector',
            tiles: ['https://cfw.shademap.app/planet/{z}/{x}/{y}.pbf'],
            attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
            maxzoom: 15,
          },
          buildings: {
            type: 'vector',
            tiles: ['https://cfw.shademap.app/buildings/{z}/{x}/{y}.mvt'],
            minzoom: 14,
            maxzoom: 14,
          },
          model: { type: 'geojson', data: EMPTY },
          matched: { type: 'geojson', data: EMPTY },
        },
        layers: [
          ...layers('protomaps', 'light', 'fi'),
          {
            id: 'building-fill',
            source: 'buildings',
            'source-layer': 'building',
            type: 'fill',
            paint: { 'fill-color': '#d9d4cc', 'fill-opacity': 0.6 },
          },
          {
            id: 'building-line',
            source: 'buildings',
            'source-layer': 'building',
            type: 'line',
            paint: { 'line-color': '#8a8378', 'line-width': 0.8 },
          },
          {
            id: 'matched-line',
            source: 'matched',
            type: 'line',
            paint: { 'line-color': '#1f6feb', 'line-width': 2, 'line-dasharray': [2, 1] },
          },
          {
            id: 'model-fill',
            source: 'model',
            type: 'fill',
            paint: {
              'fill-color': ['interpolate', ['linear'], ['get', 'height'], 0, '#ffd8a8', 30, '#e8590c'],
              'fill-opacity': 0.55,
            },
          },
        ],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.loaded = new Promise((res) => this.map.on('load', res));
    this.loaded.then(() => {
      this.map.addLayer({
        id: 'model-outline',
        source: 'model',
        type: 'line',
        paint: { 'line-color': '#c2410c', 'line-width': 1.5 },
      });
    });
    this._setupDrag();
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

  /** Kaikki ladatut rakennukset (kartan omat), korkeus metreinä. */
  getBuildings() {
    const raw = this.map.querySourceFeatures('buildings', { sourceLayer: 'building' });
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
      for (const id of ['model-outline', 'matched-line']) if (map.getLayer(id)) map.moveLayer(id);
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
    this.map.getSource('model')?.setData({ type: 'FeatureCollection', features: this.modelFeatures });
  }

  setMatched(features) {
    this.map.getSource('matched')?.setData({ type: 'FeatureCollection', features: features || [] });
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
