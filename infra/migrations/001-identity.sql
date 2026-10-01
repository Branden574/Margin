-- Apply once with a migration owner that can create roles. No accounts or sample memberships are seeded.
-- Separate from the disconnected infra/schema.sql proposal. Runtime is NOT the migration owner.
BEGIN;
CREATE SCHEMA margin_identity;
REVOKE ALL ON SCHEMA margin_identity FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_identity_runtime') THEN
    CREATE ROLE margin_identity_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_identity_runtime' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Existing identity runtime group has unsafe privileges';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_identity_provisioner') THEN
    CREATE ROLE margin_identity_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='margin_identity_provisioner' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Existing identity provisioning group has unsafe privileges';
  END IF;
END $$;
CREATE FUNCTION margin_identity.context_user() RETURNS uuid LANGUAGE sql STABLE
  SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_identity.user_id',true),'')::uuid $$;
CREATE FUNCTION margin_identity.context_value(setting_name text) RETURNS text LANGUAGE sql STABLE
  SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_identity.' || setting_name,true),'') $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA margin_identity FROM PUBLIC;
CREATE TABLE margin_identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_key text NOT NULL UNIQUE CHECK(identity_key ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
);
CREATE TABLE margin_identity.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
);
CREATE TABLE margin_identity.memberships (
  organization_id uuid NOT NULL REFERENCES margin_identity.organizations(id),
  user_id uuid NOT NULL REFERENCES margin_identity.users(id),
  role text NOT NULL CHECK(role IN ('student','teacher','viewer','school_admin','district_admin','owner','support','system_admin')),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX memberships_user ON margin_identity.memberships(user_id,organization_id);
CREATE TABLE margin_identity.login_attempts (
  state_hash text PRIMARY KEY CHECK(state_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX login_attempts_expiry ON margin_identity.login_attempts(expires_at);
CREATE TABLE margin_identity.sessions (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL UNIQUE CHECK(session_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES margin_identity.users(id),
  organization_id uuid NOT NULL REFERENCES margin_identity.organizations(id),
  mfa boolean NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  authentication_method text NOT NULL DEFAULT 'oidc' CHECK(authentication_method IN ('oidc','lti')),
  idle_expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, revoked_at timestamptz,
  FOREIGN KEY(organization_id,user_id) REFERENCES margin_identity.memberships(organization_id,user_id),
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CHECK(idle_expires_at <= expires_at AND last_seen_at >= created_at)
);
CREATE INDEX sessions_user ON margin_identity.sessions(user_id,created_at DESC);
CREATE INDEX sessions_expiry ON margin_identity.sessions(expires_at);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','organizations','memberships','login_attempts','sessions'] LOOP
    EXECUTE format('ALTER TABLE margin_identity.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE margin_identity.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
CREATE POLICY identity_user_read ON margin_identity.users FOR SELECT TO margin_identity_runtime
  USING(id=margin_identity.context_user() OR identity_key=margin_identity.context_value('identity_key'));
CREATE POLICY identity_membership_read ON margin_identity.memberships FOR SELECT TO margin_identity_runtime
  USING(user_id=margin_identity.context_user());
CREATE POLICY identity_organization_read ON margin_identity.organizations FOR SELECT TO margin_identity_runtime
  USING(EXISTS(SELECT 1 FROM margin_identity.memberships m WHERE m.organization_id=id AND m.user_id=margin_identity.context_user() AND m.revoked_at IS NULL));
CREATE POLICY identity_login_read ON margin_identity.login_attempts FOR SELECT TO margin_identity_runtime
  USING(state_hash=margin_identity.context_value('login_hash'));
CREATE POLICY identity_login_insert ON margin_identity.login_attempts FOR INSERT TO margin_identity_runtime
  WITH CHECK(state_hash=margin_identity.context_value('login_hash'));
CREATE POLICY identity_login_consume ON margin_identity.login_attempts FOR UPDATE TO margin_identity_runtime
  USING(state_hash=margin_identity.context_value('login_hash')) WITH CHECK(state_hash=margin_identity.context_value('login_hash'));
CREATE POLICY identity_session_read ON margin_identity.sessions FOR SELECT TO margin_identity_runtime
  USING(session_hash=margin_identity.context_value('session_hash') OR user_id=margin_identity.context_user());
CREATE POLICY identity_session_insert ON margin_identity.sessions FOR INSERT TO margin_identity_runtime
  WITH CHECK(user_id=margin_identity.context_user() AND session_hash=margin_identity.context_value('session_hash') AND EXISTS(
    SELECT 1 FROM margin_identity.memberships m JOIN margin_identity.users u ON u.id=m.user_id JOIN margin_identity.organizations o ON o.id=m.organization_id
    WHERE m.user_id=sessions.user_id AND m.organization_id=sessions.organization_id AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND o.disabled_at IS NULL));
CREATE POLICY identity_session_update ON margin_identity.sessions FOR UPDATE TO margin_identity_runtime
  USING(session_hash=margin_identity.context_value('session_hash') OR user_id=margin_identity.context_user())
  WITH CHECK(session_hash=margin_identity.context_value('session_hash') OR user_id=margin_identity.context_user());
-- Trusted control-plane/operator credentials only. Never grant this group to the application login.
CREATE POLICY provision_users_read ON margin_identity.users FOR SELECT TO margin_identity_provisioner USING(true);
CREATE POLICY provision_users_insert ON margin_identity.users FOR INSERT TO margin_identity_provisioner WITH CHECK(true);
CREATE POLICY provision_users_update ON margin_identity.users FOR UPDATE TO margin_identity_provisioner USING(true) WITH CHECK(true);
CREATE POLICY provision_org_read ON margin_identity.organizations FOR SELECT TO margin_identity_provisioner USING(true);
CREATE POLICY provision_org_insert ON margin_identity.organizations FOR INSERT TO margin_identity_provisioner WITH CHECK(true);
CREATE POLICY provision_org_update ON margin_identity.organizations FOR UPDATE TO margin_identity_provisioner USING(true) WITH CHECK(true);
CREATE POLICY provision_member_read ON margin_identity.memberships FOR SELECT TO margin_identity_provisioner USING(true);
CREATE POLICY provision_member_insert ON margin_identity.memberships FOR INSERT TO margin_identity_provisioner WITH CHECK(true);
CREATE POLICY provision_member_update ON margin_identity.memberships FOR UPDATE TO margin_identity_provisioner USING(true) WITH CHECK(true);
CREATE POLICY provision_session_read ON margin_identity.sessions FOR SELECT TO margin_identity_provisioner USING(true);
CREATE POLICY provision_session_revoke ON margin_identity.sessions FOR UPDATE TO margin_identity_provisioner USING(true) WITH CHECK(true);
GRANT USAGE ON SCHEMA margin_identity TO margin_identity_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA margin_identity TO margin_identity_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA margin_identity TO margin_identity_runtime;
GRANT INSERT ON margin_identity.login_attempts,margin_identity.sessions TO margin_identity_runtime;
GRANT UPDATE(consumed_at) ON margin_identity.login_attempts TO margin_identity_runtime;
GRANT UPDATE(revoked_at,last_seen_at,idle_expires_at) ON margin_identity.sessions TO margin_identity_runtime;
GRANT USAGE ON SCHEMA margin_identity TO margin_identity_provisioner;
GRANT SELECT,INSERT ON margin_identity.users,margin_identity.organizations,margin_identity.memberships TO margin_identity_provisioner;
GRANT UPDATE(disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_identity_provisioner;
GRANT UPDATE(role,revoked_at) ON margin_identity.memberships TO margin_identity_provisioner;
GRANT SELECT(id,user_id,organization_id,revoked_at,expires_at),UPDATE(revoked_at) ON margin_identity.sessions TO margin_identity_provisioner;
COMMIT;
-- Provisioning is a separate trusted administration capability. Grant margin_identity_runtime to
-- a restricted LOGIN role; do not use the migration owner, superuser, or a BYPASSRLS role in the app.
-- Schedule deletion of expired login receipts and expired/revoked session receipts using maintenance
-- credentials, not runtime. SET LOCAL context is trusted BFF state, never authentication by itself.
