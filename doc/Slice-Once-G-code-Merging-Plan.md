# Implementation Plan: Design D-02 — Slice-Once G-code Merging

Subsystem: Dynamic 2D Nesting & Batching (SYS-06 / FR-11), selected design D-02
from `Design Alternatives: Dynamic 2D Nesting & Batching` (Google Drive).
Implementation lives in `backend/src/backend/batching/` (Python 3.13, `uv`,
stdlib-only) with tests in `backend/tests/`.

## 1. What D-02 is

Slice each job **once** at submission with the Orca Slicer CLI and cache the
G-code. Batching is then pure post-processing of cached files:

1. extract each job's printed footprint (bounding box of extrusion paths,
   brim/skirt included) from its cached G-code,
2. 2D bin-pack those rectangles (90° rotation allowed) onto the build plate,
3. merge the plate's cached files into one dispatchable G-code: translate X/Y
   by the packed offset, interleave layer by layer, emit one shared start
   sequence, insert travel moves + `M486` object tags between parts.

This keeps re-batching cost independent of plate geometry (SYS-06 "dynamic"),
bounds slicing at the largest single model (NFR-01), and gives exact per-job
durations at nesting time (FR-08 → FR-10 shift check).

## 2. Requirements trace

| Req | How this implementation addresses it |
| --- | --- |
| SYS-06 / FR-11 | `pipeline.plan_batches()` groups compatible models into one G-code per plate |
| FR-03 | footprint/plate bounds checked during packing; oversize parts never placed |
| FR-05 | batching key = (printer, material, profile); profiles pinned via Orca presets |
| FR-08 | `ParsedGcode.duration_s` parsed from Orca `; estimated printing time` / `;TIME_ELAPSED:` |
| FR-10 | `Batch.total_duration_s` available at nesting time for the shift check |
| FR-17 | packing + merging is milliseconds-to-seconds; re-runnable every tick |
| NFR-01 | slicing happens once per job, never per plate |
| SYS-11 | no custom slicing: `slicer.py` only wraps the Orca Slicer CLI |

## 3. Module map (`backend/src/backend/batching/`)

```
stl.py       STL (ASCII + binary) loading, mesh bounding box (FR-03 input)
gcode.py     parse cached G-code -> start block / layers(;Z:) / end block,
             extrusion footprint, duration, filament; X/Y translation
packing.py   MaxRects 2D bin-packer (PlatePacker incremental, pack_rectangles,
             pack_into_plates for multi-plate splits), margin = inter-part gap
merge.py     merge_parts(): shared start/end, layer interleaving, M486 T/S,
             travel moves; rejects mismatched layer grids
slicer.py    Orca Slicer CLI wrapper (binary discovery, --slice/--outputdir/
             --load-settings/--datadir); defaults to the pinned presets in
             backend/profiles/ via default_settings(profile)
pipeline.py  PrintJob / BuildPlate / PRINTER_PLATES / Batch / plan_batches():
             group by compatibility key, slice-or-cache, footprint, pack onto
             the printer's plate, merge
```

Pinned presets live in `backend/profiles/` (machine + FR-05 Draft/Standard/
High Strength process JSONs, developed against OrcaSlicer 2.5.0). Plate sizes
are per printer (`PRINTER_PLATES`: prusa-mk4 250x210, bambu-x1c/p1s 256x256,
generic default 250x250).

## 4. Data flow

```
STL files ──slice once──> cached .gcode ──parse──> ParsedGcode
                                                        │ footprint (extrusion bbox, brim incl.)
                                                        ▼
                                              Rect list ──MaxRects──> Placements (x, y, rotated)
                                                        │
                                              dx = x - footprint.min_x  (per part)
                                                        ▼
                                              merge_parts() ──> one G-code per plate
                                                        │
                                              Batch{gcode, items, total_duration_s,
                                                    total_filament_mm, utilization}
```

## 5. Key algorithms & decisions

- **Footprint**: bbox over XY of extrusion moves (E > 0, M83 relative; M82
  absolute handled via deltas). Skirt/brim are extruded, so they are included
  automatically; a configurable `margin` (default 1 mm) adds a safety gap.
- **Layer model**: layers split on `;LAYER_CHANGE`, keyed by the following
  `;Z:`; Orca's duplicate markers at the same Z collapse into one layer.
  Batching requires identical layer grids (same profile ⇒ same layer heights);
  shorter parts simply stop contributing after their last layer.
- **Translation**: X/Y rewritten only on `G0`/`G1` lines, 3-decimal output;
  `G2`/`G3` arcs are rejected (constrained grammar: no arc fitting).
- **End-block detection**: first non-comment command after the last motion
  line; per-file start/end blocks are stripped, one shared pair is emitted.
- **M486**: `M486 T<n>` in the shared start, `M486 S<i>` + travel move before
  each part's block in every layer → per-object cancellation on the printer.
- **Packing**: MaxRects best-short-side-fit, deterministic, input sorted by
  area (first-fit-decreasing across plates when one plate is full).
- **Compatibility**: jobs batch only with same (printer, material, profile).

## 6. Testing strategy (`backend/tests/`)

- `tests/stl/` is a **drop folder**: every `*.stl` placed there is picked up
  automatically (parametrized fixtures in `conftest.py`). Committed samples
  keep CI green; `yafic_v2.stl` is a real binary STL.
- `fixture_slicer.py` is a test-only generator producing grammar-faithful
  Orca-style G-code from any STL, so the pipeline is testable without a slicer
  install. Production always uses the Orca CLI.
- `test_stl.py` / `test_gcode.py` / `test_packing.py` / `test_merge.py`:
  unit tests (parsing, translation, packing, merging, M486, interleaving).
- `test_pipeline_stl.py`: end-to-end per STL — single-job batch, all-STLs
  batch with plate-bounds + non-overlap + duration/filament roll-up checks,
  cache-never-resliced, plate splitting, profile compatibility.
- `test_orca_slicer_end_to_end`: slices every STL with the real OrcaSlicer
  CLI and the committed `backend/profiles/` presets whenever a binary is
  locatable (skips in CI, where no Orca install exists). Env overrides:
  `PRINTHIVE_ORCA_SLICER` / `PRINTHIVE_ORCA_DATADIR` / `PRINTHIVE_ORCA_SETTINGS`.
- CI gates: `uv sync --locked`, `ruff check .`, `uv run pytest tests/`.

## 7. Risks & mitigations (from the trade study)

- **Bespoke G-code fragility** → constrained input grammar (M83, no arcs,
  uniform layer heights), pinned Orca version, and the real-Orca contract
  test above; merged output is re-parsed and validated in tests.
- **FR-11 wording** ("prior to slicing") → observable behaviour (several
  models in one G-code file) still satisfied; RVTM note at next SDP revision.
- **Lower packing density than polygon nesting** → extrusion-path footprints
  (not mesh boxes) + 90° rotation keep loss acceptable for Hive queue sizes.
- **Shared-plate blast radius** → M486 tags + FR-15 auto-requeue.

## 8. Milestones

1. Core modules (stl/gcode/packing/merge/slicer/pipeline) + unit tests — done.
2. STL-driven end-to-end tests over `backend/tests/stl` — done.
3. Real-Orca contract test wired to pinned profiles (env-configured) — done,
   verify per slicer upgrade.
4. Next: wire `plan_batches` into the queue/scheduler tick (FR-17) and the
   shift check (FR-10) using `Batch.total_duration_s`.
