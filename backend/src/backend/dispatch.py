"""Transactional, local dispatch for one simulated printer.

All schedulers sharing a database must use this store for claims and printer
state. SQLite serializes the selection and both state changes across connections.
"""

import sqlite3
from collections.abc import Iterable
from contextlib import closing
from datetime import datetime

from .batching.pipeline import Batch
from .priority_scheduling import (
    PriorityPolicy,
    QueuedJob,
    StaffShift,
    eligible_jobs,
    known_total_duration,
)


class DispatchStore:
    """A shared SQLite-backed set of ready dispatch units and one printer.

    Each operation opens a connection to the same database file. A dispatch
    unit represents one job or a preformed batch. Callers assign each physical
    job to exactly one unit and use a unique ID for each unit.
    """

    def __init__(self, database: str):
        self.database = database
        with closing(self._connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS dispatch_units (
                    id TEXT PRIMARY KEY, submitted_at TEXT NOT NULL,
                    initial_priority REAL NOT NULL, duration_s REAL,
                    state TEXT NOT NULL CHECK (state IN ('ready', 'claimed', 'completed'))
                );
                CREATE TABLE IF NOT EXISTS simulated_printer (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    available INTEGER NOT NULL CHECK (available IN (0, 1)),
                    bed_clear INTEGER NOT NULL CHECK (bed_clear IN (0, 1)),
                    claimed_id TEXT REFERENCES dispatch_units(id)
                );
                INSERT OR IGNORE INTO simulated_printer
                    (singleton, available, bed_clear, claimed_id) VALUES (1, 1, 0, NULL);
            """)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.database, timeout=10, isolation_level=None)
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def enqueue(self, job: QueuedJob) -> None:
        """Add a ready unit; duplicate IDs are rejected by the database."""
        # Validate duration before storage: SQLite converts NaN to NULL.
        duration = known_total_duration((job.duration_s,))
        with closing(self._connect()) as db:
            db.execute(
                "INSERT INTO dispatch_units VALUES (?, ?, ?, ?, 'ready')",
                (
                    job.job_id,
                    job.submitted_at.isoformat(),
                    job.initial_priority,
                    duration,
                ),
            )

    def enqueue_batch(
        self,
        batch: Batch,
        *,
        batch_id: str,
        submitted_at: datetime,
        initial_priority: float,
    ) -> None:
        """Enqueue a preformed batch using every member's estimate.

        The priority and submission time are explicit unit-level policy inputs;
        no batch priority policy is assumed here. Empty or invalid estimates are
        retained as unknown and cannot be dispatched.
        """
        duration = known_total_duration(item.parsed.duration_s for item in batch.items)
        self.enqueue(QueuedJob(batch_id, submitted_at, initial_priority, duration))

    def confirm_bed_clear(self) -> None:
        """Record staff confirmation only while the simulated printer is idle."""
        with closing(self._connect()) as db:
            cursor = db.execute(
                "UPDATE simulated_printer SET bed_clear = 1 WHERE singleton = 1 AND available = 1"
            )
            if cursor.rowcount != 1:
                raise ValueError("cannot confirm the bed while printer is busy")

    def claim_next(
        self, shifts: Iterable[StaffShift], *, now: datetime, policy: PriorityPolicy
    ) -> QueuedJob | None:
        """Atomically choose and claim the highest-ranked eligible ready unit."""
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            available, clear = db.execute(
                "SELECT available, bed_clear FROM simulated_printer WHERE singleton = 1"
            ).fetchone()
            if not available or not clear:
                return None
            rows = db.execute(
                "SELECT id, submitted_at, initial_priority, duration_s "
                "FROM dispatch_units WHERE state = 'ready'"
            ).fetchall()
            jobs = (
                QueuedJob(job_id, datetime.fromisoformat(submitted_at), priority, duration)
                for job_id, submitted_at, priority, duration in rows
            )
            # Jobs submitted after this tick are eligible for a later run.
            ready_jobs = (job for job in jobs if job.submitted_at <= now)
            ranked = eligible_jobs(ready_jobs, shifts, now=now, policy=policy)
            if not ranked:
                return None
            job = ranked[0]
            db.execute(
                "UPDATE dispatch_units SET state = 'claimed' WHERE id = ?",
                (job.job_id,),
            )
            db.execute(
                "UPDATE simulated_printer SET available = 0, bed_clear = 0, claimed_id = ? "
                "WHERE singleton = 1",
                (job.job_id,),
            )
            return job

    def finish_simulated_print(self, job_id: str) -> None:
        """Mark the job completed and release the simulated printer."""
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            cursor = db.execute(
                "UPDATE simulated_printer SET available = 1, claimed_id = NULL "
                "WHERE singleton = 1 AND available = 0 AND claimed_id = ?",
                (job_id,),
            )
            if cursor.rowcount != 1:
                raise ValueError("job does not own the printer")
            cursor = db.execute(
                "UPDATE dispatch_units SET state = 'completed' "
                "WHERE id = ? AND state = 'claimed'",
                (job_id,),
            )
            if cursor.rowcount != 1:
                raise ValueError("claimed job is not in claimed state")
