# PrintHive Backend

Python 3.13 backend, managed with [uv](https://docs.astral.sh/uv/). Source lives
in `src/backend/` (src layout); tests live in `tests/`.

## Setup & checks

```bash
uv sync --locked     # install deps from the lockfile (CI gate)
uv run ruff check .  # lint (CI gate)
uv run pytest tests/ # tests (CI gate)
```

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
print(batches[0].total_duration_s)        # FR-08/FR-10 input
```

Each job is sliced once with the Orca Slicer CLI using the pinned presets in
`profiles/` (FR-05: draft / standard / high_strength). Plates are sized per
printer (`PRINTER_PLATES`); pass an explicit `BuildPlate` to override.

### Testing with your own STL files

Drop any `.stl` files into `tests/stl/` — the suite parametrizes over every
file there and runs the full pipeline against each one. When an Orca Slicer
binary is available (macOS bundle, `PATH`, or `PRINTHIVE_ORCA_SLICER`), the
`test_orca_slicer_end_to_end` tests slice each STL with the real CLI and the
committed presets; otherwise they skip (as in CI):

```bash
uv run pytest tests/ -k orca   # real Orca Slicer end-to-end
```
