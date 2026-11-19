"""Private PostgreSQL-backed worker for a single uploaded STL per submission.

Apply sql/slice_jobs.sql after the intake schema. Jobs are claimed in short
transactions; leases and fencing tokens prevent stale workers publishing results.
This module does not dispatch prints or expose customer data over HTTP.
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4

import psycopg
from dotenv import load_dotenv

from backend.batching.gcode import parse_gcode
from backend.batching.pipeline import PRINTER_PLATES
from backend.batching.slicer import (
    MACHINE_PRESETS,
    SliceError,
    SlicerUnavailableError,
    find_orca_slicer,
    normalize_printer_name,
    slice_stl,
)
from backend.batching.stl import load_stl
from backend.priority_scheduling import (
    PriorityPolicy,
    QueuedJob,
    StaffShift,
    eligible_jobs,
)
from backend.submissions import PartSettings

LOG = logging.getLogger(__name__)


class UnsupportedJob(ValueError):
    """A request cannot be handled by this worker."""


IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]


def _printer(printer: str) -> str:
    key = normalize_printer_name(printer)
    if key not in MACHINE_PRESETS or key not in PRINTER_PLATES:
        raise ValueError(f"Unsupported printer: {printer}")
    return key


def _validate_part(filename: str, settings: dict) -> PartSettings:
    part = PartSettings.model_validate(settings)
    unsupported = []
    if Path(filename).suffix.lower() != ".stl":
        unsupported.append("only STL is supported")
    if part.copies != 1:
        unsupported.append("only one copy is supported")
    if part.material.strip().lower() != "pla":
        unsupported.append("only PLA is supported by the pinned profiles")
    if part.supports != "operator" or part.supportAngle is not None:
        unsupported.append("support overrides are not supported")
    if part.units != "mm" or part.scalePercent != 100:
        unsupported.append("unit and scale transforms are not supported")
    if part.mirror or part.rotation != IDENTITY:
        unsupported.append("mirror and rotation transforms are not supported")
    if unsupported:
        raise UnsupportedJob("; ".join(unsupported))
    # Color is a physical filament selection, not a slicer setting. It remains
    # attached to the original request for the operator.
    return part


def process_one(
    database_url: str,
    printer: str = "prusa-core-one-plus",
    *,
    lease_seconds: int = 1500,
    slicer=slice_stl,
) -> UUID | None:
    """Claim and process one job; return its ID or None when no work is ready.

    The lease must exceed both of the slicer's 600-second attempts. A crashed worker's
    claim expires and another worker can retry it. Failed jobs are not retried
    automatically; an operator can reset them to pending after correcting the
    issue. A token fences updates from a worker whose lease was reclaimed.
    """
    printer = _printer(printer)
    if lease_seconds <= 1200:
        raise ValueError("lease_seconds must exceed both 600 second slicer attempts")
    token = uuid4()
    with psycopg.connect(database_url, connect_timeout=5) as db:
        row = db.execute(
            """WITH candidate AS (
                   SELECT j.submission_id FROM slice_jobs j
                   JOIN print_submissions s ON s.id = j.submission_id
                   WHERE j.status = 'pending' OR
                         (j.status = 'processing' AND j.lease_until < now())
                   ORDER BY s.created_at, s.id
                   FOR UPDATE OF j SKIP LOCKED LIMIT 1
               )
               UPDATE slice_jobs j SET status = 'processing', printer = %s,
                   claim_token = %s, lease_until = now() + (%s * interval '1 second'),
                   attempts = attempts + 1, updated_at = now(), error = NULL,
                   gcode = NULL, duration_s = NULL
               FROM candidate c WHERE j.submission_id = c.submission_id
               RETURNING j.submission_id""",
            (printer, token, lease_seconds),
        ).fetchone()
    if row is None:
        return None
    job_id = row[0]
    try:
        with psycopg.connect(database_url, connect_timeout=5) as db:
            count = db.execute(
                "SELECT count(*) FROM print_submission_parts WHERE submission_id = %s",
                (job_id,),
            ).fetchone()[0]
            if count != 1:
                raise UnsupportedJob("only submissions with one part are supported")
            filename, settings, model = db.execute(
                "SELECT filename, settings, model FROM print_submission_parts WHERE submission_id = %s",
                (job_id,),
            ).fetchone()
        part = _validate_part(filename, settings)
        with TemporaryDirectory(prefix="printhive-slice-") as directory:
            path = Path(directory) / "model.stl"
            path.write_bytes(bytes(model))
            mesh = load_stl(path)
            if not all(
                math.isfinite(v)
                for triangle in mesh.triangles
                for vertex in triangle
                for v in vertex
            ):
                raise UnsupportedJob("STL contains non-finite coordinates")
            dimensions = mesh.dimensions
            if not all(math.isfinite(x) and x > 0 for x in dimensions):
                raise UnsupportedJob("STL must have finite, positive dimensions")
            plate = PRINTER_PLATES[printer]
            x, y, z = dimensions
            if z > plate.max_z or not (
                (x <= plate.width and y <= plate.height)
                or (y <= plate.width and x <= plate.height)
            ):
                raise UnsupportedJob("STL exceeds the printer build volume")
            output = slicer(
                path,
                path.parent / "output",
                profile=part.profile,
                printer=printer,
                working_dir=path.parent,
            )
            if Path(output).stat().st_size > 50 * 1024 * 1024:
                raise UnsupportedJob("G-code exceeds the 50 MB worker limit")
            gcode = Path(output).read_bytes()
            parsed = parse_gcode(gcode.decode("utf-8"))
            if parsed.footprint is None:
                raise UnsupportedJob("slicer output has no extrusion footprint")
            duration = parsed.duration_s
            if duration is None or not math.isfinite(duration) or duration <= 0:
                raise UnsupportedJob(
                    "slicer did not produce a positive estimated duration"
                )
        with psycopg.connect(database_url, connect_timeout=5) as db:
            updated = db.execute(
                """UPDATE slice_jobs SET status = 'completed', gcode = %s, duration_s = %s,
                   claim_token = NULL, lease_until = NULL, updated_at = now()
                   WHERE submission_id = %s AND status = 'processing' AND claim_token = %s
                   AND lease_until > now()""",
                (gcode, duration, job_id, token),
            )
            if updated.rowcount != 1:
                LOG.warning("Slice claim expired before completion")
                return None
        LOG.info(
            "Prepared submission %s for %s (%g seconds estimated)",
            job_id,
            printer,
            duration,
        )
    except (ValueError, OSError, SliceError, SlicerUnavailableError) as exc:
        # Avoid storing paths, subprocess output, model contents or customer data.
        if isinstance(exc, UnsupportedJob):
            message = str(exc)[:500]
        else:
            message = f"Slicing failed ({type(exc).__name__}); inspect worker configuration and model."
        with psycopg.connect(database_url, connect_timeout=5) as db:
            updated = db.execute(
                """UPDATE slice_jobs SET status = 'failed', error = %s,
                   claim_token = NULL, lease_until = NULL, updated_at = now()
                   WHERE submission_id = %s AND status = 'processing' AND claim_token = %s
                   AND lease_until > now()""",
                (message, job_id, token),
            )
            if updated.rowcount != 1:
                LOG.warning("Slice claim expired before failure was recorded")
                return None
        LOG.warning("Submission %s failed: %s", job_id, message)
    return job_id


def eligibility(
    database_url: str,
    printer: str,
    shifts: list[StaffShift],
    *,
    now: datetime,
    policy: PriorityPolicy,
) -> tuple[QueuedJob, ...]:
    """Read completed jobs for a printer and rank those fitting staffed time.

    Initial priority is zero until an authoritative priority source is defined.
    This read-only decision neither reserves nor dispatches jobs.
    """
    printer = _printer(printer)
    with psycopg.connect(database_url, connect_timeout=5) as db:
        rows = db.execute(
            """SELECT j.submission_id, s.created_at, j.duration_s FROM slice_jobs j
               JOIN print_submissions s ON s.id = j.submission_id
               WHERE j.status = 'completed' AND j.printer = %s""",
            (printer,),
        ).fetchall()
    jobs = (
        QueuedJob(str(job_id), created, 0, duration)
        for job_id, created, duration in rows
    )
    return eligible_jobs(jobs, shifts, now=now, policy=policy)


def main() -> None:
    parser = argparse.ArgumentParser(description="Slice queued PrintHive submissions")
    parser.add_argument("--printer", default="prusa-core-one-plus")
    parser.add_argument(
        "--eligible",
        action="store_true",
        help="evaluate completed jobs instead of slicing",
    )
    parser.add_argument("--shift-start", help="ISO 8601 shift start with timezone")
    parser.add_argument("--shift-end", help="ISO 8601 shift end with timezone")
    parser.add_argument(
        "--now", help="ISO 8601 evaluation time with timezone (default: now)"
    )
    parser.add_argument(
        "--aging-per-hour", type=float, help="priority points per waiting hour"
    )
    parser.add_argument(
        "--once", action="store_true", help="process at most one job and exit"
    )
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    args = parser.parse_args()
    if not math.isfinite(args.poll_seconds) or args.poll_seconds <= 0:
        parser.error("--poll-seconds must be positive and finite")
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required")
    try:
        printer = _printer(args.printer)
    except ValueError as exc:
        parser.error(str(exc))
    if args.eligible:
        if not (args.shift_start and args.shift_end) or args.aging_per_hour is None:
            parser.error(
                "--eligible requires --shift-start, --shift-end and --aging-per-hour"
            )
        try:
            shift = StaffShift(
                datetime.fromisoformat(args.shift_start),
                datetime.fromisoformat(args.shift_end),
            )
            now = datetime.fromisoformat(args.now) if args.now else datetime.now(UTC)
            policy = PriorityPolicy(args.aging_per_hour)
            for job in eligibility(
                database_url, printer, [shift], now=now, policy=policy
            ):
                print(f"{job.job_id} {job.duration_s:g}")
        except ValueError as exc:
            parser.error(str(exc))
        return
    if not find_orca_slicer():
        parser.error("Orca Slicer CLI not found; set PRINTHIVE_ORCA_SLICER")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    while True:
        job_id = process_one(database_url, printer)
        if args.once:
            return
        if job_id is None:
            time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
