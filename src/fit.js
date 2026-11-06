// Mallin jalanjäljen automaattinen sovitus kartan rakennusmuotoihin.
// Vertaillaan mallin korkeusrasterin peittoaluetta (solut) kartan rakennuspolygoneihin
// (ShadeMapin rakennusaineisto) ja haetaan kierto + siirto, joka maksimoi IoU:n.
import { lngLatToEN, pointInPolygon, rotate2, ringArea } from './geo.js';
import { peakAngle } from './ifc.js';

/** Muuntaa kartan rakennusfeaturet paikallisiksi ENU-polygoneiksi (anchor = origo). */
export function featuresToLocal(features, anchor) {
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      const local = rings.map((r) => r.map(([lng, lat]) => lngLatToEN(lng, lat, anchor)));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of local[0]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      out.push({ feature: f, rings: local, bbox: [x0, y0, x1, y1], area: Math.abs(ringArea(local[0])) });
    }
  }
  return out;
}

function polyCentroid(p) {
  let cx = 0, cy = 0;
  const r = p.rings[0];
  for (const [x, y] of r) (cx += x), (cy += y);
  return [cx / r.length, cy / r.length];
}

function polyDominantAngle(polys) {
  const bins = new Float64Array(90);
  for (const p of polys)
    for (const ring of p.rings)
      for (let i = 1; i < ring.length; i++) {
        const dx = ring[i][0] - ring[i - 1][0], dy = ring[i][1] - ring[i - 1][1];
        const len = Math.hypot(dx, dy);
        if (len < 0.5) continue;
        // seinän normaalin suunta = reunan suunta + 90°; mod 90 sama
        let a = (Math.atan2(dy, dx) * 180) / Math.PI;
        a = ((a % 90) + 90) % 90;
        bins[Math.floor(a) % 90] += len;
      }
  return peakAngle(bins);
}

/** Rasteroi polygonit ENU-ruudukkoon (Set-tyyppinen hakutaulu). */
export function rasterize(polys, res) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) {
    x0 = Math.min(x0, p.bbox[0]); y0 = Math.min(y0, p.bbox[1]);
    x1 = Math.max(x1, p.bbox[2]); y1 = Math.max(y1, p.bbox[3]);
  }
  const nx = Math.ceil((x1 - x0) / res) + 1, ny = Math.ceil((y1 - y0) / res) + 1;
  const grid = new Uint8Array(nx * ny);
  let count = 0;
  for (const p of polys) {
    const i0 = Math.floor((p.bbox[0] - x0) / res), i1 = Math.ceil((p.bbox[2] - x0) / res);
    const j0 = Math.floor((p.bbox[1] - y0) / res), j1 = Math.ceil((p.bbox[3] - y0) / res);
    for (let j = j0; j <= j1 && j < ny; j++)
      for (let i = i0; i <= i1 && i < nx; i++) {
        const k = j * nx + i;
        if (grid[k]) continue;
        if (pointInPolygon(x0 + (i + 0.5) * res, y0 + (j + 0.5) * res, p.rings)) (grid[k] = 1), count++;
      }
  }
  return {
    count,
    has(x, y) {
      const i = Math.floor((x - x0) / res), j = Math.floor((y - y0) / res);
      return i >= 0 && j >= 0 && i < nx && j < ny && grid[j * nx + i] === 1;
    },
  };
}

/** Mallin solut harvennettuna sovitusta varten (≈1 m). */
export function sampleCells(footprint, pivot, step = 1) {
  const seen = new Set();
  const pts = [];
  for (const [x, y] of footprint.cells) {
    const k = `${Math.round(x / step)}|${Math.round(y / step)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pts.push([x - pivot[0], y - pivot[1]]);
  }
  return pts;
}

function score(pts, target, theta, tx, ty, cellArea) {
  const a = (theta * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  let inter = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0], y = pts[i][1];
    if (target.has(x * c - y * s + tx, x * s + y * c + ty)) inter++;
  }
  // näytteistys on likimääräinen (kierretty hila vs. akselien suuntainen rasteri) → rajataan ≤ 1
  const union = Math.max(pts.length, target.count * cellArea, pts.length + target.count * cellArea - inter);
  return Math.min(1, inter / union);
}

/**
 * @param model ladattu IFC-malli (footprint, dominantAngle)
 * @param buildings kartan rakennukset paikallisina polygoneina (featuresToLocal)
 * @param initial {rotation, offsetE, offsetN} lähtöarvaus
 * @returns {rotation, offsetE, offsetN, iou, matched[]} tai null
 */
export function autoFit(model, buildings, pivot, initial) {
  const fp = model.footprint;
  if (!fp || !fp.cells.length || !buildings.length) return null;
  const step = Math.max(1, fp.cellSize);
  const pts = sampleCells(fp, pivot, step);
  const modelArea = pts.length * step * step;
  const modelRadius = Math.sqrt(modelArea / Math.PI);

  // 1) siemenrakennus: osoitepisteen (= initial-siirto) sisältävä tai lähin
  const p0 = [initial.offsetE, initial.offsetN];
  let seed = buildings.find((b) => pointInPolygon(p0[0], p0[1], b.rings));
  if (!seed) {
    let best = Infinity;
    for (const b of buildings) {
      const c = polyCentroid(b);
      const d = Math.hypot(c[0] - p0[0], c[1] - p0[1]);
      if (d < best) (best = d), (seed = b);
    }
    if (best > modelRadius + 40) seed = null;
  }
  if (!seed) return null;

  const run = (targetPolys, startRot, startT, coarse) => {
    const res = coarse ? step : step / 2;
    const target = rasterize(targetPolys, res);
    const cellArea = (res * res) / (step * step);
    let best = { iou: -1 };
    const dm = polyDominantAngle(targetPolys);
    const base = dm - model.dominantAngle;
    const rotCandidates = coarse
      ? [0, 1, 2, 3].flatMap((k) => [-3, -2, -1, 0, 1, 2, 3].map((d) => base + k * 90 + d))
      : [-1, -0.5, -0.25, 0, 0.25, 0.5, 1].map((d) => startRot + d);
    if (coarse && startRot != null) rotCandidates.push(startRot);
    for (const rot of rotCandidates) {
      // keskitä painopisteet tällä kierrolla
      let tx0 = startT[0], ty0 = startT[1];
      if (coarse) {
        const tc = targetCentroid(targetPolys);
        const [mx, my] = meanRot(pts, rot);
        tx0 = tc[0] - mx;
        ty0 = tc[1] - my;
      }
      const range = coarse ? 4 : 0.75, dstep = coarse ? 1 : 0.25;
      for (let dx = -range; dx <= range + 1e-9; dx += dstep)
        for (let dy = -range; dy <= range + 1e-9; dy += dstep) {
          const iou = score(pts, target, rot, tx0 + dx, ty0 + dy, cellArea);
          if (iou > best.iou) best = { iou, rotation: rot, offsetE: tx0 + dx, offsetN: ty0 + dy };
        }
    }
    return best;
  };

  // 2) kohdejoukko: siemen + rakennukset, joiden keskipiste osuu mallin alueelle
  let targets = [seed];
  let result = run(targets, initial.rotation, [initial.offsetE, initial.offsetN], true);
  for (let iter = 0; iter < 2; iter++) {
    const inside = buildings.filter((b) => {
      if (b === seed) return true;
      const c = polyCentroid(b);
      return coversLocal(fp, pivot, result, c[0], c[1]);
    });
    if (inside.length === targets.length) break;
    targets = inside;
    const r2 = run(targets, result.rotation, [result.offsetE, result.offsetN], true);
    if (r2.iou >= result.iou * 0.98) result = r2;
  }
  const fine = run(targets, result.rotation, [result.offsetE, result.offsetN], false);
  if (fine.iou >= result.iou) result = fine;
  result.rotation = ((result.rotation % 360) + 360) % 360;
  result.matched = targets.map((t) => t.feature);
  return result;
}

function targetCentroid(polys) {
  let ax = 0, ay = 0, aw = 0;
  for (const p of polys) {
    const c = polyCentroid(p);
    ax += c[0] * p.area; ay += c[1] * p.area; aw += p.area;
  }
  return aw ? [ax / aw, ay / aw] : [0, 0];
}

function meanRot(pts, rot) {
  let x = 0, y = 0;
  for (const p of pts) {
    const r = rotate2(p[0], p[1], rot);
    x += r[0]; y += r[1];
  }
  return [x / pts.length, y / pts.length];
}

/** Onko paikallinen ENU-piste (e, n) mallin jalanjäljen sisällä annetulla sijoituksella? */
export function coversLocal(fp, pivot, placement, e, n) {
  const [x, y] = rotate2(e - placement.offsetE, n - placement.offsetN, -placement.rotation);
  return fp.occupied(x + pivot[0], y + pivot[1]);
}

/** Kuinka suuri osa polygonista jää mallin alle (näytteistys ~1 m välein). */
export function coveredFraction(fp, pivot, placement, poly) {
  const [x0, y0, x1, y1] = poly.bbox;
  const st = Math.max(0.75, Math.sqrt(((x1 - x0) * (y1 - y0)) / 400));
  let n = 0, inside = 0;
  for (let y = y0 + st / 2; y < y1; y += st)
    for (let x = x0 + st / 2; x < x1; x += st) {
      if (!pointInPolygon(x, y, poly.rings)) continue;
      n++;
      if (coversLocal(fp, pivot, placement, x, y)) inside++;
    }
  return n ? inside / n : 0;
}
