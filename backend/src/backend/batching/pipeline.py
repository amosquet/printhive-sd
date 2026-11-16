"""Batching pipeline: STL jobs -> packed plates -> one merged G-code per plate.

This is the orchestration layer of design D-02 (Slice-Once G-code Merging):

1. each job is sliced once (Orca CLI, or a pre-sliced cached G-code) and parsed,
2. its printed footprint (extrusion bounding box, brim included) is extracted,
3. compatible jobs (same printer, material, profile per FR-05) are packed onto
   build plates with 2D bin-packing,
4. each plate's cached G-code files are merged into one dispatchable file with
   translated coordinates, layer interleaving and M486 object tags.

Per-job durations (FR-08) and filament usage survive batching, so the
shift-aware dispatcher (FR-10) can check ``batch.total_duration_s`` against the
remaining staffed shift at nesting time.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .gcode import ParsedGcode, parse_gcode
from .merge import PlacedPart, merge_parts
from .packing import Placement, Rect, pack_into_plates
from .slicer import slice_stl

# Slicer callable: (stl_path, output_dir) -> path to produced G-code.
Slicer = Callable[[Path, Path], Path]


@dataclass(frozen=True)
class BuildPlate:
    """Physical build plate dimensions in mm."""

    width: float = 250.0
    height: float = 250.0


# Plate size per printer (FR-03 build-volume analogue). Unknown printers fall
# back to the generic 250x250 SDP profile.
PRINTER_PLATES: dict[str, BuildPlate] = {
    "prusa-mk4": BuildPlate(250.0, 210.0),
    "bambu-x1c": BuildPlate(256.0, 256.0),
    "bambu-p1s": BuildPlate(256.0, 256.0),
}
DEFAULT_PLATE = BuildPlate(250.0, 250.0)


def plate_for_printer(printer: str) -> BuildPlate:
    """The build plate of a known printer, or the generic 250x250 default."""

    return PRINTER_PLATES.get(printer, DEFAULT_PLATE)


@dataclass
class PrintJob:
    """One queued job: an STL to slice once, or an already-sliced cached G-code."""

    source: Path
    profile: str = "standard"  # FR-05: draft | standard | high_strength
    printer: str = "prusa-mk4"
    material: str = "pla"
    gcode_path: Path | None = None  # cached slice output; sliced on demand if None
    name: str = ""

    def __post_init__(self) -> None:
        self.source = Path(self.source)
        if not self.name:
            self.name = self.source.stem
        if self.gcode_path is not None:
            self.gcode_path = Path(self.gcode_path)

    @property
    def compatibility_key(self) -> tuple[str, str, str]:
        """FR-05: jobs may share a plate only with same printer, material, profile."""

        return (self.printer, self.material, self.profile)


@dataclass
class PlacedJob:
    """A job with its parsed G-code and its placement on a plate."""

    job: PrintJob
    parsed: ParsedGcode
    placement: Placement

    @property
    def footprint_bounds(self) -> tuple[float, float, float, float]:
        """Absolute plate coords of this part's printed footprint."""

        min_x, min_y, max_x, max_y = self.parsed.footprint or (0.0, 0.0, 0.0, 0.0)
        return (self.placement.x, self.placement.y, self.placement.x + (max_x - min_x), self.placement.y + (max_y - min_y))


@dataclass
class Batch:
    """One build plate: placed jobs plus the merged dispatchable G-code."""

    plate: BuildPlate
    items: list[PlacedJob] = field(default_factory=list)
    gcode: str = ""

    @property
    def total_duration_s(self) -> float:
        return sum(item.parsed.duration_s or 0.0 for item in self.items)

    @property
    def total_filament_mm(self) -> float:
        return sum(item.parsed.filament_mm or 0.0 for item in self.items)

    @property
    def utilization(self) -> float:
        """Fraction of the plate area covered by part footprints."""

        area = sum(
            (item.parsed.footprint[2] - item.parsed.footprint[0])
            * (item.parsed.footprint[3] - item.parsed.footprint[1])
            for item in self.items
            if item.parsed.footprint
        )
        return area / (self.plate.width * self.plate.height)


def _resolve_gcode(job: PrintJob, slicer: Slicer | None, workdir: Path | None) -> Path:
    if job.gcode_path is not None:
        return job.gcode_path
    if slicer is not None:
        out_dir = (workdir or Path(".batch-cache")) / job.name
        return Path(slicer(job.source, out_dir))
    return slice_stl(job.source, (workdir or Path(".batch-cache")) / job.name, profile=job.profile)


def plan_batches(
    jobs: list[PrintJob],
    plate: BuildPlate | None = None,
    *,
    margin: float = 1.0,
    allow_rotation: bool = True,
    slicer: Slicer | None = None,
    workdir: Path | None = None,
) -> list[Batch]:
    """Group compatible jobs, pack them onto plates, and merge each plate's G-code.

    Jobs are grouped by (printer, material, profile); within a group, footprints
    are packed first-fit-decreasing into as few plates as needed. Each plate is
    merged into a single G-code file. ``slicer`` may be injected for tests; by
    default the Orca Slicer CLI is used (jobs with ``gcode_path`` set use the
    cache directly and are never re-sliced). When ``plate`` is None, each group
    is packed onto its printer's plate from :data:`PRINTER_PLATES`.
    """

    groups: dict[tuple[str, str, str], list[PrintJob]] = {}
    for job in jobs:
        groups.setdefault(job.compatibility_key, []).append(job)

    batches: list[Batch] = []
    for (printer, _, _), group_jobs in groups.items():
        group_plate = plate or plate_for_printer(printer)
        parsed: list[tuple[PrintJob, ParsedGcode]] = []
        for job in group_jobs:
            gcode_path = _resolve_gcode(job, slicer, workdir)
            parsed.append((job, parse_gcode(gcode_path.read_text(), source=str(gcode_path))))

        rects = [Rect(w=pg.footprint_size()[0], h=pg.footprint_size()[1]) for _, pg in parsed]
        plate_groups = pack_into_plates(
            rects, group_plate.width, group_plate.height, margin=margin, allow_rotation=allow_rotation
        )

        for placements in plate_groups:
            items: list[PlacedJob] = []
            parts: list[PlacedPart] = []
            for placement in placements:
                job, pg = parsed[placement.index]
                items.append(PlacedJob(job=job, parsed=pg, placement=placement))
                # translate so the footprint's min corner lands on the placement
                fp = pg.footprint or (0.0, 0.0, 0.0, 0.0)
                parts.append(
                    PlacedPart(
                        index=len(parts),
                        name=job.name,
                        parsed=pg,
                        dx=placement.x - fp[0],
                        dy=placement.y - fp[1],
                    )
                )
            gcode = merge_parts(parts)
            batches.append(Batch(plate=group_plate, items=items, gcode=gcode))
    return batches


def batch_stl_files(
    paths: list[str | Path],
    plate: BuildPlate | None = None,
    **kwargs,
) -> list[Batch]:
    """Convenience wrapper: batch a list of STL files with default job settings."""

    return plan_batches([PrintJob(source=Path(p)) for p in paths], plate, **kwargs)
