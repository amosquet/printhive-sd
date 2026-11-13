from pathlib import Path
from backend import main


def test_monorepo_layout_and_backend_entrypoint() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    assert (repo_root / "backend" / "pyproject.toml").is_file()
    assert (repo_root / "frontend" / "package.json").is_file()
    assert callable(main)
