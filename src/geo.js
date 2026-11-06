// Geo-apufunktiot: paikallinen ENU-taso (itä, pohjoinen metreinä), geokoodaus,
// suomalaiset tasokoordinaatistot (ETRS-TM35FIN, ETRS-GK19…31) IFC-georeferointia varten.
import proj4 from 'proj4';

const R_LAT = 110574.0; // m / leveysaste (riittää ~km-mittakaavaan)
const R_LON = 111320.0; // m / pituusaste päiväntasaajalla

export function lngLatToEN(lng, lat, origin) {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return [(lng - origin.lng) * R_LON * k, (lat - origin.lat) * R_LAT];
}

export function enToLngLat(e, n, origin) {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return [origin.lng + e / (R_LON * k), origin.lat + n / R_LAT];
}

export function rotate2(x, y, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** Osoitehaku OpenStreetMapin Nominatim-palvelusta. */
export async function geocode(address) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&accept-language=fi&q=' +
    encodeURIComponent(address);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Osoitehaku epäonnistui (${res.status})`);
  const list = await res.json();
  return list.map((r) => ({ lat: +r.lat, lng: +r.lon, label: r.display_name }));
}

// --- Suomalaiset projektiot ----------------------------------------------
proj4.defs('EPSG:3067', '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
for (let code = 3873; code <= 3885; code++) {
  const lon0 = 19 + (code - 3873);
  proj4.defs(
    `EPSG:${code}`,
    `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${lon0 * 1e6 + 500000} +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`
  );
}
// ETRS-GKn ilman kaistanumeroa itäkoordinaatissa (EPSG:3126–3138)
for (let code = 3126; code <= 3138; code++) {
  const lon0 = 19 + (code - 3126);
  proj4.defs(
    `EPSG:${code}`,
    `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`
  );
}

/** Tunnistaa EPSG-koodin IfcProjectedCRS:n nimestä/kuvauksesta. */
export function parseEpsg(text) {
  if (!text) return null;
  const m = String(text).match(/(?:EPSG[:\s]*)?(\d{4,5})/i);
  if (m && proj4.defs(`EPSG:${m[1]}`)) return `EPSG:${m[1]}`;
  const t = String(text).toUpperCase();
  if (t.includes('TM35')) return 'EPSG:3067';
  const gk = t.match(/GK\s*(\d{2})/);
  if (gk) {
    const z = +gk[1];
    if (z >= 19 && z <= 31) return `EPSG:${3873 + z - 19}`;
  }
  return null;
}

/** Tasokoordinaatit (E, N) → WGS84 [lng, lat]. Hoitaa myös akselien vaihdon (N, E). */
export function projectedToLngLat(epsg, e, n) {
  let [lng, lat] = proj4(epsg, 'WGS84', [e, n]);
  if (!(lat > 50 && lat < 75)) {
    const alt = proj4(epsg, 'WGS84', [n, e]);
    if (alt[1] > 50 && alt[1] < 75) [lng, lat] = alt;
  }
  return [lng, lat];
}

/** Karttaprojektion meridiaanikonvergenssi (kartan pohjoinen vs. todellinen pohjoinen), asteina. */
export function gridConvergence(epsg, lng, lat) {
  const [e, n] = proj4('WGS84', epsg, [lng, lat]);
  const [e2, n2] = proj4('WGS84', epsg, [lng, lat + 0.001]);
  return (Math.atan2(e2 - e, n2 - n) * 180) / Math.PI; // >0: todellinen pohjoinen kääntyy itään
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i])) return false;
  return true;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}
