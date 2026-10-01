-- Margin production schema proposal for PostgreSQL 16+. NOT wired to the local API.
-- Apply with a migration owner. Runtime MUST NOT be superuser, table owner or BYPASSRLS.
-- A trusted API verifies OIDC + membership before SET LOCAL app.organization_id,
-- app.user_id, app.role on every transaction. Never accept those values from client headers.
-- Connection pools must use transactions and SET LOCAL (never persistent SET).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS margin;
SET search_path = margin, public;
CREATE FUNCTION margin.organization_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;
CREATE FUNCTION margin.user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION margin.current_role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.role', true), '') $$;
CREATE FUNCTION margin.can_manage() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(margin.current_role() IN ('owner', 'admin'), false) $$;
CREATE FUNCTION margin.can_teach() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(margin.current_role() IN ('owner', 'admin', 'teacher'), false) $$;
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), retention_days integer CHECK (retention_days > 0)
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), oidc_issuer text NOT NULL,
  oidc_subject text NOT NULL, display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(oidc_issuer, oidc_subject)
);
CREATE TABLE memberships (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'teacher', 'student', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, user_id), UNIQUE(organization_id, id)
);
CREATE TABLE schools (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, PRIMARY KEY(organization_id, id)
);
CREATE TABLE classes (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  school_id uuid, teacher_id uuid NOT NULL, name text NOT NULL, PRIMARY KEY(organization_id, id),
  FOREIGN KEY(organization_id, school_id) REFERENCES schools(organization_id, id),
  FOREIGN KEY(organization_id, teacher_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE class_memberships (
  organization_id uuid NOT NULL, class_id uuid NOT NULL, user_id uuid NOT NULL,
  PRIMARY KEY(organization_id, class_id, user_id),
  FOREIGN KEY(organization_id, class_id) REFERENCES classes(organization_id, id),
  FOREIGN KEY(organization_id, user_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  owner_id uuid NOT NULL, name text NOT NULL, mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size > 0),
  object_key text NOT NULL, sha256 char(64) NOT NULL, state text NOT NULL CHECK(state IN ('quarantined', 'processing', 'ready', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id, id), UNIQUE(organization_id, object_key),
  FOREIGN KEY(organization_id, owner_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE document_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, document_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision >= 0), snapshot_object_key text, operation_cursor bigint,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, id),
  UNIQUE(organization_id, document_id, revision),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id),
  FOREIGN KEY(organization_id, created_by) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE pages (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, document_id uuid NOT NULL,
  page_index integer NOT NULL CHECK(page_index >= 0), width real NOT NULL CHECK(width > 0), height real NOT NULL CHECK(height > 0),
  rotation smallint NOT NULL DEFAULT 0 CHECK(rotation IN (0,90,180,270)), text_object_key text,
  PRIMARY KEY(organization_id, id), UNIQUE(organization_id, document_id, page_index), UNIQUE(organization_id, document_id, id),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id)
);
CREATE TABLE annotations (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, document_id uuid NOT NULL,
  page_id uuid NOT NULL, author_id uuid NOT NULL, kind text NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  revision bigint NOT NULL DEFAULT 0, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id, id),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id),
  FOREIGN KEY(organization_id, document_id, page_id) REFERENCES pages(organization_id, document_id, id),
  FOREIGN KEY(organization_id, author_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE annotation_operations (
  id uuid NOT NULL, organization_id uuid NOT NULL, document_id uuid NOT NULL, actor_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY, operation jsonb NOT NULL CHECK(jsonb_typeof(operation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, id), UNIQUE(organization_id, document_id, sequence),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id),
  FOREIGN KEY(organization_id, actor_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, document_id uuid NOT NULL,
  author_id uuid NOT NULL, parent_id uuid, body text NOT NULL, teacher_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, id), UNIQUE(organization_id, document_id, id),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id),
  FOREIGN KEY(organization_id, author_id) REFERENCES memberships(organization_id, user_id),
  FOREIGN KEY(organization_id, document_id, parent_id) REFERENCES comments(organization_id, document_id, id)
);
CREATE TABLE assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, class_id uuid NOT NULL,
  document_id uuid NOT NULL, teacher_id uuid NOT NULL, title text NOT NULL, instructions text NOT NULL DEFAULT '',
  due_at timestamptz, status text NOT NULL CHECK(status IN ('draft', 'assigned', 'closed')), controls jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(organization_id, id), FOREIGN KEY(organization_id, class_id) REFERENCES classes(organization_id, id),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id),
  FOREIGN KEY(organization_id, teacher_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, assignment_id uuid NOT NULL,
  student_id uuid NOT NULL, document_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('draft', 'submitted', 'returned')), submitted_at timestamptz, feedback text,
  PRIMARY KEY(organization_id, id), UNIQUE(organization_id, assignment_id, student_id),
  FOREIGN KEY(organization_id, assignment_id) REFERENCES assignments(organization_id, id),
  FOREIGN KEY(organization_id, student_id) REFERENCES memberships(organization_id, user_id),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id)
);
CREATE TABLE upload_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, owner_id uuid NOT NULL,
  document_id uuid, idempotency_key text NOT NULL, storage_upload_id text NOT NULL,
  expected_bytes bigint NOT NULL CHECK(expected_bytes > 0), part_size integer NOT NULL CHECK(part_size > 0),
  verified_parts jsonb NOT NULL DEFAULT '{}', state text NOT NULL CHECK(state IN ('uploading', 'verifying', 'processing', 'complete', 'aborted', 'failed')),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, id), UNIQUE(organization_id, idempotency_key),
  FOREIGN KEY(organization_id, owner_id) REFERENCES memberships(organization_id, user_id),
  FOREIGN KEY(organization_id, document_id) REFERENCES documents(organization_id, id)
);
CREATE TABLE integration_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL, external_tenant_id text, encrypted_secret_reference text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, id)
);
CREATE TABLE audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid, action text NOT NULL, entity_id uuid, correlation_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id, id)
);
CREATE TABLE feature_flags (
  id uuid NOT NULL DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, enabled boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL CHECK(scope_type IN ('organization', 'school', 'class', 'user')), scope_id uuid,
  PRIMARY KEY(organization_id, id),
  CHECK((scope_type = 'organization' AND scope_id IS NULL) OR (scope_type <> 'organization' AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX feature_flags_scope ON feature_flags(organization_id, name, scope_type, scope_id) NULLS NOT DISTINCT;
CREATE INDEX documents_owner ON documents(organization_id, owner_id, updated_at DESC);
CREATE INDEX annotations_document ON annotations(organization_id, document_id, updated_at);
CREATE INDEX comments_document ON comments(organization_id, document_id, created_at);
CREATE INDEX uploads_expiry ON upload_sessions(expires_at) WHERE state = 'uploading';
CREATE INDEX audit_logs_time ON audit_logs(organization_id, created_at DESC);

-- Tenant isolation is restrictive and cannot be bypassed by a permissive role policy.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','schools','classes','class_memberships','documents','document_versions','pages','annotations','annotation_operations','comments','assignments','submissions','upload_sessions','integration_connections','audit_logs','feature_flags'] LOOP
    EXECUTE format('ALTER TABLE margin.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE margin.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_boundary ON margin.%I AS RESTRICTIVE FOR ALL USING (organization_id = margin.organization_id()) WITH CHECK (organization_id = margin.organization_id())', t);
  END LOOP;
END $$;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_read ON organizations FOR SELECT USING(id = margin.organization_id());
CREATE POLICY organization_update ON organizations FOR UPDATE USING(id = margin.organization_id() AND margin.can_manage()) WITH CHECK(id = margin.organization_id() AND margin.can_manage());
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_read ON users FOR SELECT USING(id = margin.user_id());
CREATE POLICY user_update ON users FOR UPDATE USING(id = margin.user_id()) WITH CHECK(id = margin.user_id());

-- Deny-by-default skeleton: do not add an all-tenant-content SELECT policy.
-- A member can access their own upload/document; sharing must be explicitly modeled before enabling it.
CREATE POLICY membership_read ON memberships FOR SELECT USING(user_id = margin.user_id() OR margin.can_manage());
CREATE POLICY membership_manage ON memberships FOR ALL USING(margin.can_manage()) WITH CHECK(margin.can_manage());
CREATE POLICY school_admin ON schools FOR ALL USING(margin.can_manage()) WITH CHECK(margin.can_manage());
CREATE POLICY class_teacher ON classes FOR ALL USING(teacher_id = margin.user_id() AND margin.can_teach()) WITH CHECK(teacher_id = margin.user_id() AND margin.can_teach());
CREATE POLICY class_membership_teacher ON class_memberships FOR ALL USING(EXISTS(SELECT 1 FROM classes c WHERE c.organization_id = class_memberships.organization_id AND c.id = class_memberships.class_id)) WITH CHECK(EXISTS(SELECT 1 FROM classes c WHERE c.organization_id = class_memberships.organization_id AND c.id = class_memberships.class_id));
CREATE POLICY document_owner ON documents FOR ALL USING(owner_id = margin.user_id()) WITH CHECK(owner_id = margin.user_id());
CREATE POLICY upload_owner ON upload_sessions FOR ALL USING(owner_id = margin.user_id()) WITH CHECK(owner_id = margin.user_id());
CREATE POLICY version_owner ON document_versions FOR ALL USING(EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = document_versions.organization_id AND d.id = document_versions.document_id)) WITH CHECK(created_by = margin.user_id() AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = document_versions.organization_id AND d.id = document_versions.document_id));
CREATE POLICY page_owner ON pages FOR ALL USING(EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = pages.organization_id AND d.id = pages.document_id)) WITH CHECK(EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = pages.organization_id AND d.id = pages.document_id));
CREATE POLICY annotation_owner ON annotations FOR ALL USING(author_id = margin.user_id() AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = annotations.organization_id AND d.id = annotations.document_id)) WITH CHECK(author_id = margin.user_id() AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = annotations.organization_id AND d.id = annotations.document_id));
CREATE POLICY operation_read ON annotation_operations FOR SELECT USING(EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = annotation_operations.organization_id AND d.id = annotation_operations.document_id));
CREATE POLICY operation_append ON annotation_operations FOR INSERT WITH CHECK(actor_id = margin.user_id() AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = annotation_operations.organization_id AND d.id = annotation_operations.document_id));
CREATE POLICY comment_owner ON comments FOR ALL USING(author_id = margin.user_id() AND (NOT teacher_only OR margin.can_teach()) AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = comments.organization_id AND d.id = comments.document_id)) WITH CHECK(author_id = margin.user_id() AND (NOT teacher_only OR margin.can_teach()) AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = comments.organization_id AND d.id = comments.document_id));
CREATE POLICY assignment_teacher ON assignments FOR ALL USING(teacher_id = margin.user_id() AND margin.can_teach()) WITH CHECK(teacher_id = margin.user_id() AND margin.can_teach() AND EXISTS(SELECT 1 FROM documents d WHERE d.organization_id = assignments.organization_id AND d.id = assignments.document_id) AND EXISTS(SELECT 1 FROM classes c WHERE c.organization_id = assignments.organization_id AND c.id = assignments.class_id));
-- Submissions deliberately have no permissive policy until teacher/class/document grants are integrated.
CREATE POLICY integration_admin ON integration_connections FOR ALL USING(margin.can_manage()) WITH CHECK(margin.can_manage());
CREATE POLICY audit_read ON audit_logs FOR SELECT USING(margin.can_manage());
CREATE POLICY audit_append ON audit_logs FOR INSERT WITH CHECK(actor_id = margin.user_id());
CREATE POLICY flags_admin ON feature_flags FOR ALL USING(margin.can_manage()) WITH CHECK(margin.can_manage());
COMMIT;
-- Provisioning organizations/users requires a separate trusted administration role.
-- Runtime GRANTs, column privileges, document grants, object-storage policy and integration
-- tests are deployment gates. No SQL grants or production credentials are included here.
