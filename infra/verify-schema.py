#!/usr/bin/env python3
"""Apply the proposal and test RLS in an isolated disposable local PostgreSQL cluster.
Requires initdb, pg_ctl and psql on PATH. Never connects to an existing database.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

TEST_SQL = """
CREATE ROLE margin_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA margin TO margin_test_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA margin TO margin_test_runtime;
INSERT INTO margin.organizations(id,name) VALUES
('00000000-0000-4000-8000-000000000001','School A'),('00000000-0000-4000-8000-000000000002','School B');
INSERT INTO margin.users(id,oidc_issuer,oidc_subject,display_name) VALUES
('10000000-0000-4000-8000-000000000001','test','a','A'),('10000000-0000-4000-8000-000000000002','test','b','B');
INSERT INTO margin.memberships(organization_id,user_id,role) VALUES
('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','student'),
('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','student');
INSERT INTO margin.documents(id,organization_id,owner_id,name,mime_type,byte_size,object_key,sha256,state) VALUES
('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A','application/pdf',10,'a',repeat('a',64),'ready'),
('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','B','application/pdf',10,'b',repeat('b',64),'ready');
SET ROLE margin_test_runtime;
DO $$ BEGIN
 IF (SELECT count(*) FROM margin.documents) <> 0 THEN RAISE EXCEPTION 'Missing identity context must fail closed'; END IF;
END $$;
BEGIN;
SELECT set_config('app.organization_id','00000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.role','student',true);
DO $$ DECLARE changed integer; BEGIN
 IF (SELECT count(*) FROM margin.documents) <> 1 THEN RAISE EXCEPTION 'Owner must see only their tenant document'; END IF;
 IF EXISTS(SELECT 1 FROM margin.documents WHERE name='B') THEN RAISE EXCEPTION 'Cross-tenant read was allowed'; END IF;
 UPDATE margin.documents SET name='forbidden' WHERE name='B'; GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed <> 0 THEN RAISE EXCEPTION 'Cross-tenant update was allowed'; END IF;
 UPDATE margin.memberships SET role='admin'; GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed <> 0 THEN RAISE EXCEPTION 'Student escalated membership'; END IF;
 BEGIN
   INSERT INTO margin.documents(organization_id,owner_id,name,mime_type,byte_size,object_key,sha256,state) VALUES
   ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','bad','application/pdf',10,'bad',repeat('c',64),'ready');
   RAISE EXCEPTION 'Cross-tenant insertion was allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
COMMIT;
DO $$ BEGIN
 IF (SELECT count(*) FROM margin.documents) <> 0 THEN RAISE EXCEPTION 'Transaction identity leaked after commit'; END IF;
END $$;
RESET ROLE;
SELECT 'Tenant read/write isolation, student membership protection, missing context and transaction reset passed.';
"""

def main():
    for tool in ('initdb', 'pg_ctl', 'psql'):
        if not shutil.which(tool):
            raise SystemExit(f'{tool} is required; no database was started.')
    root = tempfile.mkdtemp(prefix='margin-pg-check-')
    pgdata = os.path.join(root, 'data')
    socket = os.path.join(root, 'socket')
    os.mkdir(socket)
    started = False
    try:
        subprocess.run(['initdb', '-D', pgdata, '--auth=trust', '--no-locale', '-E', 'UTF8'], check=True, capture_output=True, text=True)
        # No TCP listener. A private temporary Unix socket prevents interaction with existing clusters.
        subprocess.run(['pg_ctl', '-D', pgdata, '-l', os.path.join(root, 'postgres.log'), '-o', f"-F -k {socket} -h '' -p 55439", '-w', 'start'], check=True, capture_output=True, text=True)
        started = True
        psql = ['psql', '-h', socket, '-p', '55439', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
        schema = str(Path(__file__).with_name('schema.sql'))
        subprocess.run(psql + ['-f', schema], check=True, capture_output=True, text=True)
        tested = subprocess.run(psql, input=TEST_SQL, capture_output=True, text=True)
        if tested.returncode:
            print(tested.stdout)
            print(tested.stderr)
            tested.check_returncode()
        version = subprocess.run(psql + ['-Atc', 'SELECT version();'], check=True, capture_output=True, text=True)
        print('Schema application and 7 RLS assertions passed in an isolated disposable database.')
        print(version.stdout.strip())
    finally:
        if started:
            subprocess.run(['pg_ctl', '-D', pgdata, '-m', 'fast', '-w', 'stop'], check=True, capture_output=True, text=True)
        shutil.rmtree(root)

if __name__ == '__main__':
    main()
