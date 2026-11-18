import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier

import pytest
from fixture_slicer import fixture_slice_stl

from backend.batching.gcode import ParsedGcode
from backend.batching.packing import Placement
from backend.batching.pipeline import (
    Batch,
    BuildPlate,
    PlacedJob,
    PrintJob,
    plan_batches,
)
from backend.dispatch import DispatchStore
from backend.priority_scheduling import PriorityPolicy, QueuedJob, StaffShift

NOW = datetime(2026, 1, 1, 12, tzinfo=UTC)
POLICY = PriorityPolicy(aging_per_hour=0)
SHIFTS = [StaffShift(NOW - timedelta(hours=1), NOW + timedelta(hours=1))]


def job(identifier, priority, duration=60):
    return QueuedJob(identifier, NOW - timedelta(minutes=1), priority, duration)


def tick(store):
    return store.claim_next(SHIFTS, now=NOW, policy=POLICY)


def test_competing_schedulers_claim_only_one_job_and_printer(tmp_path):
    path = str(tmp_path / "dispatch.db")
    store = DispatchStore(path)
    store.enqueue(job("low", 1))
    store.enqueue(job("high", 10))
    store.confirm_bed_clear()
    barrier = Barrier(2)

    def run(_):
        other = DispatchStore(path)
        barrier.wait(timeout=5)
        return tick(other)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, range(2)))
    assert [result.job_id for result in results if result] == ["high"]
    assert tick(store) is None
    with pytest.raises(ValueError):
        store.finish_simulated_print("low")
    with closing(sqlite3.connect(path)) as db:
        assert db.execute(
            "SELECT state FROM dispatch_units WHERE id = 'high'"
        ).fetchone() == ("claimed",)
        assert db.execute(
            "SELECT available, bed_clear, claimed_id FROM simulated_printer"
        ).fetchone() == (0, 0, "high")
    store.finish_simulated_print("high")
    with closing(sqlite3.connect(path)) as db:
        assert db.execute(
            "SELECT state FROM dispatch_units WHERE id = 'high'"
        ).fetchone() == ("completed",)
        assert db.execute(
            "SELECT available, bed_clear, claimed_id FROM simulated_printer"
        ).fetchone() == (1, 0, None)
    assert tick(store) is None  # completion does not confirm the bed
    store.confirm_bed_clear()
    assert tick(store).job_id == "low"


def test_eligibility_and_staff_confirmation(tmp_path):
    store = DispatchStore(str(tmp_path / "dispatch.db"))
    for identifier, priority, duration in [
        ("unknown", 100, None),
        ("equal", 90, 3600),
        ("negative", 80, -1),
        ("good", 1, 3599),
    ]:
        store.enqueue(job(identifier, priority, duration))
    assert tick(store) is None
    store.confirm_bed_clear()
    assert tick(store).job_id == "good"
    with pytest.raises(ValueError):
        store.confirm_bed_clear()
    store.finish_simulated_print("good")
    store.confirm_bed_clear()
    assert tick(store) is None


def test_batches_use_member_durations_and_same_claim_path(tmp_path):
    def batch(durations):
        items = [
            PlacedJob(
                PrintJob(source=f"{i}.stl"),
                ParsedGcode([], [], [], None, duration, None),
                Placement(i, 0, 0, 1, 1, False),
            )
            for i, duration in enumerate(durations)
        ]
        return Batch(BuildPlate(), items)

    store = DispatchStore(str(tmp_path / "dispatch.db"))
    store.enqueue_batch(
        batch([50, None]), batch_id="unknown", submitted_at=NOW, initial_priority=100
    )
    stl = Path(__file__).with_name("stl") / "cube_20mm.stl"
    (sliced_batch,) = plan_batches(
        [PrintJob(source=stl, name=name) for name in ("cube-left", "cube-right")],
        slicer=fixture_slice_stl,
        workdir=tmp_path,
    )
    assert len(sliced_batch.items) == 2
    store.enqueue_batch(
        sliced_batch, batch_id="batch", submitted_at=NOW, initial_priority=2
    )
    store.enqueue(job("single", 1))
    store.confirm_bed_clear()
    claimed = tick(store)
    assert claimed is not None
    assert claimed.job_id == "batch"
    assert claimed.duration_s == sliced_batch.total_duration_s
    store.finish_simulated_print("batch")
    store.confirm_bed_clear()
    assert tick(store).job_id == "single"


def test_future_submission_waits_for_next_tick(tmp_path):
    store = DispatchStore(str(tmp_path / "dispatch.db"))
    store.enqueue(QueuedJob("future", NOW + timedelta(seconds=1), 100, 60))
    store.enqueue(job("ready", 1))
    store.confirm_bed_clear()
    assert tick(store).job_id == "ready"
    store.finish_simulated_print("ready")
    store.confirm_bed_clear()
    assert (
        store.claim_next(SHIFTS, now=NOW + timedelta(seconds=1), policy=POLICY).job_id
        == "future"
    )


def test_finish_rolls_back_printer_release_if_job_state_changed(tmp_path):
    path = str(tmp_path / "dispatch.db")
    store = DispatchStore(path)
    store.enqueue(job("one", 1))
    store.confirm_bed_clear()
    assert tick(store).job_id == "one"
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("UPDATE dispatch_units SET state = 'ready' WHERE id = 'one'")
    with pytest.raises(ValueError, match="claimed state"):
        store.finish_simulated_print("one")
    with closing(sqlite3.connect(path)) as db:
        assert db.execute(
            "SELECT available, bed_clear, claimed_id FROM simulated_printer"
        ).fetchone() == (0, 0, "one")
