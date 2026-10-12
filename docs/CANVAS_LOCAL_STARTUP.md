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

## Startup and shutdown checks

The loader bounds input sizes, rejects duplicate JSON properties and unsupported fields, validates private file ownership and certificate purpose, requires independent keys and distinct database logins, and rejects production or disabled TLS verification. Environment connection options do not replace the configured values.

Before listening, the API performs bounded read-only database checks for all ten purposes: verified TLS, exclusive actual roles, expected database identity, durable settings, exact migration ledger, and selected table, forced-RLS, policy, trigger and authority-function contracts. These are startup drift checks, not a continuous availability monitor or a complete schema/ACL security audit. Every request retains its own authorization checks.

Provisioning and materialization run sequentially in one process. Cancellation does not release admission while the underlying job is still running. Shutdown stops new HTTP/worker admission, closes idle connections, allows active responses ten seconds before closing their sockets, and then awaits actual route/worker work before closing repositories, artifact storage and owned key buffers. It does not claim an unconditional shutdown deadline for an uncooperative dependency. Immutable JavaScript strings and OpenSSL key objects remain subject to garbage collection.

## Still required before a live Canvas workflow

- A real private Canvas instance, trusted HTTPS routing for each caller, LTI developer-key/deployment registration, and explicit Margin installation/account/course/enrollment mappings.
- Teacher source intake connected to the ingestion registry and an isolated structural validator/malware scanner. Startup never seeds ready-source approvals; the synthetic test inspector must never process user uploads.
- Public-key registration or an appropriate published JWKS endpoint. Tool signing keys persist; the runtime exposes public-only JWKS to its caller, but this command does not publish a public HTTP JWKS route.
- Confirmed Canvas submission delivery, teacher feedback release, roster/grade integration and institution-specific testing.

Health booleans indicate composed services, not a registered Canvas installation, ready sources or a successful Canvas submission. This local configuration refuses production use and provides no 100,000-user capacity claim. See [private Canvas development](CANVAS_SANDBOX.md), [runtime composition](RUNTIME_COMPOSITION.md) and [production readiness](PRODUCTION_READINESS.md).
