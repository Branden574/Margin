-- Requires identity001, sync002, and LMS003. Apply with migration owner, never a service login.
-- No source, receipt, scanner approval, credential, or cloud object is seeded.
BEGIN;
CREATE SCHEMA margin_ingestion;
REVOKE ALL ON SCHEMA margin_ingestion FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['margin_ingestion_runtime','margin_ingestion_inspector','margin_ingestion_reader'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',r);
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe ingestion group'; END IF;
 END LOOP;
END $$;
CREATE FUNCTION margin_ingestion.ctx(k text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_ingestion.'||k,true),'')::uuid $$;
GRANT USAGE ON SCHEMA margin_identity,margin_lms,margin_sync TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT(id,disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT(organization_id,user_id,role,revoked_at) ON margin_identity.memberships TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT(id,user_id,organization_id,authentication_method,expires_at,idle_expires_at,revoked_at) ON margin_identity.sessions TO margin_ingestion_runtime;
GRANT SELECT ON margin_lms.session_bindings TO margin_ingestion_runtime;
GRANT SELECT(id,organization_id,version,enabled) ON margin_lms.installations TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT ON margin_lms.enrollments,margin_lms.user_links,margin_lms.courses TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT(organization_id,id,owner_id,deleted_at) ON margin_sync.documents TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT ON margin_sync.versions,margin_sync.grants TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
CREATE POLICY ingestion_user ON margin_identity.users FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(id=margin_ingestion.ctx('user_id'));
CREATE POLICY ingestion_org ON margin_identity.organizations FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(id=margin_ingestion.ctx('organization_id'));
CREATE POLICY ingestion_member ON margin_identity.memberships FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(user_id=margin_ingestion.ctx('user_id') AND organization_id=margin_ingestion.ctx('organization_id'));
CREATE POLICY ingestion_session ON margin_identity.sessions FOR SELECT TO margin_ingestion_runtime USING(id=margin_ingestion.ctx('session_id') AND user_id=margin_ingestion.ctx('user_id') AND organization_id=margin_ingestion.ctx('organization_id'));
CREATE POLICY ingestion_binding ON margin_lms.session_bindings FOR SELECT TO margin_ingestion_runtime USING(session_id=margin_ingestion.ctx('session_id') AND user_id=margin_ingestion.ctx('user_id') AND organization_id=margin_ingestion.ctx('organization_id'));
CREATE POLICY ingestion_installation ON margin_lms.installations FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id'));
CREATE POLICY ingestion_enrollment ON margin_lms.enrollments FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id') AND user_id=margin_ingestion.ctx('user_id'));
CREATE POLICY ingestion_user_link ON margin_lms.user_links FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id') AND user_id=margin_ingestion.ctx('user_id'));
CREATE POLICY ingestion_course ON margin_lms.courses FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id'));
CREATE POLICY ingestion_document ON margin_sync.documents FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id'));
CREATE POLICY ingestion_version ON margin_sync.versions FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_sync.documents d WHERE d.organization_id=versions.organization_id AND d.id=versions.document_id AND d.owner_id=margin_ingestion.ctx('user_id')));
CREATE POLICY ingestion_grant ON margin_sync.grants FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(organization_id=margin_ingestion.ctx('organization_id') AND user_id=margin_ingestion.ctx('user_id'));
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['margin_identity.users','margin_identity.organizations','margin_identity.memberships','margin_lms.installations','margin_lms.enrollments','margin_lms.user_links','margin_lms.courses','margin_sync.documents','margin_sync.versions','margin_sync.grants'] LOOP
 EXECUTE format('CREATE POLICY ingestion_inspector_read ON %s FOR SELECT TO margin_ingestion_inspector USING(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION margin_ingestion.active_teacher() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_lms.session_bindings b
 JOIN margin_identity.sessions s ON s.id=b.session_id AND s.user_id=b.user_id AND s.organization_id=b.organization_id AND s.authentication_method='lti' AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
 JOIN margin_identity.memberships m ON m.user_id=b.user_id AND m.organization_id=b.organization_id AND m.role='teacher' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=b.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=b.organization_id AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=b.installation_id AND i.organization_id=b.organization_id AND i.version=b.registration_version AND i.enabled
 JOIN margin_lms.courses c ON c.installation_id=b.installation_id AND c.organization_id=b.organization_id AND c.course_id=b.course_id AND c.external_digest=b.course_digest AND c.disabled_at IS NULL
 JOIN margin_lms.user_links l ON l.installation_id=b.installation_id AND l.organization_id=b.organization_id AND l.user_id=b.user_id AND l.subject_digest=b.subject_digest AND l.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=b.installation_id AND e.organization_id=b.organization_id AND e.course_id=b.course_id AND e.user_id=b.user_id AND e.role='teacher' AND e.disabled_at IS NULL
 WHERE b.session_id=margin_ingestion.ctx('session_id') AND b.user_id=margin_ingestion.ctx('user_id') AND b.organization_id=margin_ingestion.ctx('organization_id') AND b.installation_id=margin_ingestion.ctx('installation_id') AND b.course_id=margin_ingestion.ctx('course_id') AND b.role='teacher')
$$;
CREATE FUNCTION margin_ingestion.active_source(org uuid,usr uuid,doc uuid,ver uuid,inst uuid,course uuid,registration integer) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_sync.documents d
 JOIN margin_sync.versions v ON v.organization_id=d.organization_id AND v.document_id=d.id AND v.id=ver
 JOIN margin_sync.grants g ON g.organization_id=d.organization_id AND g.document_id=d.id AND g.user_id=usr AND g.permission='owner' AND g.revoked_at IS NULL
 JOIN margin_identity.memberships m ON m.organization_id=d.organization_id AND m.user_id=usr AND m.role='teacher' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=usr AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=org AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=inst AND i.organization_id=org AND i.version=registration AND i.enabled
 JOIN margin_lms.courses c ON c.installation_id=inst AND c.organization_id=org AND c.course_id=course AND c.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=inst AND e.organization_id=org AND e.course_id=course AND e.user_id=usr AND e.role='teacher' AND e.disabled_at IS NULL
 JOIN margin_lms.user_links l ON l.installation_id=inst AND l.organization_id=org AND l.user_id=usr AND l.disabled_at IS NULL
 WHERE d.organization_id=org AND d.id=doc AND d.owner_id=usr AND d.deleted_at IS NULL)
$$;
CREATE TABLE margin_ingestion.artifacts (
 artifact_id uuid PRIMARY KEY,organization_id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,owner_id uuid NOT NULL,
 installation_id uuid NOT NULL,course_id uuid NOT NULL,registration_version integer NOT NULL CHECK(registration_version>0),request_id uuid NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 16384),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,
 UNIQUE(organization_id,owner_id,request_id),UNIQUE(organization_id,document_id,version_id),
 FOREIGN KEY(organization_id,document_id,version_id) REFERENCES margin_sync.versions(organization_id,document_id,id),
 FOREIGN KEY(installation_id,course_id,organization_id) REFERENCES margin_lms.courses(installation_id,course_id,organization_id),
 FOREIGN KEY(organization_id,owner_id) REFERENCES margin_identity.memberships(organization_id,user_id)
);
CREATE TABLE margin_ingestion.storage_receipts (
 artifact_id uuid PRIMARY KEY REFERENCES margin_ingestion.artifacts(artifact_id),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 16384),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- The job is the durable transactional inspection outbox. No plaintext report or object path is queued.
CREATE TABLE margin_ingestion.inspection_jobs (
 artifact_id uuid PRIMARY KEY REFERENCES margin_ingestion.storage_receipts(artifact_id),
 status text NOT NULL DEFAULT 'quarantined' CHECK(status IN ('quarantined','ready','rejected')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 10),claim_id uuid,token_digest text CHECK(token_digest ~ '^[a-f0-9]{64}$'),lease_expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,scan_receipt_id uuid,
 CHECK((claim_id IS NULL AND token_digest IS NULL AND lease_expires_at IS NULL) OR (claim_id IS NOT NULL AND token_digest IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK((status='quarantined' AND completed_at IS NULL AND scan_receipt_id IS NULL) OR (status IN ('ready','rejected') AND completed_at IS NOT NULL AND scan_receipt_id IS NOT NULL))
);
CREATE INDEX inspection_due ON margin_ingestion.inspection_jobs(next_attempt_at,created_at) WHERE status='quarantined';
CREATE TABLE margin_ingestion.inspection_receipts (
 id uuid PRIMARY KEY,artifact_id uuid NOT NULL REFERENCES margin_ingestion.storage_receipts(artifact_id),claim_id uuid NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 10),verdict text NOT NULL CHECK(verdict IN ('ready','rejected')),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 16384),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(artifact_id,claim_id),UNIQUE(id,artifact_id,verdict)
);
ALTER TABLE margin_ingestion.inspection_jobs ADD CONSTRAINT inspection_result_binding FOREIGN KEY(scan_receipt_id,artifact_id,status) REFERENCES margin_ingestion.inspection_receipts(id,artifact_id,verdict);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['artifacts','storage_receipts','inspection_jobs','inspection_receipts'] LOOP
 EXECUTE format('ALTER TABLE margin_ingestion.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE margin_ingestion.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
CREATE POLICY artifact_runtime_read ON margin_ingestion.artifacts FOR SELECT TO margin_ingestion_runtime USING(organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id') AND installation_id=margin_ingestion.ctx('installation_id') AND course_id=margin_ingestion.ctx('course_id') AND revoked_at IS NULL AND margin_ingestion.active_teacher() AND margin_ingestion.active_source(organization_id,owner_id,document_id,version_id,installation_id,course_id,registration_version));
CREATE POLICY artifact_runtime_create ON margin_ingestion.artifacts FOR INSERT TO margin_ingestion_runtime WITH CHECK(organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id') AND installation_id=margin_ingestion.ctx('installation_id') AND course_id=margin_ingestion.ctx('course_id') AND revoked_at IS NULL AND margin_ingestion.active_teacher() AND margin_ingestion.active_source(organization_id,owner_id,document_id,version_id,installation_id,course_id,registration_version));
CREATE POLICY artifact_reader ON margin_ingestion.artifacts FOR SELECT TO margin_ingestion_reader USING(artifact_id=margin_ingestion.ctx('artifact_id') AND organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id') AND document_id=margin_ingestion.ctx('document_id') AND version_id=margin_ingestion.ctx('version_id') AND revoked_at IS NULL AND margin_ingestion.active_source(organization_id,owner_id,document_id,version_id,installation_id,course_id,registration_version));
CREATE POLICY artifact_inspector ON margin_ingestion.artifacts FOR SELECT TO margin_ingestion_inspector USING(true);
CREATE POLICY artifact_revoke ON margin_ingestion.artifacts FOR UPDATE TO margin_ingestion_inspector USING(true) WITH CHECK(revoked_at IS NOT NULL);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['storage_receipts','inspection_jobs','inspection_receipts'] LOOP
 EXECUTE format('CREATE POLICY ingestion_scoped_read ON margin_ingestion.%I FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(EXISTS(SELECT 1 FROM margin_ingestion.artifacts a WHERE a.artifact_id=%I.artifact_id))',t,t);
 EXECUTE format('CREATE POLICY ingestion_worker_read ON margin_ingestion.%I FOR SELECT TO margin_ingestion_inspector USING(true)',t);
 END LOOP;
END $$;
CREATE POLICY receipt_stage ON margin_ingestion.storage_receipts FOR INSERT TO margin_ingestion_runtime WITH CHECK(EXISTS(SELECT 1 FROM margin_ingestion.artifacts a WHERE a.artifact_id=storage_receipts.artifact_id));
CREATE POLICY inspection_queue ON margin_ingestion.inspection_jobs FOR INSERT TO margin_ingestion_runtime WITH CHECK(status='quarantined' AND attempt=0 AND claim_id IS NULL AND completed_at IS NULL AND scan_receipt_id IS NULL AND EXISTS(SELECT 1 FROM margin_ingestion.artifacts a WHERE a.artifact_id=inspection_jobs.artifact_id));
CREATE POLICY inspection_worker_update ON margin_ingestion.inspection_jobs FOR UPDATE TO margin_ingestion_inspector USING(true) WITH CHECK(true);
CREATE POLICY inspection_worker_result ON margin_ingestion.inspection_receipts FOR INSERT TO margin_ingestion_inspector WITH CHECK(EXISTS(SELECT 1 FROM margin_ingestion.inspection_jobs j WHERE j.artifact_id=inspection_receipts.artifact_id AND j.claim_id=inspection_receipts.claim_id AND j.attempt=inspection_receipts.attempt AND j.status='quarantined' AND j.lease_expires_at>statement_timestamp()));
CREATE FUNCTION margin_ingestion.protect_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.status<>'quarantined' THEN RAISE EXCEPTION 'Inspection decisions are immutable; revoke the artifact instead'; END IF;
 IF NEW.artifact_id<>OLD.artifact_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Inspection identity is immutable'; END IF;
 IF NEW.status<>'quarantined' THEN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.attempt<>OLD.attempt OR OLD.lease_expires_at<=statement_timestamp() OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN RAISE EXCEPTION 'Current inspection lease required'; END IF;
 ELSIF NEW.claim_id IS DISTINCT FROM OLD.claim_id AND NEW.claim_id IS NOT NULL THEN
  IF NEW.attempt<>OLD.attempt+1 OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>statement_timestamp()) OR NEW.lease_expires_at<=statement_timestamp() OR NEW.lease_expires_at>statement_timestamp()+interval '2 minutes' OR NEW.token_digest IS NULL THEN RAISE EXCEPTION 'Invalid inspection claim'; END IF;
 ELSIF NEW.claim_id IS NULL THEN
  IF NEW.attempt<>OLD.attempt OR NEW.lease_expires_at IS NOT NULL OR NEW.token_digest IS NOT NULL THEN RAISE EXCEPTION 'Invalid inspection retry'; END IF;
 ELSE RAISE EXCEPTION 'Inspection leases cannot be silently extended'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_job BEFORE UPDATE ON margin_ingestion.inspection_jobs FOR EACH ROW EXECUTE FUNCTION margin_ingestion.protect_job();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA margin_ingestion FROM PUBLIC;
GRANT USAGE ON SCHEMA margin_ingestion TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA margin_ingestion TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA margin_ingestion TO margin_ingestion_runtime,margin_ingestion_inspector,margin_ingestion_reader;
GRANT INSERT ON margin_ingestion.artifacts,margin_ingestion.storage_receipts,margin_ingestion.inspection_jobs TO margin_ingestion_runtime;
GRANT INSERT ON margin_ingestion.inspection_receipts TO margin_ingestion_inspector;
GRANT UPDATE(status,attempt,claim_id,token_digest,lease_expires_at,next_attempt_at,completed_at,scan_receipt_id) ON margin_ingestion.inspection_jobs TO margin_ingestion_inspector;
GRANT UPDATE(revoked_at) ON margin_ingestion.artifacts TO margin_ingestion_inspector;
COMMIT;
