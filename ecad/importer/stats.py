"""Summarise raw Visio dumps: which texts look like tags, wire numbers, PLC addresses..."""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

# Order matters: first match wins.
TEXT_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("contact_no", re.compile(r"^\(\d{1,3}\)$")),
    ("plc_addr", re.compile(r"^(CH\s?\d{2}\.\d{3}|CIO\s?\d+\.\d{2}|\d{1,4}\.\d{2})$")),
    ("wire_no", re.compile(r"^\(?[LPZNRSTUVW]\d{2,6}[A-Z]?\)?$")),
    ("device_tag", re.compile(r"^(CR|MC|MCB|ELB|CP|PB|SS|LS|PS|SOL|SV|FU|TB|PL|RL|TR|SW|EMG|KS|SQ|BZ|FAN|PSU|X|Y)[A-Z0-9\-]*$")),
    ("cable_spec", re.compile(r"mm2|mm²|SQ\b|AWG", re.I)),
    ("part_no", re.compile(r"^[A-Z]{1,4}\d?[A-Z]?-[A-Z0-9\-/()]+$")),
    ("terminal_no", re.compile(r"^\d{1,3}$|^[A-Z]\d{1,2}$")),
]


def classify_text(t: str) -> str:
    t = t.strip()
    for name, rx in TEXT_PATTERNS:
        if rx.search(t) if name == "cable_spec" else rx.match(t):
            return name
    return "other"


def report(raw_dir: Path) -> Path:
    lines = ["# Import statistics", ""]
    overall = Counter()
    samples: dict[str, Counter] = defaultdict(Counter)
    masters = Counter()
    for fdir in sorted(p for p in raw_dir.iterdir() if p.is_dir()):
        lines.append(f"## {fdir.name}")
        lines.append("| page | name | bg | shapes | 1D lines | polylines | texts | wire_no | device_tag | plc_addr |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        for pj in sorted(fdir.glob("p*.json")):
            d = json.loads(pj.read_text(encoding="utf-8"))
            c = Counter()
            for s in d["shapes"]:
                if s["master"]:
                    masters[s["master"]] += 1
                if s["oneD"]:
                    c["1d"] += 1
                elif s.get("paths") and s["fill_pattern"] == 0:
                    c["poly"] += 1
                if s["text"]:
                    for part in re.split(r"[\n|]", s["text"]):
                        part = part.strip()
                        if not part:
                            continue
                        k = classify_text(part)
                        c["texts"] += 1
                        c[k] += 1
                        overall[k] += 1
                        samples[k][part] += 1
            lines.append(f"| {d['index']} | {d['name']} | {'Y' if d['background'] else ''} | {len(d['shapes'])} | "
                         f"{c['1d']} | {c['poly']} | {c['texts']} | {c['wire_no']} | {c['device_tag']} | {c['plc_addr']} |")
        lines.append("")
    lines += ["## Text classes (all files)", "", "| class | count | top samples |", "|---|---|---|"]
    for k, n in overall.most_common():
        top = ", ".join(f"`{t}`" for t, _ in samples[k].most_common(25))
        lines.append(f"| {k} | {n} | {top} |")
    lines += ["", "## Masters", ""] + [f"- {m}: {n}" for m, n in masters.most_common()]
    out = raw_dir / "_stats.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    return out
