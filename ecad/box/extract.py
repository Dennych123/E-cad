"""Extract a cabinet (component placement + terminal strip plan) from an imported
Visio panel-layout page (raw JSON from importer.visio_com)."""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import yaml

from .loader import load

DUCT_RX = re.compile(r"^W\d+\s*X\s*H\d+$", re.I)
PART_RX = re.compile(r"[A-Z0-9]+-[A-Z0-9]|^[A-Z]{2,}\d{2,}", re.I)
ENCL_RX = re.compile(r"W(\d+)\s*X\s*H(\d+)\s*X\s*D(\d+)", re.I)


def _lines(text: str) -> list[str]:
    return [ln.strip() for ln in re.split(r"[\r\n  ]+", text) if ln.strip()]


def _join_part(parts: list[str]) -> str:
    out = ""
    for p in parts:
        out += p if (not out or out.endswith("-")) else " " + p
    return out


def parse_label(text: str) -> tuple[str, str | None]:
    """'CR\\nRB\\n1A' -> ('CRRB1A', None); 'CV1\\n\\nS8VK-\\nX12024A-EIP' -> ('CV1', 'S8VK-X12024A-EIP')."""
    ls = _lines(text)
    if not ls:
        return "", None
    if ls[0] == "CR":
        return "CR" + "".join(ls[1:]), None
    if len(ls) == 1:
        return ls[0], (ls[0] if PART_RX.search(ls[0]) and "-" in ls[0] else None)
    return ls[0], _join_part(ls[1:]) or None


def _inside(b, box):
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]


def _overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def extract_cabinet(page_json: Path, box_id: str, project: Path | None = None) -> dict:
    d = json.loads(page_json.read_text(encoding="utf-8"))
    W, H = d["width_mm"], d["height_mm"]
    shapes = [s for s in d["shapes"] if s["depth"] == 0]
    review: list[str] = []

    on_page = [s for s in shapes if s["bbox"][2] > 0 and s["bbox"][3] > 0 and s["bbox"][0] < W and s["bbox"][1] < H]
    offpage = [s for s in shapes if s not in on_page and s["text"]]
    if offpage:
        review.append(f"{len(offpage)} text shapes lie outside the page and were ignored "
                      f"(e.g. {', '.join(repr(s['text'][:12]) for s in offpage[:4])}).")

    ducts = [s for s in on_page if DUCT_RX.match(s["text"].strip())]
    if not ducts:
        raise ValueError("no duct shapes (text like W40XH60) found - is this a layout page?")
    plate = [min(s["bbox"][0] for s in ducts), min(s["bbox"][1] for s in ducts),
             max(s["bbox"][2] for s in ducts), max(s["bbox"][3] for s in ducts)]
    ox, oy = plate[0], plate[1]
    pw, ph = plate[2] - plate[0], plate[3] - plate[1]

    tmpl = load(box_id, project)
    if tmpl.plate and (abs(tmpl.plate.width - pw) > 2 or abs(tmpl.plate.height - ph) > 2):
        review.append(f"measured plate {pw:.1f}x{ph:.1f} differs from template {tmpl.plate.width}x{tmpl.plate.height}.")
    for s in on_page:
        m = ENCL_RX.search(s["text"])
        if m:
            w_, h_, d_ = map(float, m.groups())
            e = tmpl.enclosure
            if (w_, h_, d_) != (e.width, e.height, e.depth):
                review.append(f"drawing text '{s['text'].strip()}' vs template {e.width:g}x{e.height:g}x{e.depth:g}.")

    duct_boxes = [s["bbox"] for s in ducts]
    comps, seen = [], Counter()
    for s in on_page:
        t = s["text"].strip()
        if not t or DUCT_RX.match(t) or len(t) <= 2 or ENCL_RX.search(t) or "PLATE" in t.upper():
            continue
        if not _inside(s["bbox"], plate):
            continue
        tag, part = parse_label(t)
        b = s["bbox"]
        rel = [round(b[0] - ox, 1), round(b[1] - oy, 1), round(b[2] - b[0], 1), round(b[3] - b[1], 1)]
        if any(_overlap(b, db) for db in duct_boxes) and rel[3] < 45:
            review.append(f"'{tag}' ({part}) sits on a duct - label or duct accessory? kept as component.")
        cy = rel[1] + rel[3] / 2
        rail = min(tmpl.rails, key=lambda r: abs(r.y - cy)).id if tmpl.rails else None
        seen[tag] += 1
        comps.append({"tag": tag, "part": part, "x": rel[0], "y": rel[1], "w": rel[2], "h": rel[3], "rail": rail})

    # make tags unique: IN, IN, IN -> IN1, IN2, IN3 (ordered left->right)
    for tag, n in seen.items():
        if n > 1:
            group = sorted((c for c in comps if c["tag"] == tag), key=lambda c: (-c["y"], c["x"]))
            parts = {c["part"] for c in group}
            if tag[-1].isdigit():
                review.append(f"duplicate tag '{tag}' with parts {sorted(p or '-' for p in parts)}; renamed with suffix.")
            for i, c in enumerate(group, 1):
                c["tag"] = f"{tag}_{i}" if tag[-1].isdigit() else f"{tag}{i}"
    comps.sort(key=lambda c: (-c["y"], c["x"]))
    for c in comps:
        if c["part"] is None:
            c.pop("part")

    strips = extract_terminal_strips(on_page, plate)
    # A renamed duplicate whose part matches a terminal-plan strip is that strip (drawing typo).
    tags = {c["tag"] for c in comps}
    for name, st in strips.items():
        if name in tags:
            continue
        for c in comps:
            if "_" in c["tag"] and c.get("part") == st["part"]:
                review.append(f"'{c['tag']}' ({c['part']}) renamed to {name} to match the terminal plan.")
                c["tag"] = name
                break
    return {"box": box_id, "source": d["source"], "page": d["name"], "components": comps,
            "terminal_strips": strips, "review": review}


def extract_terminal_strips(shapes: list[dict], plate) -> dict:
    """Find 'UP'/'DOWN' terminal tables outside the plate: cells to the right of the
    row label, ordered by x, become terminal positions."""
    out = {}
    ups = [s for s in shapes if s["text"].strip().upper() == "UP"]
    for up in ups:
        down = next((s for s in shapes if s["text"].strip().upper() == "DOWN"
                     and abs(s["bbox"][0] - up["bbox"][0]) < 5 and s["bbox"][1] < up["bbox"][1]), None)
        head = None
        for s in shapes:
            ls = _lines(s["text"])
            if ls and re.match(r"^TB\d+$", ls[0]) and s["bbox"][1] > up["bbox"][3] and abs(s["bbox"][0] - up["bbox"][2]) < 10:
                if head is None or s["bbox"][1] < head["bbox"][1]:
                    head = s
        name, part = parse_label(head["text"]) if head else (f"TB?{len(out) + 1}", None)

        def row(label):
            y0, y1 = label["bbox"][1] - 15, label["bbox"][3] + 15
            cells = [s for s in shapes if s["bbox"][0] >= label["bbox"][2] - 1 and s["bbox"][1] >= y0
                     and s["bbox"][3] <= y1 and s["text"].strip() and s is not label
                     and (s["bbox"][3] - s["bbox"][1]) > (label["bbox"][3] - label["bbox"][1])]
            return sorted(cells, key=lambda s: s["bbox"][0])

        up_cells, down_cells = row(up), (row(down) if down else [])
        if not up_cells:
            continue
        pitch = min((b["bbox"][2] - b["bbox"][0]) for b in up_cells)
        x0 = up_cells[0]["bbox"][0]
        terms: dict[int, dict] = {}
        for side, cells in (("up", up_cells), ("down", down_cells)):
            for c in cells:
                no = int(round((c["bbox"][0] - x0) / pitch)) + 1
                terms.setdefault(no, {"pos": no})[side] = c["text"].strip()
        out[name] = {"part": part, "terminals": [terms[k] for k in sorted(terms)]}
    return out


class _Flow(dict):
    pass


class _Dumper(yaml.SafeDumper):
    pass


_Dumper.add_representer(_Flow, lambda d, v: d.represent_mapping("tag:yaml.org,2002:map", v.items(), flow_style=True))


def dump_yaml(data) -> str:
    """Block style overall, one-line mappings for list rows (components, terminals)."""
    def conv(node, in_list=False):
        if isinstance(node, dict):
            body = {k: conv(v) for k, v in node.items()}
            flat = all(not isinstance(v, (dict, list)) for v in body.values())
            return _Flow(body) if in_list and flat else body
        if isinstance(node, list):
            return [conv(v, True) for v in node]
        return node
    return yaml.dump(conv(data), Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=200)


def write_cabinet(data: dict, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    header = (f"# Cabinet {data['box']} - component placement on back plate (mm, origin bottom-left of plate).\n"
              f"# Generated by `ecad box extract` from {data['source']} page '{data['page']}'. Edit freely.\n")
    body = dump_yaml(data)
    dest.write_text(header + body, encoding="utf-8")
    return dest
