"""HTTP intake for print requests and their original model files."""

import logging
import os
from contextlib import asynccontextmanager
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from psycopg.types.json import Jsonb
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    StringConstraints,
    ValidationError,
)
from starlette.datastructures import UploadFile

MAX_FILES = 10
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_METADATA_BYTES = 32 * 1024
MAX_REQUEST_BYTES = MAX_FILES * MAX_FILE_BYTES + 256 * 1024
LOG = logging.getLogger(__name__)


class PartSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile: Literal["draft", "standard", "high_strength"]
    material: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)
    ]
    color: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)
    ]
    supports: Literal["operator", "none", "tree", "normal"]
    supportAngle: int | None = Field(ge=0, le=90)
    units: Literal["mm", "m", "in"]
    scalePercent: FiniteFloat = Field(ge=0.01, le=10000)
    copies: int = Field(ge=1, le=5)
    mirror: bool
    rotation: list[FiniteFloat] = Field(min_length=9, max_length=9)


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: UUID
    title: str = Field(min_length=1, max_length=200)
    email: str = Field(max_length=254, pattern=r"^[^@\s]+@purdue\.edu$")
    notes: str = Field(max_length=5000)
    parts: list[PartSettings] = Field(min_length=1, max_length=MAX_FILES)


class Receipt(BaseModel):
    id: UUID
    status: Literal["submitted"] = "submitted"


def store_submission(
    database_url: str, details: Submission, files: list[UploadFile]
) -> Receipt:
    fingerprint = sha256(details.model_dump_json().encode())
    for upload in files:
        fingerprint.update((upload.filename or "").encode() + b"\0")
        file_digest = sha256()
        while chunk := upload.file.read(1024 * 1024):
            file_digest.update(chunk)
        fingerprint.update(file_digest.digest())
        upload.file.seek(0)
    digest = fingerprint.digest()

    with psycopg.connect(database_url, connect_timeout=5) as db:
        saved = db.execute(
            """INSERT INTO print_submissions (id, title, email, notes, request_hash)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (id) DO NOTHING RETURNING id""",
            (details.id, details.title, details.email, details.notes, digest),
        ).fetchone()
        if saved is None:
            existing = db.execute(
                "SELECT request_hash FROM print_submissions WHERE id = %s",
                (details.id,),
            ).fetchone()
            if existing is None or existing[0] != digest:
                raise HTTPException(
                    409, "This submission ID already belongs to a different request."
                )
            return Receipt(id=details.id)

        for position, (settings, upload) in enumerate(
            zip(details.parts, files, strict=True)
        ):
            db.execute(
                """INSERT INTO print_submission_parts
                       (submission_id, position, filename, settings, model)
                   VALUES (%s, %s, %s, %s, %s)""",
                (
                    details.id,
                    position,
                    upload.filename,
                    Jsonb(settings.model_dump()),
                    upload.file.read(),
                ),
            )
    return Receipt(id=details.id)


def create_app() -> FastAPI:
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError(
            "Set DATABASE_URL in backend/.env before starting the print API."
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        def check_database() -> None:
            with psycopg.connect(database_url, connect_timeout=5) as db:
                db.execute("SELECT id FROM print_submissions LIMIT 0")
                db.execute("SELECT submission_id FROM print_submission_parts LIMIT 0")

        try:
            await run_in_threadpool(check_database)
        except psycopg.Error:
            raise RuntimeError(
                "Unable to reach the print tables. Check DATABASE_URL and apply the submission schema."
            ) from None
        yield

    app = FastAPI(title="PrintHive Submission API", lifespan=lifespan)
    origins = os.environ.get(
        "FRONTEND_ORIGINS", "http://localhost:4321,http://127.0.0.1:4321"
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip() for origin in origins.split(",") if origin.strip()
        ],
        allow_methods=["POST"],
    )

    @app.post("/api/prints", response_model=Receipt, status_code=201)
    async def submit_print(request: Request) -> Receipt:
        length = request.headers.get("content-length", "")
        if not length.isascii() or not length.isdecimal() or len(length) > 12:
            raise HTTPException(
                411, "Send a Content-Length header with the model upload."
            )
        if int(length) > MAX_REQUEST_BYTES:
            raise HTTPException(413, "The print submission is too large.")
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip()
            != "multipart/form-data"
        ):
            raise HTTPException(
                415, "Send the metadata and models as multipart form data."
            )

        async with request.form(
            max_files=MAX_FILES, max_fields=1, max_part_size=MAX_METADATA_BYTES
        ) as form:
            metadata = form.get("submission")
            files = form.getlist("models")
            if not isinstance(metadata, str) or not all(
                isinstance(file, UploadFile) for file in files
            ):
                raise HTTPException(422, "Include submission metadata and model files.")
            try:
                details = Submission.model_validate_json(metadata)
            except ValidationError:
                raise HTTPException(
                    422, "Check your Purdue email, print title, and part settings."
                ) from None
            if len(details.parts) != len(files):
                raise HTTPException(
                    422, "Include one settings entry for each uploaded file."
                )
            for upload in files:
                name = upload.filename or ""
                if len(name) > 255 or any(char in name for char in ("/", "\\", "\0")):
                    raise HTTPException(422, "Use a valid model filename.")
                if Path(name).suffix.lower() not in {".stl", ".obj"}:
                    raise HTTPException(422, "Upload STL or OBJ files.")
                if not upload.size:
                    raise HTTPException(422, "Upload non-empty model files.")
                if upload.size > MAX_FILE_BYTES:
                    raise HTTPException(413, "Each model must be 50 MB or smaller.")
            try:
                return await run_in_threadpool(
                    store_submission, database_url, details, files
                )
            except psycopg.Error as error:
                LOG.error("Unable to save print submission (%s)", type(error).__name__)
                raise HTTPException(
                    503, "The print database is unavailable. Try submitting again."
                ) from None

    return app
