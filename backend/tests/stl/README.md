# Drop STL files here

Any `.stl` file placed in this directory is picked up automatically by the
batching test suite (`backend/tests/`). The tests slice each STL (with the
Orca Slicer CLI when available, otherwise the in-repo fixture slicer) and run
the full slice-once batching pipeline — footprint extraction, 2D bin-packing
onto the plate, and merged G-code generation — then validate the merged output
(plate bounds, no part overlap, layer interleaving, M486 tags, per-job
durations).

The sample files committed here keep CI green; add your own models freely.
