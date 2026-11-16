"""Pure scheduling decisions for FR-10 and FR-17.

The caller supplies queued jobs for one available printer and an explicit clock.
This module neither reserves jobs nor sends commands to printers.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from math import fsum, isfinite


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamps must include a timezone")
    return value.astimezone(timezone.utc)


def _finite(value: float) -> bool:
    return not isinstance(value, bool) and isfinite(value)


@dataclass(frozen=True)
class StaffShift:
    """One concrete staffing interval, with inclusive start and exclusive end."""

    start: datetime
    end: datetime

    def __post_init__(self) -> None:
        if _utc(self.start) >= _utc(self.end):
            raise ValueError("shift end must be after shift start")


@dataclass(frozen=True)
class QueuedJob:
    """Scheduling metadata for one queued job; duration is in seconds.

    None means unknown. Nonpositive or nonfinite durations remain ineligible.
    IDs must be stable strings; their final tie-break order is lexicographic.
    """

    job_id: str
    submitted_at: datetime
    initial_priority: float
    duration_s: float | None

    def __post_init__(self) -> None:
        if not isinstance(self.job_id, str) or not self.job_id.strip():
            raise ValueError("job_id must be a nonempty string")
        _utc(self.submitted_at)
        if not _finite(self.initial_priority):
            raise ValueError("initial priority must be finite")


@dataclass(frozen=True)
class PriorityPolicy:
    """Explicit linear aging rate, in priority points per waiting hour.

    There is deliberately no default rate: the SDP does not specify one.
    """

    aging_per_hour: float

    def __post_init__(self) -> None:
        if not _finite(self.aging_per_hour) or self.aging_per_hour < 0:
            raise ValueError("aging rate must be finite and nonnegative")


def remaining_staffed_seconds(shifts: Iterable[StaffShift], now: datetime) -> float:
    """Remaining continuous coverage; overlap and touching shifts are combined.

    A future shift separated by any gap cannot extend the current dispatch window.
    UTC arithmetic preserves elapsed time across daylight-saving transitions.
    """

    instant = _utc(now)
    coverage_end = instant
    for start, end in sorted((_utc(s.start), _utc(s.end)) for s in shifts):
        if start > coverage_end:
            break
        coverage_end = max(coverage_end, end)
    return (coverage_end - instant).total_seconds()


def known_total_duration(durations: Iterable[float | None]) -> float | None:
    """Sum member estimates only when every member has a positive finite value.

    Future D-02 adapters must inspect each item.parsed.duration_s, rather than
    trusting Batch.total_duration_s, which currently substitutes zero for None.
    """

    values = tuple(durations)
    if not values or any(v is None or not _finite(v) or v <= 0 for v in values):
        return None
    try:
        total = fsum(values)
    except OverflowError:
        return None
    return total if isfinite(total) else None


def effective_priority(job: QueuedJob, now: datetime, policy: PriorityPolicy) -> float:
    """Initial priority + aging rate * elapsed waiting hours (FR-17)."""

    wait_s = (_utc(now) - _utc(job.submitted_at)).total_seconds()
    if wait_s < 0:
        raise ValueError("job submission cannot be after the scheduling clock")
    score = job.initial_priority + policy.aging_per_hour * wait_s / 3600
    if not isfinite(score):
        raise ValueError("effective priority overflow")
    return score


def eligible_jobs(
    jobs: Iterable[QueuedJob],
    shifts: Iterable[StaffShift],
    *,
    now: datetime,
    policy: PriorityPolicy,
) -> tuple[QueuedJob, ...]:
    """Return eligible jobs in dispatch order without changing their state.

    FR-10 requires duration < remaining staffed seconds; equality is ineligible.
    FR-17 sorts by descending effective priority, then submission instant and ID.
    Duplicate IDs or future submissions are caller errors, even outside a shift.
    Printer availability, ownership, and manual bed clearance are caller gates.
    """

    remaining = remaining_staffed_seconds(shifts, now)
    ranked: list[tuple[float, datetime, str, QueuedJob]] = []
    seen: set[str] = set()
    for job in jobs:
        if job.job_id in seen:
            raise ValueError(f"duplicate job_id: {job.job_id}")
        seen.add(job.job_id)
        score = effective_priority(job, now, policy)
        duration = known_total_duration((job.duration_s,))
        if duration is not None and duration < remaining:
            ranked.append((-score, _utc(job.submitted_at), job.job_id, job))
    return tuple(entry[3] for entry in sorted(ranked, key=lambda entry: entry[:3]))
