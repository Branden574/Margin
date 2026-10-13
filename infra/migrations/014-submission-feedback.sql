-- Separate encrypted teacher drafts and immutable explicit releases. Student captures,
-- annotation history, and the v1 authority snapshot shape remain unchanged.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_feedback_runtime') THEN
 CREATE ROLE margin_feedback_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_feedback_runtime' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin OR rolinherit)) THEN RAISE EXCEPTION 'Unsafe feedback runtime role'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member='margin_feedback_runtime'::regrole) THEN RAISE EXCEPTION 'Feedback runtime must not inherit another role'; END IF;
END $$;
CREATE SCHEMA margin_feedback;
REVOKE ALL ON SCHEMA margin_feedback FROM PUBLIC;
GRANT USAGE ON SCHEMA margin_feedback,margin_review,margin_identity,margin_lms,margin_assignments,margin_sync,margin_ingestion,margin_work,margin_submissions TO margin_feedback_runtime;
CREATE FUNCTION margin_feedback.ctx(k text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_feedback.'||k,true),'')::uuid $$;

-- Clone only SELECT policies on this explicit structural allowlist. Each branch is
-- gated by the authenticated principal role selected for this transaction; teacher
-- policies can never expand a student's row visibility. The new role inherits none
-- of the existing roles, annotation privileges, capture writes, or retry machinery.
DO $$ DECLARE r record; BEGIN
 FOR r IN
 SELECT p.*,n.nspname,c.relname,source.actor
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN (VALUES ('margin_submission_reviewer'::regrole,'teacher'),('margin_submission_runtime'::regrole,'student')) source(role_oid,actor) ON source.role_oid=ANY(p.polroles)
 WHERE p.polcmd='r' AND (n.nspname||'.'||c.relname) IN (
 'margin_identity.users','margin_identity.organizations','margin_identity.memberships','margin_identity.sessions',
 'margin_lms.installations','margin_lms.session_bindings','margin_lms.user_links','margin_lms.courses','margin_lms.enrollments',
 'margin_assignments.assignments','margin_assignments.launch_bindings','margin_assignments.resource_links','margin_assignments.student_work','margin_assignments.provisioning_outbox',
 'margin_work.receipts','margin_sync.documents','margin_sync.versions','margin_sync.grants','margin_sync.pages','margin_sync.document_keys',
 'margin_ingestion.artifacts','margin_ingestion.storage_receipts','margin_ingestion.inspection_jobs','margin_ingestion.inspection_receipts','margin_ingestion.page_geometry',
 'margin_submissions.attempts','margin_submissions.requests','margin_submissions.outbox','margin_submissions.materialization_receipts','margin_submissions.materialization_chunks')
 LOOP
 EXECUTE format('CREATE POLICY feedback_%s_%s ON %I.%I AS %s FOR SELECT TO margin_feedback_runtime USING(current_setting(''margin_feedback.role'',true)%s%L %s (%s))',r.actor,r.oid,r.nspname,r.relname,CASE WHEN r.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,CASE WHEN r.polpermissive THEN '=' ELSE ' IS DISTINCT FROM ' END,r.actor,CASE WHEN r.polpermissive THEN 'AND' ELSE 'OR' END,pg_get_expr(r.polqual,r.polrelid));
 END LOOP;
 -- Column-level copies preserve the original structural privilege boundaries. Outbox
 -- credentials and mutable document content are excluded from the union below.
 FOR r IN
 SELECT c.oid,n.nspname,c.relname,a.attname,a.attnum
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 WHERE c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND (n.nspname||'.'||c.relname) IN (
 'margin_identity.users','margin_identity.organizations','margin_identity.memberships','margin_identity.sessions',
 'margin_lms.installations','margin_lms.session_bindings','margin_lms.user_links','margin_lms.courses','margin_lms.enrollments',
 'margin_assignments.assignments','margin_assignments.launch_bindings','margin_assignments.resource_links','margin_assignments.student_work','margin_assignments.provisioning_outbox',
 'margin_work.receipts','margin_sync.versions','margin_sync.grants','margin_sync.pages','margin_sync.document_keys',
 'margin_ingestion.artifacts','margin_ingestion.storage_receipts','margin_ingestion.inspection_jobs','margin_ingestion.inspection_receipts','margin_ingestion.page_geometry',
 'margin_submissions.attempts','margin_submissions.requests','margin_submissions.materialization_receipts','margin_submissions.materialization_chunks')
 LOOP
 IF has_column_privilege('margin_submission_reviewer',r.oid,r.attnum,'SELECT') OR has_column_privilege('margin_submission_runtime',r.oid,r.attnum,'SELECT') THEN
 EXECUTE format('GRANT SELECT(%I) ON %I.%I TO margin_feedback_runtime',r.attname,r.nspname,r.relname);
 END IF;
 END LOOP;
END $$;
GRANT SELECT(organization_id,id,owner_id,current_version_id,deleted_at,origin,audience,cursor,operation_bytes) ON margin_sync.documents TO margin_feedback_runtime;
GRANT SELECT(attempt_id,work_id,phase,created_at,materialization_state,materialization_attempt,claim_id,status_revision,processing_generation,published_error_code,failed_at,materialized_at) ON margin_submissions.outbox TO margin_feedback_runtime;

-- Both authenticated branches bind to one captured version before reading encrypted
-- payloads. A student may authenticate the completed manifest and chunk seals for
-- their own current launch, but cannot read another student's capture or a draft.
CREATE POLICY feedback_exact_attempt ON margin_submissions.attempts AS RESTRICTIVE FOR SELECT TO margin_feedback_runtime USING(id=margin_feedback.ctx('submission_id') AND id=margin_review.ctx('submission_id'));
CREATE POLICY feedback_student_receipt ON margin_submissions.materialization_receipts FOR SELECT TO margin_feedback_runtime USING(current_setting('margin_feedback.role',true)='student' AND submission_id=margin_feedback.ctx('submission_id') AND EXISTS(SELECT 1 FROM margin_submissions.outbox j WHERE j.attempt_id=submission_id AND j.materialization_state='completed' AND j.claim_id=materialization_receipts.claim_id AND j.materialization_attempt=materialization_receipts.attempt));
CREATE POLICY feedback_student_chunk ON margin_submissions.materialization_chunks FOR SELECT TO margin_feedback_runtime USING(current_setting('margin_feedback.role',true)='student' AND submission_id=margin_feedback.ctx('submission_id') AND EXISTS(SELECT 1 FROM margin_submissions.materialization_receipts r WHERE r.submission_id=materialization_chunks.submission_id AND r.claim_id=materialization_chunks.claim_id AND r.attempt=materialization_chunks.attempt));
GRANT EXECUTE ON FUNCTION margin_review.ctx(text),margin_review.request_active(),margin_review.launched(uuid),margin_work.ctx(text),margin_work.request_active(),margin_work.launched(uuid),margin_work.runtime_target(uuid,uuid),margin_work.active(uuid),margin_submissions.visible(uuid,uuid),margin_submissions.active(uuid),margin_ingestion.active_source(uuid,uuid,uuid,uuid,uuid,uuid,integer),margin_ingestion.ctx(text) TO margin_feedback_runtime;

-- Row-lock-only privileges order saves/releases against current authority revocation.
-- The service acquires its per-submission transaction advisory lock before authority
-- row locks, avoiding shared-to-exclusive attempt lock upgrades. WITH CHECK(false)
-- rejects every actual write, including no-op UPDATEs to structural identity columns.
DO $$ DECLARE item text[]; BEGIN
 FOREACH item SLICE 1 IN ARRAY ARRAY[
 ['margin_identity.users','id'],['margin_identity.organizations','id'],['margin_identity.memberships','user_id'],['margin_identity.sessions','id'],
 ['margin_lms.session_bindings','session_id'],['margin_lms.installations','id'],['margin_lms.user_links','user_id'],['margin_lms.courses','course_id'],['margin_lms.enrollments','user_id'],
 ['margin_assignments.assignments','id'],['margin_assignments.launch_bindings','session_id'],['margin_assignments.resource_links','resource_digest'],['margin_assignments.student_work','id'],['margin_assignments.provisioning_outbox','work_id'],
 ['margin_sync.documents','id'],['margin_sync.versions','id'],['margin_sync.grants','user_id'],['margin_sync.pages','id'],['margin_sync.document_keys','document_id'],
 ['margin_ingestion.artifacts','artifact_id'],['margin_ingestion.storage_receipts','artifact_id'],['margin_ingestion.inspection_jobs','artifact_id'],['margin_ingestion.inspection_receipts','id'],['margin_ingestion.page_geometry','scan_receipt_id'],
 ['margin_work.receipts','work_id'],['margin_submissions.requests','request_id'],['margin_submissions.attempts','id']
 ] LOOP
 EXECUTE format('GRANT UPDATE(%I) ON %s TO margin_feedback_runtime',item[2],item[1]);
 EXECUTE format('CREATE POLICY feedback_lock_only ON %s FOR UPDATE TO margin_feedback_runtime USING(current_setting(''margin_feedback.role'',true) IN (''teacher'',''student'')) WITH CHECK(false)',item[1]);
 END LOOP;
END $$;

CREATE TABLE margin_feedback.drafts (
 submission_id uuid PRIMARY KEY, organization_id uuid NOT NULL, work_id uuid NOT NULL,
 snapshot_pin text NOT NULL CHECK(snapshot_pin ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100000), saved_at timestamptz NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12), tag bytea NOT NULL CHECK(octet_length(tag)=16),
 wrapped_key jsonb NOT NULL CHECK(jsonb_typeof(wrapped_key)='object' AND octet_length(wrapped_key::text)<=16384),
 FOREIGN KEY(submission_id,work_id) REFERENCES margin_submissions.attempts(id,work_id)
);
CREATE TABLE margin_feedback.releases (
 submission_id uuid NOT NULL, organization_id uuid NOT NULL, work_id uuid NOT NULL,
 snapshot_pin text NOT NULL CHECK(snapshot_pin ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100000), released_at timestamptz NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12), tag bytea NOT NULL CHECK(octet_length(tag)=16),
 wrapped_key jsonb NOT NULL CHECK(jsonb_typeof(wrapped_key)='object' AND octet_length(wrapped_key::text)<=16384),
 PRIMARY KEY(submission_id,revision), FOREIGN KEY(submission_id,work_id) REFERENCES margin_submissions.attempts(id,work_id)
);
CREATE TABLE margin_feedback.commands (
 submission_id uuid NOT NULL, request_id uuid NOT NULL, organization_id uuid NOT NULL, work_id uuid NOT NULL,
 snapshot_pin text NOT NULL CHECK(snapshot_pin ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN ('save','release')),
 expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 100000),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12), tag bytea NOT NULL CHECK(octet_length(tag)=16),
 wrapped_key jsonb NOT NULL CHECK(jsonb_typeof(wrapped_key)='object' AND octet_length(wrapped_key::text)<=16384),
 PRIMARY KEY(submission_id,request_id), FOREIGN KEY(submission_id,work_id) REFERENCES margin_submissions.attempts(id,work_id)
);

-- This invoker function traverses only already-scoped authority tables, never feedback
-- tables, so policies cannot recurse through drafts/releases/commands. The application
-- authenticates encrypted snapshot pins and manifests before using this authority.
CREATE FUNCTION margin_feedback.visible(org uuid,work uuid,submission uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 BEGIN RETURN current_setting('margin_feedback.role',true) IN ('teacher','student')
 AND submission=margin_feedback.ctx('submission_id') AND submission=margin_review.ctx('submission_id')
 AND org=margin_review.ctx('organization_id') AND org=margin_work.ctx('organization_id')
 AND margin_review.ctx('session_id')=margin_work.ctx('session_id')
 AND margin_review.ctx('user_id')=margin_work.ctx('user_id')
 AND margin_submissions.active(work)
 AND EXISTS(SELECT 1 FROM margin_submissions.attempts a
 JOIN margin_submissions.outbox j ON j.attempt_id=a.id AND j.work_id=a.work_id AND j.materialization_state='completed'
 JOIN margin_submissions.materialization_receipts r ON r.submission_id=a.id AND r.claim_id=j.claim_id AND r.attempt=j.materialization_attempt
 WHERE a.id=submission AND a.organization_id=org AND a.work_id=work); END
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['drafts','releases','commands'] LOOP
 EXECUTE format('ALTER TABLE margin_feedback.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE margin_feedback.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY feedback_teacher_read ON margin_feedback.%I FOR SELECT TO margin_feedback_runtime USING(current_setting(''margin_feedback.role'',true)=''teacher'' AND margin_feedback.visible(organization_id,work_id,submission_id))',t);
 EXECUTE format('CREATE POLICY feedback_teacher_insert ON margin_feedback.%I FOR INSERT TO margin_feedback_runtime WITH CHECK(current_setting(''margin_feedback.role'',true)=''teacher'' AND margin_feedback.visible(organization_id,work_id,submission_id))',t);
 END LOOP;
END $$;
CREATE POLICY feedback_draft_update ON margin_feedback.drafts FOR UPDATE TO margin_feedback_runtime USING(current_setting('margin_feedback.role',true)='teacher' AND margin_feedback.visible(organization_id,work_id,submission_id)) WITH CHECK(current_setting('margin_feedback.role',true)='teacher' AND margin_feedback.visible(organization_id,work_id,submission_id));
CREATE POLICY feedback_student_release ON margin_feedback.releases FOR SELECT TO margin_feedback_runtime USING(current_setting('margin_feedback.role',true)='student' AND margin_feedback.visible(organization_id,work_id,submission_id));
CREATE POLICY feedback_release_saved_revision ON margin_feedback.releases AS RESTRICTIVE FOR INSERT TO margin_feedback_runtime WITH CHECK(EXISTS(SELECT 1 FROM margin_feedback.drafts d WHERE d.submission_id=releases.submission_id AND d.organization_id=releases.organization_id AND d.work_id=releases.work_id AND d.snapshot_pin=releases.snapshot_pin AND d.revision=releases.revision AND d.saved_at<=releases.released_at));

CREATE FUNCTION margin_feedback.protect_draft() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
 IF NEW.revision<>1 THEN RAISE EXCEPTION 'Feedback draft must start at revision one'; END IF;
 ELSE
 IF ROW(NEW.submission_id,NEW.organization_id,NEW.work_id,NEW.snapshot_pin) IS DISTINCT FROM ROW(OLD.submission_id,OLD.organization_id,OLD.work_id,OLD.snapshot_pin)
 OR NEW.revision<>OLD.revision+1 OR NEW.saved_at<OLD.saved_at THEN RAISE EXCEPTION 'Feedback draft identity or revision changed'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_feedback_draft BEFORE INSERT OR UPDATE ON margin_feedback.drafts FOR EACH ROW EXECUTE FUNCTION margin_feedback.protect_draft();
GRANT SELECT,INSERT ON margin_feedback.drafts,margin_feedback.releases,margin_feedback.commands TO margin_feedback_runtime;
GRANT UPDATE(revision,saved_at,ciphertext,nonce,tag,wrapped_key) ON margin_feedback.drafts TO margin_feedback_runtime;
REVOKE ALL ON FUNCTION margin_feedback.ctx(text),margin_feedback.visible(uuid,uuid,uuid),margin_feedback.protect_draft() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION margin_feedback.ctx(text),margin_feedback.visible(uuid,uuid,uuid),margin_feedback.protect_draft() TO margin_feedback_runtime;
COMMIT;
