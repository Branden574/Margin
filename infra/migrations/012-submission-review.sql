-- Author-only, current-launch review of immutable Margin captures. No new sync grants or writes.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_submission_reviewer') THEN
 CREATE ROLE margin_submission_reviewer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_submission_reviewer' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe submission reviewer role'; END IF;
END $$;
CREATE SCHEMA margin_review;
REVOKE ALL ON SCHEMA margin_review FROM PUBLIC;
GRANT USAGE ON SCHEMA margin_review,margin_identity,margin_lms,margin_assignments,margin_sync,margin_ingestion,margin_work,margin_submissions TO margin_submission_reviewer;
CREATE FUNCTION margin_review.ctx(k text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_review.'||k,true),'')::uuid $$;
GRANT SELECT(id,disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_submission_reviewer;
GRANT SELECT(organization_id,user_id,role,revoked_at) ON margin_identity.memberships TO margin_submission_reviewer;
GRANT SELECT(id,user_id,organization_id,authentication_method,expires_at,idle_expires_at,revoked_at) ON margin_identity.sessions TO margin_submission_reviewer;
GRANT SELECT(id,organization_id,version,enabled) ON margin_lms.installations TO margin_submission_reviewer;
GRANT SELECT ON margin_lms.session_bindings,margin_lms.user_links,margin_lms.courses,margin_lms.enrollments TO margin_submission_reviewer;
CREATE POLICY reviewer_user ON margin_identity.users FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_identity.memberships m WHERE m.user_id=users.id AND m.organization_id=margin_review.ctx('organization_id')));
CREATE POLICY reviewer_org ON margin_identity.organizations FOR SELECT TO margin_submission_reviewer USING(id=margin_review.ctx('organization_id'));
CREATE POLICY reviewer_member ON margin_identity.memberships FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id'));
CREATE POLICY reviewer_session ON margin_identity.sessions FOR SELECT TO margin_submission_reviewer USING(id=margin_review.ctx('session_id') AND user_id=margin_review.ctx('user_id') AND organization_id=margin_review.ctx('organization_id'));
CREATE POLICY reviewer_binding ON margin_lms.session_bindings FOR SELECT TO margin_submission_reviewer USING(session_id=margin_review.ctx('session_id') AND user_id=margin_review.ctx('user_id') AND organization_id=margin_review.ctx('organization_id'));
CREATE POLICY reviewer_installation ON margin_lms.installations FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=installations.id));
CREATE POLICY reviewer_course ON margin_lms.courses FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=courses.installation_id AND b.course_id=courses.course_id));
CREATE POLICY reviewer_link ON margin_lms.user_links FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=user_links.installation_id));
CREATE POLICY reviewer_enrollment ON margin_lms.enrollments FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_lms.session_bindings b WHERE b.installation_id=enrollments.installation_id AND b.course_id=enrollments.course_id));
CREATE FUNCTION margin_review.request_active() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RETURN EXISTS(SELECT 1 FROM margin_lms.session_bindings b
 JOIN margin_identity.sessions s ON s.id=b.session_id AND s.user_id=b.user_id AND s.organization_id=b.organization_id AND s.authentication_method='lti' AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
 JOIN margin_identity.memberships m ON m.organization_id=b.organization_id AND m.user_id=b.user_id AND m.role='teacher' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=b.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=b.organization_id AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=b.installation_id AND i.organization_id=b.organization_id AND i.version=b.registration_version AND i.enabled
 JOIN margin_lms.courses c ON c.installation_id=b.installation_id AND c.organization_id=b.organization_id AND c.course_id=b.course_id AND c.external_digest=b.course_digest AND c.disabled_at IS NULL
 JOIN margin_lms.user_links l ON l.installation_id=b.installation_id AND l.organization_id=b.organization_id AND l.user_id=b.user_id AND l.subject_digest=b.subject_digest AND l.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=b.installation_id AND e.organization_id=b.organization_id AND e.course_id=b.course_id AND e.user_id=b.user_id AND e.role='teacher' AND e.disabled_at IS NULL
 WHERE b.session_id=margin_review.ctx('session_id') AND b.organization_id=margin_review.ctx('organization_id') AND b.user_id=margin_review.ctx('user_id') AND b.role='teacher'); END $$;
GRANT SELECT ON margin_assignments.launch_bindings,margin_assignments.resource_links,margin_assignments.assignments,margin_assignments.student_work TO margin_submission_reviewer;
GRANT SELECT(work_id,state,claim_id,attempt,completed_at) ON margin_assignments.provisioning_outbox TO margin_submission_reviewer;
CREATE POLICY reviewer_launch ON margin_assignments.launch_bindings FOR SELECT TO margin_submission_reviewer USING(session_id=margin_review.ctx('session_id') AND user_id=margin_review.ctx('user_id') AND margin_review.request_active());
CREATE POLICY reviewer_resource ON margin_assignments.resource_links FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_assignments.launch_bindings l WHERE l.installation_id=resource_links.installation_id AND l.resource_digest=resource_links.resource_digest AND l.assignment_id=resource_links.assignment_id));
CREATE FUNCTION margin_review.launched(assignment uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RETURN EXISTS(SELECT 1 FROM margin_assignments.launch_bindings l JOIN margin_assignments.resource_links r ON r.installation_id=l.installation_id AND r.resource_digest=l.resource_digest AND r.assignment_id=l.assignment_id JOIN margin_lms.session_bindings b ON b.session_id=l.session_id AND b.installation_id=r.installation_id AND b.organization_id=r.organization_id AND b.course_id=r.course_id WHERE l.assignment_id=assignment); END $$;
CREATE POLICY reviewer_assignment ON margin_assignments.assignments FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND created_by=margin_review.ctx('user_id') AND selected_at IS NOT NULL AND disabled_at IS NULL AND margin_review.launched(id));
CREATE POLICY reviewer_work ON margin_assignments.student_work FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND status='provisioned' AND EXISTS(SELECT 1 FROM margin_assignments.assignments a JOIN margin_assignments.launch_bindings l ON l.assignment_id=a.id JOIN margin_lms.session_bindings b ON b.session_id=l.session_id WHERE a.id=student_work.assignment_id AND l.resource_digest=student_work.resource_digest AND b.installation_id=student_work.installation_id AND b.course_id=student_work.course_id AND b.registration_version=student_work.registration_version AND b.course_digest=student_work.course_digest));
CREATE POLICY reviewer_provisioning ON margin_assignments.provisioning_outbox FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=work_id));
GRANT SELECT ON margin_work.receipts TO margin_submission_reviewer;
CREATE POLICY reviewer_work_receipt ON margin_work.receipts FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=work_id));
GRANT SELECT(organization_id,id,owner_id,current_version_id,deleted_at,origin,audience) ON margin_sync.documents TO margin_submission_reviewer;
GRANT SELECT ON margin_sync.versions,margin_sync.grants,margin_sync.pages,margin_sync.document_keys TO margin_submission_reviewer;
CREATE POLICY reviewer_document ON margin_sync.documents FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND (EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.source_document_id=documents.id AND a.created_by=documents.owner_id) OR EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=documents.id)));
CREATE POLICY reviewer_version ON margin_sync.versions FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND (EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.source_document_id=versions.document_id AND a.source_version_id=versions.id) OR EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=versions.document_id AND w.version_id=versions.id)));
CREATE POLICY reviewer_grant ON margin_sync.grants FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND (EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.source_document_id=grants.document_id AND a.created_by=grants.user_id) OR EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.document_id=grants.document_id AND w.user_id=grants.user_id)));
GRANT SELECT ON margin_submissions.attempts,margin_submissions.requests,margin_submissions.materialization_receipts,margin_submissions.materialization_chunks TO margin_submission_reviewer;
GRANT SELECT(attempt_id,work_id,phase,created_at,materialization_state,materialization_attempt,claim_id,status_revision,processing_generation,published_error_code,failed_at,materialized_at) ON margin_submissions.outbox TO margin_submission_reviewer;
CREATE POLICY reviewer_attempt ON margin_submissions.attempts FOR SELECT TO margin_submission_reviewer USING(organization_id=margin_review.ctx('organization_id') AND EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=work_id) AND margin_submissions.active(work_id));
CREATE POLICY reviewer_request ON margin_submissions.requests FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=margin_review.ctx('submission_id') AND a.work_id=requests.work_id AND a.request_id=requests.request_id));
CREATE POLICY reviewer_queue ON margin_submissions.outbox FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=attempt_id));
CREATE POLICY reviewer_pages ON margin_sync.pages FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=margin_review.ctx('submission_id') AND a.organization_id=pages.organization_id AND a.document_id=pages.document_id AND a.version_id=pages.version_id));
CREATE POLICY reviewer_key ON margin_sync.document_keys FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_submissions.attempts a WHERE a.id=margin_review.ctx('submission_id') AND a.organization_id=document_keys.organization_id AND a.document_id=document_keys.document_id));
CREATE POLICY reviewer_receipt ON margin_submissions.materialization_receipts FOR SELECT TO margin_submission_reviewer USING(submission_id=margin_review.ctx('submission_id') AND EXISTS(SELECT 1 FROM margin_submissions.outbox j WHERE j.attempt_id=submission_id AND j.materialization_state='completed' AND j.claim_id=materialization_receipts.claim_id AND j.materialization_attempt=materialization_receipts.attempt));
CREATE POLICY reviewer_chunk ON margin_submissions.materialization_chunks FOR SELECT TO margin_submission_reviewer USING(submission_id=margin_review.ctx('submission_id') AND EXISTS(SELECT 1 FROM margin_submissions.materialization_receipts r WHERE r.submission_id=materialization_chunks.submission_id AND r.claim_id=materialization_chunks.claim_id AND r.attempt=materialization_chunks.attempt));
GRANT SELECT ON margin_ingestion.artifacts,margin_ingestion.storage_receipts,margin_ingestion.inspection_jobs,margin_ingestion.inspection_receipts,margin_ingestion.page_geometry TO margin_submission_reviewer;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['artifacts','storage_receipts','inspection_jobs','inspection_receipts','page_geometry'] LOOP
 EXECUTE format('CREATE POLICY reviewer_source ON margin_ingestion.%I FOR SELECT TO margin_submission_reviewer USING(EXISTS(SELECT 1 FROM margin_work.receipts r WHERE r.source_artifact_id=%I.artifact_id))',t,t);
 END LOOP;
END $$;
-- Lock-only UPDATE privileges establish a serial order against revocation; WITH CHECK(false)
-- denies all actual mutation, including no-op writes. No operations/annotations permission exists.
DO $$ DECLARE item text[]; BEGIN
 FOREACH item SLICE 1 IN ARRAY ARRAY[
 ['margin_identity.users','id'],['margin_identity.organizations','id'],['margin_identity.memberships','user_id'],['margin_identity.sessions','id'],['margin_lms.session_bindings','session_id'],['margin_lms.installations','id'],['margin_lms.user_links','user_id'],['margin_lms.courses','course_id'],['margin_lms.enrollments','user_id'],['margin_assignments.assignments','id'],['margin_assignments.launch_bindings','session_id'],['margin_assignments.resource_links','resource_digest'],['margin_assignments.student_work','id'],['margin_assignments.provisioning_outbox','work_id'],['margin_sync.documents','id'],['margin_sync.versions','id'],['margin_sync.grants','user_id'],['margin_sync.pages','id'],['margin_sync.document_keys','document_id'],['margin_ingestion.artifacts','artifact_id'],['margin_ingestion.storage_receipts','artifact_id'],['margin_ingestion.inspection_jobs','artifact_id'],['margin_ingestion.inspection_receipts','id'],['margin_ingestion.page_geometry','scan_receipt_id'],['margin_work.receipts','work_id'],['margin_submissions.requests','request_id'],['margin_submissions.attempts','id']
 ] LOOP
 EXECUTE format('GRANT UPDATE(%I) ON %s TO margin_submission_reviewer',item[2],item[1]);
 EXECUTE format('CREATE POLICY reviewer_lock_only ON %s FOR UPDATE TO margin_submission_reviewer USING(true) WITH CHECK(false)',item[1]);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION margin_review.ctx(text),margin_review.request_active(),margin_review.launched(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION margin_review.ctx(text),margin_review.request_active(),margin_review.launched(uuid),margin_work.active(uuid),margin_submissions.active(uuid),margin_ingestion.active_source(uuid,uuid,uuid,uuid,uuid,uuid,integer),margin_ingestion.ctx(text) TO margin_submission_reviewer;
COMMIT;
