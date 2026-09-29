"""Self-contained HTML gallery of box templates (preview + params + 'make custom' command)."""
from __future__ import annotations

import json
from html import escape
from pathlib import Path

import yaml

from .loader import list_boxes, load, load_raw
from .render import render_sheet

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Box Templates</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--mut:#5f6b7a;--line:#dde2e8;--acc:#1a4d8f;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#15181c;--card:#1e2227;--fg:#e8ebef;--mut:#9aa5b1;--line:#333a42;--acc:#7fb0ff;--warn:#ffb74d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif}
header{padding:20px 16px 8px;max-width:1300px;margin:auto}h1{margin:0 0 4px;font-size:22px}header p{margin:0;color:var(--mut)}
.bar{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.bar button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.bar button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px;padding:0 16px 32px;max-width:1300px;margin:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.pv{background:#fff;border-bottom:1px solid var(--line);cursor:zoom-in}.pv svg{display:block;width:100%;height:auto}
.body{padding:12px 14px;display:flex;flex-direction:column;gap:8px}.id{font-weight:700;font-size:16px}.nm{color:var(--mut)}
.chain{font-size:12px;color:var(--mut)}.chain b{color:var(--acc)}
.tags span{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 6px;margin:0 4px 4px 0;color:var(--mut)}
table{border-collapse:collapse;font-size:12px;width:100%}td{border-top:1px solid var(--line);padding:3px 4px}td:first-child{color:var(--mut);width:40%}
.rev{font-size:12px;color:var(--warn)}details summary{cursor:pointer;color:var(--acc);font-size:13px}
.mk{display:grid;grid-template-columns:1fr 1fr;gap:6px}.mk input{width:100%;padding:5px 6px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--fg)}
.mk label{font-size:11px;color:var(--mut)}pre{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all}
.cp{align-self:flex-start;border:1px solid var(--acc);color:var(--acc);background:none;border-radius:5px;padding:3px 10px;cursor:pointer}
dialog{width:min(96vw,1400px);max-height:94vh;padding:0;border:0;border-radius:8px}dialog svg{width:100%;height:auto;display:block}
dialog::backdrop{background:#000a}
</style></head><body>
<header><h1>Box templates</h1><p>Pick a base, set overrides, copy the command. Everything is YAML in <code>library/boxes</code> &mdash; templates inherit with <code>extends</code>.</p>
<div class="bar" id="bar"></div></header><main id="grid">__CARDS__</main>
<dialog id="dlg" onclick="this.close()"></dialog>
<script>
const cards=[...document.querySelectorAll('.card')];const tags=new Set();cards.forEach(c=>c.dataset.tags.split(' ').forEach(t=>t&&tags.add(t)));
const bar=document.getElementById('bar');let cur='all';
function mk(t){const b=document.createElement('button');b.textContent=t;b.onclick=()=>{cur=t;[...bar.children].forEach(x=>x.classList.toggle('on',x===b));
cards.forEach(c=>c.style.display=(t==='all'||c.dataset.tags.split(' ').includes(t))?'':'none')};bar.appendChild(b);return b}
mk('all').classList.add('on');[...tags].sort().forEach(mk);
document.querySelectorAll('.pv').forEach(p=>p.onclick=()=>{const d=document.getElementById('dlg');d.innerHTML=p.innerHTML;d.showModal()});
document.querySelectorAll('.mk').forEach(f=>{const upd=()=>{const base=f.dataset.base;const v=n=>f.querySelector('[name='+n+']').value.trim();
let cmd='python -m ecad.cli box new '+(v('id')||'MY-BOX')+' --from '+base;
f.querySelectorAll('input[data-key]').forEach(i=>{if(i.value.trim()!==''&&i.value.trim()!==i.dataset.def)cmd+=' --set '+i.dataset.key+'='+i.value.trim()});
f.nextElementSibling.textContent=cmd};f.oninput=upd;upd()});
document.querySelectorAll('.cp').forEach(b=>b.onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(b.previousElementSibling.textContent);b.textContent='copied';setTimeout(()=>b.textContent='copy',1200)});
</script></body></html>"""


def _editable(raw: dict, t) -> list[tuple[str, object]]:
    keys = [(f"params.{k}", v) for k, v in (raw.get("params") or {}).items()]
    e = t.enclosure
    keys += [("enclosure.width", e.width), ("enclosure.height", e.height), ("enclosure.depth", e.depth)]
    return keys


def build_gallery(project: Path | None = None) -> str:
    cards = []
    for b in list_boxes(project):
        try:
            t = load(b["id"], project)
            raw = load_raw(b["id"], project)
        except Exception as ex:  # show broken templates instead of hiding them
            cards.append(f'<div class="card" data-tags="error"><div class="body"><div class="id">{escape(b["id"])}</div>'
                         f'<div class="rev">error: {escape(str(ex))}</div></div></div>')
            continue
        cab = None
        if project:
            cf = Path(project) / "cabinets" / f"{b['id']}.yaml"
            if cf.exists():
                cab = yaml.safe_load(cf.read_text(encoding="utf-8"))
        svg = render_sheet(t, cab)
        chain, cur = [], raw.get("extends")
        while cur:
            chain.append(cur)
            cur = load_raw(cur, project).get("extends")
        e = t.enclosure
        rows = [("kind", e.kind), ("W x H x D", f"{e.width:g} x {e.height:g} x {e.depth:g}"),
                ("material", f"{e.material} / {e.paint}")]
        if t.plate:
            rows.append(("plate", f"{t.plate.width:g} x {t.plate.height:g} t{t.plate.thickness:g}"))
        if t.rails:
            rows.append(("rails / ducts", f"{len(t.rails)} / {len(t.ducts)}"))
        n_holes = sum(len(v) for v in t.faces.values())
        if n_holes:
            rows.append(("cutouts", ", ".join(f"{k}: {len(v)}" for k, v in t.faces.items())))
        if cab:
            rows.append(("components (project)", str(len(cab.get("components", [])))))
        tags = list(dict.fromkeys((t.tags or []) + (["abstract"] if b["abstract"] else [])))
        fields = "".join(
            f'<div><label>{escape(k)}</label><input data-key="{escape(k)}" data-def="{escape(str(v))}" value="{escape(str(v))}"></div>'
            for k, v in _editable(raw, t))
        review = "".join(f'<div class="rev">&#9888; {escape(r)}</div>' for r in t.review)
        cards.append(
            f'<div class="card" data-tags="{escape(" ".join(tags))}">'
            f'<div class="pv" title="click to enlarge">{svg}</div><div class="body">'
            f'<div><div class="id">{escape(b["id"])}</div><div class="nm">{escape(t.name)}</div></div>'
            f'<div class="chain">{" &larr; ".join(["<b>" + escape(b["id"]) + "</b>"] + [escape(c) for c in chain])}</div>'
            f'<div class="tags">{"".join(f"<span>{escape(x)}</span>" for x in tags)}</div>'
            f'<table>{"".join(f"<tr><td>{escape(k)}</td><td>{escape(str(v))}</td></tr>" for k, v in rows)}</table>'
            f'{review}<details><summary>Make custom box from {escape(b["id"])}</summary>'
            f'<div class="mk" data-base="{escape(b["id"])}"><div><label>new id</label><input name="id" value="{escape(b["id"])}-B"></div>{fields}</div>'
            f'<pre></pre><button class="cp">copy</button></details></div></div>')
    return PAGE.replace("__CARDS__", "\n".join(cards))
