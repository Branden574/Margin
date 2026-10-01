-- Requires identity001, sync002 and LMS003. No approved source or assignment is seeded.
BEGIN;
CREATE SCHEMA margin_assignments;
REVOKE ALL ON SCHEMA margin_assignments FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_assignments_runtime') THEN
  CREATE ROLE margin_assignments_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_assignments_runtime' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Unsafe assignment runtime group'; END IF;
END $$;
CREATE FUNCTION margin_assignments.context_id(k text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_assignments.'||k,true),'')::uuid $$;
CREATE FUNCTION margin_assignments.context_value(k text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_assignments.'||k,true),'') $$;
GRANT USAGE ON SCHEMA margin_identity,margin_lms,margin_sync TO margin_assignments_runtime;
GRANT SELECT(id,disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_assignments_runtime;
GRANT SELECT(organization_id,user_id,role,revoked_at) ON margin_identity.memberships TO margin_assignments_runtime;
GRANT SELECT(id,user_id,organization_id,authentication_method,expires_at,idle_expires_at,revoked_at) ON margin_identity.sessions TO margin_assignments_runtime;
GRANT SELECT(id,organization_id,version,enabled) ON margin_lms.installations TO margin_assignments_runtime;
GRANT SELECT ON margin_lms.session_bindings,margin_lms.enrollments,margin_lms.user_links,margin_lms.courses TO margin_assignments_runtime;
GRANT SELECT(organization_id,id,owner_id,deleted_at) ON margin_sync.documents TO margin_assignments_runtime;
GRANT SELECT ON margin_sync.versions TO margin_assignments_runtime;
CREATE POLICY assignment_identity_user ON margin_identity.users FOR SELECT TO margin_assignments_runtime USING(id=margin_assignments.context_id('user_id'));
CREATE POLICY assignment_identity_org ON margin_identity.organizations FOR SELECT TO margin_assignments_runtime USING(id=margin_assignments.context_id('organization_id'));
CREATE POLICY assignment_identity_member ON margin_identity.memberships FOR SELECT TO margin_assignments_runtime USING(user_id=margin_assignments.context_id('user_id') AND organization_id=margin_assignments.context_id('organization_id'));
CREATE POLICY assignment_identity_session ON margin_identity.sessions FOR SELECT TO margin_assignments_runtime USING(id=margin_assignments.context_id('session_id') AND user_id=margin_assignments.context_id('user_id'));
CREATE POLICY assignment_lms_installation ON margin_lms.installations FOR SELECT TO margin_assignments_runtime USING(id=margin_assignments.context_id('installation_id') AND organization_id=margin_assignments.context_id('organization_id'));
CREATE POLICY assignment_lms_session ON margin_lms.session_bindings FOR SELECT TO margin_assignments_runtime USING(session_id=margin_assignments.context_id('session_id') AND user_id=margin_assignments.context_id('user_id'));
CREATE POLICY assignment_lms_enrollment ON margin_lms.enrollments FOR SELECT TO margin_assignments_runtime USING(installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND user_id=margin_assignments.context_id('user_id'));
CREATE POLICY assignment_lms_user ON margin_lms.user_links FOR SELECT TO margin_assignments_runtime USING(installation_id=margin_assignments.context_id('installation_id') AND user_id=margin_assignments.context_id('user_id'));
CREATE POLICY assignment_lms_course ON margin_lms.courses FOR SELECT TO margin_assignments_runtime USING(installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id'));
CREATE POLICY assignment_source_read ON margin_sync.documents FOR SELECT TO margin_assignments_runtime USING(organization_id=margin_assignments.context_id('organization_id') AND owner_id=margin_assignments.context_id('user_id') AND deleted_at IS NULL);
CREATE POLICY assignment_version_read ON margin_sync.versions FOR SELECT TO margin_assignments_runtime USING(organization_id=margin_assignments.context_id('organization_id') AND EXISTS(SELECT 1 FROM margin_sync.documents d WHERE d.organization_id=versions.organization_id AND d.id=versions.document_id AND d.owner_id=margin_assignments.context_id('user_id') AND d.deleted_at IS NULL));
CREATE FUNCTION margin_assignments.active_role() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT e.role FROM margin_lms.session_bindings b
 JOIN margin_lms.installations i ON i.id=b.installation_id AND i.organization_id=b.organization_id AND i.version=b.registration_version AND i.enabled
 JOIN margin_lms.enrollments e ON e.installation_id=b.installation_id AND e.organization_id=b.organization_id AND e.course_id=b.course_id AND e.user_id=b.user_id AND e.role=b.role AND e.disabled_at IS NULL
 JOIN margin_lms.user_links l ON l.installation_id=b.installation_id AND l.subject_digest=b.subject_digest AND l.user_id=b.user_id AND l.organization_id=b.organization_id AND l.disabled_at IS NULL
 JOIN margin_lms.courses c ON c.installation_id=b.installation_id AND c.external_digest=b.course_digest AND c.course_id=b.course_id AND c.organization_id=b.organization_id AND c.disabled_at IS NULL
 JOIN margin_identity.sessions s ON s.id=b.session_id AND s.user_id=b.user_id AND s.organization_id=b.organization_id AND s.authentication_method='lti' AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
 JOIN margin_identity.memberships m ON m.organization_id=b.organization_id AND m.user_id=b.user_id AND m.role=e.role AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=b.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=b.organization_id AND o.disabled_at IS NULL
 WHERE b.session_id=margin_assignments.context_id('session_id') AND b.user_id=margin_assignments.context_id('user_id') AND b.organization_id=margin_assignments.context_id('organization_id') AND b.installation_id=margin_assignments.context_id('installation_id') AND b.course_id=margin_assignments.context_id('course_id')
$$;
CREATE TABLE margin_assignments.assignments (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,installation_id uuid NOT NULL,course_id uuid NOT NULL,created_by uuid NOT NULL,
 request_id uuid NOT NULL,
 source_document_id uuid NOT NULL,source_version_id uuid NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 32768),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),selected_at timestamptz,disabled_at timestamptz,
 UNIQUE(organization_id,created_by,request_id), UNIQUE(id,organization_id,installation_id,course_id),
 FOREIGN KEY(installation_id,course_id,organization_id) REFERENCES margin_lms.courses(installation_id,course_id,organization_id),
 FOREIGN KEY(organization_id,created_by) REFERENCES margin_identity.memberships(organization_id,user_id),
 FOREIGN KEY(organization_id,source_document_id,source_version_id) REFERENCES margin_sync.versions(organization_id,document_id,id)
);
CREATE TABLE margin_assignments.deep_link_selections (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,installation_id uuid NOT NULL,course_id uuid NOT NULL,user_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES margin_identity.sessions(id),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 32768),nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,selected_assignment_id uuid,
 FOREIGN KEY(installation_id,course_id,organization_id) REFERENCES margin_lms.courses(installation_id,course_id,organization_id),
 FOREIGN KEY(selected_assignment_id,organization_id,installation_id,course_id) REFERENCES margin_assignments.assignments(id,organization_id,installation_id,course_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
);
CREATE INDEX selections_expiry ON margin_assignments.deep_link_selections(expires_at);
CREATE TABLE margin_assignments.resource_links (
 installation_id uuid NOT NULL,resource_digest text NOT NULL CHECK(resource_digest ~ '^[a-f0-9]{64}$'),organization_id uuid NOT NULL,course_id uuid NOT NULL,assignment_id uuid NOT NULL,
 PRIMARY KEY(installation_id,resource_digest),UNIQUE(installation_id,resource_digest,assignment_id),
 FOREIGN KEY(assignment_id,organization_id,installation_id,course_id) REFERENCES margin_assignments.assignments(id,organization_id,installation_id,course_id)
);
CREATE TABLE margin_assignments.launch_bindings (
 session_id uuid PRIMARY KEY REFERENCES margin_identity.sessions(id),installation_id uuid NOT NULL,resource_digest text NOT NULL,assignment_id uuid NOT NULL,user_id uuid NOT NULL,
 FOREIGN KEY(installation_id,resource_digest,assignment_id) REFERENCES margin_assignments.resource_links(installation_id,resource_digest,assignment_id)
);
CREATE TABLE margin_assignments.student_work (
 id uuid PRIMARY KEY,assignment_id uuid NOT NULL,organization_id uuid NOT NULL,installation_id uuid NOT NULL,course_id uuid NOT NULL,user_id uuid NOT NULL,
 document_id uuid NOT NULL UNIQUE,version_id uuid NOT NULL UNIQUE,status text NOT NULL DEFAULT 'pending' CHECK(status='pending'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(assignment_id,user_id),
 FOREIGN KEY(assignment_id,organization_id,installation_id,course_id) REFERENCES margin_assignments.assignments(id,organization_id,installation_id,course_id),
 FOREIGN KEY(organization_id,user_id) REFERENCES margin_identity.memberships(organization_id,user_id)
);
CREATE TABLE margin_assignments.provisioning_outbox (
 work_id uuid PRIMARY KEY REFERENCES margin_assignments.student_work(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['assignments','deep_link_selections','resource_links','launch_bindings','student_work','provisioning_outbox'] LOOP EXECUTE format('ALTER TABLE margin_assignments.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE margin_assignments.%I FORCE ROW LEVEL SECURITY',t);END LOOP;
END $$;
CREATE POLICY assignment_read ON margin_assignments.assignments FOR SELECT TO margin_assignments_runtime USING(organization_id=margin_assignments.context_id('organization_id') AND installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND disabled_at IS NULL AND ((margin_assignments.active_role()='teacher' AND created_by=margin_assignments.context_id('user_id')) OR (margin_assignments.active_role() IN ('student','viewer') AND selected_at IS NOT NULL AND (id=margin_assignments.context_id('verified_assignment_id') OR EXISTS(SELECT 1 FROM margin_assignments.launch_bindings b WHERE b.session_id=margin_assignments.context_id('session_id') AND b.user_id=margin_assignments.context_id('user_id') AND b.assignment_id=assignments.id)))));
CREATE POLICY assignment_create ON margin_assignments.assignments FOR INSERT TO margin_assignments_runtime WITH CHECK(organization_id=margin_assignments.context_id('organization_id') AND installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND created_by=margin_assignments.context_id('user_id') AND margin_assignments.active_role()='teacher' AND EXISTS(SELECT 1 FROM margin_sync.documents d WHERE d.organization_id=assignments.organization_id AND d.id=assignments.source_document_id AND d.owner_id=assignments.created_by AND d.deleted_at IS NULL));
CREATE POLICY assignment_select ON margin_assignments.assignments FOR UPDATE TO margin_assignments_runtime USING(created_by=margin_assignments.context_id('user_id') AND margin_assignments.active_role()='teacher') WITH CHECK(created_by=margin_assignments.context_id('user_id') AND margin_assignments.active_role()='teacher');
CREATE POLICY selection_read ON margin_assignments.deep_link_selections FOR SELECT TO margin_assignments_runtime USING(session_id=margin_assignments.context_id('session_id') AND user_id=margin_assignments.context_id('user_id') AND margin_assignments.active_role()='teacher');
CREATE POLICY selection_insert ON margin_assignments.deep_link_selections FOR INSERT TO margin_assignments_runtime WITH CHECK(session_id=margin_assignments.context_id('session_id') AND user_id=margin_assignments.context_id('user_id') AND organization_id=margin_assignments.context_id('organization_id') AND installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND margin_assignments.active_role()='teacher');
CREATE POLICY selection_consume ON margin_assignments.deep_link_selections FOR UPDATE TO margin_assignments_runtime USING(session_id=margin_assignments.context_id('session_id') AND margin_assignments.active_role()='teacher') WITH CHECK(session_id=margin_assignments.context_id('session_id') AND margin_assignments.active_role()='teacher');
CREATE POLICY resource_read ON margin_assignments.resource_links FOR SELECT TO margin_assignments_runtime USING(installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND resource_digest=margin_assignments.context_value('resource_digest') AND margin_assignments.active_role() IS NOT NULL);
CREATE POLICY resource_insert ON margin_assignments.resource_links FOR INSERT TO margin_assignments_runtime WITH CHECK(installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND organization_id=margin_assignments.context_id('organization_id') AND resource_digest=margin_assignments.context_value('resource_digest') AND margin_assignments.active_role() IS NOT NULL AND EXISTS(SELECT 1 FROM margin_assignments.assignments a WHERE a.id=assignment_id AND a.selected_at IS NOT NULL));
CREATE POLICY launch_read ON margin_assignments.launch_bindings FOR SELECT TO margin_assignments_runtime USING(session_id=margin_assignments.context_id('session_id') AND user_id=margin_assignments.context_id('user_id') AND margin_assignments.active_role() IS NOT NULL);
CREATE POLICY launch_insert ON margin_assignments.launch_bindings FOR INSERT TO margin_assignments_runtime WITH CHECK(session_id=margin_assignments.context_id('session_id') AND user_id=margin_assignments.context_id('user_id') AND installation_id=margin_assignments.context_id('installation_id') AND margin_assignments.active_role() IS NOT NULL);
CREATE POLICY work_read ON margin_assignments.student_work FOR SELECT TO margin_assignments_runtime USING(user_id=margin_assignments.context_id('user_id') AND organization_id=margin_assignments.context_id('organization_id') AND installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND margin_assignments.active_role()='student');
CREATE POLICY work_insert ON margin_assignments.student_work FOR INSERT TO margin_assignments_runtime WITH CHECK(user_id=margin_assignments.context_id('user_id') AND organization_id=margin_assignments.context_id('organization_id') AND installation_id=margin_assignments.context_id('installation_id') AND course_id=margin_assignments.context_id('course_id') AND margin_assignments.active_role()='student' AND EXISTS(SELECT 1 FROM margin_assignments.launch_bindings b WHERE b.session_id=margin_assignments.context_id('session_id') AND b.assignment_id=student_work.assignment_id));
CREATE POLICY outbox_read ON margin_assignments.provisioning_outbox FOR SELECT TO margin_assignments_runtime USING(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=work_id));
CREATE POLICY outbox_insert ON margin_assignments.provisioning_outbox FOR INSERT TO margin_assignments_runtime WITH CHECK(EXISTS(SELECT 1 FROM margin_assignments.student_work w WHERE w.id=work_id));
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA margin_assignments FROM PUBLIC;
GRANT USAGE ON SCHEMA margin_assignments TO margin_assignments_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA margin_assignments TO margin_assignments_runtime;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA margin_assignments TO margin_assignments_runtime;
GRANT UPDATE(selected_at) ON margin_assignments.assignments TO margin_assignments_runtime;
GRANT UPDATE(consumed_at,selected_assignment_id) ON margin_assignments.deep_link_selections TO margin_assignments_runtime;
COMMIT;
-- Student work remains honestly pending until a separate trusted, idempotent sync-provisioning worker is implemented.
-- No runtime user can mark inspection ready, change a master, mutate assignment content, or mark work provisioned.
