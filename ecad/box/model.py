"""Enclosure / box template schema.

Units: millimetres. Every face and the mounting plate use a local frame with
origin at the bottom-left corner, x to the right, y up (as seen from outside,
or from the front for the plate).
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

FaceName = Literal["front", "door", "back", "left", "right", "top", "bottom"]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Hole(_M):
    shape: Literal["circle", "rect", "slot"] = "circle"
    x: float
    y: float
    d: Optional[float] = None          # circle diameter
    w: Optional[float] = None          # rect/slot width
    h: Optional[float] = None          # rect/slot height
    key: Optional[float] = None        # anti-rotation notch width (e.g. 22 mm PB holes)
    thread: Optional[str] = None       # "M5" -> tapped instead of through
    label: Optional[str] = None        # device tag mounted here
    note: Optional[str] = None


class HoleGrid(_M):
    """Generator: rows x cols of identical holes, optionally skipping cells."""
    x0: float
    y0: float
    pitch_x: float
    pitch_y: float
    cols: int
    rows: int
    d: float
    skip: list[tuple[int, int]] = []   # (col, row), 0-based, row 0 = top row
    labels: list[Optional[str]] = []   # row-major, applied to non-skipped cells
    from_top: bool = True              # rows counted downward from y0


class Enclosure(_M):
    kind: Literal["floor_stand", "wall_mount", "pb_box", "junction", "desk"] = "wall_mount"
    width: float
    height: float
    depth: float
    stand_height: float = 0
    material: str = "SPHC"
    paint: str = "MUNSELL 5Y8/1"
    thickness: dict[str, float] = {}   # body/door/plate/stand...
    ip: Optional[str] = None
    maker: Optional[str] = None
    part: Optional[str] = None


class Door(_M):
    hinge: Literal["left", "right", "top", "none"] = "right"
    open_angle: float = 120
    handle: Optional[str] = None       # part no.
    handle_pos: Optional[tuple[float, float]] = None


class Plate(_M):
    width: float
    height: float
    thickness: float = 2.3
    offset_x: float = 30               # from enclosure inner left
    offset_y: float = 30               # from enclosure inner bottom
    material: str = "SPHC"


class Duct(_M):
    id: str
    x: float
    y: float
    w: float
    h: float
    size: Optional[str] = None         # "W40XH60"
    part: Optional[str] = None


class Rail(_M):
    id: str
    x: float
    y: float                           # rail centreline
    length: float
    part: str = "PFP-100N"             # 35 mm DIN rail
    width: float = 35


class AutoLayout(_M):
    """Generator: vertical wiring ducts on both sides + N horizontal duct rows,
    with a DIN rail centred in every gap."""
    rows: int                          # number of rail rows
    duct_w: float = 40                 # horizontal duct height on plate (W40)
    duct_size: str = "W40XH60"
    side_duct_w: float = 45
    side_duct_size: str = "W45XH65"
    rail_part: str = "PFP-100N"
    gaps: list[float] = []             # optional explicit gap heights, bottom->top


class Component(_M):
    tag: str
    part: Optional[str] = None
    x: float
    y: float
    w: float
    h: float
    rail: Optional[str] = None
    module: Optional[str] = None       # functional module this belongs to
    note: Optional[str] = None


class Accessory(_M):
    part: str
    name: str
    qty: float = 1
    maker: Optional[str] = None
    face: Optional[str] = None


class BoxTemplate(_M):
    id: str
    name: str
    description: str = ""
    extends: Optional[str] = None
    params: dict[str, Any] = {}        # free parameters, usable in "=expr" values
    tags: list[str] = []
    source: list[str] = []             # drawings this template was derived from
    enclosure: Enclosure
    door: Door = Door()
    plate: Optional[Plate] = None
    faces: dict[FaceName, list[Hole]] = {}
    hole_grids: dict[FaceName, list[HoleGrid]] = {}
    auto_layout: Optional[AutoLayout] = None
    ducts: list[Duct] = []
    rails: list[Rail] = []
    components: list[Component] = []  # default/reference placement
    accessories: list[Accessory] = []
    notes: list[str] = []
    review: list[str] = Field(default_factory=list, description="open questions from import")
