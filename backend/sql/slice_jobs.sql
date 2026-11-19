-- Apply after print_submissions.sql. The trigger queues new submissions in the
-- same transaction as their models; the backfill also covers existing uploads.
BEGIN;
CREATE TABLE IF NOT EXISTS slice_jobs (
    submission_id UUID PRIMARY KEY REFERENCES print_submissions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    printer TEXT,
    claim_token UUID,
    lease_until TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    gcode BYTEA,
    duration_s DOUBLE PRECISION CHECK (duration_s > 0 AND duration_s < 'Infinity'::float8),
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'processing') = (claim_token IS NOT NULL AND lease_until IS NOT NULL)),
    CHECK (status <> 'completed' OR (printer IS NOT NULL AND gcode IS NOT NULL AND duration_s IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS slice_jobs_claim_idx ON slice_jobs (status, lease_until);

CREATE OR REPLACE FUNCTION queue_print_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO slice_jobs (submission_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS queue_print_submission ON print_submissions;
CREATE TRIGGER queue_print_submission AFTER INSERT ON print_submissions
    FOR EACH ROW EXECUTE FUNCTION queue_print_submission();
INSERT INTO slice_jobs (submission_id) SELECT id FROM print_submissions ON CONFLICT DO NOTHING;
COMMIT;
