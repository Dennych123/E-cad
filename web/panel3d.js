// 3D panel mode: enclosure, door, plate, components, drawing-derived wires. Mounted into the app shell.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildBox } from '/web/view3d.js';
import { esc } from '/web/ui.js';
import { icon } from '/web/icons.js';

export function createPanel3D({ stage, inspector, api, project, onShowInDrawings, toast }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 5, 50000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-1500, -2500, 3000);
  scene.add(sun);
  let grid = null, active = false;
  const theme = () => { scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#0b0d0f'); };
  theme();

  let model = null, box = null, cabinet = null, selected = null, wires = [], wireMeshes = [], partsCat = {};
  let doorDeg = 0, doorTarget = 0, xray = false, labelsOn = true, wiresOn = true, boxes = [], cabs = [];

  function setGrid(size) {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); }
    const step = 10 ** Math.floor(Math.log10(size / 10)), n = Math.ceil(size / step);
    grid = new THREE.GridHelper(n * step, n, 0x5d646c, 0x33393f);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);

  function fit() {
    if (!model) return;
    const b = model.bounds, c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z);
    controls.target.copy(c);
    camera.position.set(c.x + r * 0.9, c.y - r * 1.9, c.z + r * 0.7);
    camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
    setGrid(r * 3); grid.position.set(c.x, c.y, 0);
  }
  function rebuild(refit) {
    if (model) { scene.remove(model.root); model.root.traverse((o) => o.geometry?.dispose()); }
    selected = null;
    model = buildBox(box, cabinet, { labels: labelsOn, parts: partsCat });
    scene.add(model.root);
    doorDeg = Math.min(doorDeg, model.doorMax); doorTarget = Math.min(doorTarget, model.doorMax);
    model.setDoor(doorDeg);
    applyXray(); drawWires();
    if (refit) fit();
    render();
  }
  function applyXray() { const m = model.bodyMaterial; m.transparent = xray; m.opacity = xray ? 0.18 : 1; m.depthWrite = !xray; m.needsUpdate = true; }
  function drawWires() {
    model.pickables = model.pickables.filter((o) => o.userData.kind !== 'wire');
    wireMeshes = wiresOn ? model.setWires(wires, { labels: labelsOn }) : model.setWires([]);
    model.pickables.push(...wireMeshes);
    model.openDucts(wiresOn && wires.length > 0);
  }

  const kv = (pairs) => `<div class="kv">${pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('')}</div>`;
  function render() {
    if (!box) { inspector.innerHTML = '<div class="empty">Pick a box.</div>'; return; }
    const e = box.enclosure, comps = cabinet?.components || [];
    const total = wires.reduce((s, w) => s + (w.route?.length || 0), 0);
    const u = selected?.userData;
    let selHtml = '<div class="faint">Click a part or a wire in the view.</div>';
    if (u?.kind === 'wire') {
      const w = u.wire;
      selHtml = kv([['Wire no.', `<span class="mono">${esc(w.no ?? '—')}</span>`], ['From', `<span class="mono">${esc(w.from.tag)}${w.from.pin ? ':' + esc(w.from.pin) : ''}</span> <span class="faint">${esc(w.from.why)}</span>`],
        ['To', `<span class="mono">${esc(w.to.tag)}${w.to.pin ? ':' + esc(w.to.pin) : ''}</span> <span class="faint">${esc(w.to.why)}</span>`], ['Length', w.route?.ok ? `${w.route.length} mm <span class="faint">incl. slack</span>` : 'not routed'],
        ['Drawing', `${esc(w.line || '')}`]]) + `<div style="margin-top:10px"><button class="btn solid" data-open="${esc(w.page)}" data-line="${esc(w.line || '')}">${icon('sheet')}Open in drawing</button></div>`;
    } else if (u) {
      const n = wires.filter((w) => w.from.tag === u.tag || w.to.tag === u.tag).length;
      selHtml = kv([['Tag', `<span class="mono">${esc(u.tag)}</span>`], ['Part', `<span class="mono">${esc(u.part || '—')}</span>`], ['Kind', esc(u.category || u.kind)], ['Rail', esc(u.rail)],
        ['Position', u.x !== undefined ? `<span class="mono">${u.x}, ${u.y}</span> <span class="faint">${u.w}×${u.h} mm</span>` : ''], ['3D model', esc(u.model)], ['Wires', n || '']])
        + (u.tag ? `<div style="margin-top:10px"><button class="btn solid" data-key="${esc(u.tag)}">${icon('search')}Show ${esc(u.tag)} in drawings</button></div>` : '');
    }
    inspector.innerHTML = `
      <div class="section"><h4>Door</h4><div class="range"><input type="range" min="0" max="${model?.doorMax || 0}" value="${doorDeg}" ${model?.doorMax ? '' : 'disabled'} data-door aria-label="Door angle"><span class="mono" data-doorval>${Math.round(doorDeg)}°</span></div></div>
      <div class="section"><h4>Selection</h4>${selHtml}</div>
      <div class="section"><h4>Enclosure</h4>${kv([['Template', `<span class="mono">${esc(box.id)}</span>${box.chain.length ? ' <span class="faint">← ' + esc(box.chain.join(' ← ')) + '</span>' : ''}`], ['Size', `<span class="mono">${e.width} × ${e.height} × ${e.depth}</span>${e.stand_height ? ` <span class="faint">+${e.stand_height} stand</span>` : ''}`], ['Material', esc(`${e.material}, ${e.paint}`)], ['Plate', box.plate ? `<span class="mono">${box.plate.width} × ${box.plate.height}</span>` : ''], ['Ducts / rails', box.plate ? `${box.ducts.length} / ${box.rails.length}` : '']])}</div>
      <div class="section"><h4>Wires <span class="count">${wires.length || ''}</span></h4>${wires.length ? `<div class="faint" style="margin-bottom:6px">From the drawings' nets · ${(total / 1000).toFixed(1)} m routed</div>` + wires.map((w, i) => `<div class="occ" data-w="${i}" ${u?.wire === w ? 'aria-current="true"' : ''}><span class="ln">${esc(w.no ?? '')}</span><span class="wh">${esc(w.from.tag)} → ${esc(w.to.tag)}${w.to.pin ? ':' + esc(w.to.pin) : ''}</span><span class="rl">${w.route?.ok ? w.route.length + ' mm' : '—'}</span></div>`).join('') : '<div class="faint">No drawing connections for this cabinet.</div>'}</div>
      <div class="section"><h4>Components <span class="count">${comps.length || ''}</span></h4>${comps.map((c, i) => `<div class="occ" data-c="${i}" ${u?.tag === c.tag && u.kind === 'component' ? 'aria-current="true"' : ''}><span class="ln">${esc(c.tag)}</span><span class="wh">${esc(c.part || '')}</span></div>`).join('') || '<div class="faint">No cabinet.</div>'}</div>
      ${[...(box.review || []), ...(cabinet?.review || [])].length ? `<div class="section"><h4>Review</h4>${[...(box.review || []), ...(cabinet?.review || [])].map((r) => `<div style="color:var(--warn);font-size:12px;margin-bottom:6px">${esc(r)}</div>`).join('')}</div>` : ''}`;
  }
  // the inspector element is shared with the drawings workspace: only react while 3D is active
  inspector.addEventListener('input', (e) => { if (active && e.target.matches('[data-door]')) { doorTarget = doorDeg = Number(e.target.value); model.setDoor(doorDeg); inspector.querySelector('[data-doorval]').textContent = Math.round(doorDeg) + '°'; } });
  inspector.addEventListener('click', (e) => {
    if (!active) return;
    const w = e.target.closest('[data-w]'); if (w) return select(wireMeshes.find((m) => m.userData.wire === wires[Number(w.dataset.w)]) || null);
    const c = e.target.closest('[data-c]'); if (c) return select(model.pickables.find((o) => o.userData.kind === 'component' && o.userData.tag === cabinet.components[Number(c.dataset.c)].tag) || null);
    const k = e.target.closest('[data-key]'); if (k) return onShowInDrawings({ key: k.dataset.key });
    const o = e.target.closest('[data-open]'); if (o) return onShowInDrawings({ page: o.dataset.open, line: o.dataset.line });
  });

  const hl = { obj: null };
  function select(obj) {
    if (hl.obj) for (const m of [].concat(hl.obj.material)) m.emissive?.setHex(0);
    selected = obj; hl.obj = obj;
    if (obj) for (const m of [].concat(obj.material)) m.emissive?.setHex(0x663300);
    render();
  }
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !model) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    select(ray.intersectObjects(model.pickables, false)[0]?.object || null);
  });

  async function load(boxId, cabId, refit = true) {
    try {
      let wdata;
      [box, cabinet, wdata] = await Promise.all([
        api(`/api/box/${encodeURIComponent(boxId)}?project=${encodeURIComponent(project())}`),
        cabId ? api(`/api/cabinet/${encodeURIComponent(project())}/${encodeURIComponent(cabId)}`) : null,
        cabId ? api(`/api/wires/${encodeURIComponent(project())}/${encodeURIComponent(cabId)}`).catch(() => null) : null,
      ]);
      wires = wdata?.wires || [];
      rebuild(refit);
    } catch (e) { toast(e.message, { kind: 'err' }); }
  }

  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!active) return;
    if (model && doorDeg !== doorTarget) {
      const step = 140 * dt;
      doorDeg = Math.abs(doorTarget - doorDeg) <= step ? doorTarget : doorDeg + Math.sign(doorTarget - doorDeg) * step;
      model.setDoor(doorDeg);
      const r = inspector.querySelector('[data-door]'); if (r) { r.value = doorDeg; inspector.querySelector('[data-doorval]').textContent = Math.round(doorDeg) + '°'; }
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    async activate() {
      active = true; theme(); resize();
      if (!boxes.length) {
        [boxes, cabs, partsCat] = await Promise.all([api('/api/boxes?project=' + encodeURIComponent(project())), api('/api/cabinets/' + encodeURIComponent(project())), api('/api/parts').catch(() => ({}))]);
      }
      if (!model) { const b = boxes.find((x) => !x.abstract && !x.error && cabs.includes(x.id)) || boxes.find((x) => !x.abstract && !x.error); if (b) await load(b.id, cabs.includes(b.id) ? b.id : ''); }
      else render();
    },
    deactivate() { active = false; },
    get boxes() { return boxes.filter((b) => !b.abstract && !b.error); }, get cabinets() { return cabs; },
    get boxId() { return box?.id; }, get cabinetId() { return cabinet ? cabs.find((c) => c === box?.id) ?? '' : ''; },
    load, fit,
    toggleDoor() { if (model) doorTarget = doorTarget > 0 ? 0 : model.doorMax; },
    toggleXray() { xray = !xray; if (model) applyXray(); return xray; },
    toggleLabels() { labelsOn = !labelsOn; if (box) rebuild(false); return labelsOn; },
    toggleWires() { wiresOn = !wiresOn; if (model) drawWires(); return wiresOn; },
    selectTag(tag) { if (model) select(model.pickables.find((o) => o.userData.kind === 'component' && o.userData.tag === tag) || null); doorTarget = model?.doorMax || 0; },
    reset() { boxes = []; cabs = []; model && scene.remove(model.root); model = null; box = null; },
    get state() { return { xray, labelsOn, wiresOn, door: doorTarget > 0 }; },
    debug: { get model() { return model; }, camera },
  };
}
