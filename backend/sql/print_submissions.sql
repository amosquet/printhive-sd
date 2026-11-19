BEGIN;

CREATE TABLE IF NOT EXISTS print_submissions (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    email TEXT NOT NULL,
    notes TEXT NOT NULL,
    request_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS print_submission_parts (
    submission_id UUID NOT NULL REFERENCES print_submissions (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    filename TEXT NOT NULL,
    settings JSONB NOT NULL,
    model BYTEA NOT NULL,
    PRIMARY KEY (submission_id, position)
);

COMMIT;
