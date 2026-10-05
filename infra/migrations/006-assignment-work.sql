-- Apply after 001..005 with the migration owner. No account, provider or cloud object is created.
BEGIN;
CREATE SCHEMA margin_work;
REVOKE ALL ON SCHEMA margin_work FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_assignment_provisioner') THEN
 CREATE ROLE margin_assignment_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_assignment_provisioner' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe assignment provisioner group'; END IF;
END $$;
ALTER TABLE margin_ingestion.inspection_receipts ADD COLUMN has_geometry boolean NOT NULL DEFAULT false;
CREATE TABLE margin_ingestion.page_geometry (
 scan_receipt_id uuid PRIMARY KEY REFERENCES margin_ingestion.inspection_receipts(id),artifact_id uuid NOT NULL REFERENCES margin_ingestion.artifacts(artifact_id),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE margin_ingestion.page_geometry ENABLE ROW LEVEL SECURITY;
ALTER TABLE margin_ingestion.page_geometry FORCE ROW LEVEL SECURITY;
CREATE POLICY geometry_scoped_read ON margin_ingestion.page_geometry FOR SELECT TO margin_ingestion_runtime,margin_ingestion_reader USING(EXISTS(SELECT 1 FROM margin_ingestion.artifacts a WHERE a.artifact_id=page_geometry.artifact_id));
CREATE POLICY geometry_inspector_read ON margin_ingestion.page_geometry FOR SELECT TO margin_ingestion_inspector USING(true);
CREATE POLICY geometry_insert ON margin_ingestion.page_geometry FOR INSERT TO margin_ingestion_inspector WITH CHECK(EXISTS(SELECT 1 FROM margin_ingestion.inspection_receipts r JOIN margin_ingestion.inspection_jobs j ON j.artifact_id=r.artifact_id AND j.claim_id=r.claim_id AND j.attempt=r.attempt WHERE r.id=page_geometry.scan_receipt_id AND r.artifact_id=page_geometry.artifact_id AND r.has_geometry AND j.status='quarantined' AND j.lease_expires_at>statement_timestamp()));
GRANT SELECT ON margin_ingestion.page_geometry TO margin_ingestion_runtime,margin_ingestion_reader,margin_ingestion_inspector;
GRANT INSERT ON margin_ingestion.page_geometry TO margin_ingestion_inspector;
ALTER TABLE margin_sync.documents ADD COLUMN origin text NOT NULL DEFAULT 'general' CHECK(origin IN ('general','assignment'));
-- Even a valid OIDC owner session cannot use the generic API for assignment work.
CREATE POLICY assignment_origin_read ON margin_sync.documents AS RESTRICTIVE FOR SELECT TO margin_sync_runtime USING(origin='general');
CREATE POLICY assignment_origin_update ON margin_sync.documents AS RESTRICTIVE FOR UPDATE TO margin_sync_runtime USING(origin='general') WITH CHECK(origin='general');
ALTER TABLE margin_assignments.student_work DROP CONSTRAINT student_work_status_check;
ALTER TABLE margin_assignments.student_work ADD CONSTRAINT student_work_status_check CHECK(status IN ('pending','provisioned'));
ALTER TABLE margin_assignments.student_work ADD COLUMN provisioned_at timestamptz,ADD COLUMN registration_version integer CHECK(registration_version>0),ADD COLUMN subject_digest text CHECK(subject_digest ~ '^[a-f0-9]{64}$'),ADD COLUMN course_digest text CHECK(course_digest ~ '^[a-f0-9]{64}$'),ADD COLUMN provenance_session_id uuid,ADD COLUMN resource_digest text CHECK(resource_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE margin_assignments.student_work ADD CONSTRAINT work_provenance CHECK((registration_version IS NULL AND subject_digest IS NULL AND course_digest IS NULL AND provenance_session_id IS NULL AND resource_digest IS NULL) OR (registration_version IS NOT NULL AND subject_digest IS NOT NULL AND course_digest IS NOT NULL AND provenance_session_id IS NOT NULL AND resource_digest IS NOT NULL));
ALTER TABLE margin_assignments.student_work ADD CONSTRAINT work_completion CHECK((status='pending' AND provisioned_at IS NULL) OR (status='provisioned' AND provisioned_at IS NOT NULL));
ALTER TABLE margin_assignments.student_work ADD CONSTRAINT work_target UNIQUE(id,organization_id,document_id,version_id);
ALTER TABLE margin_assignments.provisioning_outbox ADD COLUMN state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 10),ADD COLUMN claim_id uuid,ADD COLUMN token_digest text CHECK(token_digest ~ '^[a-f0-9]{64}$'),ADD COLUMN lease_expires_at timestamptz,ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),ADD COLUMN completed_at timestamptz;
ALTER TABLE margin_assignments.provisioning_outbox ADD CONSTRAINT work_claim CHECK((claim_id IS NULL AND token_digest IS NULL AND lease_expires_at IS NULL) OR (claim_id IS NOT NULL AND token_digest IS NOT NULL AND lease_expires_at IS NOT NULL));
ALTER TABLE margin_assignments.provisioning_outbox ADD CONSTRAINT work_outbox_completion CHECK((state='pending' AND completed_at IS NULL) OR (state='completed' AND completed_at IS NOT NULL AND claim_id IS NOT NULL));
CREATE INDEX work_due ON margin_assignments.provisioning_outbox(next_attempt_at,created_at) WHERE state='pending';
CREATE FUNCTION margin_work.ctx(k text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_work.'||k,true),'')::uuid $$;
CREATE FUNCTION margin_work.claimed(work uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM margin_assignments.provisioning_outbox j WHERE j.work_id=work AND j.work_id=margin_work.ctx('work_id') AND j.claim_id=margin_work.ctx('claim_id') AND j.token_digest=nullif(current_setting('margin_work.token_digest',true),'') AND j.state='pending' AND j.lease_expires_at>statement_timestamp()) $$;
-- Durable background authorization follows current enrollment and pinned subject/course mapping,
-- not the lifetime of the browser session that created the reservation.
CREATE FUNCTION margin_work.active(work uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_assignments.student_work w
 JOIN margin_assignments.assignments a ON a.id=w.assignment_id AND a.organization_id=w.organization_id AND a.installation_id=w.installation_id AND a.course_id=w.course_id AND a.selected_at IS NOT NULL AND a.disabled_at IS NULL
 JOIN margin_assignments.resource_links r ON r.installation_id=w.installation_id AND r.resource_digest=w.resource_digest AND r.organization_id=w.organization_id AND r.course_id=w.course_id AND r.assignment_id=w.assignment_id
 JOIN margin_identity.memberships m ON m.organization_id=w.organization_id AND m.user_id=w.user_id AND m.role='student' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=w.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=w.organization_id AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=w.installation_id AND i.organization_id=w.organization_id AND i.version=w.registration_version AND i.enabled
 JOIN margin_lms.user_links l ON l.installation_id=w.installation_id AND l.organization_id=w.organization_id AND l.user_id=w.user_id AND l.subject_digest=w.subject_digest AND l.disabled_at IS NULL
 JOIN margin_lms.courses c ON c.installation_id=w.installation_id AND c.organization_id=w.organization_id AND c.course_id=w.course_id AND c.external_digest=w.course_digest AND c.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=w.installation_id AND e.organization_id=w.organization_id AND e.course_id=w.course_id AND e.user_id=w.user_id AND e.role='student' AND e.disabled_at IS NULL
 WHERE w.id=work AND w.registration_version IS NOT NULL)
$$;
CREATE TABLE margin_work.receipts (
 work_id uuid PRIMARY KEY,organization_id uuid NOT NULL,document_id uuid NOT NULL,version_id uuid NOT NULL,claim_id uuid NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 10),source_artifact_id uuid NOT NULL REFERENCES margin_ingestion.artifacts(artifact_id),scan_receipt_id uuid NOT NULL REFERENCES margin_ingestion.inspection_receipts(id),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 262144),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(work_id,organization_id,document_id,version_id) REFERENCES margin_assignments.student_work(id,organization_id,document_id,version_id),FOREIGN KEY(organization_id,document_id,version_id) REFERENCES margin_sync.versions(organization_id,document_id,id)
);
ALTER TABLE margin_work.receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE margin_work.receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY receipt_read ON margin_work.receipts FOR SELECT TO margin_assignment_provisioner USING(work_id=margin_work.ctx('work_id'));
CREATE POLICY receipt_insert ON margin_work.receipts FOR INSERT TO margin_assignment_provisioner WITH CHECK(margin_work.claimed(work_id) AND margin_work.active(work_id) AND claim_id=margin_work.ctx('claim_id') AND EXISTS(SELECT 1 FROM margin_assignments.provisioning_outbox j WHERE j.work_id=receipts.work_id AND j.attempt=receipts.attempt));
CREATE FUNCTION margin_work.protect_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b margin_lms.session_bindings; BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.provisioned_at IS NOT NULL THEN RAISE EXCEPTION 'New work must be pending'; END IF;
  IF margin_assignments.active_role() IS DISTINCT FROM 'student' THEN RAISE EXCEPTION 'Verified student launch required'; END IF;
  SELECT * INTO b FROM margin_lms.session_bindings WHERE session_id=margin_assignments.context_id('session_id') AND user_id=NEW.user_id AND organization_id=NEW.organization_id AND installation_id=NEW.installation_id AND course_id=NEW.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work provenance is missing'; END IF;
  NEW.registration_version=b.registration_version;NEW.subject_digest=b.subject_digest;NEW.course_digest=b.course_digest;NEW.provenance_session_id=b.session_id;
  SELECT resource_digest INTO NEW.resource_digest FROM margin_assignments.launch_bindings WHERE session_id=b.session_id AND user_id=NEW.user_id AND assignment_id=NEW.assignment_id AND installation_id=NEW.installation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Verified resource binding required'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.assignment_id,NEW.organization_id,NEW.installation_id,NEW.course_id,NEW.user_id,NEW.document_id,NEW.version_id,NEW.created_at,NEW.registration_version,NEW.subject_digest,NEW.course_digest,NEW.provenance_session_id,NEW.resource_digest) IS DISTINCT FROM ROW(OLD.id,OLD.assignment_id,OLD.organization_id,OLD.installation_id,OLD.course_id,OLD.user_id,OLD.document_id,OLD.version_id,OLD.created_at,OLD.registration_version,OLD.subject_digest,OLD.course_digest,OLD.provenance_session_id,OLD.resource_digest) THEN RAISE EXCEPTION 'Work identity is immutable'; END IF;
  IF OLD.status<>'pending' OR NEW.status<>'provisioned' OR NOT margin_work.claimed(OLD.id) OR NOT margin_work.active(OLD.id) OR NOT EXISTS(SELECT 1 FROM margin_work.receipts r WHERE r.work_id=OLD.id AND r.claim_id=margin_work.ctx('claim_id')) THEN RAISE EXCEPTION 'Current claim and completion receipt required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_reservation BEFORE INSERT OR UPDATE ON margin_assignments.student_work FOR EACH ROW EXECUTE FUNCTION margin_work.protect_reservation();
CREATE FUNCTION margin_work.protect_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.state<>'pending' OR NEW.work_id<>OLD.work_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Completed work and job identity are immutable'; END IF;
 IF NEW.state='completed' THEN
  IF NOT margin_work.claimed(OLD.work_id) OR NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.attempt<>OLD.attempt OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at OR NOT EXISTS(SELECT 1 FROM margin_assignments.student_work w JOIN margin_work.receipts r ON r.work_id=w.id WHERE w.id=OLD.work_id AND w.status='provisioned' AND r.claim_id=OLD.claim_id AND r.attempt=OLD.attempt) THEN RAISE EXCEPTION 'Atomic work completion required'; END IF;
 ELSIF NEW.claim_id IS DISTINCT FROM OLD.claim_id AND NEW.claim_id IS NOT NULL THEN
  IF NEW.attempt<>OLD.attempt+1 OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>statement_timestamp()) OR NEW.lease_expires_at<=statement_timestamp() OR NEW.lease_expires_at>statement_timestamp()+interval '2 minutes' OR NEW.token_digest IS NULL OR NOT margin_work.active(OLD.work_id) THEN RAISE EXCEPTION 'Invalid work claim'; END IF;
 ELSIF NEW.claim_id IS NULL THEN
  IF NOT margin_work.claimed(OLD.work_id) OR NEW.attempt<>OLD.attempt OR NEW.lease_expires_at IS NOT NULL OR NEW.token_digest IS NOT NULL OR NEW.next_attempt_at<statement_timestamp() OR NEW.next_attempt_at>statement_timestamp()+interval '1 hour' THEN RAISE EXCEPTION 'Invalid work retry'; END IF;
 ELSE RAISE EXCEPTION 'Work leases cannot be extended'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_work_job BEFORE UPDATE ON margin_assignments.provisioning_outbox FOR EACH ROW EXECUTE FUNCTION margin_work.protect_job();
CREATE POLICY outbox_initial ON margin_assignments.provisioning_outbox AS RESTRICTIVE FOR INSERT TO margin_assignments_runtime WITH CHECK(state='pending' AND attempt=0 AND claim_id IS NULL AND completed_at IS NULL);
GRANT USAGE ON SCHEMA margin_work TO margin_assignment_provisioner,margin_assignments_runtime;
GRANT USAGE ON SCHEMA margin_identity,margin_lms,margin_sync,margin_assignments,margin_ingestion TO margin_assignment_provisioner;
GRANT SELECT(id,disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_assignment_provisioner;
GRANT SELECT(organization_id,user_id,role,revoked_at) ON margin_identity.memberships TO margin_assignment_provisioner;
GRANT SELECT(id,organization_id,version,enabled) ON margin_lms.installations TO margin_assignment_provisioner;
GRANT SELECT ON margin_lms.enrollments,margin_lms.user_links,margin_lms.courses TO margin_assignment_provisioner;
GRANT SELECT ON margin_assignments.assignments,margin_assignments.student_work,margin_assignments.provisioning_outbox,margin_assignments.resource_links TO margin_assignment_provisioner;
GRANT UPDATE(status,provisioned_at) ON margin_assignments.student_work TO margin_assignment_provisioner;
GRANT UPDATE(state,attempt,claim_id,token_digest,lease_expires_at,next_attempt_at,completed_at) ON margin_assignments.provisioning_outbox TO margin_assignment_provisioner;
GRANT SELECT(organization_id,id,owner_id,current_version_id,deleted_at,origin) ON margin_sync.documents TO margin_assignment_provisioner;
GRANT SELECT ON margin_sync.versions,margin_sync.grants,margin_sync.pages TO margin_assignment_provisioner;
GRANT INSERT ON margin_sync.documents,margin_sync.versions,margin_sync.pages,margin_sync.grants,margin_sync.document_keys TO margin_assignment_provisioner;
GRANT SELECT ON ALL TABLES IN SCHEMA margin_ingestion TO margin_assignment_provisioner;
GRANT SELECT,INSERT ON margin_work.receipts TO margin_assignment_provisioner;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['margin_identity.users','margin_identity.organizations','margin_identity.memberships','margin_lms.installations','margin_lms.enrollments','margin_lms.user_links','margin_lms.courses','margin_assignments.assignments','margin_assignments.student_work','margin_assignments.provisioning_outbox','margin_assignments.resource_links','margin_sync.documents','margin_sync.versions','margin_sync.grants','margin_sync.pages','margin_ingestion.artifacts','margin_ingestion.storage_receipts','margin_ingestion.inspection_jobs','margin_ingestion.inspection_receipts','margin_ingestion.page_geometry'] LOOP
 EXECUTE format('CREATE POLICY work_worker_read ON %s FOR SELECT TO margin_assignment_provisioner USING(true)',t);
 END LOOP;
END $$;
CREATE POLICY work_worker_update ON margin_assignments.student_work FOR UPDATE TO margin_assignment_provisioner USING(margin_work.claimed(id) AND margin_work.active(id)) WITH CHECK(margin_work.claimed(id) AND margin_work.active(id));
CREATE POLICY work_job_update ON margin_assignments.provisioning_outbox FOR UPDATE TO margin_assignment_provisioner USING(true) WITH CHECK(true);
CREATE FUNCTION margin_work.target(org uuid,doc uuid,ver uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=margin_work.ctx('work_id') AND w.organization_id=org AND w.document_id=doc AND (ver IS NULL OR w.version_id=ver) AND w.status='pending' AND margin_work.claimed(w.id) AND margin_work.active(w.id)) $$;
CREATE POLICY work_document_insert ON margin_sync.documents FOR INSERT TO margin_assignment_provisioner WITH CHECK(origin='assignment' AND audience='members' AND deleted_at IS NULL AND cursor=0 AND operation_bytes=0 AND margin_work.target(organization_id,id,current_version_id) AND EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=margin_work.ctx('work_id') AND w.user_id=owner_id));
CREATE POLICY work_version_insert ON margin_sync.versions FOR INSERT TO margin_assignment_provisioner WITH CHECK(margin_work.target(organization_id,document_id,id));
CREATE POLICY work_page_insert ON margin_sync.pages FOR INSERT TO margin_assignment_provisioner WITH CHECK(margin_work.target(organization_id,document_id,version_id));
CREATE POLICY work_key_insert ON margin_sync.document_keys FOR INSERT TO margin_assignment_provisioner WITH CHECK(margin_work.target(organization_id,document_id));
CREATE POLICY work_grant_insert ON margin_sync.grants FOR INSERT TO margin_assignment_provisioner WITH CHECK(margin_work.target(organization_id,document_id) AND permission='owner' AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=margin_work.ctx('work_id') AND w.user_id=grants.user_id));
-- PostgreSQL requires UPDATE privileges/policy visibility for FOR SHARE. These exact
-- structural-column grants permit row locking; WITH CHECK(false) forbids every write,
-- including no-op updates. Mixed-role service credentials are rejected by repositories.
DO $$ DECLARE item text[]; BEGIN
 FOREACH item SLICE 1 IN ARRAY ARRAY[
 ['margin_identity.users','id'],['margin_identity.organizations','id'],['margin_identity.memberships','user_id'],
 ['margin_lms.installations','id'],['margin_lms.user_links','user_id'],['margin_lms.courses','course_id'],['margin_lms.enrollments','user_id'],
 ['margin_assignments.assignments','id'],['margin_assignments.resource_links','resource_digest'],['margin_sync.documents','id'],['margin_sync.versions','id'],['margin_sync.grants','user_id'],
 ['margin_ingestion.artifacts','artifact_id'],['margin_ingestion.storage_receipts','artifact_id'],['margin_ingestion.inspection_jobs','artifact_id'],['margin_ingestion.inspection_receipts','id'],['margin_ingestion.page_geometry','scan_receipt_id']
 ] LOOP
 EXECUTE format('GRANT UPDATE(%I) ON %s TO margin_assignment_provisioner',item[2],item[1]);
 EXECUTE format('CREATE POLICY work_lock_only ON %s FOR UPDATE TO margin_assignment_provisioner USING(true) WITH CHECK(false)',item[1]);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA margin_work FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA margin_work TO margin_assignment_provisioner;
GRANT EXECUTE ON FUNCTION margin_work.protect_reservation() TO margin_assignments_runtime;
GRANT EXECUTE ON FUNCTION margin_ingestion.ctx(text),margin_ingestion.active_source(uuid,uuid,uuid,uuid,uuid,uuid,integer) TO margin_assignment_provisioner;
COMMIT;
-- Pre-006 reservations without pinned provenance remain pending. Reauthorization/migration is an explicit future operation.
-- No download/editor adapter, scheduler, scanner, cloud provider or deployment is enabled by this migration.
