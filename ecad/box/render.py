"""Render a box template (optionally with a cabinet's component placement) to an A3 SVG sheet."""
from __future__ import annotations

from html import escape
from typing import Optional

from .model import BoxTemplate, Hole

SHEET_W, SHEET_H = 420.0, 297.0
MARGIN = 10.0
TB_W, TB_H = 170.0, 38.0
GAP = 22.0
SCALES = [5, 4, 3, 2, 1.5, 1, 1 / 1.5, 1 / 2, 1 / 2.5, 1 / 3, 1 / 3.5, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10,
          1 / 12, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50]

CSS = """
.o{fill:none;stroke:#111;stroke-width:.35}
.t{fill:none;stroke:#111;stroke-width:.18}
.h{fill:none;stroke:#555;stroke-width:.18;stroke-dasharray:2 1}
.c{fill:none;stroke:#c00;stroke-width:.12;stroke-dasharray:3 1 .5 1}
.duct{fill:url(#hatch);stroke:#666;stroke-width:.15}
.rail{fill:#e9e9e9;stroke:#888;stroke-width:.12}
.cmp{fill:#fff;stroke:#1a4d8f;stroke-width:.25}
.hole{fill:#fff;stroke:#111;stroke-width:.25}
.dim{stroke:#1a4d8f;stroke-width:.15;fill:none}
text{font-family:Arial,Helvetica,sans-serif;fill:#111}
.dt{fill:#1a4d8f}
.lbl{fill:#b3261e}
.tbk{fill:none;stroke:#111;stroke-width:.3}
"""


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def scale_label(s: float) -> str:
    return f"{_fmt(s)}:1" if s >= 1 else f"1:{_fmt(1 / s)}"


class View:
    """Model mm (origin bottom-left, y up) -> paper mm."""

    def __init__(self, ox: float, oy: float, s: float, out: list[str]):
        self.ox, self.oy, self.s, self.out = ox, oy, s, out

    def X(self, x): return self.ox + x * self.s
    def Y(self, y): return self.oy - y * self.s

    def rect(self, x, y, w, h, cls="o", extra=""):
        self.out.append(f'<rect x="{self.X(x):.2f}" y="{self.Y(y + h):.2f}" width="{w * self.s:.2f}" '
                        f'height="{h * self.s:.2f}" class="{cls}" {extra}/>')

    def line(self, x1, y1, x2, y2, cls="t"):
        self.out.append(f'<line x1="{self.X(x1):.2f}" y1="{self.Y(y1):.2f}" x2="{self.X(x2):.2f}" '
                        f'y2="{self.Y(y2):.2f}" class="{cls}"/>')

    def text(self, x, y, txt, size=2.5, anchor="middle", cls="", rot=0.0, weight="normal"):
        px, py = self.X(x), self.Y(y)
        tr = f' transform="rotate({rot:.1f} {px:.2f} {py:.2f})"' if rot else ""
        self.out.append(f'<text x="{px:.2f}" y="{py:.2f}" font-size="{size:.2f}" text-anchor="{anchor}" '
                        f'dominant-baseline="middle" font-weight="{weight}" class="{cls}"{tr}>{escape(str(txt))}</text>')

    def hole(self, h: Hole, label=True):
        s = self.s
        if h.shape == "circle" and h.d:
            r = h.d / 2
            self.out.append(f'<circle cx="{self.X(h.x):.2f}" cy="{self.Y(h.y):.2f}" r="{r * s:.2f}" class="hole"/>')
            self.line(h.x - r * 1.3, h.y, h.x + r * 1.3, h.y, "c")
            self.line(h.x, h.y - r * 1.3, h.x, h.y + r * 1.3, "c")
            if h.key:
                self.rect(h.x - h.key / 2, h.y + r - 0.5, h.key, 1.5, "hole")
        else:
            w, hh = h.w or 10, h.h or 10
            self.rect(h.x - w / 2, h.y - hh / 2, w, hh, "hole")
        if label and h.label:
            off = (h.d or h.h or 10) / 2
            self.text(h.x, h.y - off - 2.2 / s, h.label, size=min(2.4, max(1.4, 5 * s)), cls="lbl")

    def hdim(self, x1, x2, y, off, txt=None):
        """Horizontal dimension placed `off` paper-mm below (neg) / above (pos) model y."""
        py = self.Y(y) - off
        a, b = self.X(x1), self.X(x2)
        self.out.append(f'<line x1="{a:.2f}" y1="{py:.2f}" x2="{b:.2f}" y2="{py:.2f}" class="dim" '
                        f'marker-start="url(#arr)" marker-end="url(#arr)"/>')
        for xx in (a, b):
            self.out.append(f'<line x1="{xx:.2f}" y1="{self.Y(y):.2f}" x2="{xx:.2f}" y2="{py - (1.5 if off > 0 else -1.5):.2f}" class="dim"/>')
        self.out.append(f'<text x="{(a + b) / 2:.2f}" y="{py - 1.2:.2f}" font-size="2.4" text-anchor="middle" '
                        f'class="dt">{_fmt(txt if txt is not None else abs(x2 - x1))}</text>')

    def vdim(self, y1, y2, x, off, txt=None):
        px = self.X(x) - off
        a, b = self.Y(y1), self.Y(y2)
        self.out.append(f'<line x1="{px:.2f}" y1="{a:.2f}" x2="{px:.2f}" y2="{b:.2f}" class="dim" '
                        f'marker-start="url(#arr)" marker-end="url(#arr)"/>')
        for yy in (a, b):
            self.out.append(f'<line x1="{self.X(x):.2f}" y1="{yy:.2f}" x2="{px - (1.5 if off > 0 else -1.5):.2f}" y2="{yy:.2f}" class="dim"/>')
        cy = (a + b) / 2
        self.out.append(f'<text x="{px - 1.2:.2f}" y="{cy:.2f}" font-size="2.4" text-anchor="middle" class="dt" '
                        f'transform="rotate(-90 {px - 1.2:.2f} {cy:.2f})">{_fmt(txt if txt is not None else abs(y2 - y1))}</text>')


def _pick_scale(need_w: float, need_h: float, avail_w: float, avail_h: float) -> float:
    for s in SCALES:
        if need_w * s <= avail_w and need_h * s <= avail_h:
            return s
    return SCALES[-1]


def _defs() -> str:
    return ('<defs><style>' + CSS + '</style>'
            '<marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" '
            'orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,2 L10,5 L0,8 z" fill="#1a4d8f"/></marker>'
            '<pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
            '<rect width="3" height="3" fill="#dcdcdc"/><line x1="0" y1="0" x2="0" y2="3" stroke="#bbb" stroke-width=".6"/></pattern>'
            '</defs>')


def _title_block(out: list[str], t: BoxTemplate, s: float, subtitle: str):
    x0, y0 = SHEET_W - MARGIN - TB_W, SHEET_H - MARGIN - TB_H
    e = t.enclosure
    rows = [
        ("PART NAME", t.name, 4.2),
        ("ID / EXTENDS", f"{t.id}" + (f"  <  {t.extends}" if t.extends else ""), 3),
        ("SIZE W x H x D", f"{_fmt(e.width)} x {_fmt(e.height)} x {_fmt(e.depth)}"
         + (f"  (+stand {_fmt(e.stand_height)})" if e.stand_height else ""), 3),
        ("MATERIAL / PAINT", f"{e.material}   {e.paint}", 3),
        ("SHEET", f"{subtitle}      SCALE {scale_label(s)}", 3),
    ]
    out.append(f'<rect x="{x0}" y="{y0}" width="{TB_W}" height="{TB_H}" class="tbk"/>')
    rh = TB_H / len(rows)
    for i, (k, v, fs) in enumerate(rows):
        y = y0 + i * rh
        if i:
            out.append(f'<line x1="{x0}" y1="{y:.2f}" x2="{x0 + TB_W}" y2="{y:.2f}" class="t"/>')
        out.append(f'<text x="{x0 + 1.5}" y="{y + 2.3:.2f}" font-size="1.8" fill="#1a4d8f">{k}</text>')
        out.append(f'<text x="{x0 + 34}" y="{y + rh / 2 + 1:.2f}" font-size="{fs}" dominant-baseline="middle">{escape(v)}</text>')
    out.append(f'<line x1="{x0 + 32}" y1="{y0}" x2="{x0 + 32}" y2="{y0 + TB_H}" class="t"/>')
    out.append(f'<text x="{x0 + TB_W}" y="{y0 + TB_H + 4}" font-size="2" text-anchor="end" fill="#777">'
               f'generated by ecad-code - edit the YAML, not this drawing</text>')


def _notes(out: list[str], lines: list[str], x: float, y: float, width_chars: int = 110):
    yy = y
    for ln in lines:
        while ln:
            chunk, ln = ln[:width_chars], ln[width_chars:]
            out.append(f'<text x="{x:.2f}" y="{yy:.2f}" font-size="2.2">{escape(chunk)}</text>')
            yy += 3.2
    return yy


def _components(v: View, comps: list[dict]):
    for c in comps:
        x, y, w, h = c["x"], c["y"], c["w"], c["h"]
        v.rect(x, y, w, h, "cmp")
        tag = c["tag"]
        pw, ph = w * v.s, h * v.s
        vertical = ph > pw * 1.6 and pw < len(tag) * 1.5
        fs = max(0.9, min(2.6, (ph if vertical else pw) / max(len(tag), 1) * 1.5, (pw if vertical else ph) * 0.5))
        cy = y + h / 2 + (0 if not c.get("part") else h * 0.12)
        v.text(x + w / 2, cy, tag, size=fs, rot=-90 if vertical else 0, weight="bold")
        if c.get("part") and not vertical and ph > 6:
            v.text(x + w / 2, y + h * 0.25, c["part"], size=max(0.8, min(1.6, pw / max(len(c["part"]), 1) * 1.6)), cls="dt")


def render_sheet(t: BoxTemplate, cabinet: Optional[dict] = None) -> str:
    e = t.enclosure
    W, H, D, st = e.width, e.height, e.depth, e.stand_height
    out: list[str] = []
    avail_w = SHEET_W - 2 * MARGIN - 20
    avail_h = SHEET_H - 2 * MARGIN - TB_H - 18
    faces = t.faces

    if t.plate:
        P = t.plate
        need_w = W + D + P.width
        need_h = H + st + D
        s = _pick_scale(need_w, need_h, avail_w - 3 * GAP, avail_h - GAP)
        x = MARGIN + 18
        top = MARGIN + 12
        base = top + (H + st) * s
        # front / door
        fv = View(x, base - st * s, s, out)
        fv.text(W / 2, H + 8 / s, "FRONT (DOOR)", 2.8, weight="bold")
        fv.rect(0, 0, W, H)
        fv.rect(15, 15, W - 30, H - 30, "h")
        if st:
            fv.rect(0, -st, 100, st)
            fv.rect(W - 100, -st, 100, st)
            fv.line(100, -st * 0.02, W - 100, -st * 0.02, "t")
        hx = W - 2 if t.door.hinge == "right" else 2
        if t.door.hinge in ("left", "right"):
            for hy in (H * 0.15, H * 0.85):
                fv.rect(hx - 2, hy - 20, 4, 40, "o")
        if t.door.handle_pos:
            hx_, hy_ = t.door.handle_pos
            fv.rect(hx_ - 6, hy_ - 25, 12, 50, "o")
            fv.text(hx_ + 10, hy_, t.door.handle or "handle", 1.8, anchor="start", cls="dt")
        for h in faces.get("door", []) + faces.get("front", []):
            fv.hole(h)
        fv.hdim(0, W, -st, -8 if not st else -6)
        fv.vdim(0, H, 0, 8)
        if st:
            fv.vdim(-st, 0, 0, 8)
        # right side
        rx = x + W * s + GAP
        rv = View(rx, base - st * s, s, out)
        rv.text(D / 2, H + 8 / s, "RIGHT SIDE", 2.8, weight="bold")
        rv.rect(0, 0, D, H)
        if st:
            rv.rect(0, -st, D, st)
        for h in faces.get("right", []):
            rv.hole(h)
        rv.hdim(0, D, -st, -6)
        # plate
        px = rx + D * s + GAP
        pv = View(px, base - (st + P.offset_y) * s, s, out)
        pv.text(P.width / 2, P.height + 8 / s, "BACK PLATE LAYOUT", 2.8, weight="bold")
        pv.rect(0, 0, P.width, P.height)
        for r in t.rails:
            pv.rect(r.x, r.y - r.width / 2, r.length, r.width, "rail")
            pv.text(r.x + r.length + 3 / s, r.y, r.id, 1.8, anchor="start", cls="dt")
        for dct in t.ducts:
            pv.rect(dct.x, dct.y, dct.w, dct.h, "duct")
            if dct.w > dct.h:
                pv.text(dct.x + dct.w / 2, dct.y + dct.h / 2, f"{dct.id}  {dct.size or ''}", 1.7)
            else:
                pv.text(dct.x + dct.w / 2, dct.y + dct.h / 2, f"{dct.id}  {dct.size or ''}", 1.7, rot=-90)
        if cabinet:
            _components(pv, cabinet.get("components", []))
        pv.hdim(0, P.width, 0, -6)
        pv.vdim(0, P.height, P.width, -8)
        # bottom view below front
        by = base + GAP + D * s
        bv = View(x, by, s, out)
        bv.text(W / 2, -7 / s, "BOTTOM", 2.8, weight="bold")
        bv.rect(0, 0, W, D)
        for h in faces.get("bottom", []):
            bv.hole(h)
        # notes go in the free area right of the bottom view, above the title block
        notes_x, notes_y, notes_chars = rx, base + GAP, int((SHEET_W - MARGIN - rx) / 1.15)
        sub = "OUTLINE + LAYOUT"
    else:
        s = _pick_scale(W + D, H, avail_w - 2 * GAP - 135, avail_h - GAP)  # ~110 mm hole table + dims
        x = MARGIN + 25
        top = MARGIN + 18
        base = top + H * s
        fv = View(x, base, s, out)
        fv.text(W / 2, -16 / s, "FRONT PLATE (DRILLING)", 3, weight="bold")
        fv.rect(0, 0, W, H)
        for h in faces.get("front", []):
            fv.hole(h)
        fv.hdim(0, W, 0, -8)
        fv.vdim(0, H, 0, 10)
        big = [h for h in faces.get("front", []) if (h.d or h.w or 0) > 8]
        for i, xx in enumerate(sorted({round(h.x, 2) for h in big})):
            fv.hdim(0, xx, H, 6 + i * 5)
        for i, yy in enumerate(sorted({round(h.y, 2) for h in big}, reverse=True)):
            fv.vdim(yy, H, W, -6 - i * 5, txt=H - yy)
        sv = View(x + W * s + GAP + 25, base, s, out)
        sv.text(D / 2, -16 / s, "SIDE", 3, weight="bold")
        sv.rect(0, 0, D, H)
        sv.hdim(0, D, 0, -8)
        # hole table
        tx = x + (W + D) * s + 2 * GAP + 25
        ty = top
        out.append(f'<text x="{tx:.2f}" y="{ty:.2f}" font-size="3" font-weight="bold">HOLE TABLE (origin bottom-left)</text>')
        hdr = ["#", "LABEL", "X", "Y", "DIA", "NOTE"]
        cols = [0, 7, 30, 42, 54, 66]
        ty += 5
        for c, hname in zip(cols, hdr):
            out.append(f'<text x="{tx + c:.2f}" y="{ty:.2f}" font-size="2.3" fill="#1a4d8f">{hname}</text>')
        for i, h in enumerate(faces.get("front", []), 1):
            ty += 3.6
            vals = [i, h.label or "", _fmt(h.x), _fmt(h.y), ("Ø" + _fmt(h.d)) if h.d else f"{_fmt(h.w or 0)}x{_fmt(h.h or 0)}",
                    ("key " + _fmt(h.key)) if h.key else (h.thread or "")]
            for c, val in zip(cols, vals):
                out.append(f'<text x="{tx + c:.2f}" y="{ty:.2f}" font-size="2.3">{escape(str(val))}</text>')
        notes_x, notes_y, notes_chars = MARGIN + 2, base + 26, 95
        sub = "BOX + PLATE DRILLING"

    lines = [f"NOTE: {n}" for n in t.notes] + [f"REVIEW: {r}" for r in t.review]
    if cabinet:
        lines += [f"REVIEW (layout): {r}" for r in cabinet.get("review", [])]
    if t.accessories:
        lines.append("ACCESSORIES: " + "; ".join(f"{a.name} [{a.part}]" for a in t.accessories))
    _notes(out, lines, notes_x, notes_y, width_chars=notes_chars)

    _title_block(out, t, s, sub)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{SHEET_W}mm" height="{SHEET_H}mm" '
            f'viewBox="0 0 {SHEET_W} {SHEET_H}">{_defs()}'
            f'<rect width="{SHEET_W}" height="{SHEET_H}" fill="#fff"/>'
            f'<rect x="{MARGIN / 2}" y="{MARGIN / 2}" width="{SHEET_W - MARGIN}" height="{SHEET_H - MARGIN}" class="tbk"/>'
            + "".join(out) + "</svg>")
