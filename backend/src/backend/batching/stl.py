"""Minimal STL (ASCII + binary) loading used to derive mesh bounding boxes.

The production slicing path is the Orca Slicer CLI (SYS-11); this module only
reads geometry so the backend can validate build-volume fit (FR-03) and hand
models to the slicer. It is intentionally dependency-free.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

Vertex = tuple[float, float, float]
Triangle = tuple[Vertex, Vertex, Vertex]
BoundingBox = tuple[Vertex, Vertex]  # (min, max)


@dataclass(frozen=True)
class Mesh:
    """A triangle mesh loaded from an STL file."""

    triangles: tuple[Triangle, ...]
    source: str = ""

    @property
    def bounding_box(self) -> BoundingBox:
        if not self.triangles:
            raise ValueError("mesh has no triangles")
        xs: list[float] = []
        ys: list[float] = []
        zs: list[float] = []
        for tri in self.triangles:
            for x, y, z in tri:
                xs.append(x)
                ys.append(y)
                zs.append(z)
        return (
            (min(xs), min(ys), min(zs)),
            (max(xs), max(ys), max(zs)),
        )

    @property
    def dimensions(self) -> Vertex:
        lo, hi = self.bounding_box
        return (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])


def _looks_ascii(data: bytes) -> bool:
    head = data[:512].lstrip()
    return head.startswith(b"solid") and b"facet" in data[:512]


def _parse_ascii(text: str, source: str) -> Mesh:
    triangles: list[Triangle] = []
    verts: list[Vertex] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.lower().startswith("vertex"):
            parts = line.split()
            if len(parts) != 4:
                raise ValueError(f"malformed vertex line in {source}: {raw!r}")
            verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
            if len(verts) == 3:
                triangles.append((verts[0], verts[1], verts[2]))
                verts = []
    if not triangles:
        raise ValueError(f"no triangles found in ASCII STL {source}")
    return Mesh(tuple(triangles), source=source)


def _parse_binary(data: bytes, source: str) -> Mesh:
    if len(data) < 84:
        raise ValueError(f"binary STL {source} is too short")
    (count,) = struct.unpack_from("<I", data, 80)
    expected = 84 + count * 50
    if len(data) < expected:
        raise ValueError(
            f"binary STL {source} truncated: expected {expected} bytes, got {len(data)}"
        )
    triangles: list[Triangle] = []
    offset = 84
    for _ in range(count):
        values = struct.unpack_from("<12fH", data, offset)
        v = values[3:12]
        triangles.append(
            (
                (v[0], v[1], v[2]),
                (v[3], v[4], v[5]),
                (v[6], v[7], v[8]),
            )
        )
        offset += 50
    if not triangles:
        raise ValueError(f"no triangles found in binary STL {source}")
    return Mesh(tuple(triangles), source=source)


def load_stl(path: str | Path) -> Mesh:
    """Load an STL file (ASCII or binary) into a :class:`Mesh`."""

    p = Path(path)
    data = p.read_bytes()
    if _looks_ascii(data):
        return _parse_ascii(data.decode("utf-8", errors="replace"), source=str(p))
    return _parse_binary(data, source=str(p))


def write_binary_stl(mesh: Mesh, path: str | Path) -> None:
    """Write a mesh as a binary STL (used by tests and tooling)."""

    p = Path(path)
    with p.open("wb") as fh:
        fh.write(b"\0" * 80)
        fh.write(struct.pack("<I", len(mesh.triangles)))
        for tri in mesh.triangles:
            fh.write(struct.pack("<3f", 0.0, 0.0, 0.0))
            for vertex in tri:
                fh.write(struct.pack("<3f", *vertex))
            fh.write(struct.pack("<H", 0))
