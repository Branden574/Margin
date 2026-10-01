-- Apply after 001-identity.sql with the migration owner. No accounts, objects or grants are seeded.
BEGIN;
CREATE SCHEMA margin_sync;
REVOKE ALL ON SCHEMA margin_sync FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['margin_sync_runtime','margin_sync_provisioner'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',role_name);
    ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN
      RAISE EXCEPTION 'Existing document sync group has unsafe privileges';
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION margin_sync.context_id(setting_name text) RETURNS uuid LANGUAGE sql STABLE
  SET search_path=pg_catalog AS $$ SELECT nullif(current_setting('margin_sync.' || setting_name,true),'')::uuid $$;
-- Sync credentials cannot create or discover sessions; they see only the trusted request context.
GRANT USAGE ON SCHEMA margin_identity TO margin_sync_runtime,margin_sync_provisioner;
GRANT SELECT(id,disabled_at) ON margin_identity.users,margin_identity.organizations TO margin_sync_runtime,margin_sync_provisioner;
GRANT SELECT(organization_id,user_id,role,revoked_at) ON margin_identity.memberships TO margin_sync_runtime,margin_sync_provisioner;
GRANT SELECT(id,user_id,organization_id,mfa,authentication_method,expires_at,idle_expires_at,revoked_at) ON margin_identity.sessions TO margin_sync_runtime;
CREATE POLICY sync_user_read ON margin_identity.users FOR SELECT TO margin_sync_runtime USING(id=margin_sync.context_id('user_id'));
CREATE POLICY sync_org_read ON margin_identity.organizations FOR SELECT TO margin_sync_runtime USING(id=margin_sync.context_id('organization_id'));
CREATE POLICY sync_member_read ON margin_identity.memberships FOR SELECT TO margin_sync_runtime USING(user_id=margin_sync.context_id('user_id') AND organization_id=margin_sync.context_id('organization_id'));
CREATE POLICY sync_session_read ON margin_identity.sessions FOR SELECT TO margin_sync_runtime USING(id=margin_sync.context_id('session_id') AND user_id=margin_sync.context_id('user_id') AND organization_id=margin_sync.context_id('organization_id'));
CREATE POLICY sync_provision_user_read ON margin_identity.users FOR SELECT TO margin_sync_provisioner USING(true);
CREATE POLICY sync_provision_org_read ON margin_identity.organizations FOR SELECT TO margin_sync_provisioner USING(true);
CREATE POLICY sync_provision_member_read ON margin_identity.memberships FOR SELECT TO margin_sync_provisioner USING(true);
CREATE FUNCTION margin_sync.active_role() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT m.role FROM margin_identity.sessions s
  JOIN margin_identity.memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
  JOIN margin_identity.users u ON u.id=s.user_id JOIN margin_identity.organizations o ON o.id=s.organization_id
  WHERE s.id=margin_sync.context_id('session_id') AND s.user_id=margin_sync.context_id('user_id') AND s.organization_id=margin_sync.context_id('organization_id')
    AND s.authentication_method=nullif(current_setting('margin_sync.authentication_method',true),'')
    AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
    AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND o.disabled_at IS NULL
    AND (m.role NOT IN ('school_admin','district_admin','owner','support','system_admin') OR s.mfa)
$$;
CREATE TABLE margin_sync.documents (
  organization_id uuid NOT NULL REFERENCES margin_identity.organizations(id), id uuid NOT NULL,
  owner_id uuid NOT NULL, current_version_id uuid NOT NULL, audience text NOT NULL CHECK(audience IN ('members','teachers')),
  cursor bigint NOT NULL DEFAULT 0 CHECK(cursor BETWEEN 0 AND 100000),
  operation_bytes bigint NOT NULL DEFAULT 0 CHECK(operation_bytes BETWEEN 0 AND 134217728),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,owner_id) REFERENCES margin_identity.memberships(organization_id,user_id)
);
CREATE TABLE margin_sync.versions (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,document_id,id), FOREIGN KEY(organization_id,document_id) REFERENCES margin_sync.documents(organization_id,id)
);
ALTER TABLE margin_sync.documents ADD CONSTRAINT document_current_version FOREIGN KEY(organization_id,id,current_version_id) REFERENCES margin_sync.versions(organization_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE margin_sync.pages (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, version_id uuid NOT NULL, id uuid NOT NULL,
  page_index integer NOT NULL CHECK(page_index BETWEEN 0 AND 1999),
  width double precision NOT NULL CHECK(width>0 AND width<=100000), height double precision NOT NULL CHECK(height>0 AND height<=100000),
  PRIMARY KEY(organization_id,document_id,version_id,id), UNIQUE(organization_id,document_id,version_id,page_index),
  FOREIGN KEY(organization_id,document_id,version_id) REFERENCES margin_sync.versions(organization_id,document_id,id)
);
CREATE TABLE margin_sync.grants (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, user_id uuid NOT NULL,
  permission text NOT NULL CHECK(permission IN ('owner','editor','viewer')), revoked_at timestamptz,
  PRIMARY KEY(organization_id,document_id,user_id),
  FOREIGN KEY(organization_id,document_id) REFERENCES margin_sync.documents(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES margin_identity.memberships(organization_id,user_id)
);
CREATE UNIQUE INDEX one_document_owner ON margin_sync.grants(organization_id,document_id) WHERE permission='owner' AND revoked_at IS NULL;
CREATE TABLE margin_sync.document_keys (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, wrapped_key jsonb NOT NULL CHECK(octet_length(wrapped_key::text)<=16384),
  PRIMARY KEY(organization_id,document_id), FOREIGN KEY(organization_id,document_id) REFERENCES margin_sync.documents(organization_id,id)
);
CREATE TABLE margin_sync.annotations (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, annotation_id uuid NOT NULL,
  version_id uuid NOT NULL, page_id uuid NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100000),
  deleted boolean NOT NULL, latest_cursor bigint NOT NULL,
  PRIMARY KEY(organization_id,document_id,annotation_id),
  FOREIGN KEY(organization_id,document_id,version_id,page_id) REFERENCES margin_sync.pages(organization_id,document_id,version_id,id)
);
CREATE TABLE margin_sync.operations (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, cursor bigint NOT NULL CHECK(cursor BETWEEN 1 AND 100000),
  actor_id uuid NOT NULL, operation_id uuid NOT NULL, version_id uuid NOT NULL, page_id uuid NOT NULL, annotation_id uuid NOT NULL,
  base_revision integer NOT NULL CHECK(base_revision BETWEEN 0 AND 99999), annotation_revision integer NOT NULL CHECK(annotation_revision=base_revision+1),
  kind text NOT NULL CHECK(kind IN ('put','delete')), committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 65536),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12), tag bytea NOT NULL CHECK(octet_length(tag)=16),
  PRIMARY KEY(organization_id,document_id,cursor), UNIQUE(organization_id,document_id,actor_id,operation_id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES margin_identity.memberships(organization_id,user_id),
  FOREIGN KEY(organization_id,document_id,version_id,page_id) REFERENCES margin_sync.pages(organization_id,document_id,version_id,id)
);
CREATE TABLE margin_sync.outbox (
  organization_id uuid NOT NULL, document_id uuid NOT NULL, cursor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
  PRIMARY KEY(organization_id,document_id,cursor),
  FOREIGN KEY(organization_id,document_id,cursor) REFERENCES margin_sync.operations(organization_id,document_id,cursor)
);
CREATE INDEX undelivered_sync_outbox ON margin_sync.outbox(created_at) WHERE delivered_at IS NULL;
CREATE FUNCTION margin_sync.has_grant(doc uuid,writing boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM margin_sync.grants g WHERE g.organization_id=margin_sync.context_id('organization_id') AND g.document_id=doc AND g.user_id=margin_sync.context_id('user_id') AND g.revoked_at IS NULL AND (NOT writing OR g.permission IN ('owner','editor')))
$$;
CREATE FUNCTION margin_sync.visible_document(doc uuid,writing boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM margin_sync.documents d WHERE d.organization_id=margin_sync.context_id('organization_id') AND d.id=doc AND d.deleted_at IS NULL AND (NOT writing OR (margin_sync.has_grant(doc,true) AND margin_sync.active_role() NOT IN ('viewer','support'))))
$$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['documents','versions','pages','grants','document_keys','annotations','operations','outbox'] LOOP
    EXECUTE format('ALTER TABLE margin_sync.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE margin_sync.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
CREATE POLICY sync_grants_read ON margin_sync.grants FOR SELECT TO margin_sync_runtime USING(organization_id=margin_sync.context_id('organization_id') AND user_id=margin_sync.context_id('user_id') AND margin_sync.active_role() IS NOT NULL);
CREATE POLICY sync_document_read ON margin_sync.documents FOR SELECT TO margin_sync_runtime USING(organization_id=margin_sync.context_id('organization_id') AND deleted_at IS NULL AND margin_sync.active_role() IS NOT NULL AND margin_sync.has_grant(id) AND (audience='members' OR margin_sync.active_role() IN ('teacher','school_admin','district_admin','owner','system_admin')));
CREATE POLICY sync_document_advance ON margin_sync.documents FOR UPDATE TO margin_sync_runtime USING(margin_sync.has_grant(id,true) AND margin_sync.active_role() NOT IN ('viewer','support')) WITH CHECK(organization_id=margin_sync.context_id('organization_id') AND margin_sync.has_grant(id,true));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['versions','pages','document_keys','annotations','operations'] LOOP
    EXECUTE format('CREATE POLICY sync_payload_read ON margin_sync.%I FOR SELECT TO margin_sync_runtime USING(organization_id=margin_sync.context_id(''organization_id'') AND margin_sync.visible_document(document_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['annotations','operations','outbox'] LOOP
    EXECUTE format('CREATE POLICY sync_payload_insert ON margin_sync.%I FOR INSERT TO margin_sync_runtime WITH CHECK(organization_id=margin_sync.context_id(''organization_id'') AND margin_sync.visible_document(document_id,true))',t);
  END LOOP;
END $$;
-- Actor identity cannot be supplied by an operation caller or changed after commit.
CREATE POLICY sync_operation_actor ON margin_sync.operations AS RESTRICTIVE FOR INSERT TO margin_sync_runtime WITH CHECK(actor_id=margin_sync.context_id('user_id'));
CREATE POLICY sync_annotation_update ON margin_sync.annotations FOR UPDATE TO margin_sync_runtime USING(organization_id=margin_sync.context_id('organization_id') AND margin_sync.visible_document(document_id,true)) WITH CHECK(organization_id=margin_sync.context_id('organization_id') AND margin_sync.visible_document(document_id,true));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['documents','versions','pages','grants'] LOOP
    EXECUTE format('CREATE POLICY sync_provision_read ON margin_sync.%I FOR SELECT TO margin_sync_provisioner USING(true)',t);
    EXECUTE format('CREATE POLICY sync_provision_insert ON margin_sync.%I FOR INSERT TO margin_sync_provisioner WITH CHECK(true)',t);
  END LOOP;
END $$;
CREATE POLICY sync_provision_key_insert ON margin_sync.document_keys FOR INSERT TO margin_sync_provisioner WITH CHECK(true);
CREATE POLICY sync_provision_document_update ON margin_sync.documents FOR UPDATE TO margin_sync_provisioner USING(true) WITH CHECK(true);
CREATE POLICY sync_provision_grant_update ON margin_sync.grants FOR UPDATE TO margin_sync_provisioner USING(true) WITH CHECK(true);
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA margin_sync FROM PUBLIC;
GRANT USAGE ON SCHEMA margin_sync TO margin_sync_runtime,margin_sync_provisioner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA margin_sync TO margin_sync_runtime;
GRANT SELECT ON margin_sync.documents,margin_sync.versions,margin_sync.pages,margin_sync.grants,margin_sync.document_keys,margin_sync.annotations,margin_sync.operations TO margin_sync_runtime;
GRANT UPDATE(cursor,operation_bytes) ON margin_sync.documents TO margin_sync_runtime;
GRANT INSERT ON margin_sync.annotations,margin_sync.operations,margin_sync.outbox TO margin_sync_runtime;
GRANT UPDATE(revision,deleted,latest_cursor) ON margin_sync.annotations TO margin_sync_runtime;
GRANT SELECT,INSERT ON margin_sync.documents,margin_sync.versions,margin_sync.pages,margin_sync.grants TO margin_sync_provisioner;
GRANT INSERT ON margin_sync.document_keys TO margin_sync_provisioner;
GRANT UPDATE(deleted_at) ON margin_sync.documents TO margin_sync_provisioner;
GRANT UPDATE(permission,revoked_at) ON margin_sync.grants TO margin_sync_provisioner;
COMMIT;
