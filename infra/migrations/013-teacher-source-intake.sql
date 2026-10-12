-- Apply after 001–012 with the migration owner. No accounts, sources or approvals are seeded.
-- Upload reservations create an immutable private shell, never inspected geometry or ready work.
BEGIN;
ALTER TABLE margin_sync.documents DROP CONSTRAINT documents_origin_check;
ALTER TABLE margin_sync.documents ADD CONSTRAINT documents_origin_check CHECK(origin IN ('general','assignment','lms-source'));

GRANT SELECT(current_version_id,origin,audience,cursor,operation_bytes) ON margin_sync.documents TO margin_ingestion_runtime;
GRANT INSERT(organization_id,id,owner_id,current_version_id,audience,origin) ON margin_sync.documents TO margin_ingestion_runtime;
GRANT INSERT(organization_id,document_id,id) ON margin_sync.versions TO margin_ingestion_runtime;
GRANT INSERT(organization_id,document_id,user_id,permission) ON margin_sync.grants TO margin_ingestion_runtime;
CREATE POLICY ingestion_upload_document_insert ON margin_sync.documents FOR INSERT TO margin_ingestion_runtime WITH CHECK(
 organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id') AND
 origin='lms-source' AND audience='teachers' AND cursor=0 AND operation_bytes=0 AND deleted_at IS NULL AND margin_ingestion.active_teacher()
);
CREATE POLICY ingestion_upload_version_insert ON margin_sync.versions FOR INSERT TO margin_ingestion_runtime WITH CHECK(
 organization_id=margin_ingestion.ctx('organization_id') AND margin_ingestion.active_teacher() AND
 EXISTS(SELECT 1 FROM margin_sync.documents d WHERE d.organization_id=versions.organization_id AND d.id=versions.document_id AND d.current_version_id=versions.id AND d.owner_id=margin_ingestion.ctx('user_id') AND d.origin='lms-source' AND d.deleted_at IS NULL)
);
CREATE POLICY ingestion_upload_grant_insert ON margin_sync.grants FOR INSERT TO margin_ingestion_runtime WITH CHECK(
 organization_id=margin_ingestion.ctx('organization_id') AND user_id=margin_ingestion.ctx('user_id') AND permission='owner' AND revoked_at IS NULL AND margin_ingestion.active_teacher() AND
 EXISTS(SELECT 1 FROM margin_sync.documents d WHERE d.organization_id=grants.organization_id AND d.id=grants.document_id AND d.owner_id=margin_ingestion.ctx('user_id') AND d.origin='lms-source' AND d.deleted_at IS NULL)
);

-- Keep capacity accounting even after revocation, rejection or approval. Reclamation is deliberately
-- unavailable until an authenticated object-deletion/retention workflow can release durable capacity.
CREATE TABLE margin_ingestion.upload_reservations (
 artifact_id uuid PRIMARY KEY REFERENCES margin_ingestion.artifacts(artifact_id),
 organization_id uuid NOT NULL, owner_id uuid NOT NULL, installation_id uuid NOT NULL, course_id uuid NOT NULL,
 plaintext_bytes bigint NOT NULL CHECK(plaintext_bytes BETWEEN 1 AND 104857600),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,owner_id) REFERENCES margin_identity.memberships(organization_id,user_id),
 FOREIGN KEY(installation_id,course_id,organization_id) REFERENCES margin_lms.courses(installation_id,course_id,organization_id)
);
CREATE INDEX upload_reservation_capacity ON margin_ingestion.upload_reservations(organization_id,owner_id,installation_id,course_id);
ALTER TABLE margin_ingestion.upload_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE margin_ingestion.upload_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_reservation_read ON margin_ingestion.upload_reservations FOR SELECT TO margin_ingestion_runtime USING(
 organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id') AND
 installation_id=margin_ingestion.ctx('installation_id') AND course_id=margin_ingestion.ctx('course_id') AND margin_ingestion.active_teacher()
);
CREATE POLICY upload_reservation_insert ON margin_ingestion.upload_reservations FOR INSERT TO margin_ingestion_runtime WITH CHECK(
 organization_id=margin_ingestion.ctx('organization_id') AND owner_id=margin_ingestion.ctx('user_id') AND
 installation_id=margin_ingestion.ctx('installation_id') AND course_id=margin_ingestion.ctx('course_id') AND margin_ingestion.active_teacher() AND
 EXISTS(SELECT 1 FROM margin_ingestion.artifacts a JOIN margin_sync.documents d ON d.organization_id=a.organization_id AND d.id=a.document_id
 WHERE a.artifact_id=upload_reservations.artifact_id AND a.organization_id=upload_reservations.organization_id AND a.owner_id=upload_reservations.owner_id
 AND a.installation_id=upload_reservations.installation_id AND a.course_id=upload_reservations.course_id AND d.origin='lms-source')
);
REVOKE ALL ON margin_ingestion.upload_reservations FROM PUBLIC;
GRANT SELECT,INSERT ON margin_ingestion.upload_reservations TO margin_ingestion_runtime;

-- The repository's lock improves exact-retry behavior; the database independently enforces
-- declared capacity for every writer. READ COMMITTED gives the volatile trigger a fresh
-- snapshot after waiting for the preceding writer; stronger snapshot modes must retry in
-- READ COMMITTED rather than count an obsolete snapshot. No caller-controlled timeout can
-- make this lock wait unbounded. The transaction holds the lock through its actual commit.
CREATE FUNCTION margin_ingestion.protect_upload_capacity() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='2s' AS $$
DECLARE upload_count bigint; claimed_bytes numeric;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM margin_ingestion.ctx('organization_id') OR NEW.owner_id IS DISTINCT FROM margin_ingestion.ctx('user_id') OR NEW.installation_id IS DISTINCT FROM margin_ingestion.ctx('installation_id') OR NEW.course_id IS DISTINCT FROM margin_ingestion.ctx('course_id') OR NOT margin_ingestion.active_teacher() THEN
  RAISE EXCEPTION 'Current teacher upload scope required' USING ERRCODE='42501';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Upload capacity requires READ COMMITTED transactions' USING ERRCODE='25001';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('margin-upload-capacity:'||NEW.organization_id::text||':'||NEW.owner_id::text||':'||NEW.installation_id::text||':'||NEW.course_id::text,0));
 SELECT count(*),coalesce(sum(plaintext_bytes),0) INTO upload_count,claimed_bytes FROM margin_ingestion.upload_reservations
 WHERE organization_id=NEW.organization_id AND owner_id=NEW.owner_id AND installation_id=NEW.installation_id AND course_id=NEW.course_id;
 IF upload_count>=100 OR claimed_bytes+NEW.plaintext_bytes>536870912 THEN
  RAISE EXCEPTION 'Teacher source capacity reached' USING ERRCODE='23514',CONSTRAINT='upload_reservation_capacity_limit';
 END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER protect_upload_capacity BEFORE INSERT ON margin_ingestion.upload_reservations FOR EACH ROW EXECUTE FUNCTION margin_ingestion.protect_upload_capacity();

-- A runtime credential cannot omit accounting by committing only a shell or artifact.
-- Encryption authenticates the declared byte count at the application/storage boundary;
-- PostgreSQL cannot decrypt it and enforces the declared count, not malware approval.
CREATE FUNCTION margin_ingestion.enforce_upload_accounting() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 -- Keep this as a separate branch: ordinary provisioners have no ingestion table access.
 IF NEW.origin<>'lms-source' THEN RETURN NULL; END IF;
 IF NOT EXISTS(
  SELECT 1 FROM margin_ingestion.artifacts a JOIN margin_ingestion.upload_reservations u ON u.artifact_id=a.artifact_id
  WHERE a.organization_id=NEW.organization_id AND a.document_id=NEW.id AND a.version_id=NEW.current_version_id AND a.owner_id=NEW.owner_id
  AND u.organization_id=a.organization_id AND u.owner_id=a.owner_id AND u.installation_id=a.installation_id AND u.course_id=a.course_id
 ) THEN
  RAISE EXCEPTION 'Source uploads require matching durable accounting' USING ERRCODE='23514',CONSTRAINT='upload_document_accounting';
 END IF;
 RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER enforce_upload_accounting AFTER INSERT ON margin_sync.documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION margin_ingestion.enforce_upload_accounting();
REVOKE ALL ON FUNCTION margin_ingestion.protect_upload_capacity(),margin_ingestion.enforce_upload_accounting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION margin_ingestion.protect_upload_capacity(),margin_ingestion.enforce_upload_accounting() TO margin_ingestion_runtime;
COMMIT;
