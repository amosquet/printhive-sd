"""Orca Slicer CLI wrapper (SYS-04, SYS-11).

Every job is sliced exactly once at submission time and the resulting G-code
is cached; the batching stage (:mod:`backend.batching.pipeline`) never
re-slices. The binary is located via, in order:

1. the ``PRINTHIVE_ORCA_SLICER`` environment variable,
2. ``orca-slicer`` / ``OrcaSlicer`` on ``PATH``,
3. the macOS app bundle ``/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer``.

Profiles are pinned per the trade study: pass a ``--load-settings`` file and
optionally a ``--datadir`` with the team's preset bundle via
:func:`slice_stl`.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

DEFAULT_MACOS_BUNDLE = Path("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer")

# FR-05 profiles pinned in the repo: backend/profiles/<profile>.process.json
PROFILES = ("draft", "standard", "high_strength")
MACHINE_PRESET = "printhive_mk4.machine.json"
MACHINE_PRESETS: dict[str, str] = {
    "prusa-mk4": "printhive_mk4.machine.json",
    "prusa-core-one": "printhive_core_one_plus.machine.json",
    "prusa-core-one+": "printhive_core_one_plus.machine.json",
    "prusa-core-one-plus": "printhive_core_one_plus.machine.json",
    "bambu-x1c": "printhive_bambu_x1c.machine.json",
    "bambu-p1s": "printhive_bambu_x1c.machine.json",
    "bambu-h2d": "printhive_h2d_pro.machine.json",
    "bambu-h2d-pro": "printhive_h2d_pro.machine.json",
}


def normalize_printer_name(printer: str) -> str:
    """Canonical printer key (e.g. 'Prusa Core One+' -> 'prusa-core-one+')."""

    key = "-".join(printer.strip().lower().replace("_", "-").split())
    if key.startswith("bambu-lab-"):
        key = "bambu-" + key.removeprefix("bambu-lab-")
    return key


def machine_preset_for_printer(printer: str = "prusa-mk4") -> str:
    """Machine preset filename in ``backend/profiles/`` for ``printer``."""

    key = normalize_printer_name(printer)
    return MACHINE_PRESETS.get(key, MACHINE_PRESET)


def default_profiles_dir() -> Path:
    """The pinned Orca preset bundle committed at backend/profiles/."""

    return Path(__file__).resolve().parents[3] / "profiles"


def default_settings(profile: str = "standard", printer: str = "prusa-mk4") -> tuple[str, str]:
    """(datadir, settings) pointing at the pinned presets for a FR-05 profile and printer."""

    profiles_dir = default_profiles_dir()
    if profile not in PROFILES:
        raise ValueError(f"unknown profile {profile!r}; expected one of {PROFILES}")
    machine = machine_preset_for_printer(printer)
    settings = f"{profiles_dir / machine};{profiles_dir / (profile + '.process.json')}"
    return str(profiles_dir), settings


class SlicerUnavailableError(RuntimeError):
    """Raised when no Orca Slicer CLI binary can be found."""


class SliceError(RuntimeError):
    """Raised when the Orca Slicer CLI fails."""


def find_orca_slicer() -> str | None:
    """Locate the Orca Slicer CLI binary, or return None."""

    env = os.environ.get("PRINTHIVE_ORCA_SLICER")
    if env and Path(env).exists():
        return env
    for name in ("orca-slicer", "OrcaSlicer"):
        found = shutil.which(name)
        if found:
            return found
    if DEFAULT_MACOS_BUNDLE.exists():
        return str(DEFAULT_MACOS_BUNDLE)
    return None


def slice_stl(
    stl_path: str | Path,
    output_dir: str | Path,
    *,
    binary: str | None = None,
    settings: str | Path | None = None,
    datadir: str | Path | None = None,
    profile: str = "standard",
    printer: str = "prusa-mk4",
    timeout_s: float = 600.0,
) -> Path:
    """Slice one STL with the Orca Slicer CLI and return the produced G-code path.

    ``profile`` selects one of the pinned FR-05 profiles (draft / standard /
    high_strength) and ``printer`` selects the target machine preset from
    ``backend/profiles/``; ``settings``/``datadir`` override the preset bundle
    (env: ``PRINTHIVE_ORCA_SETTINGS`` / ``PRINTHIVE_ORCA_DATADIR``) for custom
    setups.
    """

    binary = binary or find_orca_slicer()
    if binary is None:
        raise SlicerUnavailableError(
            "Orca Slicer CLI not found; set PRINTHIVE_ORCA_SLICER or install orca-slicer"
        )
    stl_path = Path(stl_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if settings is None and datadir is None:
        datadir, settings = default_settings(profile, printer=printer)
    datadir = datadir or os.environ.get("PRINTHIVE_ORCA_DATADIR")
    settings = settings or os.environ.get("PRINTHIVE_ORCA_SETTINGS")

    cmd = [binary, "--allow-rotations", "--slice", "0", "--outputdir", str(output_dir)]
    if datadir:
        cmd += ["--datadir", str(datadir)]
    if settings:
        cmd += ["--load-settings", str(settings)]
    cmd.append(str(stl_path))

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s, check=False)
        if proc.returncode == 206:
            # Retry with an explicit 90-degree Z rotation for full-plate models whose
            # unrotated orientation exceeds the bed and cannot be auto-arranged with margin.
            rot_cmd = [binary, "--rotate", "90", "--slice", "0", "--outputdir", str(output_dir)]
            if datadir:
                rot_cmd += ["--datadir", str(datadir)]
            if settings:
                rot_cmd += ["--load-settings", str(settings)]
            rot_cmd.append(str(stl_path))
            proc = subprocess.run(rot_cmd, capture_output=True, text=True, timeout=timeout_s, check=False)
    except subprocess.TimeoutExpired as exc:
        raise SliceError(f"Orca Slicer timed out after {timeout_s}s slicing {stl_path}") from exc
    if proc.returncode != 0:
        raise SliceError(
            f"Orca Slicer failed (exit {proc.returncode}) slicing {stl_path}: "
            f"{(proc.stdout + proc.stderr).strip()[-2000:]}"
        )

    produced = sorted(output_dir.glob("plate_*.gcode"), key=lambda p: p.stat().st_mtime)
    if not produced:
        produced = sorted(output_dir.glob("*.gcode"), key=lambda p: p.stat().st_mtime)
    if not produced:
        raise SliceError(f"Orca Slicer produced no G-code for {stl_path} in {output_dir}")
    return produced[-1]
