// IFC-tiedoston luku web-ifc:llä → three.js-geometria, tilat, kerrokset, georeferointi
// sekä rakennuksen "jalanjälki" (korkeusrasteri) ShadeMapia ja sovitusta varten.
//
// Koordinaatit: web-ifc palauttaa Y-ylös -koordinaatit: IFC (x, y, z) → three (x, z, -y).
// Mallin tasokoordinaatit 2D:ssä: mx = x, my = -z  (my = projektin "pohjoinen").
import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import { parseEpsg, projectedToLngLat, gridConvergence } from './geo.js';

let api = null;
async function getApi() {
  if (api) return api;
  api = new WebIFC.IfcAPI();
  await api.Init((path) => (path.endsWith('.wasm') ? wasmUrl : path), true);
  return api;
}

const val = (v) => {
  if (v && typeof v === 'object') {
    if ('value' in v) return v.value;
    if ('_representationValue' in v) return v._representationValue;
  }
  return v;
};
const str = (v) => {
  const s = val(v);
  return s == null ? '' : String(s);
};

function compoundAngle(arr) {
  arr = val(arr);
  if (!arr) return null;
  const a = (Array.isArray(arr) ? arr : [arr]).map((x) => Number(val(x)) || 0);
  if (!a.length) return null;
  const sign = a.some((x) => x < 0) ? -1 : 1;
  const [d = 0, m = 0, s = 0, us = 0] = a.map(Math.abs);
  return sign * (d + m / 60 + s / 3600 + us / 3600e6);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @returns {Promise<IfcModel>}
 */
export async function loadIfc(buffer, onProgress = () => {}) {
  const ifc = await getApi();
  onProgress('Avataan IFC-tiedostoa…');
  await tick();
  const modelID = ifc.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 16 });

  // --- Tyypit ja tilat --------------------------------------------------
  const spaceIds = new Set(Array.from(ifc.GetLineIDsWithType(modelID, WebIFC.IFCSPACE, true)));
  const siteIds = new Set(Array.from(ifc.GetLineIDsWithType(modelID, WebIFC.IFCSITE, true)));
  const typeCache = new Map();
  const typeOf = (id) => {
    if (!typeCache.has(id)) typeCache.set(id, ifc.GetLineType(modelID, id));
    return typeCache.get(id);
  };
  // ympäristöobjektit (puut, autot, kalusteet): näkyvät ja varjostavat 3D:ssä, mutta eivät kuulu
  // rakennuksen jalanjälkeen (ShadeMap, sovitus)
  const contextTypes = new Set(
    [WebIFC.IFCFURNISHINGELEMENT, WebIFC.IFCFURNITURE, WebIFC.IFCSYSTEMFURNITUREELEMENT, WebIFC.IFCGEOGRAPHICELEMENT, WebIFC.IFCVIRTUALELEMENT, WebIFC.IFCANNOTATION].filter(Boolean)
  );
  const glazingTypes = new Set([WebIFC.IFCWINDOW, WebIFC.IFCPLATE, WebIFC.IFCCURTAINWALL].filter(Boolean));

  // --- Geometrian virtaus -----------------------------------------------
  const buckets = new Map(); // key → {pos:[], nrm:[], idx:[], color, opacity, kind}
  const spaceGeoms = new Map(); // spaceId → {pos, nrm, idx}
  const elemMinY = new Map(); // expressID → min y (kerroskorkeuksia varten)
  const mat = new THREE.Matrix4();
  const nmat = new THREE.Matrix3();
  const v = new THREE.Vector3();
  let count = 0;

  const pushGeom = (target, verts, indices, m) => {
    const base = target.pos.length / 3;
    nmat.getNormalMatrix(m);
    let minY = Infinity;
    for (let i = 0; i < verts.length; i += 6) {
      v.set(verts[i], verts[i + 1], verts[i + 2]).applyMatrix4(m);
      target.pos.push(v.x, v.y, v.z);
      if (v.y < minY) minY = v.y;
      v.set(verts[i + 3], verts[i + 4], verts[i + 5]).applyMatrix3(nmat).normalize();
      target.nrm.push(v.x, v.y, v.z);
    }
    for (let i = 0; i < indices.length; i++) target.idx.push(base + indices[i]);
    return minY;
  };

  onProgress('Luetaan geometriaa…');
  await tick();
  const streamed = new Set();
  const onMesh = (mesh) => {
    const id = mesh.expressID;
    if (streamed.has(id)) return;
    streamed.add(id);
    const isSpace = spaceIds.has(id);
    const isSite = siteIds.has(id);
    const isContext = contextTypes.has(typeOf(id));
    const type = typeOf(id);
    const geoms = mesh.geometries;
    // Ikkuna/lasielementti ilman läpinäkyvää osaa (moni ohjelma vie lasin läpinäkymättömänä):
    // käsitellään koko elementti lasina, jotta aurinko pääsee sisään.
    let forceGlass = false;
    if (!isSpace && glazingTypes.has(type)) {
      forceGlass = true;
      for (let g = 0; g < geoms.size(); g++) if (geoms.get(g).color.w < 0.98) forceGlass = false;
    }
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = ifc.GetGeometry(modelID, pg.geometryExpressID);
      const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const indices = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      mat.fromArray(pg.flatTransformation);
      if (isSpace) {
        if (!spaceGeoms.has(id)) spaceGeoms.set(id, { pos: [], nrm: [], idx: [] });
        pushGeom(spaceGeoms.get(id), verts, indices, mat);
      } else {
        const c = pg.color;
        const opacity = forceGlass ? 0.35 : c.w;
        const transparent = opacity < 0.98;
        const kind = isSite ? 'site' : isContext && !transparent ? 'context' : transparent ? 'glass' : 'opaque';
        const key = `${kind}|${c.x.toFixed(2)}|${c.y.toFixed(2)}|${c.z.toFixed(2)}|${opacity.toFixed(2)}`;
        if (!buckets.has(key))
          buckets.set(key, { pos: [], nrm: [], idx: [], color: [c.x, c.y, c.z], opacity, kind });
        const b = buckets.get(key);
        const minY = pushGeom(b, verts, indices, mat);
        elemMinY.set(id, Math.min(elemMinY.get(id) ?? Infinity, minY));
      }
      geom.delete?.();
    }
    count++;
  };
  ifc.StreamAllMeshes(modelID, onMesh);
  // StreamAllMeshes ohittaa tilat (IfcSpace) → haetaan ne erikseen
  if (spaceIds.size) ifc.StreamAllMeshesWithTypes(modelID, [WebIFC.IFCSPACE], onMesh);
  onProgress(`Geometria luettu (${count} elementtiä). Rakennetaan 3D-mallia…`);
  await tick();

  // --- three.js-objektit --------------------------------------------------
  const group = new THREE.Group();
  group.name = 'ifc-model';
  const toGeometry = (b) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setIndex(b.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };
  const meshes = [];
  for (const b of buckets.values()) {
    if (!b.idx.length) continue;
    const color = new THREE.Color().setRGB(b.color[0], b.color[1], b.color[2], THREE.SRGBColorSpace);
    const material = new THREE.MeshLambertMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: b.kind === 'glass',
      opacity: b.kind === 'glass' ? Math.min(b.opacity, 0.35) : 1,
      depthWrite: b.kind !== 'glass',
    });
    const m = new THREE.Mesh(toGeometry(b), material);
    m.userData.kind = b.kind;
    // Lasi päästää auringon läpi → ei heitä varjoa
    m.castShadow = b.kind !== 'glass';
    m.receiveShadow = b.kind !== 'glass';
    meshes.push(m);
    group.add(m);
  }

  // --- Tilat ----------------------------------------------------------------
  const spaces = [];
  for (const [id, g] of spaceGeoms) {
    const line = ifc.GetLine(modelID, id);
    const geometry = toGeometry(g);
    spaces.push({
      id,
      name: str(line.Name),
      longName: str(line.LongName),
      geometry,
      bbox: geometry.boundingBox.clone(),
      storeyId: null,
    });
  }

  // --- Kerrokset (IfcRelAggregates / IfcRelContainedInSpatialStructure) ----
  const storeyIds = Array.from(ifc.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY, true));
  const storeys = storeyIds.map((id) => {
    const l = ifc.GetLine(modelID, id);
    return { id, name: str(l.Name) || `Kerros ${id}`, elevationRaw: Number(val(l.Elevation)), floorY: null, spaces: [] };
  });
  const storeyById = new Map(storeys.map((s) => [s.id, s]));
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const contained = new Map(storeys.map((s) => [s.id, []]));
  const relAgg = ifc.GetLineIDsWithType(modelID, WebIFC.IFCRELAGGREGATES, true);
  for (let i = 0; i < relAgg.size(); i++) {
    const r = ifc.GetLine(modelID, relAgg.get(i));
    const parent = val(r.RelatingObject);
    if (!storeyById.has(parent)) continue;
    for (const o of r.RelatedObjects || []) {
      const sid = val(o);
      if (spaceById.has(sid)) spaceById.get(sid).storeyId = parent;
    }
  }
  const relCont = ifc.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE, true);
  for (let i = 0; i < relCont.size(); i++) {
    const r = ifc.GetLine(modelID, relCont.get(i));
    const parent = val(r.RelatingStructure);
    if (!contained.has(parent)) continue;
    for (const o of r.RelatedElements || []) {
      const eid = val(o);
      if (elemMinY.has(eid)) contained.get(parent).push(elemMinY.get(eid));
      if (spaceById.has(eid)) spaceById.get(eid).storeyId = parent;
    }
  }
  for (const s of storeys) {
    const ys = contained.get(s.id).sort((a, b) => a - b);
    const spaceYs = spaces.filter((sp) => sp.storeyId === s.id).map((sp) => sp.bbox.min.y).sort((a, b) => a - b);
    if (spaceYs.length) s.floorY = spaceYs[Math.floor(spaceYs.length / 2)];
    else if (ys.length) s.floorY = ys[Math.floor(ys.length * 0.25)];
  }
  storeys.sort((a, b) => (a.floorY ?? a.elevationRaw ?? 0) - (b.floorY ?? b.elevationRaw ?? 0));
  for (const sp of spaces) {
    const st = storeyById.get(sp.storeyId);
    if (st) st.spaces.push(sp);
  }
  for (const st of storeys) st.spaces.sort((a, b) => a.name.localeCompare(b.name, 'fi', { numeric: true }));

  // --- Georeferointi --------------------------------------------------------
  const georef = readGeoref(ifc, modelID);

  // web-ifc siirtää mallin origoon (COORDINATE_TO_ORIGIN); projektin origon paikka three-koordinaateissa:
  const coord = new THREE.Matrix4().fromArray(ifc.GetCoordinationMatrix(modelID));
  const projectOrigin = new THREE.Vector3(0, 0, 0).applyMatrix4(coord);

  const bbox = new THREE.Box3();
  for (const m of meshes) if (m.userData.kind === 'opaque' || m.userData.kind === 'glass') bbox.union(m.geometry.boundingBox);
  if (bbox.isEmpty()) for (const m of meshes) bbox.union(m.geometry.boundingBox);

  const projectName = (() => {
    const ids = ifc.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
    if (!ids.size()) return '';
    const p = ifc.GetLine(modelID, ids.get(0));
    return str(p.LongName) || str(p.Name);
  })();

  ifc.CloseModel(modelID);

  // Maanpinnan oletuskorko: ±0 tai alin kerros, jos se on selvästi yläpuolella
  const groundStorey = storeys.find((s) => s.floorY != null && s.floorY > -1.5);
  let groundY = 0;
  if (bbox.min.y > 0.5) groundY = bbox.min.y;
  else if (groundStorey && Math.abs(groundStorey.floorY) < 1.5) groundY = groundStorey.floorY;

  onProgress('Lasketaan rakennuksen jalanjälkeä…');
  await tick();
  const dominantAngle = computeDominantAngle(meshes);

  return {
    name: projectName,
    group,
    meshes,
    spaces,
    storeys,
    bbox,
    georef,
    projectOrigin,
    groundY,
    dominantAngle,
    footprint: null, // lasketaan computeFootprint()-funktiolla (riippuu maanpinnan korosta)
  };
}

function readGeoref(ifc, modelID) {
  const out = { lat: null, lng: null, rotation: null, source: null, epsg: null };
  // True North: IfcGeometricRepresentationContext.TrueNorth
  try {
    const ctxIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT, false);
    for (let i = 0; i < ctxIds.size(); i++) {
      const ctx = ifc.GetLine(modelID, ctxIds.get(i), true);
      const tn = ctx.TrueNorth;
      if (tn && tn.DirectionRatios) {
        const [x, y] = tn.DirectionRatios.map((d) => Number(val(d)));
        if (isFinite(x) && isFinite(y) && (x || y)) {
          out.trueNorthRotation = 90 - (Math.atan2(y, x) * 180) / Math.PI;
          break;
        }
      }
    }
  } catch (e) {
    console.warn('TrueNorth', e);
  }
  // IfcSite.RefLatitude/RefLongitude
  try {
    const siteIds = ifc.GetLineIDsWithType(modelID, WebIFC.IFCSITE, false);
    if (siteIds.size()) {
      const s = ifc.GetLine(modelID, siteIds.get(0));
      const lat = compoundAngle(s.RefLatitude);
      const lng = compoundAngle(s.RefLongitude);
      if (lat && lng && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
        out.lat = lat;
        out.lng = lng;
        out.rotation = out.trueNorthRotation ?? 0;
        out.source = 'IfcSite (RefLatitude/RefLongitude)';
      }
    }
  } catch (e) {
    console.warn('IfcSite', e);
  }
  // IfcMapConversion (IFC4) – tarkempi, ensisijainen
  try {
    if (WebIFC.IFCMAPCONVERSION) {
      const ids = ifc.GetLineIDsWithType(modelID, WebIFC.IFCMAPCONVERSION, false);
      if (ids.size()) {
        const mc = ifc.GetLine(modelID, ids.get(0), true);
        const crs = mc.TargetCRS || {};
        const epsg = parseEpsg(str(crs.Name)) || parseEpsg(str(crs.Description)) || parseEpsg(str(crs.GeodeticDatum));
        const scale = Number(val(mc.Scale)) || 1;
        const e = Number(val(mc.Eastings)), n = Number(val(mc.Northings));
        if (epsg && isFinite(e) && isFinite(n)) {
          const [lng, lat] = projectedToLngLat(epsg, e, n);
          const ax = Number(val(mc.XAxisAbscissa)), ay = Number(val(mc.XAxisOrdinate));
          const gridRot = isFinite(ax) && isFinite(ay) && (ax || ay) ? (Math.atan2(ay, ax) * 180) / Math.PI : 0;
          out.lat = lat;
          out.lng = lng;
          out.rotation = gridRot + gridConvergence(epsg, lng, lat);
          out.scale = scale;
          out.epsg = epsg;
          out.source = `IfcMapConversion (${epsg})`;
        }
      }
    }
  } catch (e) {
    console.warn('IfcMapConversion', e);
  }
  return out;
}

/** Hallitseva seinäsuunta (0–90°) seinäpintojen normaaleista; käytetään sovituksessa. */
function computeDominantAngle(meshes) {
  const bins = new Float64Array(90);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const m of meshes) {
    if (m.userData.kind !== 'opaque') continue;
    const pos = m.geometry.attributes.position.array;
    const idx = m.geometry.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      a.fromArray(pos, idx[i] * 3);
      b.fromArray(pos, idx[i + 1] * 3);
      c.fromArray(pos, idx[i + 2] * 3);
      n.subVectors(b, a).cross(c.sub(a));
      const area = n.length() / 2;
      if (area < 1e-4) continue;
      n.normalize();
      if (Math.abs(n.y) > 0.3) continue;
      // tasokoordinaatit: mx = x, my = -z
      let ang = (Math.atan2(-n.z, n.x) * 180) / Math.PI;
      ang = ((ang % 90) + 90) % 90;
      bins[Math.floor(ang) % 90] += area;
    }
  }
  return peakAngle(bins);
}

export function peakAngle(bins) {
  // pehmennetty huippu, ympyrämäinen 90° jakso
  let best = 0, bestV = -1;
  for (let i = 0; i < 90; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += bins[(i + k + 90) % 90] * (3 - Math.abs(k));
    if (s > bestV) (bestV = s), (best = i);
  }
  // painotettu keskiarvo huipun ympärillä
  let sw = 0, sa = 0;
  for (let k = -3; k <= 3; k++) {
    const w = bins[(best + k + 90) % 90];
    sw += w;
    sa += w * (best + k + 0.5);
  }
  return sw ? ((sa / sw) % 90 + 90) % 90 : 0;
}

/**
 * Korkeusrasteri ylhäältä katsottuna: jokaiselle solulle korkein kohta maanpinnan yläpuolella.
 * Palauttaa myös suorakaiteiksi yhdistetyt alueet (ShadeMapin rakennuspolygonit).
 */
export function computeFootprint(model, groundY, cellSize = 0.5) {
  const bb = model.bbox;
  const w0 = bb.max.x - bb.min.x, h0 = bb.max.z - bb.min.z;
  const cs = Math.max(cellSize, Math.max(w0, h0) / 800);
  const minX = bb.min.x - cs, maxMy = -bb.min.z + cs; // my = -z
  const nx = Math.ceil((w0 + 2 * cs) / cs) + 1;
  const ny = Math.ceil((h0 + 2 * cs) / cs) + 1;
  const H = new Float32Array(nx * ny).fill(-Infinity);
  const cellOf = (x, my) => {
    const i = Math.floor((x - minX) / cs);
    const j = Math.floor((maxMy - my) / cs);
    return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
  };
  const mark = (x, my, y) => {
    const k = cellOf(x, my);
    if (k >= 0 && y > H[k]) H[k] = y;
  };
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (const m of model.meshes) {
    if (m.userData.kind === 'site' || m.userData.kind === 'context') continue;
    const pos = m.geometry.attributes.position.array;
    const idx = m.geometry.index.array;
    for (let t = 0; t < idx.length; t += 3) {
      A.fromArray(pos, idx[t] * 3);
      B.fromArray(pos, idx[t + 1] * 3);
      C.fromArray(pos, idx[t + 2] * 3);
      const top = Math.max(A.y, B.y, C.y);
      if (top < groundY + 0.3) continue; // maanalaiset osat eivät varjosta
      // reunat (pystypinnat projisoituvat viivoiksi)
      for (const [P, Q] of [[A, B], [B, C], [C, A]]) {
        const len = Math.hypot(Q.x - P.x, Q.z - P.z);
        const steps = Math.max(1, Math.ceil(len / (cs * 0.5)));
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          mark(P.x + (Q.x - P.x) * f, -(P.z + (Q.z - P.z) * f), Math.max(P.y, Q.y));
        }
      }
      // sisäosa: solukeskipisteet kolmion sisällä
      const x0 = Math.min(A.x, B.x, C.x), x1 = Math.max(A.x, B.x, C.x);
      const z0 = Math.min(A.z, B.z, C.z), z1 = Math.max(A.z, B.z, C.z);
      if (x1 - x0 < cs && z1 - z0 < cs) continue;
      const d = (B.z - C.z) * (A.x - C.x) + (C.x - B.x) * (A.z - C.z);
      if (Math.abs(d) < 1e-9) continue;
      const i0 = Math.floor((x0 - minX) / cs), i1 = Math.floor((x1 - minX) / cs);
      const j0 = Math.floor((maxMy + z0 - 0) / cs), j1 = Math.floor((maxMy + z1) / cs);
      // j = floor((maxMy - my)/cs) = floor((maxMy + z)/cs)
      for (let j = Math.max(0, j0); j <= Math.min(ny - 1, j1); j++) {
        const pz = -(maxMy - (j + 0.5) * cs); // z = -my
        for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) {
          const px = minX + (i + 0.5) * cs;
          const l1 = ((B.z - C.z) * (px - C.x) + (C.x - B.x) * (pz - C.z)) / d;
          const l2 = ((C.z - A.z) * (px - C.x) + (A.x - C.x) * (pz - C.z)) / d;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
          const y = l1 * A.y + l2 * B.y + l3 * C.y;
          const k = j * nx + i;
          if (y > H[k]) H[k] = y;
        }
      }
    }
  }
  // Täytä suljetut aukot (sisäpihat jäävät, koska ne ovat yhteydessä reunaan vain jos avoimia)
  // → ei täytetä: atriumit ja sisäpihat ovat varjotarkastelussa oikeasti avoimia.

  // Korkeudet maanpinnan yläpuolella, kvantisoitu 0.5 m
  const Q = new Float32Array(nx * ny);
  const cells = [];
  let maxH = 0;
  for (let k = 0; k < H.length; k++) {
    if (H[k] === -Infinity) continue;
    const h = Math.max(0.5, Math.round((H[k] - groundY) * 2) / 2);
    Q[k] = h;
    if (h > maxH) maxH = h;
    const i = k % nx, j = (k / nx) | 0;
    cells.push([minX + (i + 0.5) * cs, maxMy - (j + 0.5) * cs]);
  }
  // Suorakaiteet: rivikohtaiset jaksot, jotka yhdistetään pystysuunnassa
  const rects = [];
  let open = new Map(); // "i0|i1|h" → rect
  for (let j = 0; j < ny; j++) {
    const runs = [];
    let i = 0;
    while (i < nx) {
      const h = Q[j * nx + i];
      if (!h) { i++; continue; }
      let i2 = i;
      while (i2 + 1 < nx && Q[j * nx + i2 + 1] === h) i2++;
      runs.push([i, i2, h]);
      i = i2 + 1;
    }
    const next = new Map();
    for (const [a, b, h] of runs) {
      const key = `${a}|${b}|${h}`;
      const r = open.get(key);
      if (r) { r.j1 = j; next.set(key, r); open.delete(key); }
      else next.set(key, { i0: a, i1: b, j0: j, j1: j, h });
    }
    for (const r of open.values()) rects.push(r);
    open = next;
  }
  for (const r of open.values()) rects.push(r);
  const rectangles = rects.map((r) => ({
    // tasokoordinaatit (mx, my)
    x0: minX + r.i0 * cs, x1: minX + (r.i1 + 1) * cs,
    y1: maxMy - r.j0 * cs, y0: maxMy - (r.j1 + 1) * cs,
    height: r.h,
  }));
  // yhtenäiset alueet (8-naapurusto); sovitukseen vain merkittävät rakennusmassat
  const comp = new Int32Array(nx * ny).fill(-1);
  const sizes = [];
  const stack = [];
  for (let k0 = 0; k0 < Q.length; k0++) {
    if (!Q[k0] || comp[k0] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    stack.push(k0);
    comp[k0] = id;
    while (stack.length) {
      const k = stack.pop();
      n++;
      const i = k % nx, j = (k / nx) | 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const kk = jj * nx + ii;
          if (Q[kk] && comp[kk] < 0) (comp[kk] = id), stack.push(kk);
        }
    }
    sizes.push(n);
  }
  const minCells = Math.max(30 / (cs * cs), 0.03 * sizes.reduce((a, b) => Math.max(a, b), 0));
  const fitCells = [];
  for (let k = 0; k < Q.length; k++)
    if (Q[k] && sizes[comp[k]] >= minCells) fitCells.push([minX + ((k % nx) + 0.5) * cs, maxMy - (((k / nx) | 0) + 0.5) * cs]);

  let cx = 0, cy = 0;
  for (const [x, y] of cells) (cx += x), (cy += y);
  const centroid = cells.length ? [cx / cells.length, cy / cells.length] : [(bb.min.x + bb.max.x) / 2, -(bb.min.z + bb.max.z) / 2];
  return {
    cellSize: cs, nx, ny, minX, maxMy, heights: Q, cells, fitCells, rectangles, maxHeight: maxH, centroid,
    occupied(mx, my) {
      const k = cellOf(mx, my);
      return k >= 0 && Q[k] > 0;
    },
  };
}
