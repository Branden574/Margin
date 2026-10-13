# Optional local feedback service

The local feedback service saves encrypted teacher drafts separately from student captures and publishes an immutable release only when the teacher explicitly releases it. It uses its own PostgreSQL login and migration 014. It does not turn local synthetic launches into a live Canvas integration.

The ordinary setup still creates the supported migration 013 installation with ten restricted service credentials. Existing v12 installations must first run the separate `upgrade` action. To enable feedback on an owned v13 installation, stop that installation's API, scanner, workers and other database clients, leave its dedicated PostgreSQL cluster running, and run:

```sh
npm run setup:canvas -- enable-feedback --root /absolute/path/to/owned/canvas
```

For the default `.local/canvas` installation, omit `--root`. The command accepts only the saved root; it does not change the original ports, credentials, keys, TLS trust, setup receipt, config file, artifacts or capture contents. The optional credential is `margin_canvas_feedback`, a separate login with only the `margin_feedback_runtime` group. It never reuses the reviewer password. The original config JSON remains unchanged; the loader supplies `configuration.feedbackDatabase` only after the private companion's final installation receipt has been published.

The operator first verifies the original protected-file hashes, database identity, exact v13 ledger/policy baseline and runtime readiness, then takes a private logical database backup. The archive and manifest live in `backups/before-014-*`; the manifest records its hash, v13 migration prefix and the original file fingerprints. `pg_restore --list` validates the completed archive. Keep the original keys, credentials and encrypted artifacts: the archive does not contain artifact files or global PostgreSQL roles, and is never automatically restored over the database.

Under exclusive maintenance admission, one bounded transaction applies the pinned migration 014, verifies that old functions/triggers/tables and policies were preserved, checks the exact additional policy inventory (including dynamically generated clone names), creates the dedicated login and updates the migration/policy contract. The transaction uses lock, statement and idle limits plus a 30-second outer deadline. A separate connection then verifies the stored password over real certificate-verified TLS and checks the dedicated role, schema, canonical policy expressions and installation identity. Only that success publishes `feedback/installation.json`.

## Interrupted setup and recovery

The private `feedback/setup-journal.json` is written and fsynced before database mutation and contains the stable operation identity, dedicated password, file hashes and backup reference. Keep it private. Companion files are published without overwriting existing files; a retry verifies exact bytes and reconciles only a known extra publication hard link. An unrelated or modified credential, backup, role marker, file, migration or policy contract is refused.

If COMMIT's acknowledgement is lost, the command reconnects with verified TLS, reacquires exclusive maintenance admission, checks the original files and verifies the exact ledger and operation-marked role. A complete v14 ledger with the matching login can continue through credential verification and publication without replaying DDL. An exact v13 ledger with no feedback login is preserved and reported as incomplete; an explicit retry can attempt the same operation with the same password. An unknown or inconsistent result is refused. A prior completed installation is verified without credential rotation or another backup.

If the process exits after migration but before final publication, feedback stays unavailable and the original API can run with its existing roles against v14. The loader never activates a partial journal as a credential. If a published companion is changed, configuration fails closed. A process killed during setup can leave the existing unowned `.bootstrap-lock`; unlike the certificate-renewal journal, this lock is deliberately not auto-adopted. Preserve it and investigate the operation before any manual lock recovery. Do not delete private files or reset the installation to bypass a refusal.

The companion binds the stable installation identity, original config/ownership files and PostgreSQL CA rather than the renewable server leaf. The supported PostgreSQL leaf renewal therefore preserves every feedback file and credential, and verifies feedback readiness when it is installed. Expired CA recovery, synchronizing a replaced browser/API certificate and automatic recovery of an abandoned generic bootstrap lock remain separate operator work.

Verification of this command uses disposable real PostgreSQL/TLS clusters. It is not evidence of an administrator-installed Canvas integration, Google Classroom integration, hosted operations, or capacity for 100,000 users.
