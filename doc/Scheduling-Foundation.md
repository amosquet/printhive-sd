# Scheduling foundation (FR-10 and FR-17)

## Scope and branch context

`backend.priority_scheduling` ranks jobs for one printer using an explicit clock,
concrete staff shifts, and the configured aging rate. The implementation from
PR #6 is carried forward here. PR #9 provides the single-shift helper on `dev`.
The dispatch store uses continuous coverage across touching or overlapping shifts
and retains the same strict finish-before-end boundary.

`backend.dispatch.DispatchStore` uses the ranking in a transaction that claims
one ready job or batch and reserves the simulated printer. A claim consumes staff
bed-clearance confirmation (FR-14). Simulated completion frees the printer;
staff must confirm bed clearance before a new claim. Authorization for staff
actions belongs to the application that calls the store.

## Decisions and acceptance matrix

| Requirement | Acceptance case | Expected result |
| --- | --- | --- |
| FR-10 | Four-hour job, two-hour staffing remainder | Ineligible |
| FR-10 | Duration below / equal to / above remainder | Eligible / ineligible / ineligible |
| FR-10 | Missing, nonpositive, nonfinite member duration | Ineligible; never replace with zero |
| FR-10 | No active shift or a staffing gap | No dispatch across the gap |
| FR-10 | Overlapping or touching shifts | Combine continuous staffed coverage |
| FR-10 | Overnight, timezone offset, daylight-saving transition | Compare elapsed UTC instants |
| FR-17 | Older low-priority job gains enough aging points | Outranks newer job |
| FR-17 | Equal score | Earlier submission, then lexicographic job ID |
| FR-17 | Input permutation or repeated tick | Same order, unchanged input |
| API contract | Duplicate ID, future submission, naive time, invalid policy | Explicit ValueError |

Linear aging is `initial_priority + aging_per_hour * waiting_hours`. The caller
must provide a finite, nonnegative rate; there is no unapproved default.
Shifts use inclusive starts and exclusive ends. Adjacent shifts are treated as
uninterrupted staff coverage. FR-10 uses strict `<`, as written in the SDP.
The clock must be timezone aware and is injected for reproducible tests.

Example (the aging rate below is illustrative, not a project default):

```python
from datetime import datetime, timedelta, timezone
from backend.priority_scheduling import PriorityPolicy, QueuedJob, StaffShift, eligible_jobs

now = datetime(2026, 11, 15, 15, tzinfo=timezone.utc)
jobs = [QueuedJob("job-001", now - timedelta(hours=1), 0, 3600)]
shifts = [StaffShift(now, now + timedelta(hours=2))]
ordered = eligible_jobs(jobs, shifts, now=now, policy=PriorityPolicy(aging_per_hour=1))
# ordered is a tuple containing job-001; nothing was dispatched or removed.
```

## Batching and dispatch boundary

PR #4 supplies sliced artifacts, compatible-job grouping, and per-member duration
estimates. `DispatchStore.enqueue_batch` derives the duration using
`known_total_duration` on each member. A batch with any missing or invalid member
estimate stays ineligible. The caller supplies the batch ID, submission time,
and initial priority, and owns artifact readiness and assignment of each print to
one dispatch unit. The team still needs a batch priority policy and measured
estimates for merged plates. FR-11 specifies grouping models before slicing, while
D-02 merges individual slices. Reconcile the requirement and design before release.

The slicer cache currently uses printer, profile, and job name as its disk key.
Review cache identity before connecting uploads so a reused name cannot select
an artifact for different model content or material.

## Checks

```sh
cd backend
uv sync --locked
uv run ruff check .
uv run pytest tests/
```

Remaining integration includes upload and artifact storage, an Orca worker,
weekly shift ingestion (FR-09), authenticated staff controls, and printer relay
dispatch and recovery. The NFR-06 comparison against FCFS also remains open.
