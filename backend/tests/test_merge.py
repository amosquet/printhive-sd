"""Tests for the slice-once G-code merger (offsets, interleaving, M486)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fixture_slicer import generate_gcode

from backend.batching.gcode import parse_gcode
from backend.batching.merge import IncompatibleLayersError, load_part, merge_parts
from backend.batching.packing import Placement, Rect, pack_rectangles


def _box_stl(path: Path, sx: float, sy: float, sz: float) -> Path:
    v = [(0, 0, 0), (sx, 0, 0), (sx, sy, 0), (0, sy, 0), (0, 0, sz), (sx, 0, sz), (sx, sy, sz), (0, sy, sz)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    with path.open("w") as fh:
        fh.write(f"solid {path.stem}\n")
        for a, b, c in f:
            fh.write("  facet normal 0 0 1\n    outer loop\n")
            for p in (v[a], v[b], v[c]):
                fh.write(f"      vertex {p[0]} {p[1]} {p[2]}\n")
            fh.write("    endloop\n  endfacet\n")
        fh.write(f"endsolid {path.stem}\n")
    return path


def _placed_parts(
    tmp_path: Path, sizes: list[tuple[float, float, float]], plate=(250.0, 250.0), margin=1.0
) -> tuple[list, list[Placement]]:
    """Fixture-slice box STLs, pack their footprints, return parts with plate offsets."""

    parsed = []
    rects = []
    for i, (sx, sy, sz) in enumerate(sizes):
        stl = _box_stl(tmp_path / f"part{i}.stl", sx, sy, sz)
        pg = parse_gcode(generate_gcode(stl), source=stl.name)
        parsed.append((stl, pg))
        rects.append(Rect(w=pg.footprint_size()[0], h=pg.footprint_size()[1]))
    placements = pack_rectangles(rects, plate[0], plate[1], margin=margin)
    assert placements is not None
    parts = []
    for placement in placements:
        stl, pg = parsed[placement.index]
        fp = pg.footprint
        parts.append(
            load_part(
                placement.index,
                stl.stem,
                generate_gcode(stl),
                dx=placement.x - fp[0],
                dy=placement.y - fp[1],
                rotated=placement.rotated,
            )
        )
    return parts, placements


def _translated_footprints(parts, placements) -> list[tuple[float, float, float, float]]:
    out = []
    for part, _placement in zip(parts, placements):
        min_x, min_y, max_x, max_y = part.parsed.footprint
        w, h = max_x - min_x, max_y - min_y
        if part.rotated:
            w, h = h, w
        x0, y0 = min_x + part.dx, min_y + part.dy
        out.append((x0, y0, x0 + w, y0 + h))
    return out


def test_merge_produces_single_start_and_end(tmp_path: Path) -> None:
    parts, _ = _placed_parts(tmp_path, [(20, 20, 4), (30, 10, 4)])
    merged = merge_parts(parts)
    assert merged.count("; EXECUTABLE_BLOCK_START") == 1
    assert merged.count("; EXECUTABLE_BLOCK_END") == 1
    assert merged.count("\nM83") == 1  # shared start sequence emitted once
    assert merged.count("\nM84") == 1  # shared end sequence emitted once
    assert "M486 T2" in merged


def test_merge_interleaves_layers_and_tags_objects(tmp_path: Path) -> None:
    parts, _ = _placed_parts(tmp_path, [(20, 20, 4), (30, 10, 4)])
    merged = merge_parts(parts)
    tags = re.findall(r"^M486 S(\d+)", merged, flags=re.MULTILINE)
    zs = re.findall(r"^;Z:([\d.]+)", merged, flags=re.MULTILINE)
    n_layers = len(parts[0].parsed.layers)
    assert len(tags) == 2 * n_layers
    # layer interleaving: both parts' layer 0 before any layer 1
    assert tags[:4] == ["0", "1", "0", "1"]
    assert zs[0] == zs[1] and zs[2] == zs[3] and float(zs[2]) > float(zs[0])


def test_merge_applies_offsets_and_keeps_footprints_apart(tmp_path: Path) -> None:
    parts, placements = _placed_parts(tmp_path, [(40, 40, 4), (40, 40, 4)])
    merged = merge_parts(parts)
    reparsed = parse_gcode(merged, source="merged")
    translated = _translated_footprints(parts, placements)
    assert reparsed.footprint[0] == pytest.approx(min(t[0] for t in translated), abs=1e-3)
    assert reparsed.footprint[1] == pytest.approx(min(t[1] for t in translated), abs=1e-3)
    assert reparsed.footprint[2] == pytest.approx(max(t[2] for t in translated), abs=1e-3)
    assert reparsed.footprint[3] == pytest.approx(max(t[3] for t in translated), abs=1e-3)
    for t in translated:
        assert t[0] >= -1e-6 and t[1] >= -1e-6 and t[2] <= 250 and t[3] <= 250
    for i, a in enumerate(translated):
        for b in translated[i + 1 :]:
            overlap = a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
            assert not overlap


def test_merge_rejects_mismatched_layer_heights(tmp_path: Path) -> None:
    stl_a = _box_stl(tmp_path / "a.stl", 20, 20, 4)
    stl_b = _box_stl(tmp_path / "b.stl", 20, 20, 4)
    text_a = generate_gcode(stl_a, layer_height=0.2)
    text_b = generate_gcode(stl_b, layer_height=0.3)  # different layer grid
    parts = [load_part(0, "a", text_a, 0.0, 0.0), load_part(1, "b", text_b, 30.0, 0.0)]
    with pytest.raises(IncompatibleLayersError):
        merge_parts(parts)


def test_merge_different_layer_counts_ok_on_same_grid(tmp_path: Path) -> None:
    stl_a = _box_stl(tmp_path / "a.stl", 20, 20, 4.0)  # 20 layers @ 0.2
    stl_b = _box_stl(tmp_path / "b.stl", 20, 20, 1.0)  # 5 layers @ 0.2
    parts = [
        load_part(0, "a", generate_gcode(stl_a), 0.0, 0.0),
        load_part(1, "b", generate_gcode(stl_b), 30.0, 0.0),
    ]
    merged = merge_parts(parts)
    assert "M486 T2" in merged
    reparsed = parse_gcode(merged, source="merged")
    assert len(reparsed.layers) == 20


def test_merge_rotates_gcode_when_placement_is_rotated(tmp_path: Path) -> None:
    # 40x60 box (+ 3mm skirt -> 46x66) on a 100x50 plate only fits when rotated to 66x46
    parts, placements = _placed_parts(tmp_path, [(40, 60, 4)], plate=(100.0, 50.0), margin=0.0)
    assert placements[0].rotated
    merged = merge_parts(parts)
    reparsed = parse_gcode(merged, source="merged-rotated")
    assert reparsed.footprint == pytest.approx((0.0, 0.0, 66.0, 46.0), abs=1e-3)
    assert not any(ln.startswith("M486 S") for ln in reparsed.start_lines)
