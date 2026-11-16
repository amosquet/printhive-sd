# Backend Implementation & Test Suite Documentation

This document summarizes the current implementation of the PrintHive backend (`backend/`), focusing on the **Dynamic 2D Nesting & Batching subsystem (Design D-02: Slice-Once G-code Merging, SYS-06 / FR-11)**, supported printer hardware profiles, verification fixes, and the full 88-test verification suite.

---

## 1. Architecture & Work Completed (`backend/src/backend/batching/`)

Design D-02 slices each submitted 3D model **once** using the headless Orca Slicer CLI (`SYS-04`, `SYS-11`) and caches the resulting G-code. Batching and queue re-scheduling (`FR-17`) operate purely on the cached G-code without repetitive slicing (`NFR-01`).

### Core Modules

| Module | File | Responsibilities |
| :--- | :--- | :--- |
| **STL Loader** | `backend/src/backend/batching/stl.py` | Dependency-free ASCII and binary `.stl` parser (`load_stl`, `write_binary_stl`, `Mesh`). Computes 3D bounding boxes and dimensions `(width, height, depth)` for pre-slicing build-volume validation (`FR-03`). |
| **G-code Parser & Translator** | `backend/src/backend/batching/gcode.py` | Parses cached Orca Slicer 2.5.x G-code (`parse_gcode`) into `start_lines`, `layers` (keyed by `;LAYER_CHANGE` / `;Z:`), and `end_lines`. Extracts the printed XY extrusion footprint (including skirt/brim if present, handling both `M83` relative and `M82` absolute extrusion with `G92` resets), print duration (`FR-08`), and filament usage. Translates and optionally rotates `G0`/`G1` XY coordinates by 90° CCW (`translate_xy`, `translate_layer`) while rejecting `G2`/`G3` arcs. |
| **2D MaxRects Bin-Packer** | `backend/src/backend/batching/packing.py` | Deterministic MaxRects Best-Short-Side-Fit 2D rectangle packer (`PlatePacker`, `pack_rectangles`, `pack_into_plates`) with 90° rotation and inter-part gap (`margin`). Splits all intersecting free rectangles and applies `margin` strictly *between* parts so single models can span 100% of the build plate area. |
| **G-code Merger** | `backend/src/backend/batching/merge.py` | Merges placed parts (`PlacedPart`) on a build plate into one dispatchable G-code file (`merge_parts`): emits one shared start sequence and `M486 T<count>`, interleaves parts layer-by-layer on a verified common `;Z:` grid, applies each part's layer-start retraction before emitting `M486 S<index>` and inter-part travel moves, and appends one shared end sequence plus rolled-up filament and duration trailers. |
| **Orca Slicer CLI Wrapper** | `backend/src/backend/batching/slicer.py` | Locates the Orca Slicer binary (`PRINTHIVE_ORCA_SLICER`, `PATH`, or `/Applications/OrcaSlicer.app`) and slices an STL once (`slice_stl`) using the pinned machine and FR-05 process presets in `backend/profiles/`. Passes `--allow-rotations` and automatically retries with `--rotate 90` on exit code `206` so full-plate models oriented 90° relative to the bed slice without artificial border-margin failures. |
| **Batching Pipeline** | `backend/src/backend/batching/pipeline.py` | Orchestrates `plan_batches()` and `batch_stl_files()`: groups compatible `PrintJob` items by `(printer, material, profile)` (`FR-05`), validates 3D geometry against the printer's `(width, height, max_z)` (`FR-03`), resolves or caches per-job G-code under `<workdir>/<printer>/<profile>/<job.name>`, packs footprints onto plates, merges G-code, and exposes `Batch.total_duration_s` (`FR-10`), `Batch.total_filament_mm`, and `Batch.utilization`. |

---

## 2. Supported Printers & Pinned Presets (`backend/profiles/`)

### Build Volumes (`PRINTER_PLATES` & `MACHINE_PRESETS`)

| Printer Key(s) | Model | Build Plate (`width × height`) | Max Height (`max_z`) | Machine Preset |
| :--- | :--- | :--- | :--- | :--- |
| `prusa-mk4` | Prusa MK4 | `250 × 210 mm` | `250 mm` | `printhive_mk4.machine.json` |
| `prusa-core-one`, `prusa-core-one+`, `prusa-core-one-plus` | Prusa CORE One / CORE One+ | `250 × 220 mm` | `270 mm` | `printhive_core_one_plus.machine.json` |
| `bambu-x1c`, `bambu-p1s` | Bambu Lab X1C / P1S | `256 × 256 mm` | `256 mm` | `printhive_bambu_x1c.machine.json` |
| `bambu-h2d`, `bambu-h2d-pro` | Bambu Lab H2D / H2D Pro | `350 × 320 mm` | `325 mm` | `printhive_h2d_pro.machine.json` |
| *(unknown printer fallback)* | Default SDP Profile | `250 × 250 mm` | `250 mm` | `printhive_mk4.machine.json` |

### FR-05 Process Presets

* `draft.process.json`: `0.3 mm` layer height, 2 wall loops, 10% infill, high speed.
* `standard.process.json`: `0.2 mm` layer height, 3 wall loops, 15% infill, balanced speed.
* `high_strength.process.json`: `0.2 mm` layer height, 5 wall loops, 40% infill, conservative speed.

All three process presets enforce the constrained D-02 grammar: relative extrusion (`M83`), arc fitting disabled (`enable_arc_fitting: "disabled"`), and no forced outer skirt/brim (`skirt_loops: "0"`, `brim_type: "no_brim"`) so full-build-plate prints never fail with Orca Slicer exit code `154`.

---

## 3. Verification & Engineering Fixes Implemented

1. **90° Coordinate Rotation in G-code Merging:** When `PlatePacker` rotates a part by 90° (`Placement.rotated == True`), `translate_xy()` and `translate_layer()` now apply a 90° CCW coordinate transformation (`x' = min_x + (max_y - y) + dx`, `y' = min_y + (x - min_x) + dy`) and `PlacedJob.footprint_bounds` swaps width and height accordingly.
2. **MaxRects Partial-Intersection Splitting:** `PlatePacker.place()` now splits *every* free rectangle that intersects the placed part's excluded region (`_intersects(free, used)`), preventing overlapping placements when free rectangles partially overlap.
3. **Full Build-Plate Area Support (Edge-Margin Decoupling):** `PlatePacker` enforces `margin` strictly *between* parts (expanding `used` by `margin` on all four sides when splitting free space) rather than subtracting `margin` from the outer plate edges, allowing single parts to span 100% of the build plate (`250×220 mm` on Prusa CORE One+, `350×320 mm` on Bambu H2D Pro).
4. **Persistent Slice-Once Caching:** `_resolve_gcode()` persists `job.gcode_path` on the `PrintJob` instance and reuses cached `.gcode` files in `<workdir>/<printer>/<profile>/<job.name>` across repeated `plan_batches()` ticks without re-slicing.
5. **Inter-Part Retraction Ordering, Fan Isolation & End-Block Separation:**
   * `merge_parts()` emits each part's layer header and initial retraction *before* `M486 S<i>` and the inter-part travel move.
   * `parse_gcode()` moves next-layer `M106` fan commands emitted right before `;LAYER_CHANGE` into the following layer so Layer 0 bed adhesion is unaffected on subsequent parts.
   * `parse_gcode()` detects `;TYPE:Custom` after the final `;LAYER_CHANGE` so park/retract moves in `machine_end_gcode` remain in `end_lines`.

---

## 4. Available Backend Tests (88 Tests)

Run the backend test suite from `backend/`:

```bash
uv sync --locked          # install locked environment
uv run ruff check .       # lint check
uv run pytest -v          # run all 88 backend tests
uv run pytest -k orca -v  # run real Orca Slicer CLI end-to-end tests
```

Drop any `.stl` file into `backend/tests/stl/` and the parametrized fixtures in `backend/tests/conftest.py` will automatically run the STL and pipeline tests against it.

### 4.1 STL Loading & Geometry Tests (`backend/tests/test_stl.py` — 14 tests)

* `test_stl_file_loads[<stl>]` *(3 cases)*: Verifies every STL in `tests/stl/` loads with non-empty triangles and non-degenerate bounding boxes.
* `test_stl_file_dimensions_match_name[<stl>]` *(3 cases)*: Verifies exact dimensions for `box_40x60x8.stl` (`40×60×8`), `cube_20mm.stl` (`20×20×20`), and `cylinder_r15_h10.stl` (`30×30×10`).
* `test_binary_roundtrip[<stl>]` *(3 cases)*: Writes each mesh as binary STL (`write_binary_stl`), reloads it, and verifies identical bounding boxes.
* `test_ascii_and_binary_agree[<stl>]` *(3 cases)*: Verifies ASCII and binary representations yield identical dimensions.
* `test_empty_file_rejected`: Verifies 0-triangle binary STL headers raise `ValueError`.
* `test_mesh_bounding_box_of_empty_mesh`: Verifies `Mesh(triangles=()).bounding_box` raises `ValueError`.

### 4.2 G-code Parsing & Translation Tests (`backend/tests/test_gcode.py` — 14 tests)

* `test_parse_layers_and_z`: Verifies `;LAYER_CHANGE` splitting and deduplication of consecutive markers at the same `;Z:`.
* `test_parse_start_and_end_blocks`: Verifies extraction of `start_lines` and `end_lines` within `; EXECUTABLE_BLOCK_START` / `; EXECUTABLE_BLOCK_END`.
* `test_footprint_includes_skirt`: Verifies XY extrusion bounding box includes skirt moves and expands with `footprint_size(margin=...)`.
* `test_duration_and_filament`: Verifies `; estimated printing time` (`FR-08`) and `; filament used [mm]` extraction.
* `test_parse_duration_formats`: Verifies `parse_duration()` across `Xh Ym Zs`, `Ym Zs`, `Zs`, and invalid strings.
* `test_missing_layer_marker_rejected`: Verifies `GcodeFormatError` on unsliced G-code lacking `;LAYER_CHANGE`.
* `test_translate_xy_shifts_only_motion`: Verifies `translate_xy()` shifts `X`/`Y` on `G0`/`G1` while leaving `Z`, `E`, `F`, `M205`, and comments untouched.
* `test_translate_xy_rejects_arcs`: Verifies `G2`/`G3` arc commands raise `GcodeFormatError`.
* `test_time_elapsed_fallback`: Verifies fallback duration extraction from `;TIME_ELAPSED:`.
* `test_translate_xy_rotates_90_ccw`: Verifies 90° CCW coordinate rotation maps `(min_x, min_y, max_x, max_y)` onto `(px, py, px + h, py + w)`.
* `test_trailing_m106_moves_to_next_layer`: Verifies next-layer `M106` fan commands before `;LAYER_CHANGE` move into the next layer rather than bleeding into other parts on the current layer.
* `test_custom_end_gcode_with_park_motion_stays_in_end_lines`: Verifies park/lift motion lines (`G1 Z260`, `G1 X0 Y210`) after `;TYPE:Custom` stay in `end_lines`.
* `test_m82_absolute_extrusion_with_g92_reset`: Verifies footprint scanning in `M82` absolute extrusion mode with per-layer `G92 E0` resets.
* `test_single_axis_motion_and_inline_comments`: Verifies single-axis `G1 X...` and `G1 Y...` moves under 90° rotation and preservation of inline comments containing axis tokens.

### 4.3 2D MaxRects Bin-Packing Tests (`backend/tests/test_packing.py` — 20 tests)

* `test_single_rect_fits_at_origin`: Verifies a single rectangle places at `(0, 0)`.
* `test_two_rects_fit_without_overlap`: Verifies two rectangles pack within plate bounds without overlapping.
* `test_rotation_used_when_needed`: Verifies `200×60` rotates to `60×200` on a `100×250` plate when `allow_rotation=True` and returns `None` when `allow_rotation=False`.
* `test_oversize_rect_returns_none`: Verifies oversize rectangles return `None` in `pack_rectangles()`.
* `test_margin_keeps_parts_apart`: Verifies all placed pairs maintain at least `margin` separation.
* `test_pack_into_plates_splits_when_full`: Verifies multi-plate splitting when rectangles exceed a single plate's capacity.
* `test_rect_too_big_for_plate_raises`: Verifies `pack_into_plates()` raises `ValueError` when a single rectangle cannot fit an empty plate.
* `test_deterministic`: Verifies identical inputs produce identical placements.
* `test_maxrects_splits_partially_overlapping_free_rects`: Regression test verifying partially intersecting free rectangles are split so placements never overlap.
* `test_full_plate_rect_fits_even_with_positive_margin`: Verifies `250×220` and `350×320` full-plate rectangles fit on `250×220` and `350×320` plates even when `margin > 0`.
* `test_randomized_packing_invariants[0..9]` *(10 seeded fuzz cases)*: Packs 40 random rectangles across 10 RNG seeds onto a `250×210` plate with `margin=1.5` and verifies bounds, rotation dimensions, completeness, and non-overlapping inter-part gaps.

### 4.4 G-code Merging & Toolpath Simulation Tests (`backend/tests/test_merge.py` — 7 tests)

* `test_merge_produces_single_start_and_end`: Verifies merged output contains exactly one `; EXECUTABLE_BLOCK_START`, one `; EXECUTABLE_BLOCK_END`, one shared start (`M83`), one shared end (`M84`), and `M486 T2`.
* `test_merge_interleaves_layers_and_tags_objects`: Verifies layer-by-layer interleaving (`M486 S0`, `M486 S1` per layer) and monotonically increasing Z levels.
* `test_merge_applies_offsets_and_keeps_footprints_apart`: Verifies re-parsed merged footprint matches the union of translated part footprints without overlap.
* `test_merge_rejects_mismatched_layer_heights`: Verifies `IncompatibleLayersError` when merging parts sliced at different layer heights (`0.2 mm` vs. `0.3 mm`).
* `test_merge_different_layer_counts_ok_on_same_grid`: Verifies shorter and taller parts on the same `0.2 mm` layer grid merge cleanly (`5` layers + `20` layers).
* `test_merge_rotates_gcode_when_placement_is_rotated`: Verifies a rotated placement produces rotated G-code coordinates matching `(0, 0, 66, 46)` on a `100×50` plate.
* `test_per_move_toolpath_simulation_invariants`: Simulates every `G0`/`G1` move of a 5-part merged plate (including rotated parts and differing heights) and verifies per-object `M486 S<i>` XY containment, zero cross-part intrusion, nominal layer-Z extrusion, and retracted inter-part travel moves.

### 4.5 End-to-End Pipeline & Real Orca Slicer Tests (`backend/tests/test_pipeline_stl.py` — 32 tests)

* `test_single_stl_batches_onto_one_plate[<stl>]` *(3 cases)*: Runs each STL through `plan_batches()` and validates the re-parsed merged G-code.
* `test_all_stls_batch_together`: Batches all STLs in `tests/stl/` onto one plate and validates `M486` tags, plate bounds, non-overlap, duration/filament roll-up (`FR-08`/`FR-10`), and utilization.
* `test_cached_gcode_is_never_resliced[<stl>]` *(3 cases)*: Verifies pre-populated `PrintJob.gcode_path` never calls the slicer.
* `test_repeated_plan_batches_reuses_cache_without_reslicing[<stl>]` *(3 cases)*: Verifies repeated `plan_batches()` calls (with the same `PrintJob` or a new `PrintJob` against the same `workdir`) slice once and reuse the disk cache.
* `test_rotated_placements_never_collide_or_overflow`: Batches 7 copies of `box_40x60x8.stl` on the default `prusa-mk4` plate (triggering 90° rotations) and verifies zero collisions and plate-bound compliance.
* `test_oversize_parts_split_into_multiple_plates`: Verifies two `240×240 mm` parts split across two `250×250 mm` plates.
* `test_incompatible_profiles_never_share_a_plate`: Verifies `draft` and `high_strength` jobs are placed into separate batches (`FR-05`).
* `test_slicer_unavailable_raises[<stl>]` *(3 cases)*: Verifies `SlicerUnavailableError` when no Orca Slicer binary can be located.
* `test_orca_slicer_end_to_end[<stl>]` *(3 cases)*: Slices each STL with the real Orca Slicer CLI and pinned presets.
* `test_orca_slicer_multi_stl_batch_end_to_end`: Slices and merges all STLs in `tests/stl/` together into one multi-part plate using the real Orca Slicer CLI.
* `test_per_printer_plate_sizes[<stl>]` *(3 cases)*: Verifies plate resolution for `prusa-mk4` (`250×210`), `prusa-core-one+` (`250×220`), `bambu-x1c` (`256×256`), `bambu-h2d-pro` (`350×320`), and separate batching per printer.
* `test_full_build_plate_area_core_one_plus_and_h2d_pro` *(2 cases)*: Slices and batches full-area models (`250×220 mm` on `prusa-core-one+` and `350×320 mm` on `bambu-h2d-pro`) with both fixture and real Orca Slicer CLI.
* `test_rotated_full_plate_core_one_plus_and_h2d_pro` *(2 cases)*: Slices and batches 90°-rotated full-area models (`220×250 mm` on `prusa-core-one+` and `320×350 mm` on `bambu-h2d-pro`) with both fixture and real Orca Slicer CLI (`--rotate 90` fallback).
* `test_fr03_rejects_oversize_xy_and_z_models`: Verifies SDP `FR-03` rejection of `300×300 mm` XY models on `250×250 mm`, rejection of `280 mm` tall models on `prusa-core-one+` (`max_z=270`), acceptance of `280 mm` tall models on `bambu-h2d-pro` (`max_z=325`), and rejection of `330 mm` tall models on `bambu-h2d-pro`.
* `test_fr11_three_50x50_models_compile_into_one_gcode`: Verifies the SDP `FR-11` acceptance test (three `50×50 mm` models compiled into one G-code file).
* `test_multi_tick_queue_simulation_slices_each_job_once`: Simulates 3 queue scheduling ticks with dynamic job arrivals/removals and verifies each job is sliced at most once.
* `test_negative_coordinate_stl_batches_cleanly`: Verifies origin-centered STLs with negative vertex coordinates batch into positive plate space.
* `test_orca_slicer_all_fr05_profiles_end_to_end`: Slices `cube_20mm.stl` across `draft`, `standard`, and `high_strength` with the real Orca Slicer CLI and verifies layer counts, durations, and filament usage ordering.

### 4.6 Smoke & Cross-Stack Integration Tests (`backend/tests/test_smoke.py` & `tests/test_integration_smoke.py`)

* `backend/tests/test_smoke.py::test_backend_main_runs`: Verifies the backend package entry point imports and executes cleanly.
* `tests/test_integration_smoke.py`: Root cross-stack integration smoke test run in CI.
