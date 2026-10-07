-- Immutable submission capture only. No sender, Canvas acknowledgement, credentials or seed data.
BEGIN;
CREATE SCHEMA margin_submissions;
REVOKE ALL ON SCHEMA margin_submissions FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['margin_submission_runtime','margin_submission_retention_guard'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',r);
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe submission role'; END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA margin_identity,margin_lms,margin_sync,margin_ingestion,margin_assignments,margin_work,margin_submissions TO margin_submission_runtime;
-- Copy only the already-reviewed work SELECT policies and privileges. No role inheritance,
-- INSERT/DELETE privilege, annotation update policy, or cursor write policy is inherited.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.*,n.nspname,c.relname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE 'margin_assignment_work_runtime'::regrole=ANY(p.polroles) AND p.polcmd='r' LOOP
 EXECUTE format('CREATE POLICY submission_read_%s ON %I.%I AS %s FOR SELECT TO margin_submission_runtime USING(%s)',r.oid,r.nspname,r.relname,CASE WHEN r.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,pg_get_expr(r.polqual,r.polrelid));
 END LOOP;
 FOR r IN SELECT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('margin_identity','margin_lms','margin_sync','margin_ingestion','margin_assignments','margin_work') AND c.relkind='r' LOOP
 IF has_table_privilege('margin_assignment_work_runtime',r.oid,'SELECT') THEN EXECUTE format('GRANT SELECT ON %I.%I TO margin_submission_runtime',r.nspname,r.relname); END IF;
 END LOOP;
 FOR r IN SELECT c.oid,n.nspname,c.relname,a.attname,a.attnum FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname IN ('margin_identity','margin_lms','margin_sync','margin_ingestion','margin_assignments','margin_work') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped LOOP
 IF has_column_privilege('margin_assignment_work_runtime',r.oid,r.attnum,'SELECT') THEN EXECUTE format('GRANT SELECT(%I) ON %I.%I TO margin_submission_runtime',r.attname,r.nspname,r.relname); END IF;
 IF has_column_privilege('margin_assignment_work_runtime',r.oid,r.attnum,'UPDATE') THEN EXECUTE format('GRANT UPDATE(%I) ON %I.%I TO margin_submission_runtime',r.attname,r.nspname,r.relname); END IF;
 END LOOP;
 FOR r IN SELECT DISTINCT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname IN ('margin_identity','margin_lms','margin_sync','margin_ingestion','margin_assignments','margin_work') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('margin_assignment_work_runtime',c.oid,a.attnum,'UPDATE') LOOP
 EXECUTE format('CREATE POLICY submission_lock ON %I.%I FOR UPDATE TO margin_submission_runtime USING(true) WITH CHECK(false)',r.nspname,r.relname);
 END LOOP;
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('margin_work','margin_ingestion') AND has_function_privilege('margin_assignment_work_runtime',p.oid,'EXECUTE') LOOP
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO margin_submission_runtime',r.signature);
 END LOOP;
END $$;
CREATE TABLE margin_submissions.requests (
 organization_id uuid NOT NULL, work_id uuid NOT NULL REFERENCES margin_assignments.student_work(id), request_id uuid NOT NULL,
 expected_cursor bigint NOT NULL CHECK(expected_cursor BETWEEN 0 AND 100000), outcome text NOT NULL CHECK(outcome IN ('captured','rejected')),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144), nonce bytea NOT NULL CHECK(octet_length(nonce)=12), tag bytea NOT NULL CHECK(octet_length(tag)=16), wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
 PRIMARY KEY(work_id,request_id)
);
CREATE TABLE margin_submissions.attempts (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, work_id uuid NOT NULL UNIQUE, request_id uuid NOT NULL,
 document_id uuid NOT NULL, version_id uuid NOT NULL, frozen_cursor bigint NOT NULL CHECK(frozen_cursor BETWEEN 0 AND 100000),
 source_artifact_id uuid NOT NULL REFERENCES margin_ingestion.artifacts(artifact_id),
 scan_receipt_id uuid NOT NULL REFERENCES margin_ingestion.page_geometry(scan_receipt_id),
 FOREIGN KEY(work_id,request_id) REFERENCES margin_submissions.requests(work_id,request_id),
 FOREIGN KEY(organization_id,document_id,version_id) REFERENCES margin_sync.versions(organization_id,document_id,id),
 FOREIGN KEY(organization_id,document_id) REFERENCES margin_sync.document_keys(organization_id,document_id),
 FOREIGN KEY(source_artifact_id) REFERENCES margin_ingestion.storage_receipts(artifact_id),
 FOREIGN KEY(work_id) REFERENCES margin_work.receipts(work_id)
);
-- Phase is deliberately processing-only. A later reviewed migration/worker must add delivery.
CREATE TABLE margin_submissions.outbox (
 attempt_id uuid PRIMARY KEY REFERENCES margin_submissions.attempts(id), work_id uuid NOT NULL,
 phase text NOT NULL DEFAULT 'processing' CHECK(phase='processing'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX retained_submission_document ON margin_submissions.attempts(organization_id,document_id,frozen_cursor);
CREATE INDEX retained_submission_source ON margin_submissions.attempts(source_artifact_id);
CREATE INDEX retained_submission_scan ON margin_submissions.attempts(scan_receipt_id);
CREATE FUNCTION margin_submissions.visible(org uuid,work uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RETURN org=margin_work.ctx('organization_id') AND margin_work.request_active() AND EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=work AND w.organization_id=org AND w.user_id=margin_work.ctx('user_id') AND w.status='provisioned' AND margin_work.runtime_target(org,w.document_id)); END
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['requests','attempts','outbox'] LOOP
 EXECUTE format('ALTER TABLE margin_submissions.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE margin_submissions.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['requests','attempts'] LOOP
 EXECUTE format('CREATE POLICY request_read ON margin_submissions.%I FOR SELECT TO margin_submission_runtime USING(margin_submissions.visible(organization_id,work_id))',t);
 EXECUTE format('CREATE POLICY request_insert ON margin_submissions.%I FOR INSERT TO margin_submission_runtime WITH CHECK(margin_submissions.visible(organization_id,work_id))',t);
 END LOOP;
END $$;
CREATE POLICY attempt_identity ON margin_submissions.attempts AS RESTRICTIVE FOR INSERT TO margin_submission_runtime WITH CHECK(EXISTS(SELECT 1 FROM margin_assignments.student_work w JOIN margin_work.receipts r ON r.work_id=w.id JOIN margin_sync.documents d ON d.organization_id=w.organization_id AND d.id=w.document_id JOIN margin_submissions.requests q ON q.work_id=w.id AND q.request_id=attempts.request_id AND q.organization_id=w.organization_id AND q.outcome='captured' AND q.expected_cursor=attempts.frozen_cursor WHERE w.id=attempts.work_id AND w.organization_id=attempts.organization_id AND w.document_id=attempts.document_id AND w.version_id=attempts.version_id AND r.source_artifact_id=attempts.source_artifact_id AND r.scan_receipt_id=attempts.scan_receipt_id AND d.cursor=attempts.frozen_cursor));
CREATE POLICY queue_read ON margin_submissions.outbox FOR SELECT TO margin_submission_runtime USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=attempt_id AND a.work_id=outbox.work_id));
CREATE POLICY queue_insert ON margin_submissions.outbox FOR INSERT TO margin_submission_runtime WITH CHECK(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=attempt_id AND a.work_id=outbox.work_id));
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA margin_submissions TO margin_submission_runtime;
REVOKE ALL ON FUNCTION margin_submissions.visible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION margin_submissions.visible(uuid,uuid) TO margin_submission_runtime;
-- Retention is independent of the querying actor's RLS visibility. This NOLOGIN trigger
-- owner reads structural pins only, returns no content and has no write/BYPASS privilege.
GRANT USAGE,CREATE ON SCHEMA margin_submissions TO margin_submission_retention_guard;
GRANT SELECT ON margin_submissions.attempts TO margin_submission_retention_guard;
GRANT USAGE ON SCHEMA margin_sync TO margin_submission_retention_guard;
GRANT SELECT(organization_id,id),UPDATE(cursor) ON margin_sync.documents TO margin_submission_retention_guard;
CREATE POLICY retention_document_read ON margin_sync.documents FOR SELECT TO margin_submission_retention_guard USING(true);
CREATE POLICY retention_document_lock ON margin_sync.documents FOR UPDATE TO margin_submission_retention_guard USING(true) WITH CHECK(false);
CREATE POLICY retention_pin ON margin_submissions.attempts FOR SELECT TO margin_submission_retention_guard USING(true);
CREATE FUNCTION margin_submissions.retain_prefix() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item jsonb;
BEGIN
 -- A preexisting REPEATABLE READ snapshot cannot observe a pin committed while it waited.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Submission retention requires READ COMMITTED history writes'; END IF;
 FOREACH item IN ARRAY ARRAY[CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END] LOOP
 IF item IS NOT NULL THEN
 -- Serialize structural history changes with capture/append's document lock.
 PERFORM id FROM margin_sync.documents WHERE organization_id=(item->>'organization_id')::uuid AND id=(item->>'document_id')::uuid FOR UPDATE;
 END IF;
 IF item IS NOT NULL AND EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.organization_id=(item->>'organization_id')::uuid AND a.document_id=(item->>'document_id')::uuid AND (TG_TABLE_NAME<>'operations' OR a.frozen_cursor>=(item->>'cursor')::bigint)) THEN
 RAISE EXCEPTION 'Submission retention prevents changing frozen history'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END
$$;
ALTER FUNCTION margin_submissions.retain_prefix() OWNER TO margin_submission_retention_guard;
REVOKE CREATE ON SCHEMA margin_submissions FROM margin_submission_retention_guard;
REVOKE ALL ON FUNCTION margin_submissions.retain_prefix() FROM PUBLIC;
CREATE TRIGGER retain_submission_operations BEFORE INSERT OR UPDATE OR DELETE ON margin_sync.operations FOR EACH ROW EXECUTE FUNCTION margin_submissions.retain_prefix();
CREATE TRIGGER retain_submission_pages BEFORE INSERT OR UPDATE OR DELETE ON margin_sync.pages FOR EACH ROW EXECUTE FUNCTION margin_submissions.retain_prefix();
CREATE TRIGGER retain_submission_keys BEFORE UPDATE OR DELETE ON margin_sync.document_keys FOR EACH ROW EXECUTE FUNCTION margin_submissions.retain_prefix();
COMMIT;
