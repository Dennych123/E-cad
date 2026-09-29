"""Dump Visio (.vsd/.vsdx) drawings to raw JSON via COM automation.

All coordinates are converted to page space in millimetres (origin bottom-left),
so later stages never need Visio again.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

from win32com.client import gencache

IN2MM = 25.4
VIS_SECTION_PROP = 243
VIS_OPEN_RO_NOLIST_NOMACRO = 2 | 8 | 128
VIS_TYPE_GROUP = 2


def _mm(v: float) -> float:
    return round(v * IN2MM, 3)


def _cell(shape, name: str, default=None):
    try:
        if not shape.CellExistsU(name, 0):
            return default
        return shape.CellsU(name).ResultIU
    except Exception:
        return default


def _cell_str(shape, name: str, default=""):
    try:
        if not shape.CellExistsU(name, 0):
            return default
        return shape.CellsU(name).ResultStr("")
    except Exception:
        return default


class _Affine:
    """Maps a shape's parent coordinate space to page space."""

    def __init__(self, parent=None):
        if parent is None:
            self.o, self.ex, self.ey = (0.0, 0.0), (1.0, 0.0), (0.0, 1.0)
            return
        o = parent.XYToPage(0.0, 0.0)
        x = parent.XYToPage(1.0, 0.0)
        y = parent.XYToPage(0.0, 1.0)
        self.o = o
        self.ex = (x[0] - o[0], x[1] - o[1])
        self.ey = (y[0] - o[0], y[1] - o[1])

    def __call__(self, x: float, y: float) -> tuple[float, float]:
        return (
            self.o[0] + x * self.ex[0] + y * self.ey[0],
            self.o[1] + x * self.ex[1] + y * self.ey[1],
        )


def _props(shape) -> dict[str, str]:
    out = {}
    try:
        n = shape.RowCount(VIS_SECTION_PROP)
    except Exception:
        return out
    for r in range(n):
        try:
            row = shape.CellsSRC(VIS_SECTION_PROP, r, 0)
            out[row.RowNameU] = row.ResultStr("")
        except Exception:
            pass
    return out


def _dump_shape(shape, parent_id, to_page: _Affine, out: list, depth: int):
    t = shape.Type
    rec = {
        "id": shape.ID,
        "parent": parent_id,
        "depth": depth,
        "name": shape.NameU,
        "master": shape.Master.NameU if shape.Master else None,
        "type": "group" if t == VIS_TYPE_GROUP else "shape",
        "oneD": bool(shape.OneD),
        "text": shape.Text.replace("￼", "").strip(),
        "layers": [shape.Layer(i).Name for i in range(1, shape.LayerCount + 1)],
        "angle_deg": round((_cell(shape, "Angle", 0.0) or 0.0) * 57.29577951308232, 2),
        "line_pattern": int(_cell(shape, "LinePattern", 1) or 0),
        "line_weight_pt": round((_cell(shape, "LineWeight", 0.0) or 0.0) * 72, 3),
        "line_color": _cell_str(shape, "LineColor"),
        "fill_pattern": int(_cell(shape, "FillPattern", 0) or 0),
    }
    l, b, r, tp = shape.BoundingBox(1)
    corners = [to_page(l, b), to_page(r, tp), to_page(l, tp), to_page(r, b)]
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    rec["bbox"] = [_mm(min(xs)), _mm(min(ys)), _mm(max(xs)), _mm(max(ys))]

    if rec["text"]:
        tx, ty = shape.XYToPage(_cell(shape, "TxtPinX", 0.0), _cell(shape, "TxtPinY", 0.0))
        rec["text_pos"] = [_mm(tx), _mm(ty)]
        size = _cell(shape, "Char.Size", None)
        rec["text_size_pt"] = round(size * 72, 2) if size else None
        rec["text_angle_deg"] = round((_cell(shape, "TxtAngle", 0.0) or 0.0) * 57.29577951308232, 2)

    if rec["oneD"]:
        bx, by = to_page(_cell(shape, "BeginX", 0.0), _cell(shape, "BeginY", 0.0))
        ex, ey = to_page(_cell(shape, "EndX", 0.0), _cell(shape, "EndY", 0.0))
        rec["begin"], rec["end"] = [_mm(bx), _mm(by)], [_mm(ex), _mm(ey)]

    props = _props(shape)
    if props:
        rec["props"] = props

    if t != VIS_TYPE_GROUP:
        paths = []
        try:
            ps = shape.Paths
            for i in range(1, ps.Count + 1):
                pts = ps(i).Points(0.005)
                page_pts = (to_page(pts[k], pts[k + 1]) for k in range(0, len(pts), 2))
                paths.append([[_mm(x), _mm(y)] for x, y in page_pts])
        except Exception:
            pass
        if paths:
            rec["paths"] = paths
    out.append(rec)

    if t == VIS_TYPE_GROUP:
        child_aff = _Affine(shape)
        for child in shape.Shapes:
            _dump_shape(child, shape.ID, child_aff, out, depth + 1)


def dump_document(app, src: Path, out_dir: Path, export_images: bool = True, save_vsdx: bool = True) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    try:
        doc = app.Documents.OpenEx(str(src), VIS_OPEN_RO_NOLIST_NOMACRO)
    except Exception:
        # File locked by a running Visio instance: open a temp copy instead.
        tmp = Path(tempfile.mkdtemp()) / src.name
        shutil.copy2(src, tmp)
        doc = app.Documents.OpenEx(str(tmp), VIS_OPEN_RO_NOLIST_NOMACRO)
    summary = {"file": src.name, "pages": []}
    try:
        for page in doc.Pages:
            ps = page.PageSheet
            shapes: list[dict] = []
            top = _Affine(None)
            for s in page.Shapes:
                _dump_shape(s, None, top, shapes, 0)
            back = page.BackPage
            back_name = back.NameU if back is not None and not isinstance(back, str) else (back or None)
            meta = {
                "source": src.name,
                "index": page.Index,
                "name": page.NameU,
                "background": bool(page.Background),
                "back_page": back_name,
                "width_mm": _mm(ps.CellsU("PageWidth").ResultIU),
                "height_mm": _mm(ps.CellsU("PageHeight").ResultIU),
                "connects": [
                    {"from": c.FromSheet.ID, "from_cell": c.FromCell.Name,
                     "to": c.ToSheet.ID, "to_cell": c.ToCell.Name}
                    for c in page.Connects
                ],
                "shapes": shapes,
            }
            stem = f"p{page.Index:02d}"
            (out_dir / f"{stem}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            if export_images:
                for ext in ("svg", "png"):
                    try:
                        page.Export(str(out_dir / f"{stem}.{ext}"))
                    except Exception as e:  # export filters can be missing
                        summary.setdefault("warnings", []).append(f"{stem}.{ext}: {e}")
            summary["pages"].append({"index": page.Index, "name": page.NameU,
                                     "background": meta["background"], "shapes": len(shapes)})
        if save_vsdx and src.suffix.lower() == ".vsd":
            try:
                doc.SaveAs(str(out_dir / (src.stem + ".vsdx")))
            except Exception as e:
                summary.setdefault("warnings", []).append(f"vsdx: {e}")
    finally:
        doc.Close()
    summary["seconds"] = round(time.time() - t0, 1)
    return summary


def _set_png_dpi(app, dpi: int):
    # visRasterUseCustomResolution=3, visRasterPixelsPerInch=0; big A2 pages fail at default resolution.
    try:
        app.Settings.SetRasterExportResolution(3, dpi, dpi, 0)
    except Exception as e:
        print(f"   (raster dpi not set: {e})")


def export_pngs(src_dir: Path, raw_dir: Path, pattern: str = "*.vsd*", dpi: int = 100) -> None:
    """(Re-)export PNG previews only."""
    src_dir, raw_dir = src_dir.resolve(), raw_dir.resolve()
    app = gencache.EnsureDispatch("Visio.InvisibleApp")
    app.AlertResponse = 7
    _set_png_dpi(app, dpi)
    try:
        for f in sorted(p for p in src_dir.glob(pattern) if not p.name.startswith("~$")):
            doc = app.Documents.OpenEx(str(f), VIS_OPEN_RO_NOLIST_NOMACRO)
            try:
                for page in doc.Pages:
                    out = raw_dir / f.stem / f"p{page.Index:02d}.png"
                    try:
                        page.Export(str(out))
                    except Exception as e:
                        print(f"   {f.name} p{page.Index}: {e.args[2][2].strip() if len(e.args) > 2 and e.args[2] else e}")
            finally:
                doc.Close()
    finally:
        app.Quit()


def dump_folder(src_dir: Path, raw_dir: Path, pattern: str = "*.vsd*", **kw) -> list[dict]:
    src_dir, raw_dir = src_dir.resolve(), raw_dir.resolve()  # Visio export needs absolute paths
    files = sorted(p for p in src_dir.glob(pattern) if not p.name.startswith("~$"))
    app = gencache.EnsureDispatch("Visio.InvisibleApp")
    app.AlertResponse = 7
    _set_png_dpi(app, 100)
    results = []
    try:
        for f in files:
            print(f"[import] {f.name} ...", flush=True)
            try:
                s = dump_document(app, f, raw_dir / f.stem, **kw)
                print(f"   {len(s['pages'])} pages, {sum(p['shapes'] for p in s['pages'])} shapes, {s['seconds']}s", flush=True)
            except Exception as e:
                s = {"file": f.name, "error": repr(e)}
                print(f"   ERROR {e!r}", flush=True)
            results.append(s)
    finally:
        app.Quit()
    summary_path = raw_dir / "_import_summary.json"
    merged = {}
    if summary_path.exists():
        merged = {s["file"]: s for s in json.loads(summary_path.read_text(encoding="utf-8"))}
    merged.update({s["file"]: s for s in results})
    summary_path.write_text(json.dumps(sorted(merged.values(), key=lambda s: s["file"]),
                                       ensure_ascii=False, indent=1), encoding="utf-8")
    return results
