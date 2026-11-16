"""2D rectangle bin-packing onto the build plate (FR-11, SYS-06).

Footprints are extrusion-path bounding boxes (brim/skirt included, see
:mod:`backend.batching.gcode`), so rectangle packing with 90-degree rotation is
the placement primitive of design D-02. The packer is a MaxRects
best-short-side-fit implementation: deterministic, dependency-free, and fast
enough to re-run on every scheduling tick (the "dynamic" in SYS-06).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Rect:
    """A footprint rectangle (width, height) in mm."""

    w: float
    h: float


@dataclass(frozen=True)
class Placement:
    """Where a rectangle was placed on the plate."""

    index: int  # index into the input rect list
    x: float
    y: float
    rotated: bool
    w: float  # placed width (after rotation)
    h: float  # placed height (after rotation)

    def bounds(self) -> tuple[float, float, float, float]:
        """(min_x, min_y, max_x, max_y) of the placed rectangle."""

        return (self.x, self.y, self.x + self.w, self.y + self.h)


def _split_free(free: tuple[float, float, float, float], used: tuple[float, float, float, float]) -> list[tuple[float, float, float, float]]:
    """Split a free rectangle around an intersecting used rectangle (MaxRects split)."""

    fx, fy, fw, fh = free
    ux, uy, uw, uh = used
    out: list[tuple[float, float, float, float]] = []
    if ux + uw < fx + fw - 1e-9:
        out.append((ux + uw, fy, fx + fw - (ux + uw), fh))
    if uy + uh < fy + fh - 1e-9:
        out.append((fx, uy + uh, fw, fy + fh - (uy + uh)))
    if ux > fx + 1e-9:
        out.append((fx, fy, ux - fx, fh))
    if uy > fy + 1e-9:
        out.append((fx, fy, fw, uy - fy))
    return out


def _intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw - 1e-9 and ax + aw > bx + 1e-9 and ay < by + bh - 1e-9 and ay + ah > by + 1e-9


def _contained(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return bx <= ax + 1e-9 and by <= ay + 1e-9 and ax + aw <= bx + bw + 1e-9 and ay + ah <= by + bh + 1e-9


class PlatePacker:
    """Incrementally packs rectangles onto one plate; used to fill plates greedily."""

    def __init__(self, plate_w: float, plate_h: float, margin: float = 0.0) -> None:
        if plate_w <= 0 or plate_h <= 0:
            raise ValueError("plate dimensions must be positive")
        self.plate_w = plate_w
        self.plate_h = plate_h
        self.margin = margin
        self.free: list[tuple[float, float, float, float]] = [(0.0, 0.0, plate_w, plate_h)]
        self.placements: list[Placement] = []

    def _candidate(self, index: int, rect: Rect, allow_rotation: bool) -> Placement | None:
        best: Placement | None = None
        best_score: tuple[float, float] | None = None
        for w, h, rotated in (
            [(rect.w, rect.h, False), (rect.h, rect.w, True)] if allow_rotation else [(rect.w, rect.h, False)]
        ):
            for fx, fy, fw, fh in self.free:
                if w <= fw + 1e-9 and h <= fh + 1e-9:
                    leftover_h = fw - w
                    leftover_v = fh - h
                    short_side = min(leftover_h, leftover_v)
                    long_side = max(leftover_h, leftover_v)
                    score = (short_side, long_side)
                    if best_score is None or score < best_score:
                        best_score = score
                        best = Placement(index=index, x=fx, y=fy, rotated=rotated, w=w, h=h)
        return best

    def place(self, index: int, rect: Rect, allow_rotation: bool = True) -> Placement | None:
        """Place a rectangle; returns the placement or None if it does not fit."""

        placement = self._candidate(index, rect, allow_rotation)
        if placement is None:
            return None
        used = (
            placement.x - self.margin,
            placement.y - self.margin,
            placement.w + 2 * self.margin,
            placement.h + 2 * self.margin,
        )
        new_free: list[tuple[float, float, float, float]] = []
        for free in self.free:
            if _intersects(free, used):
                new_free.extend(_split_free(free, used))
            else:
                new_free.append(free)
        # drop free rects contained in others (keeping one copy when identical)
        pruned: list[tuple[float, float, float, float]] = []
        for i, a in enumerate(new_free):
            if any(
                i != j and _contained(a, b) and (not _contained(b, a) or j < i)
                for j, b in enumerate(new_free)
            ):
                continue
            pruned.append(a)
        self.free = pruned
        self.placements.append(placement)
        return placement


def pack_rectangles(
    rects: list[Rect],
    plate_w: float,
    plate_h: float,
    margin: float = 0.0,
    allow_rotation: bool = True,
) -> list[Placement] | None:
    """Pack all rectangles onto one plate. Returns placements, or None if they do not fit."""

    packer = PlatePacker(plate_w, plate_h, margin)
    order = sorted(range(len(rects)), key=lambda i: (rects[i].w * rects[i].h, max(rects[i].w, rects[i].h)), reverse=True)
    placements: list[Placement | None] = [None] * len(rects)
    for i in order:
        placement = packer.place(i, rects[i], allow_rotation)
        if placement is None:
            return None
        placements[i] = placement
    return [p for p in placements if p is not None]


def pack_into_plates(
    rects: list[Rect],
    plate_w: float,
    plate_h: float,
    margin: float = 0.0,
    allow_rotation: bool = True,
) -> list[list[Placement]]:
    """Greedily pack rectangles into as few plates as needed (first-fit decreasing)."""

    order = sorted(range(len(rects)), key=lambda i: (rects[i].w * rects[i].h, max(rects[i].w, rects[i].h)), reverse=True)
    plates: list[PlatePacker] = []
    result: list[list[Placement]] = []
    for i in order:
        placed = False
        for packer in plates:
            placement = packer.place(i, rects[i], allow_rotation)
            if placement is not None:
                result[plates.index(packer)].append(placement)
                placed = True
                break
        if not placed:
            packer = PlatePacker(plate_w, plate_h, margin)
            placement = packer.place(i, rects[i], allow_rotation)
            if placement is None:
                raise ValueError(
                    f"rectangle {rects[i].w}x{rects[i].h}mm (+{margin}mm margin) "
                    f"does not fit on a {plate_w}x{plate_h}mm plate"
                )
            plates.append(packer)
            result.append([placement])
    return result
