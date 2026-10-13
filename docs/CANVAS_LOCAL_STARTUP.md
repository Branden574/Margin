# Persistent local Canvas services

This development entry point runs Margin's LTI-only identity, assignment, student-work, immutable-capture and frozen-review services together against a dedicated persistent PostgreSQL cluster. It also schedules student-copy provisioning and capture materialization. It does **not** install Canvas or establish a live Canvas connection.

## Start with the default local ports

Prerequisites: Node 22+, installed project dependencies, PostgreSQL server tools (`initdb`, `pg_ctl`) and OpenSSL on PATH. The existing Margin HTTPS server certificate and key must be current, matching, owned 0600 files for `127.0.0.1`. The setup command copies that pair; it does not create browser trust or replace the original pair.

From the repository root:

```sh
npm run setup:canvas
npm run dev:canvas:api
```

In a second terminal:

```sh
npm run dev:canvas:web
```

Default endpoints:

| Service                     | Address                                         |
| --------------------------- | ----------------------------------------------- |
| Existing personal workspace | `https://127.0.0.1:5173/`                       |
| Existing local upload API   | `https://127.0.0.1:4100/`                       |
| Separate Canvas workspace   | `https://127.0.0.1:5174/`                       |
| Canvas API                  | `https://127.0.0.1:4101/`                       |
| Dedicated Canvas PostgreSQL | `127.0.0.1:55439` with certificate-verified TLS |

The browser origin on port 5174 has its own encrypted vault. Existing documents on port 5173 are not copied, moved or reset. Keep using the existing workspace for ordinary local documents. Creating a vault on the new origin does not create a Canvas identity or enrollment.

The shipped web mode supports these default ports and the original `.local/tls` certificate pair. The setup CLI accepts explicit custom ports/origin/TLS files for operator use, but a custom frontend must configure the same origin, API target and trusted API certificate. Do not disable verification to make mismatched certificates work. A later ordinary-certificate replacement also requires deliberate synchronization of the copied Canvas pair and its setup receipt; setup refuses silently changed files.

## Ownership and restart

Setup creates `.local/canvas/` with private files, an ownership receipt, migration hashes, separate operator credentials, ten distinct restricted service logins, independent cryptographic secrets and dedicated artifact/data directories. Operator credentials are excluded from the runtime configuration. PostgreSQL binds only loopback, refuses plaintext clients, and uses a separate private database CA; no OS trust changes are made.

Successful setup reruns validate and reuse the existing cluster and keys. They do not reset data or replay changed migrations. Unknown, incomplete or drifted directories are preserved and refused for operator inspection. A failed new setup attempts to stop only the cluster whose identity and owned data directory it verified. Never delete a directory or replace keys to get around a refusal when it contains work you need.

Stop the API/web terminals with Ctrl+C. Stop or restart only this owned database using:

```sh
npm run setup:canvas -- stop
npm run setup:canvas -- start
```

Data and credentials remain on disk. There is no background launch agent or automatic boot startup. The API's default configuration is `.local/canvas/config.json`; an explicit absolute configuration path can be passed after `--`.

Setup issues a 30-day PostgreSQL server leaf and copies the existing API leaf with its original expiry. Database leaf renewal is a separate explicit operation described below. Synchronizing a renewed browser/API certificate remains an operator gap; database renewal does not replace that certificate or change OS trust. The additive database upgrade does not renew either certificate.

## Optional feedback provisioning

Teacher feedback uses an additional dedicated credential and additive migration 014. Stop this installation's API/scanner/workers, leave its PostgreSQL cluster running, and run `npm run setup:canvas -- enable-feedback` (append `--root /absolute/path/to/owned/canvas` for a custom installation). Existing v13 files, credentials and captures are preserved; v12 installations must first run the separate `upgrade` action. See [feedback setup and interrupted-operation recovery](CANVAS_FEEDBACK_SETUP.md) before maintenance. Feedback remains unavailable until its private installation receipt is verified and published.

## Explicit PostgreSQL certificate renewal

Stop the Canvas API, inspector and other clients of this dedicated database, then run:

```sh
npm run setup:canvas -- renew-postgres-cert
```

For a custom installation, append `--root /absolute/path/to/owned/canvas`. A completed operation issues a new 30-day server leaf for `127.0.0.1`, signed by the same private database CA with the same server key. It preserves credentials, application signing/encryption keys, API certificate, database rows and artifacts. It updates the bootstrap hash and the owned scanner companion's binding records together; the inspector password and setup identity stay unchanged. The CA must remain valid beyond the new leaf's lifetime. An expired, mismatched or nearly expired CA requires separate operator recovery.

For a running database, renewal first verifies its current TLS identity and obtains exclusive maintenance admission. For an already stopped database, it verifies the owned cluster and clean-shutdown state; this path also accepts a genuinely expired old leaf. A database still running with an expired leaf is refused because it cannot complete the normal authenticated connection. Stop the API/inspector, use PostgreSQL's smart shutdown with the exact owned data directory recorded in the private bootstrap receipt, and retry after shutdown. Do not disable certificate verification or target another PostgreSQL installation.

Renewal verifies the new certificate actually served over TLS, the database identity, migration ledger and applicable runtime role checks before restoring the prior running/stopped state. It does not start the API or scanner for you. Restart those processes separately after maintenance completes.

The private `certificate-renewals/` journal retains exact old/new file contents before replacement. It can contain scanner credentials and must remain private. A pending marker blocks API/scanner startup and other ordinary setup operations; startup also rechecks the marker after obtaining database admission. Retrying the same renewal command reconciles only the recorded operation and expected file hashes. Preserve pending files and keys if it refuses; do not reset the installation or delete the marker to bypass it.

Recovery after process death accepts only the exact owned renewal lock whose recorded process is confirmed absent. A live, reused, inaccessible or ambiguous PID, a legacy unowned lock, changed files or a staged certificate that has since expired is refused. If the process died after durable completion and removal of the startup marker, retry only retires that completed operation's lock: its output explicitly says it does not repeat live verification or change the current running state. Rerunning after a fully completed operation and normal lock retirement requests another new leaf.

An interruption before the first complete ownership record is published may require operator inspection instead of automatic recovery. Each operation permits at most 64 ownership records; exhaustion also requires inspection. Keep the original root and private journal intact in both cases. These limits do not authorize deleting locks, resetting credentials or bypassing the pending marker.

## Explicit database upgrade

Fresh setup installs migrations 001–013. An existing verified 001–012 installation is preserved by ordinary setup/start; upgrading is a separate operator action. Stop the Canvas API, workers and every other client of its dedicated database, then run:

```sh
npm run setup:canvas -- upgrade
npm run dev:canvas:api
```

The upgrade accepts only the reviewed 012→013 transition. It requires an exclusive database maintenance lease and no other active clients, creates a private logical database backup, then commits the migration, exact ledger and policy baseline in one transaction. Existing keys, credentials, configuration and encrypted artifact files stay in place. A verified rerun on 013 performs no additional migration or backup. Unsupported versions, drift and incomplete directories are refused without resetting them.

Backup output is capped at 2 GiB while writing, with a 60-second process deadline and bounded diagnostics. An interrupted backup is retained without an accepted recovery manifest, and no migration starts. Backups remain under the private `.local/canvas/backups/` directory with their checksum and restoration notes. The database archive does not include global PostgreSQL roles, filesystem artifacts or secret files: retain the original protected root as well. Restore into a separate recovery database and validate it before any deliberate cutover; this command never automatically overwrites the working database. Backup retention and automated disaster recovery remain separate work.

Current runtime processes hold a shared maintenance lease. Losing that database connection stops HTTP/worker admission and drains their actual work before resources close. Older binaries do not participate in this lease, so they must be stopped explicitly before maintenance.

## Startup and shutdown checks

The loader bounds input sizes, rejects duplicate JSON properties and unsupported fields, validates private file ownership and certificate purpose, requires independent keys and distinct database logins, and rejects production or disabled TLS verification. Protected references stay within the private configuration directory; artifact and API data directories must be distinct direct children of that root. This binds maintenance checks to the same installation even when configuration filenames are customized. Environment connection options do not replace the configured values.

Before listening, the API performs bounded read-only database checks for all ten purposes: verified TLS, exclusive actual roles, expected database identity, durable settings, exact migration ledger, and selected table, forced-RLS, policy, trigger and authority-function contracts. These are startup drift checks, not a continuous availability monitor or a complete schema/ACL security audit. Every request retains its own authorization checks.

Provisioning and materialization run sequentially in one process. Cancellation does not release admission while the underlying job is still running. Shutdown stops new HTTP/worker admission, closes idle connections, allows active responses ten seconds before closing their sockets, and then awaits actual route/worker work before closing repositories, artifact storage and owned key buffers. It does not claim an unconditional shutdown deadline for an uncooperative dependency. Immutable JavaScript strings and OpenSSL key objects remain subject to garbage collection.

## Optional source inspection worker

The API queues teacher uploads in quarantine. A separate [local source inspector](SCANNER.md) runs the reviewed PDF parser and ClamAV images, using official signed definitions and a dedicated restricted database login. Its explicit setup requires stopping clients of this dedicated database for a maintenance lease. It adds private companion files under `.local/canvas/scanner/` while preserving the existing bootstrap, API credentials, keys and artifacts.

After following the scanner build, definition-update and setup instructions, run `npm run dev:canvas:scanner` in another terminal. Starting the API alone does not start this worker. The ordinary API's `scanningConfigured` health field describes its own composition; it does not discover this separate process or report its current readiness. The worker checks its engines and fresh definitions before claiming jobs, and shutdown retains ownership until actual work and container cleanup finish. It has no automatic boot startup or scheduled definition refresh.

## Still required before a live Canvas workflow

- A real private Canvas instance, trusted HTTPS routing for each caller, LTI developer-key/deployment registration, and explicit Margin installation/account/course/enrollment mappings.
- Configure and operate the separate source inspector with current definitions. Startup never seeds ready-source approvals; synthetic test inspectors must never process user uploads. Local engine tests do not qualify a production malware service.
- Public-key registration or an appropriate published JWKS endpoint. Tool signing keys persist; the runtime exposes public-only JWKS to its caller, but this command does not publish a public HTTP JWKS route.
- Confirmed Canvas submission delivery, teacher feedback release, roster/grade integration and institution-specific testing.

Health booleans indicate composed services, not a registered Canvas installation, ready sources or a successful Canvas submission. This local configuration refuses production use and provides no 100,000-user capacity claim. See [private Canvas development](CANVAS_SANDBOX.md), [runtime composition](RUNTIME_COMPOSITION.md) and [production readiness](PRODUCTION_READINESS.md).
