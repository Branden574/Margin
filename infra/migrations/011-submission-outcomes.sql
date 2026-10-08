-- Durable processing outcomes and retries of the SAME immutable captured submission.
-- This migration neither sends Canvas requests nor enables a production worker.
BEGIN;
ALTER TABLE margin_submissions.outbox DROP CONSTRAINT outbox_materialization_state_check;
ALTER TABLE margin_submissions.outbox DROP CONSTRAINT materialization_completion;
ALTER TABLE margin_submissions.outbox ADD COLUMN status_revision bigint NOT NULL DEFAULT 1 CHECK(status_revision BETWEEN 1 AND 9007199254740991),
 ADD COLUMN processing_generation integer NOT NULL DEFAULT 1 CHECK(processing_generation BETWEEN 1 AND 3),
 ADD COLUMN published_error_code text CHECK(published_error_code IN ('source_unavailable','snapshot_invalid','authority_revoked','retry_exhausted')),
 ADD COLUMN failed_at timestamptz;
ALTER TABLE margin_submissions.outbox ADD CONSTRAINT materialization_state CHECK(materialization_state IN ('pending','completed','failed')),
 ADD CONSTRAINT materialization_completion CHECK(
 (materialization_state='pending' AND materialized_at IS NULL AND failed_at IS NULL AND published_error_code IS NULL) OR
 (materialization_state='completed' AND materialized_at IS NOT NULL AND claim_id IS NOT NULL AND failed_at IS NULL AND published_error_code IS NULL) OR
 (materialization_state='failed' AND materialized_at IS NULL AND failed_at IS NOT NULL AND published_error_code IS NOT NULL));
-- ALTER TABLE holds an exclusive lock for this transaction; migrate existing010 successes
-- without mutating their encrypted receipts, then immediately restore the write guard.
ALTER TABLE margin_submissions.outbox DISABLE TRIGGER protect_materialization_job;
UPDATE margin_submissions.outbox SET status_revision=2 WHERE materialization_state='completed';
ALTER TABLE margin_submissions.outbox ENABLE TRIGGER protect_materialization_job;
ALTER TABLE margin_submissions.outbox ADD CONSTRAINT processing_revision CHECK(
 status_revision=processing_generation*2-CASE WHEN materialization_state='pending' THEN 1 ELSE 0 END);
CREATE POLICY outcome_initial ON margin_submissions.outbox AS RESTRICTIVE FOR INSERT TO margin_submission_runtime WITH CHECK(status_revision=1 AND processing_generation=1 AND published_error_code IS NULL AND failed_at IS NULL);
ALTER TABLE margin_submissions.attempts ADD CONSTRAINT submission_attempt_work UNIQUE(id,work_id);
CREATE TABLE margin_submissions.reprocess_commands (
 attempt_id uuid NOT NULL,organization_id uuid NOT NULL,work_id uuid NOT NULL,
 expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
 state text NOT NULL CHECK(state IN ('accepted','rejected')),
 accepted_revision bigint,code text CHECK(code IN ('revision_changed','not_retryable','retry_limit')),
 processing_generation integer NOT NULL CHECK(processing_generation BETWEEN 1 AND 3),
 prior_error_code text CHECK(prior_error_code IN ('source_unavailable','snapshot_invalid','authority_revoked','retry_exhausted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(attempt_id,expected_revision),FOREIGN KEY(attempt_id,work_id) REFERENCES margin_submissions.attempts(id,work_id),
 CHECK((state='accepted' AND accepted_revision=expected_revision+1 AND code IS NULL AND processing_generation>=2 AND prior_error_code IN ('source_unavailable','authority_revoked','retry_exhausted')) OR (state='rejected' AND accepted_revision IS NULL AND code IS NOT NULL))
);
ALTER TABLE margin_submissions.reprocess_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE margin_submissions.reprocess_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY reprocess_read ON margin_submissions.reprocess_commands FOR SELECT TO margin_submission_runtime USING(margin_submissions.visible(organization_id,work_id));
-- Future revision numbers never acquire a durable outcome: they must not poison a later retry.
CREATE POLICY reprocess_insert ON margin_submissions.reprocess_commands FOR INSERT TO margin_submission_runtime WITH CHECK(
 margin_submissions.visible(organization_id,work_id) AND EXISTS(
 SELECT 1 FROM margin_submissions.outbox j JOIN margin_submissions.attempts a ON a.id=j.attempt_id AND a.work_id=j.work_id
 WHERE j.attempt_id=reprocess_commands.attempt_id AND j.work_id=reprocess_commands.work_id AND a.organization_id=reprocess_commands.organization_id
 AND reprocess_commands.expected_revision<=j.status_revision AND reprocess_commands.prior_error_code IS NOT DISTINCT FROM j.published_error_code
 AND ((reprocess_commands.state='accepted' AND reprocess_commands.expected_revision=j.status_revision AND j.materialization_state='failed' AND j.published_error_code IN ('source_unavailable','authority_revoked','retry_exhausted') AND j.processing_generation<3 AND reprocess_commands.processing_generation=j.processing_generation+1 AND reprocess_commands.accepted_revision=j.status_revision+1)
 OR (reprocess_commands.state='rejected' AND reprocess_commands.processing_generation=j.processing_generation AND (
 (reprocess_commands.expected_revision<j.status_revision AND reprocess_commands.code='revision_changed') OR
 (reprocess_commands.expected_revision=j.status_revision AND j.materialization_state='failed' AND j.published_error_code IN ('source_unavailable','authority_revoked','retry_exhausted') AND j.processing_generation>=3 AND reprocess_commands.code='retry_limit') OR
 (reprocess_commands.expected_revision=j.status_revision AND (j.materialization_state<>'failed' OR j.published_error_code NOT IN ('source_unavailable','authority_revoked','retry_exhausted')) AND reprocess_commands.code='not_retryable'))))));
GRANT SELECT,INSERT ON margin_submissions.reprocess_commands TO margin_submission_runtime;
GRANT SELECT ON margin_submissions.reprocess_commands TO margin_submission_processor;
CREATE POLICY processor_reprocess_audit ON margin_submissions.reprocess_commands FOR SELECT TO margin_submission_processor USING(attempt_id=margin_submissions.ctx('submission_id'));
GRANT EXECUTE ON FUNCTION margin_work.active(uuid),margin_submissions.active(uuid) TO margin_submission_runtime;
GRANT UPDATE(materialization_state,materialization_attempt,claim_id,token_digest,lease_expires_at,next_attempt_at,materialized_at,status_revision,processing_generation,published_error_code,failed_at) ON margin_submissions.outbox TO margin_submission_runtime;
GRANT UPDATE(status_revision,published_error_code,failed_at) ON margin_submissions.outbox TO margin_submission_processor;
CREATE POLICY reprocess_update ON margin_submissions.outbox FOR UPDATE TO margin_submission_runtime USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=attempt_id AND a.work_id=outbox.work_id AND margin_submissions.visible(a.organization_id,a.work_id))) WITH CHECK(
 materialization_state='pending' AND materialization_attempt=0 AND claim_id IS NULL AND token_digest IS NULL AND lease_expires_at IS NULL AND materialized_at IS NULL AND failed_at IS NULL AND published_error_code IS NULL AND EXISTS(SELECT 1 FROM margin_submissions.reprocess_commands r WHERE r.attempt_id=outbox.attempt_id AND r.work_id=outbox.work_id AND r.state='accepted' AND r.accepted_revision=outbox.status_revision AND r.processing_generation=outbox.processing_generation));
CREATE OR REPLACE FUNCTION margin_submissions.protect_materialization_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE active boolean; current_claim boolean; expired boolean;
BEGIN
 IF ROW(NEW.attempt_id,NEW.work_id,NEW.phase,NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.work_id,OLD.phase,OLD.created_at) THEN RAISE EXCEPTION 'Immutable submission identity'; END IF;
 active=margin_submissions.active(OLD.work_id);
 -- Only a current verified student launch can request a new generation. The exact command
 -- outcome must already be durable in this same transaction, and all old leases are fenced.
 IF NEW.processing_generation<>OLD.processing_generation THEN
 IF NOT pg_has_role(current_user,'margin_submission_runtime','MEMBER') OR pg_has_role(current_user,'margin_submission_processor','MEMBER') OR NOT active OR OLD.materialization_state<>'failed' OR OLD.published_error_code NOT IN ('source_unavailable','authority_revoked','retry_exhausted') OR OLD.processing_generation>=3 OR NEW.processing_generation<>OLD.processing_generation+1 OR NEW.status_revision<>OLD.status_revision+1 OR NEW.materialization_state<>'pending' OR NEW.materialization_attempt<>0 OR NEW.claim_id IS NOT NULL OR NEW.token_digest IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.published_error_code IS NOT NULL OR NEW.failed_at IS NOT NULL OR NEW.materialized_at IS NOT NULL OR NEW.next_attempt_at<>statement_timestamp() OR NOT EXISTS(SELECT 1 FROM margin_submissions.reprocess_commands r WHERE r.attempt_id=OLD.attempt_id AND r.work_id=OLD.work_id AND r.expected_revision=OLD.status_revision AND r.accepted_revision=NEW.status_revision AND r.state='accepted' AND r.processing_generation=NEW.processing_generation AND r.prior_error_code=OLD.published_error_code) THEN RAISE EXCEPTION 'Invalid captured-version reprocessing'; END IF;
 RETURN NEW;
 END IF;
 IF NOT pg_has_role(current_user,'margin_submission_processor','MEMBER') OR OLD.materialization_state<>'pending' THEN RAISE EXCEPTION 'Immutable processing outcome'; END IF;
 current_claim=margin_submissions.claimed(OLD.attempt_id);
 expired=OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=statement_timestamp();
 IF NEW.materialization_state='failed' THEN
 -- Content is never released here. A revoked or exhausted expired job can be terminalized
 -- without resurrecting its browser session, source authority, or expired worker lease.
 IF NEW.status_revision<>OLD.status_revision+1 OR NEW.failed_at<>statement_timestamp() OR NEW.materialized_at IS NOT NULL OR ROW(NEW.claim_id,NEW.token_digest,NEW.materialization_attempt,NEW.lease_expires_at,NEW.next_attempt_at) IS DISTINCT FROM ROW(OLD.claim_id,OLD.token_digest,OLD.materialization_attempt,OLD.lease_expires_at,OLD.next_attempt_at) OR EXISTS(SELECT 1 FROM margin_submissions.materialization_receipts r WHERE r.submission_id=OLD.attempt_id) OR NOT (current_claim OR (expired AND (OLD.materialization_attempt>=10 OR NOT active))) OR (NOT active AND NEW.published_error_code<>'authority_revoked') OR (active AND NEW.published_error_code='authority_revoked') OR (NEW.published_error_code='retry_exhausted' AND OLD.materialization_attempt<10) OR (NOT current_claim AND active AND NEW.published_error_code<>'retry_exhausted') THEN RAISE EXCEPTION 'Invalid terminal processing outcome'; END IF;
 ELSIF NEW.materialization_state='completed' THEN
 IF NOT active OR NOT current_claim OR NEW.status_revision<>OLD.status_revision+1 OR NEW.failed_at IS NOT NULL OR NEW.published_error_code IS NOT NULL OR ROW(NEW.claim_id,NEW.token_digest,NEW.materialization_attempt,NEW.lease_expires_at,NEW.next_attempt_at) IS DISTINCT FROM ROW(OLD.claim_id,OLD.token_digest,OLD.materialization_attempt,OLD.lease_expires_at,OLD.next_attempt_at) OR NOT EXISTS(SELECT 1 FROM margin_submissions.materialization_receipts r WHERE r.submission_id=OLD.attempt_id AND r.claim_id=OLD.claim_id AND r.attempt=OLD.materialization_attempt) THEN RAISE EXCEPTION 'Atomic materialization receipt required'; END IF;
 ELSE
 IF NOT active OR NEW.status_revision<>OLD.status_revision OR NEW.materialization_state<>'pending' OR NEW.published_error_code IS NOT NULL OR NEW.failed_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid processing transition'; END IF;
 IF NEW.claim_id IS DISTINCT FROM OLD.claim_id AND NEW.claim_id IS NOT NULL THEN
 IF NEW.materialization_attempt<>OLD.materialization_attempt+1 OR NOT expired OR NEW.lease_expires_at<=statement_timestamp() OR NEW.lease_expires_at>statement_timestamp()+interval '600 seconds' OR NEW.token_digest IS NULL OR OLD.next_attempt_at>statement_timestamp() OR NEW.next_attempt_at<>OLD.next_attempt_at THEN RAISE EXCEPTION 'Invalid materialization claim'; END IF;
 ELSIF NEW.claim_id IS NULL THEN
 IF NOT current_claim OR OLD.materialization_attempt>=10 OR NEW.materialization_attempt<>OLD.materialization_attempt OR NEW.lease_expires_at IS NOT NULL OR NEW.token_digest IS NOT NULL OR NEW.next_attempt_at<statement_timestamp() OR NEW.next_attempt_at>statement_timestamp()+interval '1 hour' THEN RAISE EXCEPTION 'Invalid materialization retry'; END IF;
 ELSE RAISE EXCEPTION 'Materialization leases cannot be extended'; END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
