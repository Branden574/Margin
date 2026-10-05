-- Current-launch student content and annotation access only. No account, work or source is seeded.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_assignment_work_runtime') THEN
  CREATE ROLE margin_assignment_work_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_assignment_work_runtime' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe assignment work runtime group'; END IF;
END $$;
GRANT USAGE ON SCHEMA margin_work,margin_identity,margin_lms,margin_assignments,margin_sync,margin_ingestion TO margin_assignment_work_runtime;
GRANT EXECUTE ON FUNCTION margin_work.ctx(text) TO margin_assignment_work_runtime;
-- The server sets only an authenticated principal here. Teacher context grants structural
-- status fields, never keys or content; source content is separately tied to the live launch.
GRANT SELECT(id,disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_assignment_work_runtime;
GRANT SELECT(organization_id,user_id,role,revoked_at) ON margin_identity.memberships TO margin_assignment_work_runtime;
GRANT SELECT(id,user_id,organization_id,authentication_method,expires_at,idle_expires_at,revoked_at) ON margin_identity.sessions TO margin_assignment_work_runtime;
GRANT SELECT(id,organization_id,version,enabled) ON margin_lms.installations TO margin_assignment_work_runtime;
GRANT SELECT ON margin_lms.session_bindings,margin_lms.user_links,margin_lms.courses,margin_lms.enrollments TO margin_assignment_work_runtime;
CREATE POLICY work_api_user ON margin_identity.users FOR SELECT TO margin_assignment_work_runtime USING(id IN (margin_work.ctx('user_id'),margin_work.ctx('source_owner_id')));
CREATE POLICY work_api_org ON margin_identity.organizations FOR SELECT TO margin_assignment_work_runtime USING(id=margin_work.ctx('organization_id'));
CREATE POLICY work_api_member ON margin_identity.memberships FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND user_id IN (margin_work.ctx('user_id'),margin_work.ctx('source_owner_id')));
CREATE POLICY work_api_session ON margin_identity.sessions FOR SELECT TO margin_assignment_work_runtime USING(id=margin_work.ctx('session_id') AND user_id=margin_work.ctx('user_id') AND organization_id=margin_work.ctx('organization_id'));
CREATE POLICY work_api_binding ON margin_lms.session_bindings FOR SELECT TO margin_assignment_work_runtime USING(session_id=margin_work.ctx('session_id') AND user_id=margin_work.ctx('user_id') AND organization_id=margin_work.ctx('organization_id'));
CREATE POLICY work_api_installation ON margin_lms.installations FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=installations.id));
CREATE POLICY work_api_course ON margin_lms.courses FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=courses.installation_id AND b.course_id=courses.course_id));
CREATE POLICY work_api_link ON margin_lms.user_links FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND user_id IN (margin_work.ctx('user_id'),margin_work.ctx('source_owner_id')) AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=user_links.installation_id));
CREATE POLICY work_api_enrollment ON margin_lms.enrollments FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND user_id IN (margin_work.ctx('user_id'),margin_work.ctx('source_owner_id')) AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=enrollments.installation_id AND b.course_id=enrollments.course_id));
CREATE FUNCTION margin_work.request_active() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_lms.session_bindings b
 JOIN margin_identity.sessions s ON s.id=b.session_id AND s.user_id=b.user_id AND s.organization_id=b.organization_id AND s.authentication_method='lti' AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
 JOIN margin_identity.memberships m ON m.organization_id=b.organization_id AND m.user_id=b.user_id AND m.role='student' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=b.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=b.organization_id AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=b.installation_id AND i.organization_id=b.organization_id AND i.version=b.registration_version AND i.enabled
 JOIN margin_lms.courses c ON c.installation_id=b.installation_id AND c.organization_id=b.organization_id AND c.course_id=b.course_id AND c.external_digest=b.course_digest AND c.disabled_at IS NULL
 JOIN margin_lms.user_links l ON l.installation_id=b.installation_id AND l.organization_id=b.organization_id AND l.user_id=b.user_id AND l.subject_digest=b.subject_digest AND l.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=b.installation_id AND e.organization_id=b.organization_id AND e.course_id=b.course_id AND e.user_id=b.user_id AND e.role='student' AND e.disabled_at IS NULL
 WHERE b.session_id=margin_work.ctx('session_id') AND b.organization_id=margin_work.ctx('organization_id') AND b.user_id=margin_work.ctx('user_id') AND b.role='student')
$$;
GRANT SELECT ON margin_assignments.launch_bindings,margin_assignments.resource_links,margin_assignments.assignments,margin_assignments.student_work TO margin_assignment_work_runtime;
GRANT SELECT(work_id,state,claim_id,attempt,completed_at) ON margin_assignments.provisioning_outbox TO margin_assignment_work_runtime;
CREATE POLICY work_api_launch ON margin_assignments.launch_bindings FOR SELECT TO margin_assignment_work_runtime USING(session_id=margin_work.ctx('session_id') AND user_id=margin_work.ctx('user_id') AND margin_work.request_active());
CREATE POLICY work_api_resource ON margin_assignments.resource_links FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_assignments.launch_bindings b WHERE b.installation_id=resource_links.installation_id AND b.resource_digest=resource_links.resource_digest AND b.assignment_id=resource_links.assignment_id));
CREATE FUNCTION margin_work.launched(assignment uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_assignments.launch_bindings l JOIN margin_assignments.resource_links r ON r.installation_id=l.installation_id AND r.resource_digest=l.resource_digest AND r.assignment_id=l.assignment_id JOIN margin_lms.session_bindings b ON b.session_id=l.session_id AND b.installation_id=r.installation_id AND b.organization_id=r.organization_id AND b.course_id=r.course_id WHERE l.assignment_id=assignment)
$$;
CREATE POLICY work_api_assignment ON margin_assignments.assignments FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND selected_at IS NOT NULL AND disabled_at IS NULL AND margin_work.launched(id));
CREATE POLICY work_api_work ON margin_assignments.student_work FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND user_id=margin_work.ctx('user_id') AND margin_work.launched(assignment_id) AND EXISTS(SELECT 1 FROM margin_assignments.launch_bindings l JOIN margin_lms.session_bindings b ON b.session_id=l.session_id WHERE l.assignment_id=student_work.assignment_id AND l.resource_digest=student_work.resource_digest AND b.installation_id=student_work.installation_id AND b.registration_version=student_work.registration_version AND b.course_id=student_work.course_id AND b.subject_digest=student_work.subject_digest AND b.course_digest=student_work.course_digest));
CREATE POLICY work_api_job ON margin_assignments.provisioning_outbox FOR SELECT TO margin_assignment_work_runtime USING(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=provisioning_outbox.work_id));
GRANT SELECT ON margin_work.receipts TO margin_assignment_work_runtime;
CREATE POLICY work_api_receipt ON margin_work.receipts FOR SELECT TO margin_assignment_work_runtime USING(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=receipts.work_id AND w.status='provisioned'));
-- Source structural reads are bound to the current selected assignment; target reads are
-- bound to this student's provisioned work. No teacher annotation/key policy is granted.
GRANT SELECT ON margin_sync.documents,margin_sync.versions,margin_sync.pages,margin_sync.grants,margin_sync.document_keys,margin_sync.annotations,margin_sync.operations TO margin_assignment_work_runtime;
CREATE POLICY work_api_document ON margin_sync.documents FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND (EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.source_document_id=documents.id AND a.created_by=documents.owner_id) OR EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=documents.id AND w.status='provisioned')));
CREATE POLICY work_api_version ON margin_sync.versions FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND (EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.source_document_id=versions.document_id AND a.source_version_id=versions.id) OR EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=versions.document_id AND w.version_id=versions.id AND w.status='provisioned')));
CREATE POLICY work_api_grant ON margin_sync.grants FOR SELECT TO margin_assignment_work_runtime USING(organization_id=margin_work.ctx('organization_id') AND (EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.source_document_id=grants.document_id AND a.created_by=grants.user_id) OR (user_id=margin_work.ctx('user_id') AND EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=grants.document_id AND w.status='provisioned'))));
CREATE FUNCTION margin_work.runtime_target(org uuid,doc uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM margin_assignments.student_work w JOIN margin_assignments.assignments a ON a.id=w.assignment_id JOIN margin_sync.documents d ON d.organization_id=w.organization_id AND d.id=w.document_id AND d.owner_id=w.user_id AND d.current_version_id=w.version_id AND d.origin='assignment' AND d.deleted_at IS NULL JOIN margin_sync.grants g ON g.organization_id=w.organization_id AND g.document_id=w.document_id AND g.user_id=w.user_id AND g.permission='owner' AND g.revoked_at IS NULL WHERE w.organization_id=org AND w.document_id=doc AND w.status='provisioned')
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pages','document_keys','annotations','operations'] LOOP
  EXECUTE format('CREATE POLICY work_api_payload ON margin_sync.%I FOR SELECT TO margin_assignment_work_runtime USING(margin_work.runtime_target(organization_id,document_id))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['annotations','operations','outbox'] LOOP
  EXECUTE format('CREATE POLICY work_api_insert ON margin_sync.%I FOR INSERT TO margin_assignment_work_runtime WITH CHECK(margin_work.runtime_target(organization_id,document_id))',t);
 END LOOP;
END $$;
CREATE POLICY work_api_actor ON margin_sync.operations AS RESTRICTIVE FOR INSERT TO margin_assignment_work_runtime WITH CHECK(actor_id=margin_work.ctx('user_id'));
CREATE POLICY work_api_annotation_update ON margin_sync.annotations FOR UPDATE TO margin_assignment_work_runtime USING(margin_work.runtime_target(organization_id,document_id)) WITH CHECK(margin_work.runtime_target(organization_id,document_id));
CREATE POLICY work_api_cursor ON margin_sync.documents FOR UPDATE TO margin_assignment_work_runtime USING(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=documents.id AND w.status='provisioned')) WITH CHECK(origin='assignment' AND owner_id=margin_work.ctx('user_id') AND EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=documents.id AND w.version_id=documents.current_version_id AND w.status='provisioned'));
GRANT INSERT ON margin_sync.annotations,margin_sync.operations,margin_sync.outbox TO margin_assignment_work_runtime;
GRANT UPDATE(revision,deleted,latest_cursor) ON margin_sync.annotations TO margin_assignment_work_runtime;
GRANT UPDATE(cursor,operation_bytes) ON margin_sync.documents TO margin_assignment_work_runtime;
GRANT SELECT ON margin_ingestion.artifacts,margin_ingestion.storage_receipts,margin_ingestion.inspection_jobs,margin_ingestion.inspection_receipts,margin_ingestion.page_geometry TO margin_assignment_work_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['artifacts','storage_receipts','inspection_jobs','inspection_receipts','page_geometry'] LOOP
  EXECUTE format('CREATE POLICY work_api_source ON margin_ingestion.%I FOR SELECT TO margin_assignment_work_runtime USING(EXISTS(SELECT 1 FROM margin_work.receipts r WHERE r.source_artifact_id=%I.artifact_id))',t,t);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION margin_ingestion.ctx(text),margin_ingestion.active_source(uuid,uuid,uuid,uuid,uuid,uuid,integer) TO margin_assignment_work_runtime;
-- PostgreSQL requires an UPDATE column privilege/policy for FOR SHARE locks.
-- Only immutable structural columns are granted here, with a rejecting WITH CHECK.
-- Documents already grant UPDATE(cursor,operation_bytes); those privileges also allow
-- FOR SHARE with a lock-only USING policy, without granting any identity-column writes.
CREATE POLICY work_api_document_lock ON margin_sync.documents FOR UPDATE TO margin_assignment_work_runtime USING(true) WITH CHECK(false);
DO $$ DECLARE item text[]; BEGIN
 FOREACH item SLICE 1 IN ARRAY ARRAY[
 ['margin_identity.organizations','id'],['margin_identity.users','id'],['margin_identity.memberships','user_id'],['margin_identity.sessions','id'],
 ['margin_lms.installations','id'],['margin_lms.courses','course_id'],['margin_lms.user_links','user_id'],['margin_lms.enrollments','user_id'],['margin_lms.session_bindings','session_id'],
 ['margin_assignments.assignments','id'],['margin_assignments.launch_bindings','session_id'],['margin_assignments.resource_links','resource_digest'],['margin_assignments.student_work','id'],['margin_assignments.provisioning_outbox','work_id'],
 ['margin_work.receipts','work_id'],['margin_sync.versions','id'],['margin_sync.pages','id'],['margin_sync.grants','user_id'],['margin_sync.document_keys','document_id'],
 ['margin_ingestion.artifacts','artifact_id'],['margin_ingestion.storage_receipts','artifact_id'],['margin_ingestion.inspection_jobs','artifact_id'],['margin_ingestion.inspection_receipts','id'],['margin_ingestion.page_geometry','scan_receipt_id']
 ] LOOP
  EXECUTE format('GRANT UPDATE(%I) ON %s TO margin_assignment_work_runtime',item[2],item[1]);
  EXECUTE format('CREATE POLICY work_api_lock ON %s FOR UPDATE TO margin_assignment_work_runtime USING(true) WITH CHECK(false)',item[1]);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION margin_work.request_active(),margin_work.launched(uuid),margin_work.runtime_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION margin_work.request_active(),margin_work.launched(uuid),margin_work.runtime_target(uuid,uuid) TO margin_assignment_work_runtime;
COMMIT;
