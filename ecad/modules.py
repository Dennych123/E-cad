"""Functional modules: reusable groups of parts (+ rail footprint, cables, interface
signals) that can be placed into a cabinet with automatic tag numbering.

Module YAML lives in library/modules/<id>.yaml (or <project>/modules). It may
`extends` another module (same merge rules as box templates). Part fields:

  tag:    "CR{n}" -> {n} auto-numbered at placement; "{prefix}{i}" etc. from params
  repeat: count (int or "=expr"); inside repeated parts `i` (0-based) is available
  x, w, h: footprint on a DIN rail (mm). x omitted -> packed left to right
"""
from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .box.loader import ROOT, _EXPR_FUNCS, _NS, deep_merge, eval_exprs

LIBRARY_MODULES = ROOT / "library" / "modules"


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModPart(_M):
    tag: str
    part: Optional[str] = None
    name: Optional[str] = None
    maker: Optional[str] = None
    qty: float = 1
    x: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    mount: str = "rail"                 # rail | door | face | loose | box
    hole: Optional[str] = None          # box hole label this device sits in
    note: Optional[str] = None


class CableCore(_M):
    core: int
    signal: str
    wire: Optional[str] = None          # wire number / connect-to
    color: Optional[str] = None


class Cable(_M):
    tag: str
    part: str
    maker: Optional[str] = None
    length_m: Optional[float] = None
    from_: Optional[str] = Field(None, alias="from")
    to: Optional[str] = None
    cores: list[CableCore] = []

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Module(_M):
    id: str
    name: str
    description: str = ""
    extends: Optional[str] = None
    params: dict[str, Any] = {}
    tags: list[str] = []
    source: list[str] = []
    box: Optional[str] = None           # remote box template this module lives in (e.g. 2PB)
    parts: list[ModPart] = []
    cables: list[Cable] = []
    interface: list[str] = []           # signals/wire numbers exposed to the rest of the machine
    notes: list[str] = []
    review: list[str] = []


class _Keep(dict):
    def __missing__(self, k):
        return "{" + k + "}"


def _paths(project: Path | None) -> list[Path]:
    ps = ([Path(project) / "modules"] if project else []) + [LIBRARY_MODULES]
    return [p for p in ps if p.is_dir()]


def _raw(mod_id: str, project: Path | None, seen: tuple = ()) -> dict:
    if mod_id in seen:
        raise ValueError(f"circular extends: {seen + (mod_id,)}")
    for p in _paths(project):
        f = p / f"{mod_id}.yaml"
        if f.exists():
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            if data.get("extends"):
                data = deep_merge(_raw(data["extends"], project, seen + (mod_id,)), data)
            return data
    raise FileNotFoundError(f"module '{mod_id}' not found")


def load_module(mod_id: str, project: Path | None = None, overrides: dict | None = None) -> Module:
    data = _raw(mod_id, project)
    if overrides:
        data["params"] = {**(data.get("params") or {}), **overrides}
    parts_raw = data.pop("parts", []) or []
    data = eval_exprs(data)
    ns = {k: _NS(v) if isinstance(v, dict) else v for k, v in data.items()}
    fmt = _Keep({k: v for k, v in (data.get("params") or {}).items()})

    def ev(v, i):
        if isinstance(v, str) and v.startswith("="):
            return eval(v[1:], {"__builtins__": _EXPR_FUNCS}, {**ns, "i": i})  # noqa: S307
        if isinstance(v, str):
            return v.format_map(_Keep({**fmt, "i": i if i is not None else "{i}"}))
        return v

    parts = []
    for p in parts_raw:
        p = copy.deepcopy(p)
        rep = p.pop("repeat", None)
        count = int(ev(rep, 0)) if rep is not None else None
        for i in range(count if count is not None else 1):
            parts.append({k: ev(v, i if count is not None else None) for k, v in p.items()})
    data["parts"] = parts
    return Module.model_validate(data)


def list_modules(project: Path | None = None) -> list[dict]:
    out, seen = [], set()
    for p in _paths(project):
        for f in sorted(p.glob("*.yaml")):
            if f.stem in seen:
                continue
            seen.add(f.stem)
            raw = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            out.append({"id": f.stem, "name": raw.get("name", ""), "box": raw.get("box"),
                        "tags": raw.get("tags", []), "extends": raw.get("extends")})
    return out


def _next_number(prefix: str, used: set[str]) -> int:
    rx = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    nums = [int(m.group(1)) for t in used if (m := rx.match(t))]
    return max(nums, default=0) + 1


def place(mod: Module, cabinet: dict, rail_id: str | None, x0: float | None, box_rails: dict,
          gap: float = 0.0) -> list[dict]:
    """Append the module's rail parts to cabinet['components'] with auto-numbered tags.
    Returns the new component rows. Parts without footprint are recorded under
    cabinet['modules'] only (door devices, loose items)."""
    comps = cabinet.setdefault("components", [])
    used = {c["tag"] for c in comps}
    inst_no = sum(1 for m in cabinet.get("modules", []) if m["module"] == mod.id) + 1
    inst = f"{mod.id}#{inst_no}"
    rail = box_rails.get(rail_id) if rail_id else None
    if rail_id and rail is None:
        raise KeyError(f"rail {rail_id} not in box (have {sorted(box_rails)})")
    if x0 is None and rail is not None:        # pack after the right-most component on that rail
        on = [c for c in comps if c.get("rail") == rail_id]
        x0 = max((c["x"] + c["w"] for c in on), default=rail.x) + gap
    cursor = x0 or 0.0
    new, tags = [], []
    for p in mod.parts:
        tag = p.tag
        if "{n}" in tag:
            prefix = tag.split("{n}")[0]
            tag = tag.replace("{n}", str(_next_number(prefix, used)))
        if tag in used:
            raise ValueError(f"tag {tag} already used in cabinet")
        used.add(tag)
        tags.append(tag)
        if p.mount == "rail" and p.w and p.h and rail is not None:
            x = (x0 or 0) + p.x if p.x is not None else cursor
            row = {"tag": tag, "part": p.part, "x": round(x, 1), "y": round(rail.y - p.h / 2, 1),
                   "w": p.w, "h": p.h, "rail": rail_id, "module": inst}
            if not row["part"]:
                row.pop("part")
            comps.append(row)
            new.append(row)
            cursor = max(cursor, x + p.w + gap)
            if rail is not None and cursor > rail.x + rail.length + 0.5:
                cabinet.setdefault("review", []).append(
                    f"{inst}: {tag} ends at x={cursor:.1f}, past rail {rail_id} end {rail.x + rail.length:.1f}.")
    cabinet.setdefault("modules", []).append(
        {"module": mod.id, "instance": inst, "rail": rail_id, "params": mod.params, "tags": tags})
    return new
