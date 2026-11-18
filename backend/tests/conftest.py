"""Shared pytest fixtures.

STL-driven tests parametrize over every ``*.stl`` file in
``backend/tests/stl`` -- drop any STL files there and the whole batching
pipeline is exercised against them. If the directory is empty the tests skip.
"""

from __future__ import annotations

from pathlib import Path

import pytest

STL_DIR = Path(__file__).parent / "stl"


def discover_stl_files() -> list[Path]:
    if STL_DIR.is_dir():
        return sorted(p for p in STL_DIR.iterdir() if p.suffix.lower() == ".stl")
    return []


@pytest.fixture(params=discover_stl_files(), ids=[p.name for p in discover_stl_files()])
def stl_file(request: pytest.FixtureRequest) -> Path:
    """Each STL file in backend/tests/stl, one test case per file."""

    return request.param


@pytest.fixture
def stl_files() -> list[Path]:
    """All STL files in backend/tests/stl (skips if none are present)."""

    paths = discover_stl_files()
    if not paths:
        pytest.skip(f"no .stl files in {STL_DIR}")
    return paths
