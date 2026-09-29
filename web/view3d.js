// Builds a three.js model of a resolved box template (+ optional cabinet placement).
// World frame, mm, Z up: x = width (left->right seen from the front), y = depth (front y=0 -> back),
// z = height (floor 0). Face/plate YAML frames are 2D, bottom-left origin, as seen from outside.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const gltfCache = new Map();
const loadGltf = (url) => {
  if (!gltfCache.has(url)) gltfCache.set(url, new GLTFLoader().loadAsync(url).then((g) => g.scene));
  return gltfCache.get(url);
};
const AXIS = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

/** rotation taking the model's `front` axis to world -y (out of the panel) and `up` to world +z */
function modelRotation(front, up) {
  const f = new THREE.Vector3(...(AXIS[front] || AXIS['-y'])), u = new THREE.Vector3(...(AXIS[up] || AXIS['+z']));
  const r = new THREE.Vector3().crossVectors(u, f);            // model "right" in model axes... (u x f)
  const from = new THREE.Matrix4().makeBasis(r, f.clone().negate(), u);     // model -> canonical (x right, y back, z up)
  return new THREE.Matrix4().copy(from).invert();
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const NX = X.clone().negate(), NY = Y.clone().negate();

const COL = {
  body: 0xcfcbb9,        // MUNSELL 5Y8/1-ish
  plate: 0xc3c7cb, duct: 0x8f969d, lid: 0xaab0b6, rail: 0xd6dade, stand: 0x9a978a,
  comp: 0x51606f, plc: 0x2f3b48, psu: 0x6c7a89, relay: 0x3d6f99, breaker: 0x2b2b2b, terminal: 0x4a8a5a, motion: 0x5a4f7a,
  pb: 0x2e9d4f, pl: 0xe0a100, emg: 0xd12b2b, ss: 0x222222, ks: 0x888888, knob: 0x1b1b1b, sel: 0xff7a00,
};

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.15, ...extra });

/** A flat panel from a 2D face (w x h, holes) extruded by t, placed with a right-handed basis:
 *  u -> face x, v -> face y, w -> thickness direction; origin = world point of face (0,0) on the w=0 side. */
function facePanel(w, h, t, holes, basis, material) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(w, 0); shape.lineTo(w, h); shape.lineTo(0, h); shape.closePath();
  for (const hl of holes || []) {
    const p = new THREE.Path();
    if (hl.shape === 'circle' && hl.d) {
      const r = hl.d / 2;
      if (hl.x - r <= 0 || hl.x + r >= w || hl.y - r <= 0 || hl.y + r >= h) continue;
      p.absarc(hl.x, hl.y, r, 0, Math.PI * 2, true);
    } else if (hl.w && hl.h) {
      const x0 = hl.x - hl.w / 2, y0 = hl.y - hl.h / 2;
      if (x0 <= 0 || y0 <= 0 || x0 + hl.w >= w || y0 + hl.h >= h) continue;
      p.moveTo(x0, y0); p.lineTo(x0, y0 + hl.h); p.lineTo(x0 + hl.w, y0 + hl.h); p.lineTo(x0 + hl.w, y0); p.closePath();
    } else continue;
    shape.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 32 });
  const m = new THREE.Mesh(g, material);
  place(m, basis);
  return m;
}

function place(obj, { o, u, v, w }) {
  obj.matrixAutoUpdate = false;
  obj.matrix.makeBasis(u, v, w).setPosition(o);
  obj.matrixWorldNeedsUpdate = true;
}

/** world point of a face coordinate, on the w=0 side */
const at = ({ o, u, v }, x, y, off = 0, w = null) => {
  const p = o.clone().addScaledVector(u, x).addScaledVector(v, y);
  if (w) p.addScaledVector(w, off);
  return p;
};

function labelTexture(lines, pxW, pxH, bg = '#51606f', fg = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, pxW, pxH);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const [main, ...rest] = lines;
  let fs = Math.min(pxH * 0.28, (pxW * 1.6) / Math.max(main.length, 3));
  g.font = `bold ${fs}px system-ui, Arial`;
  g.fillText(main, pxW / 2, rest.length ? pxH * 0.38 : pxH / 2);
  if (rest.length) {
    const s = rest.join(' ');
    g.font = `${Math.min(fs * 0.55, (pxW * 1.7) / Math.max(s.length, 6))}px system-ui, Arial`;
    g.fillText(s, pxW / 2, pxH * 0.7);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function sprite(text, heightMm, color = '#b3261e') {
  const c = document.createElement('canvas');
  const fs = 64;
  const g = c.getContext('2d');
  g.font = `bold ${fs}px system-ui, Arial`;
  c.width = Math.ceil(g.measureText(text).width) + 24; c.height = fs + 20;
  g.font = `bold ${fs}px system-ui, Arial`;
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 12, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(heightMm * c.width / c.height, heightMm, 1);
  s.renderOrder = 10;
  return s;
}

function kindOf(c) {
  const t = c.tag.toUpperCase(), p = (c.part || '').toUpperCase();
  if (/^(PLC|CPU|IN\d|OUT\d|END)/.test(t) || p.startsWith('NX')) return 'plc';
  if (/^(CV|PS)/.test(t) || p.startsWith('S8V')) return 'psu';
  if (/^CR/.test(t)) return 'relay';
  if (/^(CP|CB|MCB|ELB|BRAKER|BREAKER|MC\d)/.test(t)) return 'breaker';
  if (/^(TB|BNL|X\d)/.test(t) || /^BN[DH]/.test(p)) return 'terminal';
  if (/^(AX|AXIS|AZ)/.test(t) || p.startsWith('JXC')) return 'motion';
  return 'comp';
}
const DEPTH = { plc: 90, psu: 120, relay: 75, breaker: 80, terminal: 50, motion: 120, comp: 80 };

function holeDevice(label, note) {
  const s = `${label} ${note || ''}`.toUpperCase();
  if (/EMG|EMERGENCY|^PB5\b/.test(s) && /EMERGENCY|EMG/.test(s)) return 'emg';
  if (/^FAN/.test(s)) return 'fan';
  if (/^CB|BREAKER/.test(s)) return 'knob';
  if (/^SS/.test(s)) return 'ss';
  if (/^KS/.test(s)) return 'ks';
  if (/^PB\/PL|^PB/.test(s)) return 'pb';
  if (/^PL/.test(s)) return 'pl';
  return 'pb';
}

/** Builds the model. Returns handles the app needs. */
export function buildBox(box, cabinet = null, { labels = true, parts = {} } = {}) {
  const e = box.enclosure;
  const W = e.width, H = e.height, D = e.depth, st = e.stand_height || 0;
  const tb = e.thickness?.body ?? 2.0;
  const zb = st, zt = st + H;
  const root = new THREE.Group();
  const bodyMat = mat(COL.body, { side: THREE.DoubleSide });
  const faces = box.faces || {};
  const pickables = [];
  const labelObjs = [];

  const bases = {
    right: { o: new THREE.Vector3(W - tb, 0, zb), u: Y, v: Z, w: X, w_: W, h_: H },
    left: { o: new THREE.Vector3(tb, D, zb), u: NY, v: Z, w: NX, w_: D, h_: H },
    back: { o: new THREE.Vector3(W, D - tb, zb), u: NX, v: Z, w: Y, w_: W, h_: H },
    top: { o: new THREE.Vector3(0, 0, zt - tb), u: X, v: Y, w: Z, w_: W, h_: D },
    bottom: { o: new THREE.Vector3(0, 0, zb), u: X, v: Y, w: Z, w_: W, h_: D },
  };
  for (const [name, b] of Object.entries(bases)) {
    const m = facePanel(b.w_, b.h_, tb, faces[name], b, bodyMat);
    m.userData = { kind: 'body', face: name };
    root.add(m);
    for (const hl of faces[name] || []) addHoleDevice(b, hl, tb);
  }

  // stand: two welded feet, as on the 1CE drawing
  if (st > 0) {
    const fw = Math.min(100, W / 4);
    for (const x0 of [0, W - fw]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(fw, D, st), mat(COL.stand));
      f.position.set(x0 + fw / 2, D / 2, st / 2);
      root.add(f);
    }
  }

  // door (or fixed front plate) on a hinge pivot
  const door = new THREE.Group();
  const hinge = box.door?.hinge || 'none';
  const td = e.thickness?.door ?? e.thickness?.plate ?? tb;
  const pivot = hinge === 'right' ? new THREE.Vector3(W, 0, zb) : hinge === 'left' ? new THREE.Vector3(0, 0, zb)
    : hinge === 'top' ? new THREE.Vector3(0, 0, zt) : new THREE.Vector3(0, 0, zb);
  door.position.copy(pivot);
  root.add(door);
  const doorBasis = { o: new THREE.Vector3(0, td, zb).sub(pivot), u: X, v: Z, w: NY };
  const doorFace = [...(faces.door || []), ...(faces.front || [])];
  const doorMesh = facePanel(W, H, td, doorFace, doorBasis, bodyMat);
  doorMesh.userData = { kind: 'body', face: 'door' };
  door.add(doorMesh);
  // hinge knuckles + handle
  if (hinge === 'left' || hinge === 'right') {
    const hx = hinge === 'right' ? W - 4 : 4;
    for (const hz of [H * 0.15, H * 0.85]) {
      const k = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 50, 16), mat(0x777777, { metalness: 0.6 }));
      k.rotation.x = Math.PI / 2;           // cylinder axis Y -> Z
      k.position.copy(new THREE.Vector3(hx, -4, zb + hz).sub(pivot));
      door.add(k);
    }
  }
  if (box.door?.handle_pos) {
    const [hx, hy] = box.door.handle_pos;
    const hd = new THREE.Mesh(new THREE.BoxGeometry(16, 22, 70), mat(0x2d2d2d, { metalness: 0.5 }));
    hd.position.copy(new THREE.Vector3(hx, -11, zb + hy).sub(pivot));
    hd.userData = { kind: 'accessory', tag: 'HANDLE', part: box.door.handle };
    door.add(hd);
    pickables.push(hd);
  }
  for (const hl of doorFace) addHoleDevice(doorBasis, hl, td, door);

  function addHoleDevice(b, hl, t, parent = root) {
    if (!hl.label || !(hl.d > 8)) return;
    const kind = holeDevice(hl.label, hl.note);
    const out = b.w.clone();                                // every face basis extrudes outward (w = outward normal)
    const centre = at(b, hl.x, hl.y).addScaledVector(out, t); // start on the outer surface
    const grp = new THREE.Group();
    const addCyl = (r1, r2, len, color, offset) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 32), mat(color));
      m.quaternion.setFromUnitVectors(Y, out);
      m.position.copy(centre).addScaledVector(out, offset + len / 2);
      grp.add(m);
      return m;
    };
    const r = hl.d / 2;
    if (kind === 'fan') {
      addCyl(r + 6, r + 6, 3, 0x3a3a3a, 0);
      for (let i = -2; i <= 2; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(2, 2 * r, 2), mat(0x222222));
        bar.quaternion.setFromUnitVectors(Y, b.v.clone());
        bar.position.copy(at(b, hl.x + i * r / 3, hl.y)).addScaledVector(out, t + 4);
        grp.add(bar);
      }
    } else if (kind === 'knob') {
      addCyl(r * 0.9, r * 0.9, 12, COL.knob, 0);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, 14, 14), mat(0xd12b2b));
      lever.position.copy(centre).addScaledVector(out, 18);
      lever.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(b.u, out, b.u.clone().cross(out)));
      grp.add(lever);
    } else if (kind === 'emg') {
      addCyl(r * 0.9, r * 0.9, 8, 0xf2c500, 0);               // yellow ring
      addCyl(r * 0.8, r * 0.8, 10, 0x333333, 8);
      addCyl(r * 1.7, r * 1.4, 14, COL.emg, 18);              // mushroom head
    } else {
      const color = { pb: COL.pb, pl: COL.pl, ss: COL.ss, ks: COL.ks }[kind] ?? COL.pb;
      addCyl(r * 1.45, r * 1.45, 4, 0x2a2a2a, 0);             // bezel
      addCyl(r * 1.1, r * 1.1, 10, color, 4);
      if (kind === 'ss' || kind === 'ks') {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(r * 1.8, 5, r * 0.5), mat(kind === 'ss' ? 0xeeeeee : 0xc9a227));
        bar.position.copy(centre).addScaledVector(out, 17);
        bar.quaternion.setFromUnitVectors(Y, out);
        grp.add(bar);
      }
    }
    grp.traverse((o) => { o.userData = { kind: 'device', tag: hl.label, note: hl.note || '', face: 'door' }; if (o.isMesh) pickables.push(o); });
    parent.add(grp);
    if (labels) {
      const hgt = Math.max(5, Math.min(24, hl.d * 0.38));
      const s = sprite(hl.label, hgt);
      s.position.copy(at(b, hl.x, hl.y - r * 1.45 - hgt * 0.6)).addScaledVector(out, t + 2);
      parent.add(s);
      labelObjs.push(s);
    }
  }

  // back plate with ducts, rails and components
  const components = cabinet?.components || [];
  let plateFrame = null;
  const ductMat = mat(COL.duct);
  const lids = [];
  if (box.plate) {
    const P = box.plate;
    const standoff = 15;
    const yf = D - tb - standoff - P.thickness;             // plate front surface
    const ox = P.offset_x, oz = zb + P.offset_y;
    plateFrame = { ox, oz, yf };
    const plateBasis = { o: new THREE.Vector3(ox, yf + P.thickness, oz), u: X, v: Z, w: NY };
    const pm = facePanel(P.width, P.height, P.thickness, [], plateBasis, mat(COL.plate, { metalness: 0.4 }));
    pm.userData = { kind: 'plate' };
    root.add(pm);

    for (const d of box.ducts || []) {
      const depth = Number(/H(\d+)/i.exec(d.size || '')?.[1] || 60);
      const g = new THREE.Mesh(new THREE.BoxGeometry(d.w, depth - 3, d.h), ductMat);
      g.position.set(ox + d.x + d.w / 2, yf - (depth - 3) / 2, oz + d.y + d.h / 2);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(d.w + 2, 3, d.h + 2), mat(COL.lid));
      lid.position.set(ox + d.x + d.w / 2, yf - depth + 1.5, oz + d.y + d.h / 2);
      for (const m of [g, lid]) { m.userData = { kind: 'duct', tag: d.id, part: d.size }; root.add(m); pickables.push(m); }
      lids.push(lid);
    }
    for (const r of box.rails || []) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(r.length, 7.5, r.width), mat(COL.rail, { metalness: 0.7, roughness: 0.35 }));
      m.position.set(ox + r.x + r.length / 2, yf - 3.75, oz + r.y);
      m.userData = { kind: 'rail', tag: r.id, part: r.part };
      root.add(m);
    }
    for (const c of components) {
      const kind = kindOf(c);
      const dep = DEPTH[kind];
      const color = COL[kind];
      const hexc = '#' + color.toString(16).padStart(6, '0');
      const aspect = c.w / c.h;
      const tex = labelTexture([c.tag, ...(c.part ? [c.part] : [])], Math.round(256 * Math.min(2, Math.max(0.5, aspect))),
        Math.round(256 / Math.min(2, Math.max(0.5, aspect)) * (aspect > 2 ? 1 : 1)), hexc);
      const side = mat(color);
      const front = mat(0xffffff, { map: tex });
      const m = new THREE.Mesh(new THREE.BoxGeometry(c.w, dep, c.h), [side, side, side, front, side, side]);
      m.position.set(ox + c.x + c.w / 2, yf - 7.5 - dep / 2, oz + c.y + c.h / 2);
      const pm = c.part && parts[String(c.part).toUpperCase()];
      m.userData = { kind: 'component', ...c, category: kind, depth: dep, model: pm ? 'loading' : 'no 3D model (box placeholder)' };
      root.add(m);
      pickables.push(m);
      if (pm) placeModel(m, pm, ox + c.x + c.w / 2, oz + c.y + c.h / 2, yf - 7.5);
    }
  }

  /** Real maker model at real size: centred on the footprint, its back against the rail front.
   *  The placeholder box stays as an invisible pick target. */
  function placeModel(proxy, pm, cx, cz, yRail) {
    loadGltf(pm.model).then((scene) => {
      const obj = scene.clone(true);
      obj.applyMatrix4(modelRotation(pm.front, pm.up));
      obj.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(obj);
      obj.position.add(new THREE.Vector3(cx - (bb.min.x + bb.max.x) / 2, yRail - bb.max.y, cz - (bb.min.z + bb.max.z) / 2));
      root.add(obj);
      for (const mt of [].concat(proxy.material)) { mt.transparent = true; mt.opacity = 0; mt.depthWrite = false; }
      const s = bb.getSize(new THREE.Vector3());
      proxy.userData.model = `${pm.model.split('/').pop()} (${s.x.toFixed(0)} × ${s.z.toFixed(0)} × ${s.y.toFixed(0)} mm)`;
      if (Math.abs(s.x - proxy.userData.w) > 5 || Math.abs(s.z - proxy.userData.h) > 5)
        proxy.userData.note = `model size ${s.x.toFixed(0)}×${s.z.toFixed(0)} differs from layout footprint ${proxy.userData.w}×${proxy.userData.h}`;
    }).catch((e) => { proxy.userData.model = 'model failed: ' + e.message; });
  }

  const bounds = new THREE.Box3().setFromObject(root);
  const wireGroup = new THREE.Group();
  root.add(wireGroup);
  const compDepth = new Map(pickables.filter((o) => o.userData.kind === 'component').map((o) => [o.userData.tag.toUpperCase(), o.userData.depth]));

  /** Draw routed wires (plate coords) as tubes. Colour by potential, mark tubes at both ends. */
  function setWires(wires, { labels: showLabels = true } = {}) {
    for (const o of [...wireGroup.children]) { wireGroup.remove(o); o.geometry?.dispose(); }
    if (!plateFrame) return [];
    const { ox, oz, yf } = plateFrame;
    const made = [];
    wires.forEach((w, k) => {
      const r = w.route;
      if (!r?.ok || r.points.length < 2) return;
      // spread wires inside the duct so a bundle reads as a bundle, not one line
      const jd = ((k * 7) % 9 - 4) * 4.5, jp = ((k * 5) % 7 - 3) * 3.5;
      const duct = yf - 26 + jd;
      const P3 = (p, y, j = 0) => new THREE.Vector3(ox + p[0], y, oz + p[1] + j);
      const dA = compDepth.get(w.from.tag.toUpperCase()) ?? 80, dB = compDepth.get(w.to.tag.toUpperCase()) ?? 80;
      const pts = [P3(r.points[0], yf - 7.5 - dA * 0.75)];
      for (let i = 0; i < r.points.length; i++) {
        const inner = i > 0 && i < r.points.length - 1;
        pts.push(P3(r.points[i], duct, inner ? jp : 0));
      }
      pts.push(P3(r.points.at(-1), yf - 7.5 - dB * 0.75));
      const path = new THREE.CurvePath();
      for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(pts[i - 1]) > 0.01) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
      const no = String(w.no || '');
      const color = /^P\d/.test(no) ? 0x1d4ed8 : /^Z\d/.test(no) ? 0xdbe7fb : 0x0ea5e9;
      const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, pts.length * 6), 1.4, 6, false), mat(color, { roughness: 0.5 }));
      tube.userData = { kind: 'wire', wire: w, tag: no, part: `${w.from.tag}${w.from.pin ? ':' + w.from.pin : ''} → ${w.to.tag}${w.to.pin ? ':' + w.to.pin : ''}` };
      wireGroup.add(tube);
      made.push(tube);
      if (showLabels && no) for (const end of [pts[0], pts.at(-1)]) {
        const s = sprite(no, 5, '#1a4d8f');
        s.position.copy(end).add(new THREE.Vector3(0, -4, 0));
        wireGroup.add(s);
      }
    });
    return made;
  }

  /** lids off and duct bodies see-through, so the wiring inside is visible */
  function openDucts(open) {
    for (const l of lids) l.visible = !open;
    ductMat.transparent = open; ductMat.opacity = open ? 0.28 : 1; ductMat.depthWrite = !open; ductMat.needsUpdate = true;
  }

  return {
    root, door, hinge, pickables, labelObjs, setWires, openDucts,
    bodyMaterial: bodyMat,
    doorMax: hinge === 'none' ? 0 : box.door?.open_angle ?? 120,
    setDoor(deg) {
      const a = THREE.MathUtils.degToRad(deg);
      door.rotation.set(0, 0, 0);
      if (hinge === 'right') door.rotation.z = a;
      else if (hinge === 'left') door.rotation.z = -a;
      else if (hinge === 'top') door.rotation.x = -a;
    },
    bounds,
  };
}
