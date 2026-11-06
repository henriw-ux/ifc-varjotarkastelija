import './style.css';
import SunCalc from 'suncalc';
import { MapView } from './map.js';
import { Viewer3D, heatColor } from './viewer3d.js';
import { loadIfc, computeFootprint } from './ifc.js';
import { geocode, enToLngLat, lngLatToEN, rotate2 } from './geo.js';
import { autoFit, featuresToLocal, coveredFraction, modelInsideFraction } from './fit.js';

const $ = (id) => document.getElementById(id);
const fmtH = (h) => `${h.toFixed(1).replace('.', ',')} h`;
const pct = (x) => `${Math.round(x * 100)} %`;
const pad = (n) => String(n).padStart(2, '0');
const tick = () => new Promise((r) => setTimeout(r, 0));

const state = {
  model: null,
  file: null,
  anchor: null, // {lat, lng} – paikallisen ENU-tason origo (osoitepiste tai IFC-georeferointi)
  addressPoint: null,
  placement: null, // {pivot:[mx,my], rotation, offsetE, offsetN, groundY}
  placementSource: '',
  fitIoU: null,
  date: new Date(),
  selectedSpace: null,
  results: new Map(),
};

// ---------------------------------------------------------------- näkymät --
const mapView = new MapView($('map'));
const viewer = new Viewer3D($('viewer'));

document.querySelectorAll('#layout-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('#layout-seg button').forEach((x) => x.classList.toggle('active', x === b));
    $('panes').className = `panes ${b.dataset.layout}`;
    setTimeout(() => {
      mapView.map.resize();
      viewer.resize();
    }, 0);
  })
);

function status(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}
function busy(msg) {
  $('busy').hidden = !msg;
  $('busy-text').textContent = msg || '';
}

// --------------------------------------------------------------- API-avain --
// Avainta ei ole sovelluksen koodissa: käyttäjä syöttää oman avaimensa, joka tallennetaan
// vain hänen selaimensa localStorageen.
const KEY_STORE = 'shademap-api-key';
let savedKey = '';
try {
  savedKey = localStorage.getItem(KEY_STORE) || '';
} catch {}
$('api-key').value = savedKey;

function renderKeyState() {
  const has = !!savedKey;
  $('sec-key').classList.toggle('ok', has);
  $('key-pill').textContent = has ? 'Avain käytössä' : 'Ei avainta';
  $('btn-key-clear').hidden = !has;
  $('map-msg').innerHTML = has
    ? ''
    : 'Kartan varjot näkyvät, kun olet tallentanut ShadeMap API-avaimen. <button type="button" id="msg-key">Syötä avain</button>';
  $('msg-key')?.addEventListener('click', () => {
    $('sec-key').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('api-key').focus();
  });
}
function applyApiKey(key) {
  savedKey = key;
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {}
  mapView.loaded.then(() => mapView.startShadeMap(key));
  renderKeyState();
}
$('btn-key-save').addEventListener('click', () => {
  const key = $('api-key').value.trim();
  if (!key) {
    $('api-key').focus();
    return;
  }
  applyApiKey(key);
  $('api-key').type = 'password';
});
$('api-key').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-key-save').click());
$('btn-key-clear').addEventListener('click', () => {
  $('api-key').value = '';
  applyApiKey('');
});
$('btn-key-show').addEventListener('click', () => {
  $('api-key').type = $('api-key').type === 'password' ? 'text' : 'password';
});
applyApiKey(savedKey);
mapView.on('progress', (loaded, total) => {
  if (!savedKey) return;
  $('map-msg').textContent = loaded < total ? `ShadeMap: ladataan maastoa ${Math.round((loaded / total) * 100)} %` : '';
});

// -------------------------------------------------------------- tiedosto ----
const drop = $('drop');
$('ifc-file').addEventListener('change', (e) => setFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith('.ifc'));
  if (f) setFile(f);
});
$('btn-sample').addEventListener('click', async () => {
  try {
    busy('Haetaan esimerkkimallia…');
    const res = await fetch('./esimerkki.ifc');
    if (!res.ok) throw new Error(`Esimerkkimallin haku epäonnistui (${res.status})`);
    setFile(new File([await res.blob()], 'esimerkki.ifc'));
    if (!$('address').value) $('address').value = 'Kampintori, Helsinki';
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(null);
  }
});
function setFile(f) {
  if (!f) return;
  state.file = f;
  $('drop-label').innerHTML = `<b>${f.name}</b> (${(f.size / 1e6).toFixed(1)} Mt)`;
  drop.classList.add('has-file');
}

// ------------------------------------------------------- lataus + sijoitus --
$('btn-load').addEventListener('click', loadAndPlace);
$('address').addEventListener('keydown', (e) => e.key === 'Enter' && loadAndPlace());

async function loadAndPlace() {
  const address = $('address').value.trim();
  if (!state.file && !state.model) return status('Valitse ensin IFC-tiedosto.', true);
  try {
    // 1) IFC
    if (state.file && state.file !== state.model?.file) {
      busy('Luetaan IFC-mallia…');
      const buf = await state.file.arrayBuffer();
      const model = await loadIfc(buf, (m) => {
        busy(m);
        status(m);
      });
      model.file = state.file;
      state.model = model;
      state.results.clear();
      viewer.setModel(model);
      // IFC:n maastomalli on usein eri korossa kuin kartan maanpinta → oletuksena piilossa
      viewer.setSiteVisible($('show-site').checked);
      buildSpaceList();
    }
    const model = state.model;
    const georef = model.georef;
    let useGeoref = $('use-georef').checked && georef.lat != null;
    let georefNote = '';
    // Revitin oletussijainti (Boston) päätyy IFC:hen, jos projektin sijaintia ei ole asetettu
    const isDefaultLocation = georef.lat != null && distanceKm(georef, { lat: 42.3584, lng: -71.0598 }) < 30;

    // 2) Osoite
    let addressPoint = null;
    if (address) {
      busy('Haetaan osoitetta…');
      const hits = await geocode(address);
      if (!hits.length && !useGeoref) throw new Error(`Osoitetta "${address}" ei löytynyt.`);
      if (hits.length) addressPoint = { lat: hits[0].lat, lng: hits[0].lng, label: hits[0].label };
    } else if (!useGeoref) {
      throw new Error('Anna rakennuspaikan osoite (mallissa ei ole käytettävää georeferointia).');
    }
    state.addressPoint = addressPoint;
    if (useGeoref && addressPoint) {
      const d = distanceKm(georef, addressPoint);
      if (d > 1) {
        useGeoref = false;
        georefNote = `IFC:n oma sijaintitieto (${georef.lat.toFixed(4)}, ${georef.lng.toFixed(4)}${
          isDefaultLocation ? ', Revitin oletussijainti Boston' : ''
        }) on ${d < 100 ? d.toFixed(1) : Math.round(d)} km päässä osoitteesta – käytetään osoitetta.`;
      }
    } else if (useGeoref && isDefaultLocation) {
      throw new Error(
        'IFC:n sijaintitieto on Revitin oletussijainti (Boston), eli mallia ei ole georeferoitu. Anna rakennuspaikan osoite.'
      );
    }

    // 3) Alkusijoitus
    const groundY = model.groundY;
    model.footprint = computeFootprint(model, groundY);
    state.groundBase = groundY; // valitun kerroksen lattia (mallin koordinaateissa)
    state.elev = 0; // käyttäjän nosto/lasku
    buildGroundSelect(model);
    if (useGeoref) {
      state.anchor = { lat: georef.lat, lng: georef.lng };
      state.placement = {
        pivot: [model.projectOrigin.x, -model.projectOrigin.z],
        rotation: norm360(georef.rotation || 0),
        offsetE: 0,
        offsetN: 0,
        groundY,
      };
      state.placementSource = `IFC-georeferointi: ${georef.source}`;
      state.fitIoU = null;
    } else {
      state.anchor = { lat: addressPoint.lat, lng: addressPoint.lng };
      state.placement = {
        pivot: model.footprint.centroid.slice(),
        rotation: norm360(georef.trueNorthRotation || 0),
        offsetE: 0,
        offsetN: 0,
        groundY,
      };
      state.placementSource = 'Osoitepiste';
      state.fitIoU = null;
    }
    $('sec-place').classList.remove('disabled');
    $('sec-spaces').classList.remove('disabled');

    // 4) Kartta paikalleen ja rakennusmuotojen lataus
    busy('Ladataan karttaa ja ympäröiviä rakennuksia…');
    await flyToModel();
    busy('Haetaan ympäröiviä rakennuksia (OpenStreetMap)…');
    await ensureOsmBuildings();
    if (!useGeoref) await runAutoFit({ quiet: true });
    applyPlacement({ reloadSurroundings: true });
    syncSun();
    viewer.viewAll();
    status(
      `${model.name || state.file?.name || 'Malli'}: ${model.spaces.length} tilaa, ${model.storeys.length} kerrosta.` +
        (addressPoint ? `\nOsoite: ${addressPoint.label}` : '') +
        (georefNote ? `\n${georefNote}` : '') +
        `\nMaanpinnan tasona: ${$('ground-storey').selectedOptions[0]?.text || '–'}` +
        (model.siteGroundY != null && Math.abs(model.siteGroundY - model.groundY) > 0.8
          ? `\nHuom: IFC:n oma maastopinta on ${(model.siteGroundY - model.groundY).toFixed(1).replace('.', ',')} m tästä tasosta – sen voi valita korkeusasemaksi.`
          : '')
    );
  } catch (err) {
    console.error(err);
    status(err.message || String(err), true);
  } finally {
    busy(null);
  }
}

async function flyToModel() {
  const c = modelCenterLngLat();
  const map = mapView.map;
  map.jumpTo({ center: c, zoom: 17, pitch: 0, bearing: 0 });
  await mapView.whenIdle();
}

function modelCenterLngLat() {
  const p = state.placement;
  const fp = state.model.footprint;
  const [e, n] = localToEN(fp.centroid[0], fp.centroid[1], p);
  return enToLngLat(e, n, state.anchor);
}

function localToEN(mx, my, p = state.placement) {
  const [x, y] = rotate2(mx - p.pivot[0], my - p.pivot[1], p.rotation);
  return [x + p.offsetE, y + p.offsetN];
}

const norm360 = (a) => ((a % 360) + 360) % 360;

function distanceKm(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lng - b.lng) * 111.32 * k, (a.lat - b.lat) * 110.574);
}

async function runAutoFit({ quiet = false } = {}) {
  const model = state.model;
  await mapView.whenIdle();
  await ensureOsmBuildings(); // rakennukset juuri tältä alueelta
  const radius = Math.max(150, Math.hypot(model.bbox.max.x - model.bbox.min.x, model.bbox.max.z - model.bbox.min.z));
  const buildings = featuresToLocal(mapView.getBuildings(), state.anchor).filter(
    (b) => Math.hypot((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2) < radius
  );
  const p = state.placement;
  // lähtöarvaus: mallin painopiste osoitepisteeseen
  const pivot = p.pivot;
  const res = autoFit(model, buildings, pivot, { rotation: p.rotation, offsetE: p.offsetE, offsetN: p.offsetN });
  if (!res || res.iou < 0.4) {
    state.fitIoU = null;
    mapView.setMatched([]);
    const msg = buildings.length
      ? 'Kartalta ei löytynyt mallin muotoon sopivaa rakennusta osoitteen kohdalta – sijoita malli käsin (kierto/siirto tai vetämällä).'
      : 'Kartan rakennusaineistoa ei ole ladattu tälle alueelle – sijoita malli käsin.';
    if (!quiet) status(msg, true);
    else $('place-info').dataset.warn = msg;
    return false;
  }
  Object.assign(p, { rotation: res.rotation, offsetE: res.offsetE, offsetN: res.offsetN });
  state.fitIoU = res.iou;
  state.placementSource = 'Osoite + automaattinen muotosovitus kartan rakennuksiin';
  delete $('place-info').dataset.warn;
  mapView.setMatched(res.matched);
  return true;
}

// ----------------------------------------------- sijoituksen soveltaminen --
let surroundTimer = null;
const excludeCache = new Map();

function applyPlacement({ reloadSurroundings = false, live = false } = {}) {
  const p = state.placement;
  const fp = state.model.footprint;
  // kartan suorakaiteet
  const rects = fp.rectangles.map((r) => ({
    height: r.height,
    coords: [
      [r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1], [r.x0, r.y0],
    ].map(([x, y]) => {
      const [e, n] = localToEN(x, y, p);
      return enToLngLat(e, n, state.anchor);
    }),
  }));
  mapView.setModel(rects);
  if (live) return;
  excludeCache.clear();
  mapView.isExcluded = isExcluded;
  viewer.setPlacement(p);
  if (state.results.size) {
    // tulokset ovat sijoituskohtaisia
    state.results.clear();
    viewer.clearHeatmaps();
    state.model.spaces.forEach(updateBadge);
  }
  updatePlaceUI();
  syncSun(); // aurinko lasketaan aina mallin todelliselle sijainnille
  mapView.refreshShadows();
  clearTimeout(surroundTimer);
  surroundTimer = setTimeout(loadSurroundings, reloadSurroundings ? 0 : 500);
}

function featureKey(f) {
  const g = f.geometry;
  const c = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
  return `${c.length}|${c[0][0].toFixed(7)}|${c[0][1].toFixed(7)}`;
}

const manualExclude = new Map(); // käyttäjän valinta: avain → true (piilota) / false (näytä)

function buildingKey(f) {
  return f.properties?.osm || featureKey(f);
}

function isExcluded(f) {
  const key = buildingKey(f);
  if (manualExclude.has(key)) return manualExclude.get(key);
  if (!$('replace').checked || !state.model) return false;
  if (excludeCache.has(key)) return excludeCache.get(key);
  const [poly] = featuresToLocal([f], state.anchor);
  let ex = false;
  if (poly) {
    const fp = state.model.footprint;
    const [ce, cn] = localToEN(fp.centroid[0], fp.centroid[1]);
    const r = Math.hypot(fp.nx, fp.ny) * fp.cellSize;
    const bx = (poly.bbox[0] + poly.bbox[2]) / 2, by = (poly.bbox[1] + poly.bbox[3]) / 2;
    if (Math.hypot(bx - ce, by - cn) < r + 50 || (poly.bbox[0] < ce && ce < poly.bbox[2] && poly.bbox[1] < cn && cn < poly.bbox[3]))
      ex =
        coveredFraction(fp, state.placement.pivot, state.placement, poly) > 0.3 ||
        modelInsideFraction(fp, state.placement.pivot, state.placement, poly) > 0.15;
  }
  excludeCache.set(key, ex);
  return ex;
}

function ensureOsmBuildings() {
  const [lng, lat] = modelCenterLngLat();
  const radius = Math.max(250, Number($('env-radius').value) || 300);
  return mapView.loadOsmBuildings({ lat, lng }, radius);
}

async function loadSurroundings() {
  if (!state.model) return;
  await mapView.whenIdle();
  await ensureOsmBuildings();
  const radius = Number($('env-radius').value) || 300;
  const fp = state.model.footprint;
  const [ce, cn] = localToEN(fp.centroid[0], fp.centroid[1]);
  const polys = featuresToLocal(mapView.getBuildings(), state.anchor)
    .filter((p) => Math.hypot((p.bbox[0] + p.bbox[2]) / 2 - ce, (p.bbox[1] + p.bbox[3]) / 2 - cn) < radius)
    .filter((p) => !isExcluded(p.feature))
    .map((p) => ({ rings: p.rings, height: p.feature.properties.height, estimated: !!p.feature.properties.estimated }));
  viewer.setSurroundings(polys);
  mapView.setExcluded(mapView.getBuildings().filter(isExcluded));
  const est = polys.filter((p) => p.estimated).length;
  $('viewer-label').textContent =
    `IFC-malli + ${polys.length} ympäröivää rakennusta` + (est ? ` (${est}:n korkeus arvioitu)` : '');
}

function updatePlaceUI() {
  const p = state.placement;
  $('rot').value = p.rotation.toFixed(1);
  $('rot-range').value = p.rotation;
  $('off-e').value = p.offsetE.toFixed(2);
  $('off-n').value = p.offsetN.toFixed(2);
  $('elev').value = (state.elev || 0).toFixed(2);
  const [lng, lat] = modelCenterLngLat();
  const warn = $('place-info').dataset.warn;
  $('place-info').innerHTML =
    `Sijoitustapa: <b>${state.placementSource}</b><br>` +
    (state.fitIoU != null ? `Muotojen vastaavuus (IoU): <b>${pct(state.fitIoU)}</b> – sininen katkoviiva = verratut kartan rakennukset<br>` : '') +
    `Mallin keskipiste: <b>${lat.toFixed(6)}, ${lng.toFixed(6)}</b><br>` +
    `Korkeus maanpinnasta: <b>${state.model.footprint.maxHeight.toFixed(1)} m</b>` +
    (warn ? `<br><span style="color:#c92a2a">${warn}</span>` : '');
}

const onPlaceInput = () => {
  const p = state.placement;
  if (!p) return;
  delete $('place-info').dataset.warn;
  p.rotation = norm360(Number($('rot').value) || 0);
  p.offsetE = Number($('off-e').value) || 0;
  p.offsetN = Number($('off-n').value) || 0;
  applyPlacement();
};
['rot', 'off-e', 'off-n'].forEach((id) => $(id).addEventListener('change', onPlaceInput));
$('rot-range').addEventListener('input', () => {
  $('rot').value = $('rot-range').value;
  state.placement.rotation = Number($('rot-range').value);
  applyPlacement({ live: true });
});
$('rot-range').addEventListener('change', onPlaceInput);
// --- korkeusasema --------------------------------------------------------
function buildGroundSelect(model) {
  const sel = $('ground-storey');
  const opts = model.storeys
    .filter((s) => s.floorY != null)
    .map((s) => ({ v: s.floorY, label: `${s.name} – lattia (${s.floorY.toFixed(2)})`, id: s.id }));
  if (model.siteGroundY != null)
    opts.push({ v: model.siteGroundY, label: `IFC:n maastopinta rakennuksen ympärillä (${model.siteGroundY.toFixed(2)})`, id: 'site' });
  opts.push({ v: 0, label: 'Mallin ±0,000-taso', id: 'zero' });
  opts.push({ v: model.bbox.min.y, label: `Mallin alin kohta (${model.bbox.min.y.toFixed(2)})`, id: 'min' });
  sel.innerHTML = opts.map((o, i) => `<option value="${i}">${o.label}</option>`).join('');
  sel._opts = opts;
  const i = opts.findIndex((o) => o.id === model.groundStoreyId);
  sel.value = String(i >= 0 ? i : Math.max(0, opts.findIndex((o) => Math.abs(o.v - model.groundY) < 1e-6)));
}
function setGround() {
  const p = state.placement;
  if (!p) return;
  p.groundY = state.groundBase - (state.elev || 0);
  state.model.footprint = computeFootprint(state.model, p.groundY);
  applyPlacement();
}
$('ground-storey').addEventListener('change', (e) => {
  const o = e.target._opts?.[Number(e.target.value)];
  if (!o) return;
  state.groundBase = o.v;
  state.elev = 0;
  setGround();
});
$('elev').addEventListener('change', () => {
  state.elev = Number($('elev').value) || 0;
  setGround();
});
$('btn-raise').addEventListener('click', () => {
  state.elev = Math.round(((state.elev || 0) + 0.5) * 100) / 100;
  setGround();
});
$('btn-lower').addEventListener('click', () => {
  state.elev = Math.round(((state.elev || 0) - 0.5) * 100) / 100;
  setGround();
});

// --- kartan rakennuksen piilotus/palautus klikkaamalla ---------------------
mapView.on('buildingclick', (f) => {
  if (!state.model) return;
  const key = buildingKey(f);
  manualExclude.set(key, !isExcluded(f));
  applyPlacement({ reloadSurroundings: true });
});
$('replace').addEventListener('change', () => applyPlacement());
$('drag-mode').addEventListener('change', (e) => (mapView.dragEnabled = e.target.checked));
$('btn-fit').addEventListener('click', async () => {
  busy('Sovitetaan mallia kartan rakennuksiin…');
  await tick();
  const ok = await runAutoFit();
  if (ok) applyPlacement();
  busy(null);
});
$('btn-reset').addEventListener('click', async () => {
  if (!state.addressPoint) return status('Osoitetta ei ole annettu.', true);
  const p = state.placement;
  state.anchor = { lat: state.addressPoint.lat, lng: state.addressPoint.lng };
  Object.assign(p, { pivot: state.model.footprint.centroid.slice(), offsetE: 0, offsetN: 0 });
  state.placementSource = 'Osoitepiste';
  state.fitIoU = null;
  mapView.setMatched([]);
  busy('Siirretään malli osoitteeseen ja sovitetaan kartan rakennuksiin…');
  try {
    await flyToModel();
    await runAutoFit({ quiet: true });
    applyPlacement({ reloadSurroundings: true });
    viewer.viewAll();
  } finally {
    busy(null);
  }
});

// vetäminen kartalla
let dragStart = null;
mapView.on('dragstart', (d) => {
  const p = state.placement;
  dragStart = { ...p, en: lngLatToEN(d.start.lng, d.start.lat, state.anchor), center: localToEN(...state.model.footprint.centroid) };
});
mapView.on('drag', (d, lngLat) => {
  if (!dragStart) return;
  const p = state.placement;
  const cur = lngLatToEN(lngLat.lng, lngLat.lat, state.anchor);
  if (d.rotate) {
    const c = dragStart.center;
    const a0 = Math.atan2(dragStart.en[1] - c[1], dragStart.en[0] - c[0]);
    const a1 = Math.atan2(cur[1] - c[1], cur[0] - c[0]);
    const da = ((a1 - a0) * 180) / Math.PI;
    // kierto mallin keskipisteen ympäri
    p.rotation = norm360(dragStart.rotation + da);
    const fp = state.model.footprint;
    const [x, y] = rotate2(fp.centroid[0] - p.pivot[0], fp.centroid[1] - p.pivot[1], p.rotation);
    p.offsetE = c[0] - x;
    p.offsetN = c[1] - y;
  } else {
    p.offsetE = dragStart.offsetE + cur[0] - dragStart.en[0];
    p.offsetN = dragStart.offsetN + cur[1] - dragStart.en[1];
  }
  applyPlacement({ live: true });
});
mapView.on('dragend', () => {
  dragStart = null;
  delete $('place-info').dataset.warn;
  state.placementSource = 'Käsin sijoitettu';
  state.fitIoU = null;
  applyPlacement();
});

// -------------------------------------------------------------- aika ------
function initTime() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5);
  setDate(d);
}
function setDate(d) {
  state.date = d;
  $('date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const mins = d.getHours() * 60 + d.getMinutes();
  $('time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('time-range').value = mins;
  syncSun();
}
function readDate() {
  const [y, m, dd] = $('date').value.split('-').map(Number);
  const mins = Number($('time-range').value);
  return new Date(y, m - 1, dd, Math.floor(mins / 60), mins % 60);
}
$('date').addEventListener('change', () => setDate(readDate()));
$('time').addEventListener('change', () => {
  const [h, m] = $('time').value.split(':').map(Number);
  $('time-range').value = h * 60 + m;
  setDate(readDate());
});
$('time-range').addEventListener('input', () => setDate(readDate()));
$('btn-now').addEventListener('click', initTime);
document.querySelectorAll('[data-day]').forEach((b) =>
  b.addEventListener('click', () => {
    const [m, d] = b.dataset.day.split('-').map(Number);
    const cur = readDate();
    setDate(new Date(cur.getFullYear(), m - 1, d, cur.getHours(), cur.getMinutes()));
  })
);
let playTimer = null;
$('btn-play').addEventListener('click', () => {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
    $('btn-play').textContent = '▶';
    return;
  }
  $('btn-play').textContent = '❚❚';
  playTimer = setInterval(() => {
    let v = Number($('time-range').value) + 5;
    if (v > 1435) v = 0;
    $('time-range').value = v;
    setDate(readDate());
  }, 120);
});

function siteLocation() {
  if (state.anchor && state.model) {
    const [lng, lat] = modelCenterLngLat();
    return { lat, lng };
  }
  const c = mapView.map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

function syncSun() {
  const { lat, lng } = siteLocation();
  const sun = viewer.setSun(state.date, lat, lng);
  mapView.setDate(state.date);
  const t = SunCalc.getTimes(state.date, lat, lng);
  const hm = (d) => (d instanceof Date && !isNaN(d) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '–');
  const txt =
    `Aurinko: korkeus <b>${sun.altitude.toFixed(1)}°</b>, atsimuutti <b>${sun.azimuth.toFixed(0)}°</b><br>` +
    `Nousu ${hm(t.sunrise)} · lasku ${hm(t.sunset)} <small>(selaimen aikavyöhyke)</small>`;
  $('sun-info').innerHTML = txt;
  $('sun-badge').innerHTML =
    `${state.date.toLocaleDateString('fi-FI')} klo ${pad(state.date.getHours())}:${pad(state.date.getMinutes())}<br>` +
    (sun.altitude > 0 ? `☀ ${sun.altitude.toFixed(1)}° / ${sun.azimuth.toFixed(0)}°` : '☾ Aurinko laskenut');
  if ($('exposure').checked) updateExposure();
}

async function updateExposure() {
  const on = $('exposure').checked;
  const { lat, lng } = siteLocation();
  const t = SunCalc.getTimes(state.date, lat, lng);
  let start = t.sunrise, end = t.sunset;
  if (isNaN(start) || isNaN(end)) {
    start = new Date(state.date);
    start.setHours(0, 0, 0, 0);
    end = new Date(start.getTime() + 24 * 3600e3);
  }
  await mapView.setSunExposure(on, { startDate: start, endDate: end, iterations: 48 });
  const hours = (end - start) / 3600e3;
  $('map-legend').hidden = !on;
  $('map-legend').innerHTML = `<div class="grad"></div><div class="ticks"><span>0 h</span><span>${(hours / 2).toFixed(0)} h</span><span>${hours.toFixed(1)} h</span></div><small>Aurinkotunnit kartalla (ShadeMap)</small>`;
}
let exposureDebounce;
$('exposure').addEventListener('change', () => {
  clearTimeout(exposureDebounce);
  exposureDebounce = setTimeout(updateExposure, 50);
});

// ---------------------------------------------------------------- tilat ---
function spaceLabel(s) {
  return `${s.name || '–'}${s.longName ? ` <small>${s.longName}</small>` : ''}`;
}

function buildSpaceList() {
  const list = $('space-list');
  const model = state.model;
  const filter = $('space-filter').value.trim().toLowerCase();
  list.innerHTML = '';
  const groups = model.storeys.map((st) => ({ storey: st, spaces: st.spaces }));
  const orphans = model.spaces.filter((s) => !model.storeys.some((st) => st.spaces.includes(s)));
  if (orphans.length) groups.push({ storey: null, spaces: orphans });
  let shown = 0;
  for (const g of groups) {
    const spaces = g.spaces.filter((s) => !filter || `${s.name} ${s.longName}`.toLowerCase().includes(filter));
    if (filter && !spaces.length) continue;
    const head = document.createElement('div');
    head.className = 'storey';
    head.innerHTML = `<span>${g.storey ? g.storey.name : 'Muut tilat'}</span><small>${g.storey ? 'kerrosleikkaus ›' : ''}</small>`;
    if (g.storey) head.addEventListener('click', () => viewer.viewStorey(g.storey));
    list.appendChild(head);
    for (const s of spaces) {
      const el = document.createElement('div');
      el.className = 'space';
      el.dataset.id = s.id;
      el.innerHTML = `<span class="nm">${spaceLabel(s)}</span><span class="badge-slot"></span>`;
      el.addEventListener('click', () => selectSpace(s, { go: true }));
      list.appendChild(el);
      updateBadge(s);
      shown++;
    }
  }
  if (!model.spaces.length)
    list.innerHTML =
      '<div class="empty">Mallissa ei ole tiloja (IfcSpace). Kerroksia voi silti tarkastella leikkauksina, ja sisälle pääsee tuplaklikkaamalla lattiaa 3D-näkymässä.</div>' +
      list.innerHTML;
  else if (!shown) list.innerHTML = '<div class="empty">Ei hakua vastaavia tiloja.</div>';
}
$('space-filter').addEventListener('input', buildSpaceList);

function updateBadge(space) {
  const el = document.querySelector(`.space[data-id="${space.id}"] .badge-slot`);
  if (!el) return;
  const r = state.results.get(space.id);
  el.innerHTML = r
    ? `<span class="badge" style="background:#${heatColor(r.avg / 8).getHexString()}">${fmtH(r.avg)}</span>`
    : '';
}

function selectSpace(space, { go = false } = {}) {
  state.selectedSpace = space;
  document.querySelectorAll('.space').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === space.id));
  document.querySelector(`.space[data-id="${space.id}"]`)?.scrollIntoView({ block: 'nearest' });
  if (go) viewer.goToSpace(space);
  else viewer.highlightSpace(space);
  showResult(space);
}
viewer.on('space', (s) => selectSpace(s));
viewer.on('mode', (m) => ($('btn-mode').textContent = m === 'walk' ? 'Kiertotila' : 'Kävelytila'));

function showResult(space) {
  const r = state.results.get(space?.id);
  const title = `<b>${space.name || ''} ${space.longName || ''}</b>`;
  if (!r) {
    $('result').innerHTML = `${title}<br><span class="info">Ei analyysiä vielä – paina "Analysoi valittu tila".</span>`;
    return;
  }
  $('result').innerHTML = `${title}
    <table>
      <tr><td>Keskimäärin suoraa aurinkoa</td><td>${fmtH(r.avg)}</td></tr>
      <tr><td>Aurinkoisin kohta</td><td>${fmtH(r.max)}</td></tr>
      <tr><td>Varjoisin kohta</td><td>${fmtH(r.min)}</td></tr>
      <tr><td>Osuus, johon aurinko osuu päivän aikana</td><td>${pct(r.anyShare)}</td></tr>
      <tr><td>Auringossa nyt (${pad(state.date.getHours())}:${pad(state.date.getMinutes())})</td><td>${pct(r.nowShare)}</td></tr>
      <tr><td>Päivän pituus</td><td>${fmtH(r.dayLength)}</td></tr>
      <tr><td>Näytepisteitä</td><td>${r.points.length} (${r.step.toFixed(2).replace('.', ',')} m)</td></tr>
    </table>`;
}

function analysisOpts() {
  return { date: state.date, height: Number($('an-height').value), stepMinutes: Number($('an-step').value) };
}

$('btn-an-one').addEventListener('click', async () => {
  const s = state.selectedSpace;
  if (!s) return status('Valitse ensin tila listasta tai tuplaklikkaamalla 3D-näkymässä.', true);
  busy(`Lasketaan auringonpaistetta: ${s.name}…`);
  await tick();
  try {
    const r = viewer.analyzeSpace(s, analysisOpts());
    if (r) {
      state.results.set(s.id, r);
      updateBadge(s);
    }
    showResult(s);
  } finally {
    busy(null);
  }
});

$('btn-an-all').addEventListener('click', async () => {
  const spaces = state.model?.spaces || [];
  const opts = analysisOpts();
  for (let i = 0; i < spaces.length; i++) {
    busy(`Analysoidaan tiloja ${i + 1}/${spaces.length}…`);
    await tick();
    const r = viewer.analyzeSpace(spaces[i], opts);
    if (r) {
      state.results.set(spaces[i].id, r);
      updateBadge(spaces[i]);
    }
  }
  busy(null);
  if (state.selectedSpace) showResult(state.selectedSpace);
  status(`Analysoitu ${spaces.length} tilaa (${$('date').value}). Kerrosleikkaus näyttää tulokset pohjakuvana.`);
});

$('btn-an-clear').addEventListener('click', () => {
  state.results.clear();
  viewer.clearHeatmaps();
  state.model?.spaces.forEach(updateBadge);
  if (state.selectedSpace) showResult(state.selectedSpace);
});

// ------------------------------------------------------------------ 3D ----
$('btn-viewall').addEventListener('click', () => viewer.viewAll());
$('btn-mode').addEventListener('click', () => viewer.setMode(viewer.mode === 'walk' ? 'orbit' : 'walk'));
$('btn-section-off').addEventListener('click', () => viewer.setSectionHeight(null));
$('show-spaces').addEventListener('change', (e) => viewer.showSpaces(e.target.checked));
$('show-site').addEventListener('change', (e) => viewer.setSiteVisible(e.target.checked));
$('default-height').addEventListener('change', (e) => {
  const h = Math.max(2, Number(e.target.value) || 12);
  mapView.setDefaultHeight(h);
  loadSurroundings();
});
$('shadow-q').addEventListener('change', (e) => viewer.setShadowQuality(Number(e.target.value)));
$('env-radius').addEventListener('change', () => loadSurroundings());

initTime();
