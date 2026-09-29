from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer

app = typer.Typer(help="ecad-code: code-first electrical CAD")


@app.command("import-visio")
def import_visio(
    src: Path = typer.Argument(..., help="Folder with .vsd/.vsdx files"),
    project: Path = typer.Argument(..., help="Project folder, e.g. projects/<name>"),
    pattern: str = typer.Option("*.vsd*", help="Glob for files to import"),
    no_images: bool = typer.Option(False, help="Skip SVG/PNG export"),
    no_vsdx: bool = typer.Option(False, help="Skip saving a .vsdx copy"),
):
    """Dump Visio drawings to raw JSON (+SVG/PNG, .vsdx copy) under <project>/raw."""
    from .importer.visio_com import dump_folder

    dump_folder(src, project / "raw", pattern, export_images=not no_images, save_vsdx=not no_vsdx)


@app.command("export-png")
def export_png(src: Path, project: Path, pattern: str = "*.vsd*", dpi: int = 100):
    """Re-export PNG previews of Visio pages into <project>/raw."""
    from .importer.visio_com import export_pngs

    export_pngs(src, project / "raw", pattern, dpi)


@app.command()
def stats(project: Path):
    """Summarise raw import: masters, text patterns, line geometry."""
    from .importer.stats import report

    out = report(project / "raw")
    print(f"written {out}")


box_app = typer.Typer(help="Enclosure templates: list, create from existing, render, extract.")
app.add_typer(box_app, name="box")


@box_app.command("list")
def box_list(project: Optional[Path] = typer.Option(None, help="Also search <project>/boxes")):
    """List box templates (abstract = base for inheritance only)."""
    from .box.loader import list_boxes

    for b in list_boxes(project):
        kind = "abstract" if b["abstract"] else ""
        print(f"{b['id']:<14} {kind:<9} extends={b['extends'] or '-':<13} {b['name']}")


@box_app.command("show")
def box_show(box_id: str, project: Optional[Path] = None):
    """Print the fully resolved template (inheritance + expressions + generators applied)."""
    import yaml
    from .box.loader import load

    print(yaml.safe_dump(load(box_id, project).model_dump(exclude_defaults=True), sort_keys=False, allow_unicode=True))


@box_app.command("new")
def box_new(
    new_id: str,
    base: str = typer.Option(..., "--from", help="Template to start from, e.g. 1CE"),
    name: Optional[str] = typer.Option(None, help="Display name"),
    set_: list[str] = typer.Option([], "--set", help="Override, e.g. --set enclosure.width=800 --set params.rows=6"),
    project: Optional[Path] = typer.Option(None, help="Create inside <project>/boxes instead of the library"),
):
    """Create a custom template that extends an existing one."""
    from .box.loader import LIBRARY_BOXES, new_box

    dest = (project / "boxes") if project else LIBRARY_BOXES
    print(f"created {new_box(new_id, base, name, set_, dest, project)}")


@box_app.command("render")
def box_render(
    box_id: str,
    cabinet: Optional[Path] = typer.Option(None, help="Cabinet YAML with component placement"),
    out: Optional[Path] = typer.Option(None, help="Output .svg (default out/box_<id>.svg)"),
    project: Optional[Path] = None,
):
    """Render outline + plate layout (A3 SVG)."""
    import yaml
    from .box.loader import load
    from .box.render import render_sheet

    cab = yaml.safe_load(cabinet.read_text(encoding="utf-8")) if cabinet else None
    out = out or Path("out") / f"box_{box_id}.svg"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_sheet(load(box_id, project), cab), encoding="utf-8")
    print(f"written {out}")


@box_app.command("extract")
def box_extract(layout_json: Path, box_id: str, out: Path):
    """Extract component placement + terminal plan from an imported layout page."""
    from .box.extract import extract_cabinet, write_cabinet

    data = extract_cabinet(layout_json, box_id)
    write_cabinet(data, out)
    print(f"written {out}: {len(data['components'])} components, strips {list(data['terminal_strips'])}, "
          f"{len(data['review'])} review notes")


@box_app.command("gallery")
def box_gallery(out: Path = typer.Option(Path("out/box_gallery.html")), project: Optional[Path] = None):
    """HTML gallery of all templates for picking one."""
    from .box.gallery import build_gallery

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_gallery(project), encoding="utf-8")
    print(f"written {out}")


module_app = typer.Typer(help="Functional modules: reusable part groups placed with auto tag numbering.")
app.add_typer(module_app, name="module")


def _parse_sets(sets: list[str]) -> dict:
    import yaml

    out = {}
    for s in sets:
        k, _, v = s.partition("=")
        out[k.strip()] = yaml.safe_load(v)
    return out


@module_app.command("list")
def module_list(project: Optional[Path] = None):
    from .modules import list_modules

    for m in list_modules(project):
        print(f"{m['id']:<16} box={m['box'] or '-':<5} {m['name']}")


@module_app.command("show")
def module_show(mod_id: str, set_: list[str] = typer.Option([], "--set"), project: Optional[Path] = None):
    """Show a module with params applied (parts expanded)."""
    from .modules import load_module

    m = load_module(mod_id, project, _parse_sets(set_))
    print(f"{m.id}: {m.name}  params={m.params}")
    for p in m.parts:
        fp = f"{p.w}x{p.h}" if p.w else p.mount
        print(f"  {p.tag:<12} {p.part or '-':<20} {fp:<12} {p.name or ''}")
    for c in m.cables:
        print(f"  cable {c.tag} {c.part}: {len(c.cores)} cores {c.from_} -> {c.to}")
    for r in m.review:
        print(f"  REVIEW: {r}")


@module_app.command("place")
def module_place(
    mod_id: str,
    cabinet: Path = typer.Option(..., help="Cabinet YAML to add to (created if missing)"),
    box: Optional[str] = typer.Option(None, help="Box template id (needed when creating a cabinet)"),
    rail: Optional[str] = typer.Option(None, help="Rail id, e.g. R2"),
    x: Optional[float] = typer.Option(None, help="Start x on plate; default = after last part on the rail"),
    gap: float = typer.Option(0.0, help="Gap between parts (mm)"),
    set_: list[str] = typer.Option([], "--set", help="Module params, e.g. --set count=12"),
    project: Optional[Path] = None,
):
    """Place a module into a cabinet: tags auto-numbered, footprints packed on the rail."""
    import yaml
    from .box.extract import dump_yaml
    from .box.loader import load
    from .modules import load_module, place

    cab = yaml.safe_load(cabinet.read_text(encoding="utf-8")) if cabinet.exists() else {"box": box, "components": []}
    box_id = cab.get("box") or box
    if not box_id:
        raise typer.BadParameter("--box is required for a new cabinet")
    t = load(box_id, project)
    m = load_module(mod_id, project, _parse_sets(set_))
    new = place(m, cab, rail, x, {r.id: r for r in t.rails}, gap)
    header = "".join(ln for ln in (cabinet.read_text(encoding="utf-8").splitlines(True) if cabinet.exists() else [])
                     if ln.startswith("#"))
    cabinet.parent.mkdir(parents=True, exist_ok=True)
    cabinet.write_text(header + dump_yaml(cab), encoding="utf-8")
    inst = cab["modules"][-1]
    print(f"placed {inst['instance']}: {', '.join(inst['tags'])}  ({len(new)} on rail {rail})")


if __name__ == "__main__":
    app()
