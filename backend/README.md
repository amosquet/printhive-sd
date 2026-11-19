# PrintHive Backend

Python 3.13 backend, managed with [uv](https://docs.astral.sh/uv/). Source lives
in `src/backend/` (src layout); tests live in `tests/`.

## Setup & checks

```bash
uv sync --locked     # install deps from the lockfile (CI gate)
uv run ruff check .  # lint (CI gate)
uv run pytest tests/ # tests (CI gate)
```

## Print submission API

Create a local PostgreSQL database, then copy `.env.example` to `.env` in
`backend/` and set `DATABASE_URL` to the connection URI. Apply the schema once
with `psql` from `backend/`, using the same URI:

```bash
set -a
. ./.env
set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/print_submissions.sql
```

Start it alongside the site with `bun dev` from `frontend/`, or start the API
by itself from `backend/`:

```bash
uv run --locked uvicorn backend.submissions:create_app --factory --host 127.0.0.1 --port 8000
```

`POST /api/prints` accepts multipart form data with a JSON `submission` field
and one or more `models` files in the same order as the JSON `parts`. The API
stores the request, original file bytes, and per-part settings in PostgreSQL
and returns a submission ID with status `submitted`. A retry with the same ID
and payload returns the original receipt. The API checks the Purdue email
domain, submission fields, file extensions, and upload sizes. The browser
checks geometry during preview. The slicing worker below checks STL geometry
again before calling OrcaSlicer. Keep the API local until email verification
and deployment controls are in place.

Set `PRINTHIVE_TEST_DATABASE_URL` to a PostgreSQL test database to include the
submission integration test in `uv run --locked pytest tests/`.

## Local upload-to-scheduler demo

Set up the submission API first. From `backend/`, apply `sql/slice_jobs.sql`
to the same PostgreSQL database after applying `sql/print_submissions.sql`.

```bash
set -a
. ./.env
set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/slice_jobs.sql
```

The migration queues existing submissions and automatically queues new uploads
in the same transaction that saves the request. Start the site with `bun dev`
from `frontend/`. Submit `backend/tests/stl/cube_20mm.stl` as one PLA part with
the default print settings. Use a single copy, millimeters, 100% scale, and
the original orientation with no mirror or support overrides. The worker uses
the selected Draft, Standard, or High Strength process profile. It records
unsupported requests as failed without making them eligible for scheduling.

Install the OrcaSlicer CLI on the worker host. Set `PRINTHIVE_ORCA_SLICER` in
`backend/.env` if Orca is outside the normal discovery locations. Then run the
worker from `backend/`.

```bash
uv run --locked printhive-slice-worker --printer prusa-core-one-plus --once
```

Omit `--once` to poll for pending jobs. The worker stores the G-code and its
estimated duration in seconds together. If a worker stops, another can reclaim
the job after the lease expires.

Check the scheduler with an active shift expressed as timezone-aware timestamps.
Replace the sample bounds with a shift that covers the demo time and leaves
enough time for the print to finish.

```bash
uv run --locked printhive-slice-worker --eligible --printer prusa-core-one-plus \
  --shift-start '2026-11-18T20:00:00-05:00' --shift-end '2026-11-19T01:00:00-05:00' \
  --aging-per-hour 0
```

The command prints eligible submission IDs and durations in scheduler order.
Compare the ID with the browser receipt. The shift lookup is a read-only
simulation and uses equal initial priority for demo jobs.

## Batching (design D-02: Slice-Once G-code Merging)

`src/backend/batching/` implements the Dynamic 2D Nesting & Batching
subsystem (SYS-06 / FR-11). Each job is sliced once with the Orca Slicer CLI
and cached; batching then extracts extrusion footprints from the cached
G-code, bin-packs them onto the build plate, and merges the files into one
dispatchable G-code per plate (offset translation, layer interleaving, M486
object tags). See `doc/Slice-Once-G-code-Merging-Plan.md` for the full plan.

Quick example:

```python
from pathlib import Path
from backend.batching import PrintJob, plan_batches

batches = plan_batches([PrintJob(source=Path("model.stl"), printer="prusa-mk4")])
plate_gcode = batches[0].gcode            # one merged file for the plate
print(batches[0].plate)                   # per-printer plate (250x210 for prusa-mk4)
print(batches[0].total_duration_s)        # sum of available estimates
```

Each job is sliced once with the Orca Slicer CLI using the pinned presets in
`profiles/` (FR-05: draft / standard / high_strength). Plates are sized per
printer (`PRINTER_PLATES`: `prusa-mk4` 250x210x250, `prusa-core-one+`
250x220x270, `bambu-x1c`/`bambu-p1s` 256x256x256, `bambu-h2d-pro`
350x320x325); pass an explicit `BuildPlate` to override. See
`doc/Backend-Batching-and-Testing.md` for full architecture and test suite
documentation.

### Testing with your own STL files

Drop any `.stl` files into `tests/stl/` — the suite parametrizes over every
file there and runs the full pipeline against each one. When an Orca Slicer
binary is available (macOS bundle, `PATH`, or `PRINTHIVE_ORCA_SLICER`), the
`test_orca_slicer_end_to_end` tests slice each STL with the real CLI and the
committed presets; otherwise they skip (as in CI):

```bash
uv run pytest tests/ -k orca   # real Orca Slicer end-to-end
```

## Scheduling

`src/backend/priority_scheduling.py` ranks eligible jobs using concrete staff
shifts, an explicit clock, and a configured priority-aging rate. See the
[scheduling design and integration notes](../doc/Scheduling-Foundation.md).

### Simulated atomic dispatch

`backend.dispatch.DispatchStore` connects ready units to the priority scheduler
using a local SQLite database. Create each scheduler's store with the same file
path, enqueue `QueuedJob` values, and call `claim_next(shifts, now=..., policy=...)`.
Before a claim, staff must call `confirm_bed_clear()`; a successful claim marks
the simulated printer busy and consumes that confirmation in the same database
transaction as the job claim. Call `finish_simulated_print(job_id)` when the
simulation finishes, then confirm clearance again before the next claim.

Already formed `Batch` objects can be enqueued via `enqueue_batch` with an
explicit stable batch ID, submission time, and initial priority. Every member
must have a positive finite duration; otherwise the batch remains ineligible.
The caller assigns each physical job to one dispatch unit, either as a single
job or as part of a batch. The simulated printer records state transitions in
SQLite. A printer relay and G-code delivery are future integration work.
