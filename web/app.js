// App shell: Drawings (live Visio sheets + cross-reference) and 3D panel, linked both ways.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildBox } from '/web/view3d.js';
import { createSheetView } from '/web/sheets.js';

const $ = (id) => document.getElementById(id);
const api = async (p) => { const r = await fetch(p); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: (k, d) => { try { return localStorage.getItem('ecad.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('ecad.' + k, v); } catch { /* private mode */ } } };
const project = () => $('project').value;
const rows = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');

// =========================================================================== mode
let mode = '2d';
function setMode(m) {
  mode = m;
  $('tab2d').classList.toggle('on', m === '2d'); $('tab3d').classList.toggle('on', m === '3d');
  $('ctl2d').hidden = m !== '2d'; $('ctl3d').hidden = m !== '3d';
  $('tree').hidden = m !== '2d'; $('sheet').hidden = m !== '2d'; $('view').hidden = m !== '3d';
  for (const id of ['secX']) $(id).hidden = m !== '2d';
  $('secNet').hidden = m !== '2d' || !$('net').innerHTML;
  for (const id of ['sec3d', 'secBox', 'secSel', 'secWires', 'secParts', 'secRev']) $(id).hidden = m !== '3d';
  store.set('mode', m);
  if (m === '3d') { resize(); if (!model) loadBox(true); }
}
$('tab2d').onclick = () => setMode('2d');
$('tab3d').onclick = () => setMode('3d');

// =========================================================================== drawings
const sheet = createSheetView($('sheet'), { api, project, onKey: (k, ctx) => showXref(k, ctx), onNet: showNet });
let drawings = [];

async function loadTree() {
  drawings = await api('/api/sheets/' + encodeURIComponent(project()));
  $('tree').innerHTML = drawings.map((d) => `<div class="dr">${esc(d.title)}</div>`
    + d.pages.map((p) => `<a data-p="${esc(p.id)}">${esc(p.name)}</a>`).join('')).join('')
    || '<div class="dr">no imported drawings - run import-visio</div>';
}
$('tree').onclick = (e) => { const a = e.target.closest('a[data-p]'); if (a) openSheet(a.dataset.p); };

async function openSheet(id) {
  await sheet.load(id);
  document.querySelectorAll('#tree a').forEach((a) => a.classList.toggle('cur', a.dataset.p === id));
  store.set('sheet', id);
}
$('fit2d').onclick = () => sheet.fit();

const pageName = (pid) => {
  for (const d of drawings) for (const p of d.pages) if (p.id === pid) return [d.title, p.name];
  return [pid, ''];
};

let xrefData = null;
async function showXref(key, ctx) {
  if (!key) { $('xref').innerHTML = '<span class="muted">nothing selected</span>'; return; }
  if (/^L\d{3,6}$/.test(key) && ctx && !ctx.text?.row) {
    const x = await api(`/api/xref/${encodeURIComponent(project())}?key=${encodeURIComponent(key)}`);
    if (x.line) { await sheet.gotoLine(x.line); markTree(x.line.page); }
  }
  const x = xrefData = await api(`/api/xref/${encodeURIComponent(project())}?key=${encodeURIComponent(key)}`);
  const occ = x.occurrences;
  const roles = [...new Set(occ.map((o) => o.role).filter(Boolean))];
  let html = `<div class="key">${esc(key)}</div><div class="muted">${occ.length} place(s) on ${new Set(occ.map((o) => o.page)).size} sheet(s)${roles.length ? ' · ' + esc(roles.join(', ')) : ''}</div>`;
  if (x.line) html += `<div style="margin:6px 0"><span class="pill" data-line="1">go to line ${esc(key)}</span></div>`;
  html += '<table class="click" id="occ">' + occ.map((o, i) => {
    const [dr, pn] = pageName(o.page);
    return `<tr data-i="${i}"><td>${esc(o.line || (o.row ? 'row' : '—'))}</td><td>${esc(dr)} · ${esc(pn)}${o.role ? ` <span class="muted">(${esc(o.role)})</span>` : ''}</td></tr>`;
  }).join('') + '</table>';
  if (x.cabinet.length) html += '<h3 style="margin-top:10px">In panel</h3>' + x.cabinet.map((c, i) =>
    `<span class="pill" data-cab="${i}">3D: ${esc(c.cabinet)} · ${esc(c.tag)}${c.part ? ' · ' + esc(c.part) : ''}</span>`).join('');
  $('xref').innerHTML = html;
  const cur = ctx?.text ? occ.findIndex((o) => o.page === ctx.page && o.id === ctx.text.id) : -1;
  if (cur >= 0) $('occ').rows[cur].classList.add('sel');
  if (!ctx) goOcc(0);
}
async function goOcc(i) {
  const o = xrefData.occurrences[i];
  if (!o) return;
  await sheet.focus(o.page, o.id, xrefData.key);
  markTree(o.page);
  [...$('occ').rows].forEach((r, k) => r.classList.toggle('sel', k === i));
}
function markTree(pid) { document.querySelectorAll('#tree a').forEach((a) => a.classList.toggle('cur', a.dataset.p === pid)); }
$('xref').onclick = async (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (tr) return goOcc(Number(tr.dataset.i));
  if (e.target.closest('[data-line]')) { await sheet.gotoLine(xrefData.line); return markTree(xrefData.line.page); }
  const cab = e.target.closest('[data-cab]');
  if (cab) {
    const c = xrefData.cabinet[Number(cab.dataset.cab)];
    await show3D(c.cabinet, c.tag);
  }
};

function showNet(n) {
  $('secNet').hidden = false;
  $('net').innerHTML = `<div>${n.segments} wire segment(s) connected</div>`
    + (n.labels.length ? '<div style="margin-top:4px">' + n.labels.map((k) => `<span class="pill" data-k="${esc(k)}">${esc(k)}</span>`).join('') + '</div>'
      : '<div class="muted">no label on this net</div>');
}
$('net').onclick = (e) => { const p = e.target.closest('[data-k]'); if (p) showXref(p.dataset.k); };

// search
let searchT = null;
$('q').oninput = () => {
  clearTimeout(searchT);
  searchT = setTimeout(async () => {
    const q = $('q').value.trim();
    if (q.length < 2) { $('results').hidden = true; return; }
    const res = await api(`/api/search/${encodeURIComponent(project())}?q=${encodeURIComponent(q)}`);
    const r = $('q').getBoundingClientRect();
    Object.assign($('results').style, { left: r.left + 'px', top: r.bottom + 2 + 'px' });
    $('results').innerHTML = res.map((x) => `<div data-k="${esc(x.key)}"><b>${esc(x.key)}</b> <span class="muted">${x.n}×</span></div>`).join('') || '<div class="muted">no match</div>';
    $('results').hidden = false;
  }, 120);
};
$('q').onkeydown = (e) => { if (e.key === 'Enter') { const f = $('results').querySelector('[data-k]'); if (f) f.click(); } if (e.key === 'Escape') $('results').hidden = true; };
$('results').onclick = (e) => { const d = e.target.closest('[data-k]'); if (d) { $('results').hidden = true; $('q').value = d.dataset.k; showXref(d.dataset.k); } };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#results,#q')) $('results').hidden = true; });

// =========================================================================== 3D
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 5, 50000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-1500, -2500, 3000);
scene.add(sun);
let grid = null;
function setGrid(size) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); }
  const step = 10 ** Math.floor(Math.log10(size / 10));
  const n = Math.ceil(size / step);
  grid = new THREE.GridHelper(n * step, n, 0x8f969d, 0xb9bec3);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
}
const applyTheme = () => { scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--view').trim() || '#dfe3e7'); };
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

let model = null, box = null, cabinet = null, selected = null, wires = [], wireMeshes = [], partsCat = {};
let doorDeg = 0, doorTarget = 0, xray = false, labelsOn = true, wiresOn = true;

function fit() {
  if (!model) return;
  const b = model.bounds, c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z);
  controls.target.copy(c);
  camera.position.set(c.x + r * 0.9, c.y - r * 1.9, c.z + r * 0.7);
  camera.near = r / 200; camera.far = r * 50; camera.updateProjectionMatrix();
  setGrid(r * 3);
  grid.position.set(c.x, c.y, 0);
}

function rebuild(refit) {
  if (model) { scene.remove(model.root); model.root.traverse((o) => { o.geometry?.dispose(); }); }
  selected = null;
  model = buildBox(box, cabinet, { labels: labelsOn, parts: partsCat });
  scene.add(model.root);
  $('door').max = model.doorMax;
  $('door').disabled = !model.doorMax;
  $('doorBtn').disabled = !model.doorMax;
  doorDeg = Math.min(doorDeg, model.doorMax); doorTarget = Math.min(doorTarget, model.doorMax);
  model.setDoor(doorDeg);
  applyXray();
  drawWires();
  if (refit) fit();
  panels();
}

function drawWires() {
  if (!model) return;
  model.pickables = model.pickables.filter((o) => o.userData.kind !== 'wire');
  wireMeshes = wiresOn ? model.setWires(wires, { labels: labelsOn }) : model.setWires([]);
  model.openDucts(wiresOn && wires.length > 0);
  model.pickables.push(...wireMeshes);
  $('wiresBtn').classList.toggle('on', wiresOn);
}

function wirePanel(data) {
  $('wcount').textContent = wires.length ? `(${wires.length})` : '';
  const total = wires.reduce((s, w) => s + (w.route?.length || 0), 0);
  $('wnote').textContent = data ? `from the drawings' nets · ${(total / 1000).toFixed(1)} m routed · ${data.unresolved} net(s) end outside this panel` : '';
  $('wires').innerHTML = wires.map((w, i) => `<tr data-w="${i}"><td>${esc(w.no ?? '')}</td><td>${esc(w.from.tag)}${w.from.pin ? ':' + esc(w.from.pin) : ''} → ${esc(w.to.tag)}${w.to.pin ? ':' + esc(w.to.pin) : ''}</td><td>${w.route?.ok ? w.route.length + ' mm' : '—'}</td></tr>`).join('')
    || '<tr><td class="muted">no wires (cabinet has no drawing connections)</td></tr>';
}
$('wires').onclick = (e) => {
  const tr = e.target.closest('tr[data-w]');
  if (tr) select(wireMeshes.find((m) => m.userData.wire === wires[Number(tr.dataset.w)]) || null);
};

function applyXray() {
  if (!model) return;
  const m = model.bodyMaterial;
  m.transparent = xray; m.opacity = xray ? 0.18 : 1; m.depthWrite = !xray; m.needsUpdate = true;
  $('xray').classList.toggle('on', xray);
}

function panels() {
  const e = box.enclosure;
  $('info').innerHTML = rows([
    ['id', box.id + (box.chain.length ? '  ←  ' + box.chain.join(' ← ') : '')], ['name', box.name],
    ['size', `${e.width} × ${e.height} × ${e.depth}` + (e.stand_height ? ` + stand ${e.stand_height}` : '')],
    ['material', `${e.material} / ${e.paint}`], ['door', `${box.door.hinge}, max ${model.doorMax}°`],
    ['plate', box.plate && `${box.plate.width} × ${box.plate.height} t${box.plate.thickness}`],
    ['ducts / rails', box.plate && `${box.ducts.length} / ${box.rails.length}`],
  ]);
  const comps = cabinet?.components || [];
  $('count').textContent = comps.length ? `(${comps.length})` : '';
  $('parts').innerHTML = comps.map((c, i) => `<tr data-i="${i}"><td>${esc(c.tag)}</td><td>${esc(c.part || '')}</td><td>${esc(c.rail || '')}</td></tr>`).join('')
    || '<tr><td>no cabinet selected</td></tr>';
  const rev = [...(box.review || []), ...(cabinet?.review || [])];
  $('review').innerHTML = rev.map((r) => `<div class="rev">⚠ ${esc(r)}</div>`).join('') || '<span class="muted">none</span>';
  showSel();
}

function showSel() {
  if (!selected) { $('sel').innerHTML = '<tr><td>click a part in 3D or in the list</td></tr>'; $('selLinks').innerHTML = ''; return; }
  const u = selected.userData;
  if (u.kind === 'wire') {
    const w = u.wire;
    $('sel').innerHTML = rows([['wire no.', w.no], ['from', `${w.from.tag}${w.from.pin ? ':' + w.from.pin : ''}  (${w.from.why})`],
      ['to', `${w.to.tag}${w.to.pin ? ':' + w.to.pin : ''}  (${w.to.why})`], ['length', w.route?.ok ? w.route.length + ' mm incl. slack' : 'not routed'],
      ['drawing', `${pageName(w.page).join(' · ')}  ${w.line || ''}`], ['net labels', w.keys.join(', ')]]);
    $('selLinks').innerHTML = `<span class="pill" data-page="${esc(w.page)}" data-line="${esc(w.line || '')}">open in drawing</span>`;
  } else {
    $('sel').innerHTML = rows([['tag', u.tag], ['part', u.part], ['kind', u.category || u.kind], ['rail', u.rail],
      ['module', u.module], ['position', u.x !== undefined ? `x ${u.x}  y ${u.y}  (${u.w} × ${u.h})` : ''], ['3D model', u.model], ['note', u.note]]);
    const n = wires.filter((w) => w.from.tag === u.tag || w.to.tag === u.tag).length;
    $('selLinks').innerHTML = u.tag ? `<span class="pill" data-k="${esc(u.tag)}">show ${esc(u.tag)} in drawings</span>${n ? `<span class="muted"> · ${n} wire(s)</span>` : ''}` : '';
  }
  document.querySelectorAll('#wires tr').forEach((tr) => tr.classList.toggle('sel', u.kind === 'wire' && wires[tr.dataset.w] === u.wire));
  document.querySelectorAll('#parts tr').forEach((tr) => tr.classList.toggle('sel', cabinet?.components[tr.dataset.i]?.tag === u.tag && u.kind === 'component'));
}
$('selLinks').onclick = async (e) => {
  const p = e.target.closest('[data-k]');
  if (p) { setMode('2d'); return showXref(p.dataset.k.toUpperCase().replace(/\s+/g, '')); }
  const pg = e.target.closest('[data-page]');
  if (pg) {
    setMode('2d');
    const line = pg.dataset.line && (await api(`/api/xref/${encodeURIComponent(project())}?key=${encodeURIComponent(pg.dataset.line)}`)).line;
    if (line && line.page === pg.dataset.page) await sheet.gotoLine(line); else await openSheet(pg.dataset.page);
    markTree(pg.dataset.page);
  }
};

const highlight = { obj: null };
function select(obj) {
  if (highlight.obj) for (const m of [].concat(highlight.obj.material)) m.emissive?.setHex(0);
  selected = obj;
  highlight.obj = obj;
  if (obj) for (const m of [].concat(obj.material)) m.emissive?.setHex(0x663300);
  showSel();
}
$('parts').onclick = (ev) => {
  const tr = ev.target.closest('tr[data-i]');
  if (!tr) return;
  const tag = cabinet.components[tr.dataset.i].tag;
  select(model.pickables.find((o) => o.userData.kind === 'component' && o.userData.tag === tag) || null);
};

const ray = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(model.pickables, false)[0];
  select(hit ? hit.object : null);
});

const toggleDoor = () => { doorTarget = doorTarget > 0 ? 0 : model.doorMax; };
$('doorBtn').onclick = toggleDoor;
$('door').oninput = (e) => { doorTarget = doorDeg = Number(e.target.value); model.setDoor(doorDeg); };
$('xray').onclick = () => { xray = !xray; applyXray(); };
$('labels').onclick = () => { labelsOn = !labelsOn; $('labels').classList.toggle('on', labelsOn); rebuild(false); };
$('fit').onclick = fit;
$('wiresBtn').onclick = () => { wiresOn = !wiresOn; drawWires(); };
$('side').onclick = () => { $('aside').hidden = !$('aside').hidden; $('side').textContent = $('aside').hidden ? 'Show panel' : 'Hide panel'; };
addEventListener('keydown', (e) => {
  if (e.target.closest('input,select')) return;
  const k = e.key.toLowerCase();
  if (e.key === '/') { e.preventDefault(); setMode('2d'); $('q').focus(); return; }
  if (k === 'h') return $('side').click();
  if (mode !== '3d') return;
  if (k === 'o') toggleDoor(); else if (k === 'x') $('xray').click(); else if (k === 'l') $('labels').click();
  else if (k === 'w') $('wiresBtn').click();
  else if (e.key === 'Home') fit();
});

async function loadBox(refit = true) {
  const id = $('box').value, cab = $('cabinet').value;
  if (!id) return;
  store.set('box', id); store.set('cabinet.' + id, cab);
  try {
    let wdata;
    [box, cabinet, wdata] = await Promise.all([
      api(`/api/box/${encodeURIComponent(id)}?project=${encodeURIComponent(project())}`),
      cab ? api(`/api/cabinet/${encodeURIComponent(project())}/${encodeURIComponent(cab)}`) : null,
      cab ? api(`/api/wires/${encodeURIComponent(project())}/${encodeURIComponent(cab)}`).catch(() => null) : null,
    ]);
    wires = wdata?.wires || [];
    $('err').textContent = '';
    rebuild(refit);
    wirePanel(wdata);
  } catch (e) { $('err').textContent = e.message; }
}

function syncCabinet() {
  const opts = [...$('cabinet').options].map((o) => o.value);
  const b = $('box').value, remembered = store.get('cabinet.' + b, null);
  $('cabinet').value = remembered !== null && opts.includes(remembered) ? remembered : opts.includes(b) ? b : '';
}

async function show3D(cab, tag) {
  if ($('box').value !== cab && [...$('box').options].some((o) => o.value === cab)) { $('box').value = cab; }
  $('cabinet').value = cab;
  setMode('3d');
  await loadBox(true);
  select(model.pickables.find((o) => o.userData.kind === 'component' && o.userData.tag === tag) || null);
  doorTarget = model.doorMax;             // open the door so the part is visible
}

async function loadProject() {
  store.set('project', project());
  const [boxes, cabs] = await Promise.all([api('/api/boxes?project=' + encodeURIComponent(project())), api('/api/cabinets/' + encodeURIComponent(project()))]);
  const want = store.get('box', '1CE');
  $('box').innerHTML = boxes.filter((b) => !b.abstract && !b.error)
    .map((b) => `<option value="${esc(b.id)}" ${b.id === want ? 'selected' : ''}>${esc(b.id)}${b.local ? ' (project)' : ''} — ${esc(b.name)}</option>`).join('');
  $('cabinet').innerHTML = '<option value="">(none)</option>' + cabs.map((c) => `<option>${esc(c)}</option>`).join('');
  syncCabinet();
  model = null;
  await loadTree();
  if (mode === '3d') await loadBox(true);
}

$('project').onchange = loadProject;
$('box').onchange = () => { syncCabinet(); loadBox(true); };
$('cabinet').onchange = () => loadBox(false);

// URL: ?project=&mode=2d|3d&sheet=<id>&key=CRPB1&box=&cabinet=&door=90&xray=1&panel=0
const qs = new URLSearchParams(location.search);
for (const k of ['project', 'box']) if (qs.has(k)) store.set(k, qs.get(k));
if (qs.has('cabinet')) store.set('cabinet.' + (qs.get('box') || store.get('box', '')), qs.get('cabinet'));

(async () => {
  const projects = await api('/api/projects');
  partsCat = await api('/api/parts').catch(() => ({}));
  const want = store.get('project', projects[0]);
  $('project').innerHTML = projects.map((p) => `<option ${p === want ? 'selected' : ''}>${esc(p)}</option>`).join('');
  await loadProject();
  setMode(qs.get('mode') || store.get('mode', '2d'));
  if (mode === '2d') {
    const first = drawings[0]?.pages[0]?.id;
    const sid = qs.get('sheet') || store.get('sheet', first);
    if (sid) await openSheet(drawings.some((d) => d.pages.some((p) => p.id === sid)) ? sid : first);
    if (qs.has('key')) await showXref(qs.get('key').toUpperCase());
  } else {
    if (!model) await loadBox(true);
    if (qs.has('door')) { doorTarget = doorDeg = Math.min(Number(qs.get('door')), model.doorMax); model.setDoor(doorDeg); }
    if (qs.get('xray') === '1') { xray = true; applyXray(); }
  }
  if (qs.get('panel') === '0') $('side').click();
  document.body.dataset.ready = '1';
})().catch((e) => { $('err').textContent = e.message; });

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (mode !== '3d') return;
  if (model && doorDeg !== doorTarget) {
    const step = 120 * dt;
    doorDeg = Math.abs(doorTarget - doorDeg) <= step ? doorTarget : doorDeg + Math.sign(doorTarget - doorDeg) * step;
    model.setDoor(doorDeg);
  }
  if (model) {
    if (Number($('door').value) !== doorDeg) $('door').value = doorDeg;
    $('doorVal').textContent = Math.round(doorDeg) + '°';
    $('doorBtn').textContent = doorTarget > 0 ? 'Close door' : 'Open door';
  }
  controls.update();
  renderer.render(scene, camera);
});

window.ecadDebug = { get model() { return model; }, camera, sheet, showXref, setMode };
