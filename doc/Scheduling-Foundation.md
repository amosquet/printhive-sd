# Scheduling foundation (FR-10 and FR-17)

## Scope and branch context

This feature starts from `dev` at `78f521c`. PR #4 remains open at `82eae0a`;
its batching implementation has not been merged into this feature. There is no
queue, database, shift ingestion service, or scheduler on `dev` yet.

PR #5 by `aarvinda` now proposes `backend.scheduling.is_shift_eligible` and its
tests. This module uses the distinct name `backend.priority_scheduling` to avoid
file conflicts. Both changes cover strict shift eligibility; consolidate that
shared policy during integration while retaining this module's continuous-shift
coverage and configurable priority ranking. This branch does not include PR #5.

`backend.priority_scheduling` provides pure decisions for one printer's queued jobs and
concrete staff shifts. It returns an ordered tuple; it does not reserve jobs,
change job state, slice models, or send print commands. Printer availability,
authorization, bed clearance (FR-14), and atomic dispatch remain caller gates.

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

## PR #4 review observations and integration boundary

PR #4 supplies compatible-job grouping, printer dimensions, cached slicing,
footprint packing, layer-grid checks, and per-member estimates. Existing D-02
tests cover rotation, bounds, cache reuse, incompatible profiles/layers, and
unsupported arcs. They are not copied into this independent prerequisite.

Two concrete code concerns need follow-up on PR #4 before production integration:

- `pipeline.Batch.total_duration_s` and `merge.merge_parts` replace absent member
  durations with zero. The new `known_total_duration` helper checks every member
  first and returns None for missing/invalid estimates. Do not feed the aggregate
  directly to a dispatcher.
- `_resolve_gcode` identifies disk cache entries by printer/profile/job name;
  it does not include model content or material in that path. A repeated name
  for changed geometry can reuse a stale slice. Cache identity and invalidation
  need review and regression tests before connecting uploads.

This was a source review, not a complete G-code or hardware validation. The
new tests cover scheduling decisions only; no real Orca or printer was run.
Summed single-job estimates also do not establish actual merged-plate duration
accuracy: shared startup and extra travels require measurement (FR-08/NFR-01).

After PR #4 is integrated, an adapter can inspect each
`batch.items[i].parsed.duration_s` with `known_total_duration`. It must also
check cache/artifact readiness and retain stable job IDs/submission metadata.
Do not rank batches until the team chooses how member priorities aggregate
(maximum, sum, or another policy) and how packing should preserve queue fairness.
FR-11 currently says batch before slicing, while D-02 merges individual slices;
record an approved requirements decision rather than silently changing either.

## Checks

No runtime or test dependencies are added. The suite uses Python's standard
`unittest`, and pytest can collect the same cases once CI tooling is integrated.

```sh
# From repository root
PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -v
```

Remaining work: persistent job lifecycle, weekly shift ingestion (FR-09), D-02
adapter and batch policy, atomic reservation, staff clearance, relay dispatch
and recovery, then the NFR-06 comparison against FCFS. This module does not
claim those requirements are complete.
