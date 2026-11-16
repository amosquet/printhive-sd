"""End-to-end batching tests driven by the STL files in backend/tests/stl.

Every ``*.stl`` dropped into ``backend/tests/stl`` is sliced (fixture slicer,
or the real Orca Slicer CLI when configured) and pushed through the full
D-02 pipeline: footprint extraction -> 2D bin-packing -> G-code merging. The
merged plate is then re-parsed and validated: parts stay on the plate, never
overlap, layers interleave, M486 tags are present, and per-job durations and
filament survive into the batch totals (FR-08 / FR-10 inputs).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from fixture_slicer import fixture_slice_stl

from backend.batching import (
    BuildPlate,
    PrintJob,
    SlicerUnavailableError,
    find_orca_slicer,
    parse_gcode,
    plan_batches,
    slice_stl,
)

PLATE = BuildPlate(250.0, 250.0)


def _slicer():
    return fixture_slice_stl


def _overlap(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def test_single_stl_batches_onto_one_plate(stl_file: Path, tmp_path: Path) -> None:
    batches = plan_batches(
        [PrintJob(source=stl_file)], PLATE, margin=1.0, slicer=_slicer(), workdir=tmp_path
    )
    assert len(batches) == 1
    batch = batches[0]
    assert len(batch.items) == 1
    assert "M486 T1" in batch.gcode
    (item,) = batch.items
    x0, y0, x1, y1 = item.footprint_bounds
    assert x0 >= 0 and y0 >= 0 and x1 <= PLATE.width and y1 <= PLATE.height
    # merged file is itself valid, parseable G-code
    reparsed = parse_gcode(batch.gcode, source="merged")
    assert len(reparsed.layers) == len(item.parsed.layers)


def test_all_stls_batch_together(stl_files: list[Path], tmp_path: Path) -> None:
    jobs = [PrintJob(source=p) for p in stl_files]
    batches = plan_batches(jobs, PLATE, margin=1.0, slicer=_slicer(), workdir=tmp_path)
    assert batches, "expected at least one batch"
    placed_total = 0
    for batch in batches:
        assert batch.gcode.count("; EXECUTABLE_BLOCK_START") == 1
        assert f"M486 T{len(batch.items)}" in batch.gcode
        reparsed = parse_gcode(batch.gcode, source="merged")
        bounds = [item.footprint_bounds for item in batch.items]
        for x0, y0, x1, y1 in bounds:
            assert x0 >= -1e-6 and y0 >= -1e-6
            assert x1 <= PLATE.width + 1e-6 and y1 <= PLATE.height + 1e-6
        for i, a in enumerate(bounds):
            for b in bounds[i + 1 :]:
                assert not _overlap(a, b), "placed footprints overlap"
        # merged footprint covers every placed part
        for x0, y0, x1, y1 in bounds:
            assert reparsed.footprint[0] <= x0 + 1e-3
            assert reparsed.footprint[1] <= y0 + 1e-3
            assert reparsed.footprint[2] >= x1 - 1e-3
            assert reparsed.footprint[3] >= y1 - 1e-3
        # FR-08/FR-10: per-job durations and filament roll up into the batch
        assert batch.total_duration_s == pytest.approx(
            sum(i.parsed.duration_s or 0.0 for i in batch.items)
        )
        assert batch.total_filament_mm == pytest.approx(
            sum(i.parsed.filament_mm or 0.0 for i in batch.items)
        )
        assert 0.0 < batch.utilization <= 1.0
        # M486 tag per part per layer in the merged file
        tags = re.findall(r"^M486 S(\d+)", batch.gcode, flags=re.MULTILINE)
        assert len(tags) == sum(len(i.parsed.layers) for i in batch.items)
        placed_total += len(batch.items)
    assert placed_total == len(stl_files)


def test_cached_gcode_is_never_resliced(tmp_path: Path, stl_file: Path) -> None:
    gcode_path = fixture_slice_stl(stl_file, tmp_path / "sliced")

    def forbidden_slicer(src: Path, out: Path) -> Path:
        raise AssertionError("slicer must not be called when gcode_path is set")

    batches = plan_batches(
        [PrintJob(source=stl_file, gcode_path=gcode_path)],
        PLATE,
        slicer=forbidden_slicer,
        workdir=tmp_path,
    )
    assert len(batches) == 1


def test_repeated_plan_batches_reuses_cache_without_reslicing(tmp_path: Path, stl_file: Path) -> None:
    calls = 0

    def counting_slicer(src: Path, out: Path) -> Path:
        nonlocal calls
        calls += 1
        return fixture_slice_stl(src, out)

    job = PrintJob(source=stl_file)
    plan_batches([job], PLATE, slicer=counting_slicer, workdir=tmp_path)
    assert calls == 1
    assert job.gcode_path is not None and job.gcode_path.exists()

    # Re-running with the same PrintJob or a fresh PrintJob against the same workdir
    # must reuse the cached slice and never invoke the slicer again.
    plan_batches([job], PLATE, slicer=counting_slicer, workdir=tmp_path)
    plan_batches([PrintJob(source=stl_file)], PLATE, slicer=counting_slicer, workdir=tmp_path)
    assert calls == 1


def test_rotated_placements_never_collide_or_overflow(tmp_path: Path) -> None:
    box = Path(__file__).parent / "stl" / "box_40x60x8.stl"
    jobs = [PrintJob(source=box, name=f"box_{i}") for i in range(7)]
    batches = plan_batches(jobs, margin=1.0, slicer=_slicer(), workdir=tmp_path)
    assert len(batches) == 1
    batch = batches[0]
    assert any(item.placement.rotated for item in batch.items)
    bounds = [item.footprint_bounds for item in batch.items]
    for x0, y0, x1, y1 in bounds:
        assert x0 >= -1e-6 and y0 >= -1e-6
        assert x1 <= batch.plate.width + 1e-6 and y1 <= batch.plate.height + 1e-6
    for i, a in enumerate(bounds):
        for b in bounds[i + 1 :]:
            assert not _overlap(a, b), f"rotated footprints collide: {a} vs {b}"
    reparsed = parse_gcode(batch.gcode, source="merged-7-boxes")
    assert reparsed.footprint[2] <= batch.plate.width + 1e-3
    assert reparsed.footprint[3] <= batch.plate.height + 1e-3


def _write_box_stl(path: Path, sx: float, sy: float, sz: float) -> Path:
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


def test_oversize_parts_split_into_multiple_plates(tmp_path: Path) -> None:
    # two plates-worth of model: 240x240 boxes (+ skirt) cannot share a 250 plate
    big = _write_box_stl(tmp_path / "big.stl", 240.0, 240.0, 10.0)
    jobs = [PrintJob(source=big, name="big_a"), PrintJob(source=big, name="big_b")]
    batches = plan_batches(jobs, PLATE, margin=1.0, slicer=_slicer(), workdir=tmp_path)
    assert len(batches) == 2
    for batch in batches:
        assert len(batch.items) == 1


def test_incompatible_profiles_never_share_a_plate(stl_files: list[Path], tmp_path: Path) -> None:
    jobs = [
        PrintJob(source=stl_files[0], profile="draft"),
        PrintJob(source=stl_files[0], profile="high_strength"),
    ]
    batches = plan_batches(jobs, PLATE, margin=1.0, slicer=_slicer(), workdir=tmp_path)
    assert len(batches) == 2  # FR-05: same profile required to batch


def test_slicer_unavailable_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, stl_file: Path) -> None:
    import backend.batching.slicer as slicer_mod

    monkeypatch.delenv("PRINTHIVE_ORCA_SLICER", raising=False)
    monkeypatch.setattr(slicer_mod.shutil, "which", lambda name: None)
    monkeypatch.setattr(slicer_mod, "DEFAULT_MACOS_BUNDLE", tmp_path / "nonexistent")
    assert find_orca_slicer() is None
    with pytest.raises(SlicerUnavailableError):
        slice_stl(stl_file, tmp_path / "out")


# --- optional real-OrcaSlicer end-to-end test -----------------------------
# Runs when an Orca binary is locatable, using the pinned presets committed in
# backend/profiles/ (env vars PRINTHIVE_ORCA_DATADIR / PRINTHIVE_ORCA_SETTINGS
# override them). CI skips it because no Orca binary exists there.


def _orca_slicer():
    binary = find_orca_slicer()
    if binary is None:
        return None
    datadir = os.environ.get("PRINTHIVE_ORCA_DATADIR")
    settings = os.environ.get("PRINTHIVE_ORCA_SETTINGS")

    def run(stl_path: Path, output_dir: Path) -> Path:
        return slice_stl(stl_path, output_dir, binary=binary, settings=settings, datadir=datadir)

    return run


def test_orca_slicer_end_to_end(stl_file: Path, tmp_path: Path) -> None:
    slicer = _orca_slicer()
    if slicer is None:
        pytest.skip("Orca Slicer CLI not found on this machine")
    try:
        batches = plan_batches(
            [PrintJob(source=stl_file)], PLATE, margin=1.0, slicer=slicer, workdir=tmp_path
        )
    except Exception as exc:  # noqa: BLE001 - skip when local Orca setup can't slice
        pytest.skip(f"Orca Slicer could not slice {stl_file.name} here: {exc}")
    assert len(batches) == 1
    batch = batches[0]
    reparsed = parse_gcode(batch.gcode, source="merged-orca")
    (item,) = batch.items
    x0, y0, x1, y1 = item.footprint_bounds
    assert x0 >= -1e-6 and y0 >= -1e-6 and x1 <= PLATE.width and y1 <= PLATE.height
    assert len(reparsed.layers) == len(item.parsed.layers)
    assert item.parsed.duration_s is not None and item.parsed.duration_s > 0


def test_orca_slicer_multi_stl_batch_end_to_end(stl_files: list[Path], tmp_path: Path) -> None:
    slicer = _orca_slicer()
    if slicer is None:
        pytest.skip("Orca Slicer CLI not found on this machine")
    try:
        batches = plan_batches(
            [PrintJob(source=p) for p in stl_files],
            margin=1.0,
            slicer=slicer,
            workdir=tmp_path,
        )
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Orca Slicer could not slice batch here: {exc}")
    assert len(batches) == 1
    batch = batches[0]
    assert len(batch.items) == len(stl_files)
    assert f"M486 T{len(stl_files)}" in batch.gcode
    reparsed = parse_gcode(batch.gcode, source="merged-orca-batch")
    bounds = [item.footprint_bounds for item in batch.items]
    for i, a in enumerate(bounds):
        assert a[0] >= -1e-6 and a[1] >= -1e-6
        assert a[2] <= batch.plate.width + 1e-6 and a[3] <= batch.plate.height + 1e-6
        for b in bounds[i + 1 :]:
            assert not _overlap(a, b)
    assert reparsed.footprint[2] <= batch.plate.width + 1e-3
    assert reparsed.footprint[3] <= batch.plate.height + 1e-3


def test_per_printer_plate_sizes(stl_file: Path, tmp_path: Path) -> None:
    from backend.batching import plate_for_printer

    assert plate_for_printer("prusa-mk4").width == 250.0
    assert plate_for_printer("prusa-mk4").height == 210.0
    assert (plate_for_printer("prusa-core-one+").width, plate_for_printer("prusa-core-one+").height) == (250.0, 220.0)
    assert (plate_for_printer("Prusa Core One+").width, plate_for_printer("Prusa Core One+").height) == (250.0, 220.0)
    assert (plate_for_printer("bambu-h2d-pro").width, plate_for_printer("bambu-h2d-pro").height) == (350.0, 320.0)
    assert (plate_for_printer("Bambu H2D Pro").width, plate_for_printer("Bambu H2D Pro").height) == (350.0, 320.0)
    assert plate_for_printer("bambu-x1c").width == 256.0
    assert plate_for_printer("unknown-printer").width == 250.0
    # jobs on different printers are packed onto their own plates
    jobs = [
        PrintJob(source=stl_file, name="a", printer="prusa-mk4"),
        PrintJob(source=stl_file, name="b", printer="bambu-x1c"),
    ]
    batches = plan_batches(jobs, margin=1.0, slicer=_slicer(), workdir=tmp_path)
    assert len(batches) == 2
    plates = {(b.plate.width, b.plate.height) for b in batches}
    assert plates == {(250.0, 210.0), (256.0, 256.0)}


@pytest.mark.parametrize(
    ("printer", "w", "h"),
    [
        ("prusa-core-one+", 250.0, 220.0),
        ("bambu-h2d-pro", 350.0, 320.0),
    ],
)
def test_full_build_plate_area_core_one_plus_and_h2d_pro(
    printer: str, w: float, h: float, tmp_path: Path
) -> None:
    full_stl = _write_box_stl(tmp_path / f"{printer}_full.stl", w, h, 0.4)
    batches = plan_batches(
        [PrintJob(source=full_stl, printer=printer)],
        margin=1.0,
        slicer=_slicer(),
        workdir=tmp_path / "fixture",
    )
    assert len(batches) == 1
    assert (batches[0].plate.width, batches[0].plate.height) == (w, h)
    assert batches[0].items[0].footprint_bounds == pytest.approx((0.0, 0.0, w, h), abs=1.0)

    if find_orca_slicer() is None:
        return
    orca_batches = plan_batches(
        [PrintJob(source=full_stl, printer=printer)],
        margin=1.0,
        workdir=tmp_path / "orca",
    )
    assert len(orca_batches) == 1
    (item,) = orca_batches[0].items
    x0, y0, x1, y1 = item.footprint_bounds
    assert x0 == pytest.approx(0.0, abs=1e-3) and y0 == pytest.approx(0.0, abs=1e-3)
    assert x1 == pytest.approx(w, abs=1.0) and y1 == pytest.approx(h, abs=1.0)
