"""Run with PRINTHIVE_TEST_DATABASE_URL to exercise real PostgreSQL writes."""

import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from backend.submissions import create_app


@pytest.fixture
def postgres(monkeypatch):
    url = os.environ.get("PRINTHIVE_TEST_DATABASE_URL")
    if not url:
        pytest.skip(
            "Set PRINTHIVE_TEST_DATABASE_URL to run PostgreSQL integration tests."
        )

    schema = f"intake_test_{uuid4().hex}"
    with psycopg.connect(url, autocommit=True) as db:
        db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            dsn = make_conninfo(url, options=f"-c search_path={schema}")
            monkeypatch.setenv("DATABASE_URL", dsn)
            with psycopg.connect(dsn) as target:
                migration = Path(__file__).parents[1] / "sql" / "print_submissions.sql"
                target.execute(migration.read_text())
            yield dsn
        finally:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_upload_saves_parts_and_retry_returns_same_id(postgres):
    request_id = str(uuid4())
    part = {
        "profile": "standard",
        "material": "PLA",
        "color": "White",
        "supports": "operator",
        "supportAngle": None,
        "units": "mm",
        "scalePercent": 100,
        "copies": 2,
        "mirror": False,
        "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
    }
    details = {
        "id": request_id,
        "title": "Test plate",
        "email": "student@purdue.edu",
        "notes": "Keep flat",
        "parts": [part, {**part, "profile": "draft"}],
    }
    models = [
        ("models", ("cube.stl", b"STL fixture")),
        ("models", ("bracket.obj", b"OBJ fixture")),
    ]
    with TestClient(create_app()) as client:
        bad = client.post(
            "/api/prints",
            data={"submission": json.dumps(details)},
            files=[models[0], ("models", ("not-a-model.txt", b"invalid"))],
        )
        assert bad.status_code == 422

        for _ in range(2):
            response = client.post(
                "/api/prints", data={"submission": json.dumps(details)}, files=models
            )
            assert response.status_code == 201
            assert response.json() == {"id": request_id, "status": "submitted"}

        details["title"] = "Different print"
        conflict = client.post(
            "/api/prints", data={"submission": json.dumps(details)}, files=models
        )
        assert conflict.status_code == 409

    with psycopg.connect(postgres) as db:
        assert db.execute(
            "SELECT title, notes, email FROM print_submissions"
        ).fetchall() == [
            ("Test plate", "Keep flat", "student@purdue.edu"),
        ]
        assert db.execute(
            """SELECT filename, settings->>'profile', model FROM print_submission_parts
               ORDER BY position"""
        ).fetchall() == [
            ("cube.stl", "standard", b"STL fixture"),
            ("bracket.obj", "draft", b"OBJ fixture"),
        ]
