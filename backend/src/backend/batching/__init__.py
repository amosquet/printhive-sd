"""Dynamic 2D nesting & batching subsystem (SYS-06 / FR-11), design D-02.

Slice-Once G-code Merging: each job is sliced once with the Orca Slicer CLI and
cached; batching extracts extrusion footprints from the cached G-code, packs
them onto the build plate with 2D bin-packing, and merges the cached files into
one dispatchable G-code per plate (coordinate translation + layer interleaving
+ M486 object tags).
"""

from .gcode import (
    GcodeFormatError,
    Layer,
    ParsedGcode,
    parse_duration,
    parse_gcode,
    translate_layer,
    translate_xy,
)
from .merge import IncompatibleLayersError, PlacedPart, merge_parts
from .packing import Placement, PlatePacker, Rect, pack_into_plates, pack_rectangles
from .pipeline import (
    DEFAULT_PLATE,
    PRINTER_PLATES,
    Batch,
    BuildPlate,
    PlacedJob,
    PrintJob,
    batch_stl_files,
    plan_batches,
    plate_for_printer,
)
from .slicer import (
    PROFILES,
    SliceError,
    SlicerUnavailableError,
    default_profiles_dir,
    default_settings,
    find_orca_slicer,
    slice_stl,
)
from .stl import Mesh, load_stl, write_binary_stl

__all__ = [
    "DEFAULT_PLATE",
    "PRINTER_PLATES",
    "PROFILES",
    "Batch",
    "BuildPlate",
    "GcodeFormatError",
    "IncompatibleLayersError",
    "Layer",
    "Mesh",
    "ParsedGcode",
    "PlacedJob",
    "PlacedPart",
    "Placement",
    "PlatePacker",
    "PrintJob",
    "Rect",
    "SliceError",
    "SlicerUnavailableError",
    "batch_stl_files",
    "default_profiles_dir",
    "default_settings",
    "find_orca_slicer",
    "load_stl",
    "merge_parts",
    "pack_into_plates",
    "pack_rectangles",
    "parse_duration",
    "parse_gcode",
    "plan_batches",
    "plate_for_printer",
    "slice_stl",
    "translate_layer",
    "translate_xy",
    "write_binary_stl",
]
