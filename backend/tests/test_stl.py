"""STL loading tests, parametrized over every file in backend/tests/stl."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.batching.stl import Mesh, load_stl, write_binary_stl


def test_stl_file_loads(stl_file: Path) -> None:
    mesh = load_stl(stl_file)
    assert len(mesh.triangles) > 0
    lo, hi = mesh.bounding_box
    assert all(hi[i] > lo[i] for i in range(3)), f"{stl_file.name} has degenerate bbox"


def test_stl_file_dimensions_match_name(stl_file: Path) -> None:
    mesh = load_stl(stl_file)
    w, h, d = mesh.dimensions
    if stl_file.name == "cube_20mm.stl":
        assert (w, h, d) == pytest.approx((20.0, 20.0, 20.0), abs=1e-3)
    if stl_file.name == "box_40x60x8.stl":
        assert (w, h, d) == pytest.approx((40.0, 60.0, 8.0), abs=1e-3)
    if stl_file.name == "cylinder_r15_h10.stl":
        assert (w, h, d) == pytest.approx((30.0, 30.0, 10.0), abs=1e-3)


def test_binary_roundtrip(tmp_path: Path, stl_file: Path) -> None:
    mesh = load_stl(stl_file)
    out = tmp_path / "roundtrip.stl"
    write_binary_stl(mesh, out)
    reloaded = load_stl(out)
    lo_a, hi_a = mesh.bounding_box
    lo_b, hi_b = reloaded.bounding_box
    assert lo_b == pytest.approx(lo_a)
    assert hi_b == pytest.approx(hi_a)


def test_ascii_and_binary_agree(tmp_path: Path, stl_file: Path) -> None:
    mesh = load_stl(stl_file)
    binary = tmp_path / "as_binary.stl"
    write_binary_stl(mesh, binary)
    assert load_stl(binary).dimensions == pytest.approx(mesh.dimensions)


def test_empty_file_rejected(tmp_path: Path) -> None:
    bad = tmp_path / "empty.stl"
    bad.write_bytes(b"\0" * 84)  # binary header claiming 0 triangles
    with pytest.raises(ValueError):
        load_stl(bad)


def test_mesh_bounding_box_of_empty_mesh() -> None:
    mesh = Mesh(triangles=())
    with pytest.raises(ValueError):
        _ = mesh.bounding_box
