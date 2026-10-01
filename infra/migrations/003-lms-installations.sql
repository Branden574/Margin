-- Requires 001-identity.sql. Execute as the separate migration owner, never the API login.
-- No installations, links, users or enrollments are seeded. Provisioning is an explicit trusted task.
BEGIN;
CREATE SCHEMA margin_lms;
REVOKE ALL ON SCHEMA margin_lms FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['margin_lms_runtime','margin_lms_provisioner'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',role_name);
    ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN
      RAISE EXCEPTION 'Existing LMS role has unsafe privileges';
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION margin_lms.context_value(setting_name text) RETURNS text LANGUAGE sql STABLE
  SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_lms.' || setting_name,true),'') $$;
CREATE FUNCTION margin_lms.context_id(setting_name text) RETURNS uuid LANGUAGE sql STABLE
  SET search_path=pg_catalog AS $$ SELECT margin_lms.context_value(setting_name)::uuid $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA margin_lms FROM PUBLIC;
CREATE TABLE margin_lms.installations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES margin_identity.organizations(id),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 2048),
  deployment_id text NOT NULL CHECK(length(deployment_id) BETWEEN 1 AND 2048),
  version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL DEFAULT false,
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issuer,client_id,deployment_id), UNIQUE(id,organization_id)
);
CREATE FUNCTION margin_lms.protect_registration() RETURNS trigger LANGUAGE plpgsql
  SET search_path=pg_catalog AS $$ BEGIN
  IF (NEW.id,NEW.organization_id,NEW.issuer,NEW.client_id,NEW.deployment_id) IS DISTINCT FROM
     (OLD.id,OLD.organization_id,OLD.issuer,OLD.client_id,OLD.deployment_id) OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'LMS identity tuples are immutable and changes must increment version';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION margin_lms.protect_registration() FROM PUBLIC;
CREATE TRIGGER protect_registration BEFORE UPDATE ON margin_lms.installations FOR EACH ROW EXECUTE FUNCTION margin_lms.protect_registration();
CREATE TABLE margin_lms.launch_attempts (
  state_digest text PRIMARY KEY CHECK(state_digest ~ '^[a-f0-9]{64}$'),
  installation_id uuid NOT NULL REFERENCES margin_lms.installations(id), registration_version integer NOT NULL CHECK(registration_version>0),
  nonce_digest text NOT NULL CHECK(nonce_digest ~ '^[a-f0-9]{64}$'),
  browser_binding_digest text NOT NULL CHECK(browser_binding_digest ~ '^[a-f0-9]{64}$'),
  target_uri text NOT NULL CHECK(length(target_uri) BETWEEN 1 AND 2048),
  message_type text NOT NULL CHECK(message_type IN ('LtiResourceLinkRequest','LtiDeepLinkingRequest')),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
CREATE INDEX launch_attempts_expiry ON margin_lms.launch_attempts(expires_at);
CREATE TABLE margin_lms.nonce_receipts (
  installation_id uuid NOT NULL REFERENCES margin_lms.installations(id),
  nonce_digest text NOT NULL CHECK(nonce_digest ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL,
  PRIMARY KEY(installation_id,nonce_digest)
);
CREATE INDEX nonce_receipts_expiry ON margin_lms.nonce_receipts(expires_at);
CREATE TABLE margin_lms.user_links (
  installation_id uuid NOT NULL, organization_id uuid NOT NULL,
  subject_digest text NOT NULL CHECK(subject_digest ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL, disabled_at timestamptz,
  PRIMARY KEY(installation_id,subject_digest), UNIQUE(installation_id,user_id),
  FOREIGN KEY(installation_id,organization_id) REFERENCES margin_lms.installations(id,organization_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES margin_identity.memberships(organization_id,user_id)
);
CREATE TABLE margin_lms.courses (
  installation_id uuid NOT NULL, organization_id uuid NOT NULL,
  external_digest text NOT NULL CHECK(external_digest ~ '^[a-f0-9]{64}$'),
  course_id uuid NOT NULL, disabled_at timestamptz,
  PRIMARY KEY(installation_id,external_digest), UNIQUE(installation_id,course_id,organization_id),
  FOREIGN KEY(installation_id,organization_id) REFERENCES margin_lms.installations(id,organization_id)
);
CREATE TABLE margin_lms.enrollments (
  installation_id uuid NOT NULL, organization_id uuid NOT NULL, course_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('student','teacher','viewer')), disabled_at timestamptz,
  PRIMARY KEY(installation_id,course_id,user_id),
  FOREIGN KEY(installation_id,course_id,organization_id) REFERENCES margin_lms.courses(installation_id,course_id,organization_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES margin_identity.memberships(organization_id,user_id),
  FOREIGN KEY(installation_id,user_id) REFERENCES margin_lms.user_links(installation_id,user_id)
);
CREATE TABLE margin_lms.session_bindings (
  session_id uuid PRIMARY KEY REFERENCES margin_identity.sessions(id),
  installation_id uuid NOT NULL, registration_version integer NOT NULL CHECK(registration_version>0),
  organization_id uuid NOT NULL, user_id uuid NOT NULL, course_id uuid NOT NULL,
  subject_digest text NOT NULL, course_digest text NOT NULL,
  role text NOT NULL CHECK(role IN ('student','teacher','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(installation_id,organization_id) REFERENCES margin_lms.installations(id,organization_id),
  FOREIGN KEY(installation_id,subject_digest) REFERENCES margin_lms.user_links(installation_id,subject_digest),
  FOREIGN KEY(installation_id,course_digest) REFERENCES margin_lms.courses(installation_id,external_digest),
  FOREIGN KEY(installation_id,course_id,user_id) REFERENCES margin_lms.enrollments(installation_id,course_id,user_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['installations','launch_attempts','nonce_receipts','user_links','courses','enrollments','session_bindings'] LOOP
    EXECUTE format('ALTER TABLE margin_lms.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE margin_lms.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['installations','user_links','courses','enrollments'] LOOP
    EXECUTE format('CREATE POLICY provision_read ON margin_lms.%I FOR SELECT TO margin_lms_provisioner USING(true)',t);
    EXECUTE format('CREATE POLICY provision_insert ON margin_lms.%I FOR INSERT TO margin_lms_provisioner WITH CHECK(true)',t);
    EXECUTE format('CREATE POLICY provision_update ON margin_lms.%I FOR UPDATE TO margin_lms_provisioner USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
CREATE POLICY binding_read ON margin_lms.session_bindings FOR SELECT TO margin_lms_runtime USING(session_id=margin_lms.context_id('session_id'));
CREATE POLICY binding_insert ON margin_lms.session_bindings FOR INSERT TO margin_lms_runtime WITH CHECK(session_id=margin_lms.context_id('session_id') AND installation_id=margin_lms.context_id('installation_id') AND user_id=margin_lms.context_id('user_id'));
CREATE POLICY lms_session_read ON margin_identity.sessions FOR SELECT TO margin_lms_runtime USING(id=margin_lms.context_id('session_id') AND user_id=margin_lms.context_id('user_id'));
CREATE POLICY installation_read ON margin_lms.installations FOR SELECT TO margin_lms_runtime
 USING(id=margin_lms.context_id('installation_id'));
CREATE POLICY attempt_read ON margin_lms.launch_attempts FOR SELECT TO margin_lms_runtime USING(state_digest=margin_lms.context_value('state_digest'));
CREATE POLICY attempt_insert ON margin_lms.launch_attempts FOR INSERT TO margin_lms_runtime WITH CHECK(state_digest=margin_lms.context_value('state_digest') AND installation_id=margin_lms.context_id('installation_id'));
CREATE POLICY attempt_consume ON margin_lms.launch_attempts FOR UPDATE TO margin_lms_runtime USING(state_digest=margin_lms.context_value('state_digest')) WITH CHECK(state_digest=margin_lms.context_value('state_digest'));
CREATE POLICY nonce_read ON margin_lms.nonce_receipts FOR SELECT TO margin_lms_runtime USING(installation_id=margin_lms.context_id('installation_id') AND nonce_digest=margin_lms.context_value('nonce_digest'));
CREATE POLICY nonce_insert ON margin_lms.nonce_receipts FOR INSERT TO margin_lms_runtime WITH CHECK(installation_id=margin_lms.context_id('installation_id') AND nonce_digest=margin_lms.context_value('nonce_digest'));
CREATE POLICY link_read ON margin_lms.user_links FOR SELECT TO margin_lms_runtime USING(installation_id=margin_lms.context_id('installation_id') AND subject_digest=margin_lms.context_value('subject_digest'));
CREATE POLICY course_read ON margin_lms.courses FOR SELECT TO margin_lms_runtime USING(installation_id=margin_lms.context_id('installation_id') AND external_digest=margin_lms.context_value('course_digest'));
CREATE POLICY enrollment_read ON margin_lms.enrollments FOR SELECT TO margin_lms_runtime USING(installation_id=margin_lms.context_id('installation_id') AND user_id=margin_lms.context_id('user_id') AND course_id=margin_lms.context_id('course_id'));
-- Only the linked user and organization become visible during server-controlled enrollment resolution.
CREATE POLICY lms_user_read ON margin_identity.users FOR SELECT TO margin_lms_runtime USING(id=margin_lms.context_id('user_id'));
CREATE POLICY lms_org_read ON margin_identity.organizations FOR SELECT TO margin_lms_runtime USING(id=margin_lms.context_id('organization_id'));
CREATE POLICY lms_membership_read ON margin_identity.memberships FOR SELECT TO margin_lms_runtime USING(user_id=margin_lms.context_id('user_id') AND organization_id=margin_lms.context_id('organization_id'));
GRANT USAGE ON SCHEMA margin_lms TO margin_lms_runtime,margin_lms_provisioner;
GRANT EXECUTE ON FUNCTION margin_lms.context_value(text),margin_lms.context_id(text) TO margin_lms_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA margin_lms TO margin_lms_runtime;
GRANT INSERT ON margin_lms.launch_attempts,margin_lms.nonce_receipts,margin_lms.session_bindings TO margin_lms_runtime;
GRANT UPDATE(consumed_at) ON margin_lms.launch_attempts TO margin_lms_runtime;
GRANT USAGE ON SCHEMA margin_identity TO margin_lms_runtime;
GRANT SELECT ON margin_identity.users,margin_identity.organizations,margin_identity.memberships,margin_identity.sessions TO margin_lms_runtime;
GRANT SELECT,INSERT ON margin_lms.installations,margin_lms.user_links,margin_lms.courses,margin_lms.enrollments TO margin_lms_provisioner;
GRANT UPDATE(version,enabled,configuration) ON margin_lms.installations TO margin_lms_provisioner;
GRANT UPDATE(disabled_at) ON margin_lms.user_links,margin_lms.courses TO margin_lms_provisioner;
GRANT UPDATE(role,disabled_at) ON margin_lms.enrollments TO margin_lms_provisioner;
COMMIT;
-- Maintenance owner must purge expired launch_attempts/nonce_receipts; runtime cannot read/delete all receipts.
-- Runtime cannot provision or relink identities. Enrollment requires an existing identity membership.
