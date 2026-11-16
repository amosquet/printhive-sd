"""Unit tests for the 2D MaxRects bin-packer."""

from __future__ import annotations

import pytest

from backend.batching.packing import Rect, pack_into_plates, pack_rectangles


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def test_single_rect_fits_at_origin() -> None:
    placements = pack_rectangles([Rect(10, 20)], 250, 250, margin=1.0)
    assert placements is not None
    (p,) = placements
    assert (p.x, p.y) == (0.0, 0.0)
    assert (p.w, p.h) == (10, 20)


def test_two_rects_fit_without_overlap() -> None:
    rects = [Rect(100, 100), Rect(100, 100)]
    placements = pack_rectangles(rects, 250, 250, margin=2.0)
    assert placements is not None
    assert len(placements) == 2
    for p in placements:
        _, _, x1, y1 = p.bounds()
        assert x1 <= 250 and y1 <= 250
    assert not _overlaps(placements[0].bounds(), placements[1].bounds())


def test_rotation_used_when_needed() -> None:
    # 200x60 only fits a 100x250 plate if rotated to 60x200
    placements = pack_rectangles([Rect(200, 60)], 100, 250, margin=0.0, allow_rotation=True)
    assert placements is not None
    assert placements[0].rotated
    assert (placements[0].w, placements[0].h) == (60, 200)
    no_rotation = pack_rectangles([Rect(200, 60)], 100, 250, margin=0.0, allow_rotation=False)
    assert no_rotation is None


def test_oversize_rect_returns_none() -> None:
    assert pack_rectangles([Rect(300, 10)], 250, 250) is None
    assert pack_rectangles([Rect(10, 10), Rect(300, 10)], 250, 250) is None


def test_margin_keeps_parts_apart() -> None:
    margin = 5.0
    rects = [Rect(50, 50)] * 4
    placements = pack_rectangles(rects, 250, 250, margin=margin)
    assert placements is not None and len(placements) == 4
    for i, a in enumerate(placements):
        for b in placements[i + 1 :]:
            ax0, ay0, ax1, ay1 = a.bounds()
            bx0, by0, bx1, by1 = b.bounds()
            gap_x = max(bx0 - ax1, ax0 - bx1)
            gap_y = max(by0 - ay1, ay0 - by1)
            assert max(gap_x, gap_y) >= margin - 1e-9


def test_pack_into_plates_splits_when_full() -> None:
    # two 200x200 footprints cannot share a 250x250 plate
    rects = [Rect(200, 200), Rect(200, 200), Rect(20, 20)]
    plates = pack_into_plates(rects, 250, 250, margin=1.0)
    assert len(plates) == 2
    assert sorted(len(p) for p in plates) == [1, 2]
    for plate in plates:
        for i, a in enumerate(plate):
            assert a.bounds()[2] <= 250 and a.bounds()[3] <= 250
            for b in plate[i + 1 :]:
                assert not _overlaps(a.bounds(), b.bounds())


def test_rect_too_big_for_plate_raises() -> None:
    with pytest.raises(ValueError):
        pack_into_plates([Rect(500, 500)], 250, 250)


def test_deterministic() -> None:
    rects = [Rect(30, 40), Rect(60, 20), Rect(25, 25), Rect(80, 50), Rect(15, 15)]
    a = pack_rectangles(rects, 250, 250, margin=1.0)
    b = pack_rectangles(rects, 250, 250, margin=1.0)
    assert a == b


def test_maxrects_splits_partially_overlapping_free_rects() -> None:
    rects = [Rect(80, 160), Rect(150, 80), Rect(60, 180)]
    placements = pack_rectangles(rects, 200, 240, margin=0.0, allow_rotation=False)
    # 60x180 cannot fit without overlapping 150x80 once 80x160 and 150x80 are placed
    assert placements is None
    plates = pack_into_plates(rects, 200, 240, margin=0.0, allow_rotation=False)
    for plate in plates:
        for i, a in enumerate(plate):
            for b in plate[i + 1 :]:
                assert not _overlaps(a.bounds(), b.bounds())


def test_full_plate_rect_fits_even_with_positive_margin() -> None:
    for w, h in [(250.0, 220.0), (350.0, 320.0)]:
        placements = pack_rectangles([Rect(w, h)], w, h, margin=2.0)
        assert placements is not None
        assert placements[0].bounds() == (0.0, 0.0, w, h)


@pytest.mark.parametrize("seed", range(10))
def test_randomized_packing_invariants(seed: int) -> None:
    import random

    rng = random.Random(seed)
    rects = [Rect(rng.uniform(10.0, 90.0), rng.uniform(10.0, 90.0)) for _ in range(40)]
    plate_w, plate_h, margin = 250.0, 210.0, 1.5
    plates = pack_into_plates(rects, plate_w, plate_h, margin=margin, allow_rotation=True)
    seen_indices: set[int] = set()
    for plate in plates:
        for i, a in enumerate(plate):
            seen_indices.add(a.index)
            orig = rects[a.index]
            expected_dims = (orig.h, orig.w) if a.rotated else (orig.w, orig.h)
            assert (a.w, a.h) == pytest.approx(expected_dims)
            ax0, ay0, ax1, ay1 = a.bounds()
            assert ax0 >= -1e-6 and ay0 >= -1e-6
            assert ax1 <= plate_w + 1e-6 and ay1 <= plate_h + 1e-6
            for b in plate[i + 1 :]:
                bx0, by0, bx1, by1 = b.bounds()
                gap_x = max(bx0 - ax1, ax0 - bx1)
                gap_y = max(by0 - ay1, ay0 - by1)
                assert max(gap_x, gap_y) >= margin - 1e-6
    assert seen_indices == set(range(len(rects)))
