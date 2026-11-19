"""Submission-to-scheduling regression tests using an isolated PostgreSQL schema.

Set PRINTHIVE_TEST_DATABASE_URL to a disposable PostgreSQL database to run.
"""

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from fixture_slicer import fixture_slice_stl
from psycopg import sql
from psycopg.conninfo import make_conninfo

from backend.priority_scheduling import PriorityPolicy, StaffShift
from backend.slice_worker import eligibility, process_one
from backend.submissions import create_app


@pytest.fixture
def database(monkeypatch):
    url = os.environ.get("PRINTHIVE_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set PRINTHIVE_TEST_DATABASE_URL to run PostgreSQL integration tests.")
    schema = f"slice_test_{uuid4().hex}"
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            dsn = make_conninfo(url, options=f"-c search_path={schema}")
            monkeypatch.setenv("DATABASE_URL", dsn)
            with psycopg.connect(dsn) as db:
                for name in ("print_submissions.sql", "slice_jobs.sql"):
                    db.execute((Path(__file__).parents[1] / "sql" / name).read_text())
            yield dsn
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def _submit(client, filename, model):
    request_id = uuid4()
    details = {
        "id": str(request_id),
        "title": "Integration print",
        "email": "student@purdue.edu",
        "notes": "",
        "parts": [{
            "profile": "standard", "material": "PLA", "color": "White",
            "supports": "operator", "supportAngle": None, "units": "mm",
            "scalePercent": 100, "copies": 1, "mirror": False,
            "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        }],
    }
    def post():
        return client.post(
            "/api/prints", data={"submission": json.dumps(details)},
            files=[("models", (filename, model))],
        )
    response = post()
    assert response.status_code == 201, response.text
    assert response.json()["id"] == str(request_id)
    return request_id, post


def _fixture_slicer(src, out, **_settings):
    return fixture_slice_stl(src, out)


def test_upload_slice_and_schedule(database):
    model = (Path(__file__).parent / "stl" / "cube_20mm.stl").read_bytes()
    with TestClient(create_app()) as client:
        request_id, retry = _submit(client, "cube.stl", model)
        assert retry().status_code == 201

    calls = []
    def slicer(src, out, **settings):
        calls.append(settings)
        return _fixture_slicer(src, out, **settings)

    assert process_one(database, "prusa-mk4", slicer=slicer) == request_id
    assert process_one(database, "prusa-mk4", slicer=slicer) is None
    assert len(calls) == 1
    with psycopg.connect(database) as db:
        rows = db.execute(
            "SELECT status, printer, duration_s, gcode FROM slice_jobs WHERE submission_id = %s",
            (request_id,),
        ).fetchall()
    assert len(rows) == 1
    status, printer, duration, gcode = rows[0]
    assert status == "completed"
    assert printer == "prusa-mk4"
    assert duration > 0
    assert gcode and b"G1" in gcode

    now = datetime.now(UTC) + timedelta(seconds=1)
    policy = PriorityPolicy(aging_per_hour=0)
    long_shift = [StaffShift(now - timedelta(seconds=1), now + timedelta(seconds=duration + 1))]
    short_shift = [StaffShift(now - timedelta(seconds=1), now + timedelta(seconds=duration))]
    eligible = eligibility(database, "prusa-mk4", long_shift, now=now, policy=policy)
    assert [job.job_id for job in eligible] == [str(request_id)]
    assert eligible[0].duration_s == pytest.approx(duration)
    assert eligibility(database, "prusa-mk4", short_shift, now=now, policy=policy) == ()
    assert eligibility(database, "bambu-x1c", long_shift, now=now, policy=policy) == ()


def test_unsupported_submission_stays_ineligible(database):
    with TestClient(create_app()) as client:
        request_id, _ = _submit(client, "part.obj", b"v 0 0 0\n")
    assert process_one(database, "prusa-mk4", slicer=_fixture_slicer) == request_id
    with psycopg.connect(database) as db:
        status, duration, gcode = db.execute(
            "SELECT status, duration_s, gcode FROM slice_jobs WHERE submission_id = %s",
            (request_id,),
        ).fetchone()
    assert status == "failed"
    assert duration is None and gcode is None
    now = datetime.now(UTC) + timedelta(seconds=1)
    shifts = [StaffShift(now - timedelta(minutes=1), now + timedelta(days=1))]
    assert eligibility(database, "prusa-mk4", shifts, now=now, policy=PriorityPolicy(0)) == ()


def test_malformed_stl_fails_before_slicing(database):
    with TestClient(create_app()) as client:
        request_id, _ = _submit(client, "broken.stl", b"not an STL")

    calls = []
    def slicer(src, out, **settings):
        calls.append(src)
        return _fixture_slicer(src, out, **settings)

    assert process_one(database, "prusa-mk4", slicer=slicer) == request_id
    assert not calls
    with psycopg.connect(database) as db:
        assert db.execute(
            "SELECT status, duration_s, gcode FROM slice_jobs WHERE submission_id = %s",
            (request_id,),
        ).fetchone() == ("failed", None, None)
    now = datetime.now(UTC) + timedelta(seconds=1)
    shifts = [StaffShift(now - timedelta(minutes=1), now + timedelta(days=1))]
    assert eligibility(database, "prusa-mk4", shifts, now=now, policy=PriorityPolicy(0)) == ()
    assert process_one(database, "prusa-mk4", slicer=slicer) is None


def test_expired_claim_is_retried(database):
    model = (Path(__file__).parent / "stl" / "cube_20mm.stl").read_bytes()
    with TestClient(create_app()) as client:
        request_id, _ = _submit(client, "cube.stl", model)
    with psycopg.connect(database) as db:
        db.execute(
            """UPDATE slice_jobs SET status = 'processing', claim_token = %s,
               lease_until = now() - interval '1 second', attempts = 1 WHERE submission_id = %s""",
            (uuid4(), request_id),
        )
    assert process_one(database, "prusa-mk4", slicer=_fixture_slicer) == request_id
    with psycopg.connect(database) as db:
        status, attempts, duration = db.execute(
            "SELECT status, attempts, duration_s FROM slice_jobs WHERE submission_id = %s",
            (request_id,),
        ).fetchone()
    assert (status, attempts) == ("completed", 2)
    assert duration > 0
    assert process_one(database, "prusa-mk4", slicer=_fixture_slicer) is None


def test_migration_backfills_existing_upload_and_is_idempotent(database):
    with psycopg.connect(database) as db:
        db.execute("DROP TRIGGER queue_print_submission ON print_submissions")
        db.execute("DROP TABLE slice_jobs")
    model = (Path(__file__).parent / "stl" / "cube_20mm.stl").read_bytes()
    with TestClient(create_app()) as client:
        request_id, _ = _submit(client, "cube.stl", model)
    migration = (Path(__file__).parents[1] / "sql" / "slice_jobs.sql").read_text()
    with psycopg.connect(database) as db:
        db.execute(migration)
        db.execute(migration)
        assert db.execute(
            "SELECT submission_id, status, attempts FROM slice_jobs"
        ).fetchall() == [(request_id, "pending", 0)]
    assert process_one(database, "prusa-mk4", slicer=_fixture_slicer) == request_id


def test_duration_without_extrusion_is_not_eligible(database):
    model = (Path(__file__).parent / "stl" / "cube_20mm.stl").read_bytes()
    with TestClient(create_app()) as client:
        request_id, _ = _submit(client, "cube.stl", model)

    def travel_only_slicer(src, out, **settings):
        out.mkdir()
        output = out / "plate_1.gcode"
        output.write_text(";LAYER_CHANGE\n;Z:0.2\nG1 X1 Y1\n; estimated printing time = 2m\n")
        return output

    assert process_one(database, "prusa-mk4", slicer=travel_only_slicer) == request_id
    with psycopg.connect(database) as db:
        assert db.execute(
            "SELECT status, gcode, duration_s, error FROM slice_jobs WHERE submission_id = %s",
            (request_id,),
        ).fetchone() == ("failed", None, None, "slicer output has no extrusion footprint")
