# Pinned Orca Slicer presets

These are the pinned slicer presets for the batching subsystem (SYS-11: we
build on the Orca Slicer CLI, we do not reimplement slicing). They are used by
default by `backend.batching.slicer.slice_stl()` via `default_settings(profile)`
— no environment variables needed:

- `printhive_mk4.machine.json` — Prusa MK4-class machine (250x210 bed, 0.4 mm
  nozzle, relative extrusion M83, shared start/end G-code)
- `draft.process.json` / `standard.process.json` / `high_strength.process.json`
  — the three FR-05 profiles (layer height, walls, infill, speeds)
- `system/.gitkeep` — Orca requires a `system/` dir inside the `--datadir`

Contract-test note (from the trade study): the G-code merger assumes the
constrained grammar these presets produce — relative extrusion (M83), no arc
fitting, `G92 E0` in the layer-change G-code, `;LAYER_CHANGE` / `;Z:` markers.
Pin the Orca version (developed against OrcaSlicer 2.5.0) and re-run
`pytest tests/ -k orca` after any slicer upgrade; the real-Orca end-to-end
tests slice every STL in `tests/stl/` and validate the merged plate.

Override with `PRINTHIVE_ORCA_SLICER` (binary path), `PRINTHIVE_ORCA_DATADIR`,
and `PRINTHIVE_ORCA_SETTINGS` for custom setups.
