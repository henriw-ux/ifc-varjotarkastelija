// 3D-näkymä: IFC-malli + ympäröivät rakennukset (ShadeMapin rakennusaineistosta),
// aurinko SunCalcilla samalle hetkelle kuin karttanäkymässä, reaaliaikaiset varjot,
// sisätilakävely ja tilakohtainen auringonpaisteanalyysi (säteenseuranta, three-mesh-bvh).
//
// Maailman koordinaatit: x = itä, y = ylös, z = -pohjoinen (metrejä, origo = sijoituspiste).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import SunCalc from 'suncalc';

const EYE = 1.6;

export function sunDirection(date, lat, lng) {
  const p = SunCalc.getPosition(date, lat, lng);
  // SunCalc: atsimuutti etelästä länteen
  const e = -Math.sin(p.azimuth) * Math.cos(p.altitude);
  const n = -Math.cos(p.azimuth) * Math.cos(p.altitude);
  const u = Math.sin(p.altitude);
  return {
    vec: new THREE.Vector3(e, u, -n).normalize(),
    altitude: (p.altitude * 180) / Math.PI,
    azimuth: (((p.azimuth * 180) / Math.PI + 180) % 360 + 360) % 360, // pohjoisesta myötäpäivään
  };
}

export function heatColor(t) {
  // 0 → sininen, 0.25 → syaani, 0.5 → vihreä, 0.75 → keltainen, 1 → punainen
  const stops = [
    [0.18, 0.27, 0.75], [0.1, 0.7, 0.85], [0.2, 0.75, 0.3], [0.98, 0.85, 0.2], [0.9, 0.25, 0.15],
  ];
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  const a = stops[i], b = stops[i + 1];
  return new THREE.Color(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this.listeners = {};
    this.sun = { vec: new THREE.Vector3(0, 1, 0), altitude: 90, azimuth: 180 };
    this.location = { lat: 60.17, lng: 24.94 };
    this.date = new Date();
    this.shadowExtent = 150;
    this.model = null;
    this.occluderBVH = null;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: false }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.localClippingEnabled = true;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    container.appendChild(r.domElement);
    r.domElement.tabIndex = 0;

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#9cc3e6');
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 6000);
    this.camera.position.set(80, 60, 80);

    this.hemi = new THREE.HemisphereLight('#dbe8f5', '#6b6355', 0.9);
    scene.add(this.hemi);
    const sun = (this.sunLight = new THREE.DirectionalLight('#fff4e0', 3.2));
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 4000;
    scene.add(sun, sun.target);

    // maanpinta
    const ground = (this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(2500, 64).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#b7b29f' })
    ));
    ground.receiveShadow = true;
    ground.position.y = -0.02;
    scene.add(ground);

    this.surroundings = new THREE.Group();
    scene.add(this.surroundings);
    this.modelRoot = new THREE.Group(); // sijoitus: kierto + siirto
    this.modelInner = new THREE.Group(); // pivot + maanpinnan korko
    this.modelRoot.add(this.modelInner);
    scene.add(this.modelRoot);
    this.overlay = new THREE.Group(); // analyysien tulokset, korostukset
    scene.add(this.overlay);

    // leikkaustaso (kerrosleikkaus): piilottaa mallin osat tason yläpuolelta, mutta
    // varjot lasketaan koko mallista (customDepthMaterial ilman leikkausta)
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });

    // kontrollit
    this.orbit = new OrbitControls(this.camera, r.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.mode = 'orbit';
    this._setupWalk();

    this.raycaster = new THREE.Raycaster();
    r.domElement.addEventListener('dblclick', (e) => this._onDblClick(e));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.clock = new THREE.Clock();
    r.setAnimationLoop(() => this._frame());
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
  }
  emit(evt, ...a) {
    (this.listeners[evt] || []).forEach((f) => f(...a));
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- malli --
  setModel(model) {
    this.modelInner.clear();
    this.overlay.clear();
    this.model = model;
    this.modelInner.add(model.group);
    for (const m of model.meshes) {
      m.material.clippingPlanes = [this.clipPlane];
      m.customDepthMaterial = this.depthMat;
    }
    // tilat: näkymättömiä volyymeja (valinta + korostus)
    this.spaceGroup = new THREE.Group();
    this.spaceMat = new THREE.MeshBasicMaterial({
      color: '#4dabf7', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide,
      clippingPlanes: [this.clipPlane],
    });
    for (const s of model.spaces) {
      const m = new THREE.Mesh(s.geometry, this.spaceMat);
      m.userData.space = s;
      m.castShadow = m.receiveShadow = false;
      s.mesh = m;
      this.spaceGroup.add(m);
    }
    this.spaceGroup.visible = false;
    this.modelInner.add(this.spaceGroup);
    const r = model.bbox.getBoundingSphere(new THREE.Sphere()).radius;
    this.shadowExtent = Math.min(450, Math.max(80, r + 100));
    this.invalidateOccluders();
  }

  setPlacement({ pivot, rotation, offsetE, offsetN, groundY }) {
    this.modelInner.position.set(-pivot[0], -groundY, pivot[1]);
    this.modelRoot.rotation.set(0, (rotation * Math.PI) / 180, 0);
    this.modelRoot.position.set(offsetE, 0, -offsetN);
    this.modelRoot.updateMatrixWorld(true);
    this.invalidateOccluders();
    this._updateSunLight();
  }

  showSpaces(v) {
    if (this.spaceGroup) this.spaceGroup.visible = v;
  }

  setSectionHeight(worldY) {
    this.clipPlane.constant = worldY == null ? 1e6 : worldY;
  }

  /** Mallin y-koordinaatti (malli) → maailman y */
  modelYToWorld(y) {
    return y + this.modelInner.position.y;
  }

  // ------------------------------------------------------ ympäristö --------
  /** @param polys [{rings:[[ [e,n],... ]], height}] paikallisissa ENU-koordinaateissa */
  setSurroundings(polys) {
    this.surroundings.clear();
    const geoms = [];
    for (const p of polys) {
      const outer = p.rings[0];
      if (outer.length < 4 || p.height <= 0) continue;
      const shape = new THREE.Shape(outer.map(([e, n]) => new THREE.Vector2(e, n)));
      for (let i = 1; i < p.rings.length; i++)
        shape.holes.push(new THREE.Path(p.rings[i].map(([e, n]) => new THREE.Vector2(e, n))));
      try {
        const g = new THREE.ExtrudeGeometry(shape, { depth: p.height, bevelEnabled: false });
        g.rotateX(-Math.PI / 2); // (e, n, h) → (e, h, -n)
        g.deleteAttribute('uv');
        geoms.push(g.index ? g.toNonIndexed() : g);
      } catch (e) {
        /* virheellinen polygoni */
      }
    }
    if (geoms.length) {
      const merged = mergeGeometries(geoms, false);
      geoms.forEach((g) => g.dispose());
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshLambertMaterial({ color: '#d8d2c6', side: THREE.DoubleSide })
      );
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.depthMat;
      this.surroundings.add(mesh);
    }
    this.invalidateOccluders();
  }

  // ---------------------------------------------------------- aurinko -------
  setSun(date, lat, lng) {
    this.date = date;
    this.location = { lat, lng };
    this.sun = sunDirection(date, lat, lng);
    this._updateSunLight();
    return this.sun;
  }

  setShadowQuality(size) {
    const s = this.sunLight.shadow;
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
  }

  setShadowExtent(m) {
    this.shadowExtent = m;
    this._updateSunLight();
  }

  _updateSunLight() {
    const alt = this.sun.altitude;
    const up = Math.max(0, Math.sin((alt * Math.PI) / 180));
    const center = new THREE.Vector3();
    this.modelRoot.getWorldPosition(center);
    const L = this.sunLight;
    L.position.copy(center).addScaledVector(this.sun.vec, 1500);
    L.target.position.copy(center);
    L.target.updateMatrixWorld();
    const c = L.shadow.camera;
    c.left = c.bottom = -this.shadowExtent;
    c.right = c.top = this.shadowExtent;
    c.updateProjectionMatrix();
    L.visible = alt > -0.5;
    L.intensity = alt > 0 ? 3.2 * Math.min(1, 0.25 + up * 2) : 0;
    // väri ja taivas auringon korkeuden mukaan
    const warm = Math.min(1, Math.max(0, alt / 25));
    L.color.setRGB(1, 0.78 + 0.2 * warm, 0.55 + 0.4 * warm);
    const day = Math.min(1, Math.max(0, (alt + 6) / 20));
    this.hemi.intensity = 0.15 + 0.85 * day;
    this.scene.background.setRGB(0.07 + 0.54 * day, 0.09 + 0.67 * day, 0.18 + 0.72 * day);
  }

  // ------------------------------------------------------ kontrollit -------
  _setupWalk() {
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      el.focus();
      if (this.mode !== 'walk') return;
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || this.mode !== 'walk') return;
      this.yaw -= (e.clientX - drag.x) * 0.004;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', () => (drag = null));
    el.addEventListener('wheel', (e) => {
      if (this.mode !== 'walk') return;
      e.preventDefault();
      const f = new THREE.Vector3();
      this.camera.getWorldDirection(f);
      this.camera.position.addScaledVector(f, -Math.sign(e.deltaY) * 0.5);
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    el.addEventListener('keyup', (e) => this.keys.delete(e.code));
    el.addEventListener('blur', () => this.keys.clear());
  }

  setMode(mode) {
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    if (mode === 'walk') {
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.yaw = Math.atan2(-d.x, -d.z);
      this.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    } else {
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.orbit.target.copy(this.camera.position).addScaledVector(d, 10);
    }
    this.emit('mode', mode);
  }

  _frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.mode === 'walk') {
      const k = this.keys;
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 8 : 2.2) * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const p = this.camera.position;
      if (k.has('KeyW') || k.has('ArrowUp')) p.addScaledVector(fwd, speed);
      if (k.has('KeyS') || k.has('ArrowDown')) p.addScaledVector(fwd, -speed);
      if (k.has('KeyD') || k.has('ArrowRight')) p.addScaledVector(right, speed);
      if (k.has('KeyA') || k.has('ArrowLeft')) p.addScaledVector(right, -speed);
      if (k.has('KeyE') || k.has('Space')) p.y += speed;
      if (k.has('KeyQ')) p.y -= speed;
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    } else {
      this.orbit.update();
    }
    this.renderer.render(this.scene, this.camera);
  }

  _pick(e, objects) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(objects, true);
    // ohita leikkaustason yläpuoliset osumat
    return hits.find(
      (h) => h.point.y <= this.clipPlane.constant + 1e-3 && !h.object.userData.space && h.object.userData.kind !== 'glass'
    );
  }

  _onDblClick(e) {
    const targets = [this.modelInner, this.surroundings, this.ground];
    const hit = this._pick(e, targets);
    if (!hit) return;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    if (n.y > 0.7 && hit.object !== this.ground) {
      // lattia → kävele sinne
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.camera.position.set(hit.point.x, hit.point.y + EYE, hit.point.z);
      if (this.mode !== 'walk') this.setMode('walk');
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = 0;
    } else if (this.mode === 'orbit') {
      this.orbit.target.copy(hit.point);
    }
    // tila valitulla kohdalla?
    if (this.model?.spaces.length) {
      const sp = this.spaceAt(hit.point.clone().add(new THREE.Vector3(0, 0.3, 0)));
      if (sp) this.emit('space', sp);
    }
  }

  /** Etsii tilan, jonka sisällä maailman piste on. */
  spaceAt(p) {
    if (!this.model) return null;
    const inv = new THREE.Matrix4().copy(this.modelInner.matrixWorld).invert();
    const lp = p.clone().applyMatrix4(inv);
    const candidates = this.model.spaces.filter((s) => s.bbox.containsPoint(lp));
    for (const s of candidates) if (insideMesh(s.mesh, p)) return s;
    return null;
  }

  // ------------------------------------------------------- navigointi ------
  viewAll() {
    if (!this.model) return;
    this.setSectionHeight(null);
    const box = new THREE.Box3().setFromObject(this.model.group);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getBoundingSphere(new THREE.Sphere()).radius;
    if (this.mode !== 'orbit') this.setMode('orbit');
    // katsotaan aurinkoa myötävalossa (varjot näkyvät)
    const s = this.sun.vec.clone().setY(0);
    if (s.lengthSq() < 1e-6) s.set(0, 0, 1);
    s.normalize();
    this.camera.position.copy(c).addScaledVector(s, r * 1.8).add(new THREE.Vector3(0, r * 1.2, 0));
    this.orbit.target.copy(c);
  }

  /** Kerrosleikkaus: näytä kerros ylhäältä, leikkaus 1.6 m lattian yläpuolella. */
  viewStorey(storey) {
    if (!this.model || storey.floorY == null) return;
    const y = this.modelYToWorld(storey.floorY) + 1.6;
    this.setSectionHeight(y);
    const box = new THREE.Box3().setFromObject(this.model.group);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getBoundingSphere(new THREE.Sphere()).radius;
    if (this.mode !== 'orbit') this.setMode('orbit');
    this.orbit.target.set(c.x, y - 1.6, c.z);
    this.camera.position.set(c.x + r * 0.2, y + r * 2.2, c.z + r * 0.6);
    return y;
  }

  goToSpace(space, { section = true } = {}) {
    this.modelRoot.updateMatrixWorld(true);
    const box = space.bbox.clone().applyMatrix4(this.modelInner.matrixWorld);
    const c = box.getCenter(new THREE.Vector3());
    // etsi tilan sisältä silmäkorkeudelta piste (L-muotoiset tilat)
    let eye = new THREE.Vector3(c.x, box.min.y + EYE, c.z);
    if (!insideMesh(space.mesh, eye)) {
      const tries = 7;
      outer: for (let i = 1; i < tries; i++)
        for (let j = 1; j < tries; j++) {
          const p = new THREE.Vector3(
            box.min.x + ((box.max.x - box.min.x) * i) / tries, eye.y, box.min.z + ((box.max.z - box.min.z) * j) / tries
          );
          if (insideMesh(space.mesh, p)) {
            eye = p;
            break outer;
          }
        }
    }
    if (section) this.setSectionHeight(box.max.y + 0.05);
    this.camera.position.copy(eye);
    this.setMode('walk');
    // katse varjojen suuntaan (auringosta poispäin) ja hieman alas → aurinkolaikut näkyvät
    const s = this.sun.altitude > 0 ? this.sun.vec.clone().negate() : new THREE.Vector3(0, 0, -1);
    this.yaw = Math.atan2(-s.x, -s.z);
    this.pitch = -0.3;
    this.highlightSpace(space);
  }

  highlightSpace(space) {
    this.overlay.children.filter((o) => o.userData.highlight).forEach((o) => this.overlay.remove(o));
    if (!space) return;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(space.geometry, 30),
      new THREE.LineBasicMaterial({ color: '#ffd43b', depthTest: false, transparent: true, opacity: 0.8 })
    );
    edges.applyMatrix4(this.modelInner.matrixWorld);
    edges.userData.highlight = true;
    edges.renderOrder = 10;
    this.overlay.add(edges);
  }

  // ------------------------------------------------ auringonpaiste-analyysi --
  invalidateOccluders() {
    this.occluderBVH = null;
  }

  _getOccluders() {
    if (this.occluderBVH) return this.occluderBVH;
    this.scene.updateMatrixWorld(true);
    const geoms = [];
    const add = (mesh) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', mesh.geometry.attributes.position.clone());
      if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
      g.applyMatrix4(mesh.matrixWorld);
      geoms.push(g.index ? g : g);
    };
    if (this.model) for (const m of this.model.meshes) if (m.userData.kind !== 'glass') add(m);
    this.surroundings.traverse((o) => o.isMesh && add(o));
    if (!geoms.length) return null;
    const indexed = geoms.map((g) => (g.index ? g : (() => {
      const n = g.attributes.position.count;
      g.setIndex([...Array(n).keys()]);
      return g;
    })()));
    const merged = mergeGeometries(indexed, false);
    this.occluderBVH = new MeshBVH(merged, { maxLeafSize: 12 });
    return this.occluderBVH;
  }

  /**
   * Laskee tilan lattiatasolle (tai työtasolle) osuvan suoran auringonvalon.
   * @returns {{hours:number[], points:Vector3[], avg, max, min, nowShare, dayLength}}
   */
  analyzeSpace(space, { date, height = 0.1, stepMinutes = 10, maxPoints = 500, showHeatmap = true } = {}) {
    const bvh = this._getOccluders();
    if (!bvh) return null;
    this.modelRoot.updateMatrixWorld(true);
    // näytteet mallin omassa (kiertämättömässä) koordinaatistossa → ruudukko seuraa seiniä
    const lb = space.bbox;
    const sx = lb.max.x - lb.min.x, sz = lb.max.z - lb.min.z;
    const step = Math.max(0.2, Math.sqrt((sx * sz) / maxPoints));
    const mw = this.modelInner.matrixWorld;
    const points = [];
    for (let x = lb.min.x + step / 2; x < lb.max.x; x += step)
      for (let z = lb.min.z + step / 2; z < lb.max.z; z += step) {
        const p = new THREE.Vector3(x, lb.min.y + height, z).applyMatrix4(mw);
        if (insideMesh(space.mesh, p)) points.push(p);
      }
    if (!points.length) return null;

    const { lat, lng } = this.location;
    const times = dayTimes(date, lat, lng, stepMinutes);
    const dirs = times.map((t) => sunDirection(t, lat, lng)).filter((s) => s.altitude > 0).map((s) => s.vec);
    const hours = new Float32Array(points.length);
    const ray = new THREE.Ray();
    const dt = stepMinutes / 60;
    for (let i = 0; i < points.length; i++) {
      for (const d of dirs) {
        ray.origin.copy(points[i]).addScaledVector(d, 0.05);
        ray.direction.copy(d);
        if (!bvh.raycastFirst(ray, THREE.DoubleSide, 0, 3000)) hours[i] += dt;
      }
    }
    // hetkellinen tilanne
    const nowSun = sunDirection(date, lat, lng);
    const lit = new Uint8Array(points.length);
    let nowCount = 0;
    if (nowSun.altitude > 0)
      for (let i = 0; i < points.length; i++) {
        ray.origin.copy(points[i]).addScaledVector(nowSun.vec, 0.05);
        ray.direction.copy(nowSun.vec);
        if (!bvh.raycastFirst(ray, THREE.DoubleSide, 0, 3000)) (lit[i] = 1), nowCount++;
      }
    let sum = 0, max = 0, min = Infinity, anySun = 0;
    for (const h of hours) {
      sum += h; max = Math.max(max, h); min = Math.min(min, h);
      if (h > 0) anySun++;
    }
    const res = {
      space, points, hours, lit, step,
      avg: sum / points.length, max, min,
      anyShare: anySun / points.length,
      nowShare: nowCount / points.length,
      dayLength: dirs.length * dt,
    };
    if (showHeatmap) this.showHeatmap(res);
    return res;
  }

  clearHeatmaps() {
    this.overlay.children.filter((o) => o.userData.heatmap).forEach((o) => {
      o.geometry.dispose();
      this.overlay.remove(o);
    });
  }

  showHeatmap(res, { scaleHours = 8, replace = false } = {}) {
    if (replace) this.clearHeatmaps();
    // poista saman tilan aiempi tulos
    this.overlay.children
      .filter((o) => o.userData.heatmap === res.space.id)
      .forEach((o) => this.overlay.remove(o));
    const geo = new THREE.PlaneGeometry(res.step * 0.96, res.step * 0.96).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: [this.clipPlane],
      }),
      res.points.length
    );
    const m = new THREE.Matrix4();
    const q = this.modelRoot.quaternion;
    const one = new THREE.Vector3(1, 1, 1);
    res.points.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, p.y + 0.02, p.z), q, one);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, heatColor(res.hours[i] / scaleHours));
    });
    mesh.userData.heatmap = res.space.id;
    mesh.renderOrder = 5;
    this.overlay.add(mesh);
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

const _rc = new THREE.Raycaster();
const _upDir = new THREE.Vector3(0, 1, 0);
const _dsMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
/** Onko piste suljetun tilavolyymin sisällä (parillisuustesti ylöspäin). */
function insideMesh(mesh, p) {
  if (!mesh) return false;
  const orig = mesh.material;
  mesh.material = _dsMat;
  _rc.set(p, _upDir);
  const hits = _rc.intersectObject(mesh, false);
  mesh.material = orig;
  // poista lähes päällekkäiset osumat (kolmioiden saumat)
  let n = 0, last = -1;
  for (const h of hits) {
    if (h.distance - last > 1e-4) n++;
    last = h.distance;
  }
  return n % 2 === 1;
}

/** Aikapisteet auringonnoususta laskuun (tai koko vuorokausi, jos aurinko ei laske/nouse). */
export function dayTimes(date, lat, lng, stepMinutes) {
  const t = SunCalc.getTimes(date, lat, lng);
  let start = t.sunrise, end = t.sunset;
  if (!(start instanceof Date) || isNaN(start) || !(end instanceof Date) || isNaN(end) || end <= start) {
    start = new Date(date);
    start.setHours(0, 0, 0, 0);
    end = new Date(start.getTime() + 24 * 3600e3);
  }
  const out = [];
  const st = stepMinutes * 60e3;
  for (let x = start.getTime() + st / 2; x < end.getTime(); x += st) out.push(new Date(x));
  return out;
}
