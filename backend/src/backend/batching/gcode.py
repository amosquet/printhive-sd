"""Parsing and translation of per-job G-code produced by Orca Slicer.

Design D-02 (Slice-Once G-code Merging) slices each job once and caches the
result. Batching then works on the cached G-code:

1. extract the printed footprint (bounding box of extrusion paths, brim and
   skirt included) from the file,
2. split the file into a start block, per-layer blocks and an end block,
3. translate each layer's X/Y coordinates by the packed plate offset and
   interleave all parts layer by layer when merging.

The parser targets the Orca Slicer 2.5.x grammar, which wraps the machine code
in ``; EXECUTABLE_BLOCK_START`` / ``; EXECUTABLE_BLOCK_END`` and marks layers
with ``;LAYER_CHANGE`` followed by ``;Z:<height>``. Per the trade study, the
input grammar is constrained at slicing time: relative extrusion (M83), no arc
fitting (G2/G3 are rejected), uniform layer heights within a batch.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

LAYER_MARKER = ";LAYER_CHANGE"
EXEC_START = "; EXECUTABLE_BLOCK_START"
EXEC_END = "; EXECUTABLE_BLOCK_END"

_MOTION_RE = re.compile(r"^\s*G([0123])\b")
_PARAM_RE = re.compile(r"\b([XYZEFIJ])(-?\d+(?:\.\d+)?|-?\.\d+)")
_XY_PARAM_RE = re.compile(r"\b([XY])(-?\d+(?:\.\d+)?|-?\.\d+)")
_Z_COMMENT_RE = re.compile(r"^\s*;\s*Z:\s*(-?\d+(?:\.\d+)?)")
_TIME_COMMENT_RE = re.compile(r"^\s*;\s*TIME_ELAPSED:\s*(\d+(?:\.\d+)?)", re.IGNORECASE)
_ESTIMATED_TIME_RE = re.compile(r"^\s*;\s*estimated printing time[^=]*=\s*(.+?)\s*$", re.IGNORECASE)
_FILAMENT_MM_RE = re.compile(r"^\s*;\s*filament used \[mm\]\s*=\s*(\d+(?:\.\d+)?)", re.IGNORECASE)
_TIME_PART_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(h|m|s)", re.IGNORECASE)


class GcodeFormatError(ValueError):
    """Raised when a cached G-code file violates the constrained grammar."""


@dataclass
class Layer:
    """One printed layer: its Z height and the raw (untranslated) lines."""

    z: float
    lines: list[str] = field(default_factory=list)


@dataclass
class ParsedGcode:
    """A cached per-job G-code file split into start / layers / end."""

    start_lines: list[str]
    layers: list[Layer]
    end_lines: list[str]
    footprint: tuple[float, float, float, float] | None  # min_x, min_y, max_x, max_y
    duration_s: float | None
    filament_mm: float | None
    source: str = ""

    @property
    def layer_heights(self) -> list[float]:
        return [layer.z for layer in self.layers]

    def footprint_size(self, margin: float = 0.0) -> tuple[float, float]:
        """Footprint width/height, optionally expanded by ``margin`` per side."""

        if self.footprint is None:
            raise GcodeFormatError(f"{self.source or 'gcode'} has no extrusion footprint")
        min_x, min_y, max_x, max_y = self.footprint
        return (max_x - min_x + 2 * margin, max_y - min_y + 2 * margin)


def _parse_params(line: str) -> dict[str, float]:
    params: dict[str, float] = {}
    for match in _PARAM_RE.finditer(line):
        params[match.group(1)] = float(match.group(2))
    return params


def parse_duration(text: str) -> float | None:
    """Parse an Orca ``; estimated printing time = 1h 2m 3s`` comment."""

    seconds = 0.0
    found = False
    for part in _TIME_PART_RE.finditer(text):
        value = float(part.group(1))
        unit = part.group(2).lower()
        if unit == "h":
            seconds += value * 3600
        elif unit == "m":
            seconds += value * 60
        else:
            seconds += value
        found = True
    return seconds if found else None


def _scan_footprint_and_mode(lines: list[str]) -> tuple[tuple[float, float, float, float] | None, bool]:
    """Bounding box over XY of extrusion moves (E > 0). Returns (bbox, relative_e)."""

    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")
    found = False
    relative_e = True  # Orca profiles use M83; refined while scanning
    last_abs_e = 0.0
    for line in lines:
        code = line.split(";", 1)[0].strip()
        if code == "M83":
            relative_e = True
            continue
        if code == "M82":
            relative_e = False
            continue
        if not _MOTION_RE.match(line):
            continue
        params = _parse_params(line)
        if "E" not in params:
            continue
        if relative_e:
            extruding = params["E"] > 0
        else:
            extruding = params["E"] > last_abs_e
            last_abs_e = params["E"]
        if not extruding or ("X" not in params and "Y" not in params):
            continue
        x = params.get("X", float("nan"))
        y = params.get("Y", float("nan"))
        if "X" in params:
            min_x = min(min_x, x)
            max_x = max(max_x, x)
        if "Y" in params:
            min_y = min(min_y, y)
            max_y = max(max_y, y)
        found = True
    if not found:
        return None, relative_e
    return (min_x, min_y, max_x, max_y), relative_e


def parse_gcode(text: str, source: str = "") -> ParsedGcode:
    """Parse a cached per-job G-code file into start block, layers and end block."""

    lines = text.splitlines()

    exec_start = next((i for i, ln in enumerate(lines) if ln.strip() == EXEC_START), None)
    exec_end = next((i for i, ln in enumerate(lines) if ln.strip() == EXEC_END), None)
    region_start = exec_start + 1 if exec_start is not None else 0
    region_end = exec_end if exec_end is not None else len(lines)

    region = lines[region_start:region_end]
    first_layer = next((i for i, ln in enumerate(region) if ln.strip() == LAYER_MARKER), None)
    if first_layer is None:
        raise GcodeFormatError(
            f"{source or 'gcode'}: no {LAYER_MARKER} marker; not a sliced job file"
        )

    start_lines = [ln for ln in region[:first_layer] if ln.strip()]

    body = region[first_layer:]
    # The end block starts at the first non-comment command after the last
    # motion line of the body; everything after it is the per-file end G-code.
    last_motion = -1
    for i, ln in enumerate(body):
        if _MOTION_RE.match(ln) and _parse_params(ln) and any(
            axis in _parse_params(ln) for axis in ("X", "Y", "E")
        ):
            last_motion = i
    if last_motion < 0:
        raise GcodeFormatError(f"{source or 'gcode'}: no motion commands in body")
    end_lines = [ln for ln in body[last_motion + 1 :] if ln.strip()]
    body = body[: last_motion + 1]

    # Split the body into layer chunks on each ;LAYER_CHANGE marker.
    chunks: list[list[str]] = []
    current: list[str] = []
    for ln in body:
        if ln.strip() == LAYER_MARKER:
            if current:
                chunks.append(current)
            current = [ln]
        else:
            current.append(ln)
    if current:
        chunks.append(current)

    # Orca emits the marker once from the layer-change G-code template and once
    # from the slicer itself, so consecutive chunks with the same Z are one layer.
    layers: list[Layer] = []
    for chunk in chunks:
        z: float | None = None
        for ln in chunk:
            m = _Z_COMMENT_RE.match(ln)
            if m:
                z = float(m.group(1))
                break
        if z is None:
            z = layers[-1].z if layers else 0.0
        if layers and abs(layers[-1].z - z) < 1e-6:
            layers[-1].lines.extend(chunk)
        else:
            layers.append(Layer(z=z, lines=chunk))

    footprint, _ = _scan_footprint_and_mode(body)

    duration_s: float | None = None
    for ln in lines:
        m = _ESTIMATED_TIME_RE.match(ln)
        if m:
            duration_s = parse_duration(m.group(1))
            break
    if duration_s is None:
        elapsed = [float(m.group(1)) for ln in lines if (m := _TIME_COMMENT_RE.match(ln))]
        if elapsed:
            duration_s = elapsed[-1]

    filament_mm: float | None = None
    for ln in lines:
        m = _FILAMENT_MM_RE.match(ln)
        if m:
            filament_mm = float(m.group(1))
            break

    return ParsedGcode(
        start_lines=start_lines,
        layers=layers,
        end_lines=end_lines,
        footprint=footprint,
        duration_s=duration_s,
        filament_mm=filament_mm,
        source=source,
    )


def translate_xy(line: str, dx: float, dy: float) -> str:
    """Translate the X/Y parameters of a G0/G1 line by (dx, dy).

    Z, E, F and all non-motion commands are left untouched; G2/G3 arcs are not
    part of the constrained grammar and raise :class:`GcodeFormatError`.
    """

    if re.match(r"^\s*G[23]\b", line):
        raise GcodeFormatError(f"arc command not allowed in constrained grammar: {line!r}")
    if not re.match(r"^\s*G[01]\b", line):
        return line

    def repl(match: re.Match[str]) -> str:
        axis = match.group(1)
        value = float(match.group(2)) + (dx if axis == "X" else dy)
        text = f"{value:.3f}".rstrip("0").rstrip(".")
        if text in ("", "-", "-0"):
            text = "0"
        return f"{axis}{text}"

    return _XY_PARAM_RE.sub(repl, line)


def translate_layer(layer: Layer, dx: float, dy: float) -> list[str]:
    """Return the layer's lines with X/Y translated by (dx, dy)."""

    return [translate_xy(ln, dx, dy) for ln in layer.lines]


def first_xy(lines: list[str]) -> tuple[float, float] | None:
    """First X/Y target of a (already translated) line list, if any."""

    for ln in lines:
        if _MOTION_RE.match(ln):
            params = _parse_params(ln)
            if "X" in params or "Y" in params:
                return (params.get("X", 0.0), params.get("Y", 0.0))
    return None
