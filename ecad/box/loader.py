"""Load box templates with `extends` inheritance and expand generators.

Merge rules for a child template over its parent:
  * mappings merge recursively
  * lists replace the parent's list, except keys written as `name+` which append
  * `null` deletes the parent's value
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Iterable

import yaml

from .model import BoxTemplate, Duct, Hole, Rail

ROOT = Path(__file__).resolve().parents[2]
LIBRARY_BOXES = ROOT / "library" / "boxes"


def search_path(project: Path | None = None) -> list[Path]:
    paths = []
    if project is not None:
        paths.append(Path(project) / "boxes")   # project-local templates win
    paths.append(LIBRARY_BOXES)
    return [p for p in paths if p.is_dir()]


def _find(box_id: str, paths: Iterable[Path]) -> Path:
    for p in paths:
        f = p / f"{box_id}.yaml"
        if f.exists():
            return f
    raise FileNotFoundError(f"box template '{box_id}' not found in {[str(p) for p in paths]}")


def deep_merge(base: Any, over: Any) -> Any:
    if not isinstance(base, dict) or not isinstance(over, dict):
        return copy.deepcopy(over)
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(k, str) and k.endswith("+"):
            key = k[:-1]
            if isinstance(v, dict):   # e.g. faces+: {front: [...]} appends per face
                cur = out.setdefault(key, {})
                for sk, sv in v.items():
                    cur[sk] = list(cur.get(sk) or []) + list(copy.deepcopy(sv) or [])
            else:
                out[key] = list(out.get(key) or []) + list(copy.deepcopy(v) or [])
        elif v is None:
            out.pop(k, None)
        elif k in out:
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_raw(box_id: str, project: Path | None = None, _seen: tuple = ()) -> dict:
    if box_id in _seen:
        raise ValueError(f"circular extends: {' -> '.join(_seen + (box_id,))}")
    paths = search_path(project)
    data = yaml.safe_load(_find(box_id, paths).read_text(encoding="utf-8")) or {}
    parent = data.get("extends")
    if parent:
        base = load_raw(parent, project, _seen + (box_id,))
        base.pop("abstract", None)
        data = deep_merge(base, data)
        data["extends"] = parent
    return data


class _NS(dict):
    """dict with attribute access, for expression evaluation."""
    def __getattr__(self, k):
        try:
            v = self[k]
        except KeyError:
            raise AttributeError(k) from None
        return _NS(v) if isinstance(v, dict) else v


# Expression language shared with lib/expr.js: arithmetic, attribute/index access and these
# functions only (no ternary, no comprehensions), so Python and JS evaluate identically.
_EXPR_FUNCS = {"min": min, "max": max, "round": round, "abs": abs, "int": int, "float": float,
               "len": len, "str": str,
               "pick": lambda seq, i, default=None: seq[i] if 0 <= i < len(seq) else default}


def eval_exprs(data: dict, max_pass: int = 10) -> dict:
    """Evaluate string values starting with '=' (e.g. '=enclosure.width - 60').

    Names available: every top-level key (enclosure, plate, params...).
    Runs several passes so expressions may depend on other expressions.
    """
    data = copy.deepcopy(data)

    def walk(node, ns, pending):
        items = node.items() if isinstance(node, dict) else enumerate(node)
        for k, v in list(items):
            if isinstance(v, (dict, list)):
                walk(v, ns, pending)
            elif isinstance(v, str) and v.startswith("="):
                try:
                    node[k] = eval(v[1:], {"__builtins__": _EXPR_FUNCS}, ns)  # noqa: S307 (trusted local YAML)
                except Exception as e:
                    pending.append(f"{v} ({e})")

    for _ in range(max_pass):
        pending: list[str] = []
        walk(data, {k: _NS(v) if isinstance(v, dict) else v for k, v in data.items()}, pending)
        if not pending:
            return data
    raise ValueError(f"unresolved expressions: {pending}")


def expand(t: BoxTemplate) -> BoxTemplate:
    """Materialise hole grids and auto layout into concrete holes/ducts/rails."""
    t = t.model_copy(deep=True)
    for face, grids in t.hole_grids.items():
        holes = t.faces.setdefault(face, [])
        for g in grids:
            li = 0
            for r in range(g.rows):
                for c in range(g.cols):
                    if (c, r) in {tuple(s) for s in g.skip}:
                        continue
                    y = g.y0 - r * g.pitch_y if g.from_top else g.y0 + r * g.pitch_y
                    label = g.labels[li] if li < len(g.labels) else None
                    li += 1
                    holes.append(Hole(x=g.x0 + c * g.pitch_x, y=y, d=g.d, label=label))
    t.hole_grids = {}

    if t.auto_layout and t.plate and not t.ducts:
        a, W, H = t.auto_layout, t.plate.width, t.plate.height
        t.ducts.append(Duct(id="V1", x=0, y=0, w=a.side_duct_w, h=H, size=a.side_duct_size))
        t.ducts.append(Duct(id="V2", x=W - a.side_duct_w, y=0, w=a.side_duct_w, h=H, size=a.side_duct_size))
        free = H - (a.rows + 1) * a.duct_w
        gaps = a.gaps or [free / a.rows] * a.rows
        if abs(sum(gaps) - free) > 0.5:
            raise ValueError(f"auto_layout gaps sum {sum(gaps)} != free height {free}")
        y = 0.0
        letters = "FEDCBAGHIJKL"
        for i in range(a.rows + 1):
            t.ducts.append(Duct(id=f"H{letters[i]}", x=0, y=y, w=W, h=a.duct_w, size=a.duct_size))
            if i < a.rows:
                t.rails.append(Rail(id=f"R{i + 1}", x=a.side_duct_w, y=y + a.duct_w + gaps[i] / 2,
                                    length=W - 2 * a.side_duct_w, part=a.rail_part))
                y += a.duct_w + gaps[i]
        t.auto_layout = None
    return t


def load(box_id: str, project: Path | None = None, expanded: bool = True) -> BoxTemplate:
    raw = eval_exprs(load_raw(box_id, project))
    t = BoxTemplate.model_validate({k: v for k, v in raw.items() if k != "abstract"})
    return expand(t) if expanded else t


def list_boxes(project: Path | None = None) -> list[dict]:
    seen, out = set(), []
    for p in search_path(project):
        for f in sorted(p.glob("*.yaml")):
            if f.stem in seen:
                continue
            seen.add(f.stem)
            raw = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            out.append({"id": f.stem, "name": raw.get("name", ""), "extends": raw.get("extends"),
                        "abstract": bool(raw.get("abstract")), "tags": raw.get("tags", []),
                        "path": str(f)})
    return out


def _set_path(d: dict, dotted: str, value: Any) -> None:
    keys = dotted.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


def new_box(new_id: str, base: str, name: str | None, sets: list[str], dest: Path,
            project: Path | None = None) -> Path:
    load(base, project)  # validate base exists and is valid
    data: dict = {"id": new_id, "name": name or f"{new_id} (from {base})", "extends": base}
    for s in sets:
        key, _, val = s.partition("=")
        _set_path(data, key.strip(), yaml.safe_load(val))
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"{new_id}.yaml"
    if out.exists():
        raise FileExistsError(out)
    out.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
    try:
        load(new_id, dest.parent if dest.resolve() != LIBRARY_BOXES else None)
    except Exception:
        out.unlink()
        raise
    return out
