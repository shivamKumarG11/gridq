// The 3D grid world: procedural low-poly plants, lines, a city and a sky driven by the simulated
// hour. No model files (Qollab's 2 MB per-file limit), everything is built from three.js primitives.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const COL = {
  coal: 0x6d737d, gas: 0x5f8296, oil: 0x94705a, off: 0x1b222c, power: 0x4fd1ff, amber: 0xffb347,
  good: 0x7cf0b0, ground: 0x13202e, hill: 0x182a3a, water: 0x0d2a3f, window: 0xffcf7a,
};
// plant positions (x, z): coal on the western hills, gas along the river, oil peakers near town
const SPOTS = [[-34, -12], [-34, 8], [-18, -20], [-12, -8], [-18, 12], [-6, 20], [2, -22], [8, 4], [12, 16], [16, -10]];
const SUBSTATION = new THREE.Vector3(8, 0, -2);
const CITY = new THREE.Vector3(32, 0, 0);
const SKY = [ // hour -> [sky, fog, hemi intensity]
  [0, 0x070c14], [5, 0x0b1220], [6.5, 0x2a2338], [8, 0x3a5a78], [12, 0x4a7a9c], [17, 0x3d6280],
  [18.5, 0x3a2a4a], [20, 0x1a1530], [22, 0x0a0f1a], [24, 0x070c14],
];

function lerpColor(h) {
  for (let i = 0; i < SKY.length - 1; i++) {
    const [h0, c0] = SKY[i], [h1, c1] = SKY[i + 1];
    if (h >= h0 && h <= h1) return new THREE.Color(c0).lerp(new THREE.Color(c1), (h - h0) / (h1 - h0));
  }
  return new THREE.Color(SKY[0][1]);
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, flatShading: true, ...extra });
}

function buildPlant(unit) {
  const g = new THREE.Group();
  const body = std(COL[unit.fuel]);
  const dark = std(0x2a3340);
  const mats = [body, dark];
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  const pad = add(new THREE.BoxGeometry(unit.fuel === 'coal' ? 14 : unit.fuel === 'gas' ? 8 : 5.5, 0.3, unit.fuel === 'coal' ? 10 : 6), std(0x1d2a38), 0, 0.15, 0);
  pad.receiveShadow = true;
  const vents = []; // where plumes leave the plant, plus the plume scale
  if (unit.fuel === 'coal') {
    add(new THREE.BoxGeometry(6, 3.2, 4), body, -2.5, 1.9, 0);
    const prof = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; prof.push(new THREE.Vector2(2.3 - 1.0 * Math.sin(Math.PI * t * 0.85), t * 7)); }
    const tower = new THREE.LatheGeometry(prof, 10);
    const towerMat = std(0x8a9099, { side: THREE.DoubleSide });
    mats.push(towerMat);
    add(tower, towerMat, 2.8, 0.3, -2.2);
    add(tower, towerMat, 2.8, 0.3, 2.6);
    add(new THREE.CylinderGeometry(0.35, 0.55, 10, 8), dark, -4.4, 5.3, -1.2);
    vents.push([2.8, 7.4, -2.2, 0.9], [2.8, 7.4, 2.6, 0.9], [-4.4, 10.4, -1.2, 0.5]);
  } else if (unit.fuel === 'gas') {
    add(new THREE.BoxGeometry(4.4, 2.4, 2.8), body, -0.6, 1.5, 0);
    add(new THREE.BoxGeometry(1.6, 1.4, 2.2), dark, 2.4, 1.0, 0);
    add(new THREE.CylinderGeometry(0.25, 0.32, 4.6, 8), dark, 2.0, 3.0, -0.6);
    add(new THREE.CylinderGeometry(0.25, 0.32, 4.6, 8), dark, 2.0, 3.0, 0.6);
    vents.push([2.0, 5.4, -0.6, 0.55], [2.0, 5.4, 0.6, 0.55]);
  } else {
    add(new THREE.BoxGeometry(2.6, 1.7, 2.2), body, -0.5, 1.15, 0);
    add(new THREE.CylinderGeometry(0.2, 0.26, 3.2, 8), dark, 1.3, 1.9, 0);
    vents.push([1.3, 3.6, 0, 0.45]);
  }
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x3a4350 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), lampMat);
  lamp.position.set(unit.fuel === 'coal' ? -2.5 : -0.6, unit.fuel === 'coal' ? 4.0 : unit.fuel === 'gas' ? 3.2 : 2.4, 0);
  g.add(lamp);
  // superposition ring and selection ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(unit.fuel === 'coal' ? 8 : unit.fuel === 'gas' ? 5 : 3.6, 0.22, 6, 40),
    new THREE.MeshBasicMaterial({ color: COL.power, transparent: true, opacity: 0 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.4; g.add(ring);
  const sel = new THREE.Mesh(new THREE.TorusGeometry(unit.fuel === 'coal' ? 9 : unit.fuel === 'gas' ? 6 : 4.4, 0.18, 6, 48),
    new THREE.MeshBasicMaterial({ color: COL.amber, transparent: true, opacity: 0 }));
  sel.rotation.x = Math.PI / 2; sel.position.y = 0.35; g.add(sel);
  return { group: g, mats, lamp, lampMat, ring, sel, vents, body };
}

export function createWorld(container, units, { onSelect, reducedMotion = false } = {}) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b1119, 90, 190);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 500);
  const HOME = new THREE.Vector3(-4, 84, 104);
  camera.position.copy(HOME);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  const labels = new CSS2DRenderer();
  labels.domElement.style.position = 'absolute';
  labels.domElement.style.inset = '0';
  labels.domElement.style.pointerEvents = 'none';
  container.appendChild(labels.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = !reducedMotion;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minDistance = 25;
  controls.maxDistance = 170;

  // light
  const hemi = new THREE.HemisphereLight(0x9cc8ff, 0x0b1119, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 60, bottom: -60, far: 260 });
  scene.add(sun, sun.target);
  const moon = new THREE.DirectionalLight(0x6f8fbf, 0.25);
  moon.position.set(40, 60, -30);
  scene.add(moon);

  // terrain
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 150), std(COL.ground));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(60, 150), new THREE.MeshStandardMaterial({ color: COL.water, roughness: 0.3, metalness: 0.2 }));
  water.rotation.x = -Math.PI / 2; water.position.set(75, 0.05, 0); scene.add(water);
  const river = new THREE.Mesh(new THREE.PlaneGeometry(4, 150), water.material);
  river.rotation.x = -Math.PI / 2; river.rotation.z = 0.25; river.position.set(-24, 0.04, 0); scene.add(river);
  const hillMat = std(COL.hill);
  [[-55, -30, 12, 9], [-50, 20, 14, 11], [-38, 38, 9, 7], [-60, 0, 10, 13], [-20, -45, 11, 6], [10, 45, 12, 5]].forEach(([x, z, r, h]) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), hillMat); m.position.set(x, h / 2, z); m.receiveShadow = true; scene.add(m);
  });

  // city: three districts that light up with demand
  const rand = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const districts = [];
  for (let d = 0; d < 3; d++) {
    const n = 26;
    const mat = std(0x2a3a4d, { emissive: COL.window, emissiveIntensity: 0 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, n);
    const m4 = new THREE.Matrix4();
    for (let k = 0; k < n; k++) {
      const x = CITY.x - 8 + (k % 6) * 3.4 + rand() * 0.8 + (d === 1 ? 4 : 0);
      const z = CITY.z - 18 + d * 12 + Math.floor(k / 6) * 2.8 + rand() * 0.6;
      const h = 2 + rand() * (d === 1 ? 11 : 6);
      m4.compose(new THREE.Vector3(x, h / 2, z), new THREE.Quaternion(), new THREE.Vector3(1.7, h, 1.5));
      mesh.setMatrixAt(k, m4);
    }
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh); districts.push(mat);
  }

  // substation
  const subMat = std(0x33465a, { emissive: COL.power, emissiveIntensity: 0.2 });
  const sub = new THREE.Mesh(new THREE.BoxGeometry(5, 1.6, 4), subMat);
  sub.position.copy(SUBSTATION).setY(0.8); scene.add(sub);

  // plants, lines, plumes
  const plants = units.map((u, i) => {
    const p = buildPlant(u);
    const [x, z] = SPOTS[i];
    p.group.position.set(x, 0, z);
    p.group.userData.index = i;
    p.group.traverse((o) => { o.userData.index = i; });
    scene.add(p.group);
    const div = document.createElement('div');
    div.className = 'plantlabel';
    div.textContent = `G${u.id}`;
    const lab = new CSS2DObject(div);
    lab.position.set(0, u.fuel === 'coal' ? 12 : 7, 0);
    p.group.add(lab);
    p.labelDiv = div;
    // line from plant to substation, with pylons
    const start = new THREE.Vector3(x, 0, z);
    const mid = start.clone().lerp(SUBSTATION, 0.5);
    const curve = new THREE.CatmullRomCurve3([start.clone().setY(3), mid.clone().setY(5.5), SUBSTATION.clone().setY(3)]);
    const lineMat = new THREE.MeshBasicMaterial({ color: COL.power, transparent: true, opacity: 0.15 });
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.12, 5), lineMat));
    const pyl = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 5.5, 4), std(0x45566a));
    pyl.position.copy(mid).setY(2.75); scene.add(pyl);
    p.curve = curve; p.lineMat = lineMat;
    // flow particles and plume puffs
    p.flow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 6, 4), new THREE.MeshBasicMaterial({ color: COL.power }), 6);
    p.flow.count = 0; scene.add(p.flow);
    p.flowT = Array.from({ length: 6 }, (_, k) => k / 6);
    const puffs = 10 * p.vents.length;
    p.plume = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.32, flatShading: true, depthWrite: false }), puffs);
    p.plume.count = 0; p.plume.position.copy(p.group.position); scene.add(p.plume);
    p.puffT = Array.from({ length: puffs }, (_, k) => (k % 10) / 10);
    p.unit = u;
    p.out = 0; p.target = { on: 0, starting: false, frac: 0 };
    return p;
  });
  // substation -> city trunk line
  const trunk = new THREE.CatmullRomCurve3([SUBSTATION.clone().setY(3), new THREE.Vector3(20, 6, -1), CITY.clone().setX(CITY.x - 9).setY(3)]);
  const trunkMat = new THREE.MeshBasicMaterial({ color: COL.power, transparent: true, opacity: 0.3 });
  scene.add(new THREE.Mesh(new THREE.TubeGeometry(trunk, 30, 0.3, 6), trunkMat));
  const trunkFlow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshBasicMaterial({ color: COL.power }), 14);
  scene.add(trunkFlow);
  const trunkT = Array.from({ length: 14 }, (_, k) => k / 14);

  // superposition threads
  const threads = new THREE.Group(); scene.add(threads);

  let hourF = 12, hourTarget = 12, demandFrac = 0.8, superpos = null, selected = null, flashUntil = 0;
  const dummy = new THREE.Object3D();

  function setHour({ hour, plants: states, demandFrac: df }) {
    hourTarget = hour;
    if (reducedMotion) hourF = hour;
    demandFrac = df;
    states.forEach((s, i) => { plants[i].target = s; });
  }

  function setSuperposition(sp) {
    superpos = sp;
    while (threads.children.length) { const c = threads.children.pop(); c.geometry.dispose(); c.material.dispose(); }
    if (!sp) return;
    const top = [...sp.corr].sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 10);
    const maxc = Math.max(1e-6, ...top.map((t) => Math.abs(t.c)));
    for (const { i, j, c } of top) {
      if (Math.abs(c) < 0.15 * maxc) continue;
      const a = plants[i].group.position.clone().setY(6), b = plants[j].group.position.clone().setY(6);
      const mid = a.clone().lerp(b, 0.5).setY(14 + a.distanceTo(b) * 0.15);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const mat = new THREE.MeshBasicMaterial({ color: c > 0 ? COL.power : COL.amber, transparent: true, opacity: 0.25 + 0.7 * Math.abs(c) / maxc });
      threads.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.08 + 0.25 * Math.abs(c) / maxc, 5), mat));
    }
  }

  function setSelected(i) {
    selected = i;
    plants.forEach((p, k) => { p.sel.material.opacity = k === i ? 0.95 : 0; p.labelDiv.classList.toggle('sel', k === i); });
  }

  function flash() { flashUntil = performance.now() + 900; }

  // picking: a click that did not drag the camera
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(plants.map((p) => p.group), true)[0];
    if (hit && onSelect) onSelect(hit.object.userData.index);
  });
  // keyboard camera
  container.addEventListener('keydown', (e) => {
    const off = camera.position.clone().sub(controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    let used = true;
    if (e.key === 'ArrowLeft') sph.theta -= 0.12;
    else if (e.key === 'ArrowRight') sph.theta += 0.12;
    else if (e.key === 'ArrowUp') sph.phi = Math.max(0.2, sph.phi - 0.08);
    else if (e.key === 'ArrowDown') sph.phi = Math.min(Math.PI * 0.46, sph.phi + 0.08);
    else if (e.key === '+' || e.key === '=') sph.radius = Math.max(25, sph.radius * 0.88);
    else if (e.key === '-' || e.key === '_') sph.radius = Math.min(170, sph.radius * 1.12);
    else used = false;
    if (used) { e.preventDefault(); camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph)); }
  });

  let fly = null;
  function reset() { fly = { pos: HOME.clone(), target: new THREE.Vector3(0, 0, 0) }; }
  function flyTo(i) {
    if (i == null) return;
    const p = plants[i].group.position;
    fly = { pos: p.clone().add(new THREE.Vector3(-14, 22, 26)), target: p.clone() };
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    labels.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    const now = performance.now();
    if (!reducedMotion) hourF += (hourTarget - hourF) * Math.min(1, dt * 4);
    // sky and sun from the hour (hour t covers t-1..t)
    const hh = ((hourF - 0.5) % 24 + 24) % 24;
    const sky = lerpColor(hh);
    scene.background = sky; scene.fog.color = sky;
    const ang = (hh - 6) / 12 * Math.PI;
    const elev = Math.sin(ang);
    sun.position.set(-Math.cos(ang) * 90, Math.max(5, elev * 90), 30);
    sun.intensity = Math.max(0, elev) * 1.4;
    hemi.intensity = 0.25 + Math.max(0, elev) * 0.5;
    const night = Math.min(1, Math.max(0, 1 - elev * 3));
    districts.forEach((m, d) => { m.emissiveIntensity = (0.15 + 0.85 * night) * Math.max(0, Math.min(1, demandFrac * 3 - d * 0.9)); });

    let total = 0;
    plants.forEach((p, i) => {
      const t = p.target;
      p.out += ((t.on ? t.frac : 0) - p.out) * (reducedMotion ? 1 : Math.min(1, dt * 3));
      total += p.out * p.unit.p_max;
      const sp = superpos ? superpos.pon[i] : null;
      const vis = sp == null ? 1 : 0.12 + 0.88 * sp;
      const lit = t.on ? 1 : 0;
      p.mats.forEach((m, k) => {
        const base = k === 0 ? COL[p.unit.fuel] : (k === 1 ? 0x2a3340 : 0x8a9099);
        m.color.set(lit || sp != null ? base : COL.off);
        m.transparent = sp != null; m.opacity = vis; m.depthWrite = sp == null;
      });
      const flick = t.starting && !reducedMotion ? (Math.sin(now / 90 + i) > 0 ? 1 : 0.35) : 1;
      p.lampMat.color.set(sp != null ? COL.power : t.starting ? COL.amber : t.on ? COL.good : 0x3a4350).multiplyScalar(flick);
      p.ring.material.opacity = sp == null ? 0 : 0.15 + 0.8 * sp;
      p.ring.scale.setScalar(sp == null ? 1 : 0.6 + 0.5 * sp);
      if (selected === i && !reducedMotion) p.sel.rotation.z += dt * 0.6;
      p.lineMat.opacity = 0.12 + 0.75 * p.out;
      // flow particles
      const nf = superpos || p.out < 0.02 ? 0 : 6;
      p.flow.count = nf;
      for (let k = 0; k < nf; k++) {
        if (!reducedMotion) p.flowT[k] = (p.flowT[k] + dt * (0.12 + 0.35 * p.out)) % 1;
        dummy.position.copy(p.curve.getPointAt(p.flowT[k]));
        dummy.scale.setScalar(0.6 + 0.8 * p.out);
        dummy.updateMatrix(); p.flow.setMatrixAt(k, dummy.matrix);
      }
      p.flow.instanceMatrix.needsUpdate = true;
      // plumes: count and size follow output
      const per = 10, active = superpos ? 0 : Math.round(per * Math.min(1, p.out * 1.2));
      let n = 0;
      p.vents.forEach(([vx, vy, vz, s], vi) => {
        for (let k = 0; k < active; k++) {
          const idx = vi * per + k;
          if (!reducedMotion) p.puffT[idx] = (p.puffT[idx] + dt * 0.18) % 1;
          const u = p.puffT[idx];
          dummy.position.set(vx + u * 3.5, vy + u * 7 * s, vz + Math.sin(idx) * 0.4 * u);
          dummy.scale.setScalar(s * (0.5 + u * 1.6) * (0.6 + 0.6 * p.out));
          dummy.updateMatrix(); p.plume.setMatrixAt(n++, dummy.matrix);
        }
      });
      p.plume.count = n; p.plume.instanceMatrix.needsUpdate = true;
    });
    const tf = total / 1662;
    trunkMat.opacity = 0.2 + 0.7 * tf;
    trunkFlow.count = superpos ? 0 : 14;
    for (let k = 0; k < trunkFlow.count; k++) {
      if (!reducedMotion) trunkT[k] = (trunkT[k] + dt * (0.08 + 0.25 * tf)) % 1;
      dummy.position.copy(trunk.getPointAt(trunkT[k])); dummy.scale.setScalar(0.7 + tf); dummy.updateMatrix();
      trunkFlow.setMatrixAt(k, dummy.matrix);
    }
    trunkFlow.instanceMatrix.needsUpdate = true;
    subMat.emissiveIntensity = now < flashUntil ? 1.2 : 0.15 + 0.5 * tf;
    threads.children.forEach((c) => { c.visible = !!superpos; });

    if (fly) {
      const k = reducedMotion ? 1 : Math.min(1, dt * 3);
      camera.position.lerp(fly.pos, k); controls.target.lerp(fly.target, k);
      if (camera.position.distanceTo(fly.pos) < 0.3) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { setHour, setSuperposition, setSelected, flash, reset, flyTo, resize };
}
