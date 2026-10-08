-- Internal immutable materialization only. The public submission phase remains processing.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_submission_processor') THEN
 CREATE ROLE margin_submission_processor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_submission_processor' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe submission processor role'; END IF;
END $$;
GRANT USAGE ON SCHEMA margin_identity,margin_lms,margin_sync,margin_ingestion,margin_assignments,margin_work,margin_submissions TO margin_submission_processor;
-- Background authorization is durable, independently of an expired browser launch.
-- Copy only the provisioner's read and row-lock privileges, never its write policies.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.*,n.nspname,c.relname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE 'margin_assignment_provisioner'::regrole=ANY(p.polroles) AND p.polcmd='r' AND c.relname<>'receipts' LOOP
 EXECUTE format('CREATE POLICY materializer_read_%s ON %I.%I AS %s FOR SELECT TO margin_submission_processor USING(%s)',r.oid,r.nspname,r.relname,CASE WHEN r.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,pg_get_expr(r.polqual,r.polrelid));
 END LOOP;
 FOR r IN SELECT c.oid,n.nspname,c.relname,a.attname,a.attnum FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname IN ('margin_identity','margin_lms','margin_sync','margin_ingestion','margin_assignments') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped LOOP
 IF has_column_privilege('margin_assignment_provisioner',r.oid,r.attnum,'SELECT') THEN EXECUTE format('GRANT SELECT(%I) ON %I.%I TO margin_submission_processor',r.attname,r.nspname,r.relname); END IF;
 END LOOP;
END $$;
GRANT SELECT(audience,cursor,operation_bytes) ON margin_sync.documents TO margin_submission_processor;
GRANT SELECT ON margin_work.receipts,margin_sync.document_keys,margin_sync.operations TO margin_submission_processor;
GRANT EXECUTE ON FUNCTION margin_work.active(uuid),margin_ingestion.active_source(uuid,uuid,uuid,uuid,uuid,uuid,integer),margin_ingestion.ctx(text) TO margin_submission_processor;
ALTER TABLE margin_submissions.outbox ADD COLUMN materialization_state text NOT NULL DEFAULT 'pending' CHECK(materialization_state IN ('pending','completed')),
 ADD COLUMN materialization_attempt integer NOT NULL DEFAULT 0 CHECK(materialization_attempt BETWEEN 0 AND 10),
 ADD COLUMN claim_id uuid,ADD COLUMN token_digest text CHECK(token_digest ~ '^[a-f0-9]{64}$'),ADD COLUMN lease_expires_at timestamptz,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),ADD COLUMN materialized_at timestamptz;
ALTER TABLE margin_submissions.outbox ADD CONSTRAINT materialization_claim CHECK((claim_id IS NULL AND token_digest IS NULL AND lease_expires_at IS NULL) OR (claim_id IS NOT NULL AND token_digest IS NOT NULL AND lease_expires_at IS NOT NULL)),
 ADD CONSTRAINT materialization_completion CHECK((materialization_state='pending' AND materialized_at IS NULL) OR (materialization_state='completed' AND materialized_at IS NOT NULL AND claim_id IS NOT NULL));
CREATE INDEX materialization_due ON margin_submissions.outbox(next_attempt_at,created_at) WHERE materialization_state='pending';
CREATE POLICY materialization_initial ON margin_submissions.outbox AS RESTRICTIVE FOR INSERT TO margin_submission_runtime WITH CHECK(materialization_state='pending' AND materialization_attempt=0 AND claim_id IS NULL AND materialized_at IS NULL);
CREATE FUNCTION margin_submissions.ctx(k text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_submissions.'||k,true),'')::uuid $$;
CREATE FUNCTION margin_submissions.claimed(submission uuid, completed boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_submissions.outbox j WHERE j.attempt_id=submission AND j.attempt_id=margin_submissions.ctx('submission_id') AND j.work_id=margin_submissions.ctx('work_id') AND j.claim_id=margin_submissions.ctx('claim_id') AND j.token_digest=nullif(current_setting('margin_submissions.token_digest',true),'') AND ((j.materialization_state='pending' AND j.lease_expires_at>statement_timestamp()) OR (completed AND j.materialization_state='completed')))
$$;
CREATE FUNCTION margin_submissions.active(work uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT margin_work.active(work) AND EXISTS(SELECT 1 FROM margin_assignments.student_work w JOIN margin_assignments.assignments a ON a.id=w.assignment_id JOIN margin_sync.documents d ON d.organization_id=w.organization_id AND d.id=w.document_id AND d.current_version_id=w.version_id AND d.owner_id=w.user_id AND d.origin='assignment' AND d.audience='members' AND d.deleted_at IS NULL JOIN margin_sync.grants g ON g.organization_id=w.organization_id AND g.document_id=w.document_id AND g.user_id=w.user_id AND g.permission='owner' AND g.revoked_at IS NULL WHERE w.id=work AND w.status='provisioned' AND margin_ingestion.active_source(w.organization_id,a.created_by,a.source_document_id,a.source_version_id,w.installation_id,w.course_id,w.registration_version))
$$;
CREATE POLICY materializer_requests ON margin_submissions.requests FOR SELECT TO margin_submission_processor USING(work_id=margin_submissions.ctx('work_id') AND margin_submissions.claimed(margin_submissions.ctx('submission_id'),true));
CREATE POLICY materializer_attempts ON margin_submissions.attempts FOR SELECT TO margin_submission_processor USING(true);
CREATE POLICY materializer_queue_read ON margin_submissions.outbox FOR SELECT TO margin_submission_processor USING(true);
CREATE POLICY materializer_queue_update ON margin_submissions.outbox FOR UPDATE TO margin_submission_processor USING(true) WITH CHECK(true);
CREATE POLICY materializer_work_receipt ON margin_work.receipts FOR SELECT TO margin_submission_processor USING(work_id=margin_submissions.ctx('work_id') AND margin_submissions.claimed(margin_submissions.ctx('submission_id'),true));
CREATE POLICY materializer_key ON margin_sync.document_keys FOR SELECT TO margin_submission_processor USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=margin_submissions.ctx('submission_id') AND a.organization_id=document_keys.organization_id AND a.document_id=document_keys.document_id AND margin_submissions.claimed(a.id,true)));
CREATE POLICY materializer_operations ON margin_sync.operations FOR SELECT TO margin_submission_processor USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=margin_submissions.ctx('submission_id') AND a.organization_id=operations.organization_id AND a.document_id=operations.document_id AND operations.cursor<=a.frozen_cursor AND margin_submissions.claimed(a.id)));
CREATE TABLE margin_submissions.materialization_chunks (
 submission_id uuid NOT NULL REFERENCES margin_submissions.attempts(id),claim_id uuid NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 10),chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 2047),
 plaintext_sha256 text NOT NULL CHECK(plaintext_sha256 ~ '^[a-f0-9]{64}$'),plaintext_bytes integer NOT NULL CHECK(plaintext_bytes BETWEEN 1 AND 262144),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)=plaintext_bytes),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
 PRIMARY KEY(submission_id,claim_id,chunk_index)
);
CREATE TABLE margin_submissions.materialization_receipts (
 submission_id uuid PRIMARY KEY REFERENCES margin_submissions.attempts(id),claim_id uuid NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 10),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 2048),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['materialization_chunks','materialization_receipts'] LOOP
 EXECUTE format('ALTER TABLE margin_submissions.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE margin_submissions.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY materializer_read ON margin_submissions.%I FOR SELECT TO margin_submission_processor USING(margin_submissions.claimed(submission_id,true) AND claim_id=margin_submissions.ctx(''claim_id''))',t);
 EXECUTE format('CREATE POLICY materializer_insert ON margin_submissions.%I FOR INSERT TO margin_submission_processor WITH CHECK(margin_submissions.claimed(submission_id) AND claim_id=margin_submissions.ctx(''claim_id'') AND EXISTS(SELECT 1 FROM margin_submissions.outbox j WHERE j.attempt_id=submission_id AND j.materialization_attempt=attempt AND margin_submissions.active(j.work_id)))',t);
 END LOOP;
END $$;
GRANT SELECT ON margin_submissions.requests,margin_submissions.attempts,margin_submissions.outbox TO margin_submission_processor;
GRANT SELECT,INSERT ON margin_submissions.materialization_chunks,margin_submissions.materialization_receipts TO margin_submission_processor;
GRANT UPDATE(materialization_state,materialization_attempt,claim_id,token_digest,lease_expires_at,next_attempt_at,materialized_at) ON margin_submissions.outbox TO margin_submission_processor;
CREATE FUNCTION margin_submissions.protect_materialization_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.materialization_state<>'pending' OR ROW(NEW.attempt_id,NEW.work_id,NEW.phase,NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.work_id,OLD.phase,OLD.created_at) THEN RAISE EXCEPTION 'Immutable submission job'; END IF;
 IF NOT margin_submissions.active(OLD.work_id) THEN RAISE EXCEPTION 'Submission authority revoked'; END IF;
 IF NEW.materialization_state='completed' THEN
 IF NOT margin_submissions.claimed(OLD.attempt_id) OR ROW(NEW.claim_id,NEW.token_digest,NEW.materialization_attempt,NEW.lease_expires_at,NEW.next_attempt_at) IS DISTINCT FROM ROW(OLD.claim_id,OLD.token_digest,OLD.materialization_attempt,OLD.lease_expires_at,OLD.next_attempt_at) OR NOT EXISTS(SELECT 1 FROM margin_submissions.materialization_receipts r WHERE r.submission_id=OLD.attempt_id AND r.claim_id=OLD.claim_id AND r.attempt=OLD.materialization_attempt) THEN RAISE EXCEPTION 'Atomic materialization receipt required'; END IF;
 ELSIF NEW.claim_id IS DISTINCT FROM OLD.claim_id AND NEW.claim_id IS NOT NULL THEN
 IF NEW.materialization_attempt<>OLD.materialization_attempt+1 OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>statement_timestamp()) OR NEW.lease_expires_at<=statement_timestamp() OR NEW.lease_expires_at>statement_timestamp()+interval '600 seconds' OR NEW.token_digest IS NULL OR OLD.next_attempt_at>statement_timestamp() THEN RAISE EXCEPTION 'Invalid materialization claim'; END IF;
 ELSIF NEW.claim_id IS NULL THEN
 IF NOT margin_submissions.claimed(OLD.attempt_id) OR NEW.materialization_attempt<>OLD.materialization_attempt OR NEW.lease_expires_at IS NOT NULL OR NEW.token_digest IS NOT NULL OR NEW.next_attempt_at<statement_timestamp() OR NEW.next_attempt_at>statement_timestamp()+interval '1 hour' THEN RAISE EXCEPTION 'Invalid materialization retry'; END IF;
 ELSE RAISE EXCEPTION 'Materialization leases cannot be extended'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_materialization_job BEFORE UPDATE ON margin_submissions.outbox FOR EACH ROW EXECUTE FUNCTION margin_submissions.protect_materialization_job();
-- Row-lock-only policies forbid all actual writes to source or target authority.
DO $$ DECLARE item text[]; BEGIN
 FOREACH item SLICE 1 IN ARRAY ARRAY[
 ['margin_identity.users','id'],['margin_identity.organizations','id'],['margin_identity.memberships','user_id'],['margin_lms.installations','id'],['margin_lms.user_links','user_id'],['margin_lms.courses','course_id'],['margin_lms.enrollments','user_id'],['margin_assignments.assignments','id'],['margin_assignments.resource_links','resource_digest'],['margin_assignments.student_work','id'],['margin_assignments.provisioning_outbox','work_id'],['margin_sync.documents','id'],['margin_sync.versions','id'],['margin_sync.grants','user_id'],['margin_sync.pages','id'],['margin_sync.document_keys','document_id'],['margin_ingestion.artifacts','artifact_id'],['margin_ingestion.storage_receipts','artifact_id'],['margin_ingestion.inspection_jobs','artifact_id'],['margin_ingestion.inspection_receipts','id'],['margin_ingestion.page_geometry','scan_receipt_id'],['margin_work.receipts','work_id'],['margin_submissions.requests','request_id'],['margin_submissions.attempts','id']
 ] LOOP
 EXECUTE format('GRANT UPDATE(%I) ON %s TO margin_submission_processor',item[2],item[1]);
 EXECUTE format('CREATE POLICY materializer_lock_only ON %s FOR UPDATE TO margin_submission_processor USING(true) WITH CHECK(false)',item[1]);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION margin_submissions.ctx(text),margin_submissions.claimed(uuid,boolean),margin_submissions.active(uuid),margin_submissions.protect_materialization_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION margin_submissions.ctx(text),margin_submissions.claimed(uuid,boolean),margin_submissions.active(uuid),margin_submissions.protect_materialization_job() TO margin_submission_processor;
COMMIT;
