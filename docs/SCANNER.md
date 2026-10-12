# Local source inspection

Margin has a real, isolated PDF inspection implementation: qpdf **12.4.2** and PDF.js **6.3.289**, followed by ClamAV **1.4.6** using official signed CVD databases. The policy identifiers are `qpdf-12.4.2+pdfjs-6.3.289+policy-1` and `clamav-1.4.6-policy-1`.

**Local activation verified — October 11, 2026:** the dedicated Canvas companion was installed, started, cleanly stopped and restarted on the development Mac. The real engine readiness gate, an actual empty-queue claim, exclusion of operator maintenance while the worker holds admission, and release of the executor lock and database admission on shutdown were verified. A setup rerun preserved all four companion files; all 31 original protected files and the initially empty artifact directory stayed unchanged. Building images or running tests alone does not activate this worker. The ordinary API does not gain inspection credentials.

This is local development infrastructure. It does not establish live Canvas installation, production malware protection, production key management, throughput/SLOs or readiness for 100,000 users.

## Document and decision lifecycle

1. The authorized teacher reserves and uploads an exact PDF through the HTTPS source-upload endpoints. The service checks the byte count and digest, persists an encrypted artifact and enqueues a quarantined inspection. Quarantined sources cannot be selected for an assignment.
2. Before claiming any job, the worker checks the Docker daemon, immutable engine images and fresh definition snapshot. Missing engines or stale definitions therefore do not consume inspection attempts.
3. A dedicated inspector repository obtains a bounded database claim. The artifact adapter decrypts the exact stored version; the worker independently checks its digest, length and metadata against the reservation.
4. The parser container receives the PDF over stdin. qpdf checks structure, permitted content and decoding budgets; PDF.js interprets every page and derives effective geometry. Only a strictly validated fixed JSON protocol leaves the container. A successful parse is followed by a separate AV container using a freshly revalidated definition snapshot.
5. Approval requires both engines to finish successfully, valid output and confirmed cleanup of their owned containers. The worker rechecks that the scanner did not mutate its borrowed bytes, then clears the plaintext before database completion.
6. The repository stores an authenticated encrypted inspection report and geometry, bound to the artifact, claim and attempt. Source discovery and assignment creation authenticate those records and recheck current teacher/source authority. The scanner cannot replace an already committed decision with a new approval.

Engine output is a small allowlisted result, not a transcript. Document text, names, embedded URLs, signature names and raw engine diagnostics are not persisted in journals or application logs. Docker logging is disabled. Documents are not bind-mounted from the host; container document files reside in private tmpfs mounts. The host still necessarily holds decrypted bytes in process memory while inspection is active. The Docker daemon, host account, chosen image build and key provider are trusted operator boundaries.

The snapshot manifest is locally hash-bound, not independently signed by Margin. The database contents have upstream ClamAV signatures: FreshClam downloads them and `sigtool --info` verifies them before publication. At inspection time, ClamAV accepts official databases only and refuses unsigned bytecode. Private permissions and hashes detect drift; they do not protect against a trusted owner deliberately replacing both files and their manifest.

## Isolation and bounds

Both images must already exist locally under their exact `sha256:<64 hex>` image ID. Execution uses `--pull=never`, a verified Linux daemon matching the native host architecture (`arm64` or `amd64`) and the built-in seccomp profile. The host verifies image protocol/policy labels, entrypoint, user, work directory and permitted environment, refuses inherited volumes/commands, then inspects the actual created container before sending any document bytes.

| Control                                    | Parser                                      | ClamAV                                          |
| ------------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| Container memory / total memory+swap limit | 1 GiB / 1 GiB                               | 4 GiB / 4 GiB                                   |
| CPU and process limit                      | 1 CPU; 64 PIDs                              | 1 CPU; 64 PIDs                                  |
| Private `/work` tmpfs                      | 384 MiB                                     | 128 MiB                                         |
| Private `/tmp` tmpfs                       | 16 MiB                                      | 512 MiB                                         |
| Network                                    | None                                        | None                                            |
| Host bind mounts                           | None                                        | Exact published definition directory, read-only |
| Root filesystem                            | Read-only                                   | Read-only                                       |
| User                                       | Configured nonroot UID/GID                  | Configured nonroot UID/GID                      |
| Linux privileges                           | All capabilities dropped; no new privileges | Same                                            |
| File descriptors / core dumps              | 256 / disabled                              | Same                                            |
| Container logs / restart policy            | Disabled / no restart                       | Same                                            |

Tmpfs mounts are `noexec,nosuid,nodev`, mode `0700`, with the configured UID/GID. IPC is disabled, no host PID/UTS namespace or devices are granted, and no ports are published. The images declare a nonroot default user; the executor uses the local operator's nonroot UID/GID so it can read the private definition snapshot.

Document input is bounded at **100 MiB**. Parser policy permits **1–2,000 pages**, at most **100,000 objects**, **500,000 traversal nodes/content tokens**, nesting depth **64** and **8 filters per chain**. qpdf applies a **64 MiB per decoded stream stage** and **256 MiB aggregate decoding/work budget in the qpdf pass**, including conservative image/predictor charges. Independent PDF.js and other parser allocations remain bounded by the container memory limit, not that qpdf counter. Images are limited to **16 Mi pixels each** and **64 Mi pixels in aggregate**; actual JPEG headers are checked independently of PDF dictionary claims. PDF.js additionally caps aggregate page operators at **500,000** and page dimensions at **100,000** effective PDF units. These conservative limits can reject otherwise legitimate documents.

The parser refuses encrypted PDFs, attachments, JavaScript/actions, external resources, active media, unsupported filters and inline images, including forms, patterns and Type3 glyph content. This is a restricted document policy, not full PDF feature compatibility or sanitization. Accepted bytes are preserved; the scanner does not rewrite a document to make it safe.

ClamAV uses a **35-second** inner command deadline (TERM, then KILL after one second), **100 MiB** maximum file size, **256 MiB** scan expansion, **10,000** files and recursion depth **16**. The outer worker allows **45 seconds for the combined parser and AV inspection**. Docker attach has an independent **60-second** ceiling; ordinary control commands default to **10 seconds**. Those are cancellation/admission bounds, not a promise that cleanup completes by the same instant.

Host engine stdout is capped at **256 KiB**, stderr at **64 KiB**; AV protocol output is further limited to **4 KiB**. Raw diagnostics are discarded. The worker uses separate readiness/claim/storage/completion deadlines of **10/15/20/15 seconds**. A deadline can reject its caller early, but actual promises, admission and any still-borrowed plaintext remain retained until the underlying operation settles. Shutdown drains them before closing providers.

## Outcomes, retries and shutdown

| Observation                                                                                                    | Durable behavior                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Valid PDF, matching geometry and clean AV result                                                               | Encrypted ready decision; eligible for authorized discovery and assignment                        |
| Deterministically malformed PDF or disallowed PDF features                                                     | Rejected decision; source remains unavailable for assignment                                      |
| Malware signature or AV unsupported result                                                                     | Rejected decision; source remains unavailable for assignment                                      |
| Resource exhaustion, timeout, crash, stale definitions, malformed engine output or uncertain container cleanup | No approval; source stays quarantined and eligible for bounded retry                              |
| Revoked/expired claim or uncertain database completion                                                         | Existing transactional claim/decision checks govern reconciliation; never blindly replay approval |

Claims have a **120-second** lease and a maximum of **10** attempts. Worker retry delay is `min(3600, 15 × 2^min(attempt, 8))` seconds. Exhausted jobs remain quarantined; there is no automatic approval or unlimited retry reset. An operator-facing exhausted-job recovery workflow is not established by these tests.

The polling loop is serial. Successful jobs continue immediately; idle or deferred work waits **15 seconds** by default (configurable from 100 ms to 60 seconds). It awaits `runOneAndDrain`, so an early caller cancellation cannot cause overlapping inspection. Events are only `processed`, `idle` and `deferred`, without document identifiers.

Close the polling loop/worker first, then the isolated scanner/executor, then borrowed artifact storage, inspector database pool and keys. Retain shared Canvas runtime admission until all of those owned operations have drained. A failed container cleanup is a failed close, not permission to release the execution lock or report successful shutdown.

## Build images and publish definitions

Use a trusted local Docker installation with a Unix socket and sufficient VM memory for the 4 GiB AV limit. The measured build and real-container checks were performed on native Apple Silicon with a Linux `arm64` Docker daemon. The executor admits native `amd64` too, but that platform has not received equivalent real-engine evidence here; the current definition updater explicitly requires `arm64`.

Run from the repository root. Replace the two absolute path examples with your local executable and socket. These settings never point at a remote TCP daemon.

```sh
export MARGIN_SCANNER_DOCKER_BIN=/absolute/path/to/docker
export MARGIN_SCANNER_DOCKER_SOCKET=/absolute/path/to/docker.sock

"$MARGIN_SCANNER_DOCKER_BIN" --host "unix://$MARGIN_SCANNER_DOCKER_SOCKET" build \
  -t margin-pdf-parser:policy-1 infra/scanner/parser
"$MARGIN_SCANNER_DOCKER_BIN" --host "unix://$MARGIN_SCANNER_DOCKER_SOCKET" build \
  -t margin-clamav:policy-1 infra/scanner/clamav

export MARGIN_PDF_PARSER_IMAGE="$("$MARGIN_SCANNER_DOCKER_BIN" --host "unix://$MARGIN_SCANNER_DOCKER_SOCKET" image inspect --format '{{.Id}}' margin-pdf-parser:policy-1)"
export MARGIN_CLAMAV_IMAGE="$("$MARGIN_SCANNER_DOCKER_BIN" --host "unix://$MARGIN_SCANNER_DOCKER_SOCKET" image inspect --format '{{.Id}}' margin-clamav:policy-1)"
export MARGIN_SCANNER_DEFINITIONS="$(pwd -P)/.local/scanner"
```

Builds need network access. The Dockerfiles pin base-image digests and qpdf source checksum and use the committed PDF.js lockfile. OS package installation still uses its distribution repositories; a future rebuild is not guaranteed to reproduce an identical image ID. Record and review the resulting immutable image IDs before use. Tags above are build conveniences and are not accepted runtime identities.

The native `arm64` images used for the recorded tests were:

- Parser: `sha256:090c41f13844b8910caa00c4f06286e8a0b6c95c8bf99395df6aed9c35ab4bc4`
- ClamAV: `sha256:246550ea392054fa0151a549063d63ddcb073ef2d8c91e1715c6e2bcd89adc29`

These are local image IDs, not a promise that a public registry serves them.

The updater uses `docker` from a trusted `PATH` and its **current local Unix-socket Docker context**. Check that this context targets the same daemon as the explicit executor settings; the updater does not consume the executor environment variables as endpoint overrides.

```sh
docker context inspect --format '{{.Endpoints.docker.Host}}'
node scripts/setup-scanner-definitions.mjs --image "$MARGIN_CLAMAV_IMAGE"
node scripts/setup-scanner-definitions.mjs --image "$MARGIN_CLAMAV_IMAGE" --refresh
```

The default directory is the repository's `.local/scanner`; pass `--root /absolute/private/path` to use another. Ensure `MARGIN_SCANNER_DEFINITIONS` matches it. macOS Docker must be able to bind-mount this directory. The updater requires at least **2 GiB** free storage and permits up to **512 MiB** total published CVD content. Its networked updater container receives only a writable private staging directory for public definitions, never a document, application configuration or key.

Publication creates a new snapshot UUID and atomically replaces `current.json` after verification and owned-container removal. Published files are `0400`, directories `0700`, and the pointer is `0600`. Previous snapshots are preserved. A normal run reuses a still-fresh verified snapshot; `--refresh` explicitly checks upstream updates. Runtime readiness requires a confirmation no older than **24 hours** and `daily.cvd` no older than **48 hours**. Refresh is currently an explicit operator task; no recurring updater has been installed. Preserve old snapshots until no active scan references them; automatic pruning is not implemented.

## Canvas companion setup interface

The companion implementation uses a separate configuration and restricted PostgreSQL login; the original Canvas schema-1 configuration and its protected-file receipt stay unchanged. The setup interface under integration is:

```sh
node --import tsx scripts/setup-scanner-local.mjs \
  --canvas-root /absolute/private/canvas-root \
  --parser-image "$MARGIN_PDF_PARSER_IMAGE" \
  --antivirus-image "$MARGIN_CLAMAV_IMAGE" \
  --definitions-root "$MARGIN_SCANNER_DEFINITIONS" \
  --docker-executable "$MARGIN_SCANNER_DOCKER_BIN" \
  --docker-socket "$MARGIN_SCANNER_DOCKER_SOCKET"
```

All flags are required. This operator step requires the owned Canvas database at exact migration 13, with the API, workers and other database clients stopped. It shares the bootstrap filesystem lock and exclusive database maintenance admission, verifies the actual PostgreSQL system identifier and installed ledger/policy contract, and checks actual engine readiness. The restricted runtime subsequently anchors to verified TLS, the exact installation UUID and receipt-bound configuration; it does not receive a new privilege to query PostgreSQL control-system metadata. It creates only the restricted `margin_canvas_inspector` login and private companion files under `<canvasRoot>/scanner/`: `inspector.json`, `database.url`, `setup-journal.json`, `installation.json` and `executor/`. The setup journal also contains the exact prepared database credential and configuration so interrupted setup can resume without rotating a committed login. Treat it as a secret-bearing file; the final installation receipt contains hashes and ownership metadata only. These credentials are never passed as command-line arguments.

Setup does not start inspection. This interface is documented for review while persistent setup/runtime verification is pending; it is not evidence of an activated service. The journal is published before derived credential/configuration files or any role creation. Files are fsynced and published without clobbering existing paths; retry restores only missing files whose exact bodies are bound by the journal. A crash after atomic hard-link publication is reconciled only for the matching owned temporary inode; other partial temporary files are preserved. Preserve incomplete setup journals for exact reconciliation after an uncertain database commit or interrupted file publication. Do not recreate the original Canvas installation or replace existing encryption keys to enable scanning.

The separate foreground entry point is:

```sh
npm run dev:canvas:scanner -- /absolute/private/canvas-root/scanner/inspector.json
```

It defaults to `.local/canvas/scanner/inspector.json` when no path is supplied. This command starts the durable inspection loop and therefore requires an explicitly prepared/verified installation; its presence does not change the activation checkpoint above. Stop with Ctrl-C. If shutdown reports `cleanup_pending`, keep that same process open, restore the required local service and press Ctrl-C again to retry its owned cleanup. Do not launch a replacement worker or remove its lock while that cleanup is unresolved. No launch agent, recurring scheduler or automatic startup service is installed by this command.

## Reproduce verification

Default unit and PostgreSQL tests are separate from real Docker evidence. Without all five explicit scanner environment variables, the real pipeline and the real HTTPS journey are skipped. Supplying only part of that configuration fails immediately rather than silently substituting a fixture scanner.

```sh
npx vitest run tests/ingestion.worker.test.ts tests/scanner-loop.test.ts \
  tests/scanner-process.test.ts tests/scanner-policy.test.ts \
  tests/scanner-protocol.test.ts tests/scanner-source.test.ts \
  tests/scanner-docker.test.ts tests/scanner-definitions.test.ts \
  tests/scanner-definition-updater.test.ts

# Requires the five exported settings above, built images and fresh signed definitions.
npx vitest run tests/scanner-pipeline.docker.test.ts

# Also requires initdb and pg_ctl. Uses a new disposable PostgreSQL cluster.
npx vitest run tests/runtime-composition.postgres.test.ts \
  -t 'real isolated parser and ClamAV'
```

The parser-only real Docker suite is `tests/scanner-parser.docker.test.ts`; it uses `MARGIN_PDF_PARSER_IMAGE` and the explicit Docker executable/socket settings. Its standalone harness has its own container settings; the combined pipeline tests exercise the actual executor policy shown above. The real executor recovery suite additionally uses `MARGIN_SCANNER_EXECUTOR_IMAGE="$MARGIN_CLAMAV_IMAGE"`; it creates and removes only an owned, never-started test container. Run resource-intensive real suites serially to avoid contention in the local Docker VM.

The recorded evidence includes:

- **30 real parser container cases:** benign/500-page PDFs; effective CropBox, rotation and UserUnit geometry; actual Flate/JPEG decoding; lying JPEG dimensions; active content, encryption, malformed syntax, compressed object tables, filter chains and aggregate/predictor expansion and unsupported inline content. The tests use generated fixtures and a committed qpdf encrypted regression fixture.
- **5 real parser-plus-AV pipeline cases passed** in 34.47 seconds and again after executor durability changes in 39.52 seconds: benign geometry, a standard harmless EICAR signature in a valid uncompressed PDF stream, active/malformed rejection, resource-limit quarantine, and cancellation during AV execution followed by confirmed removal and another successful scan. EICAR is a specific antivirus test signal; it does not establish detection of every malware family or every way of embedding bytes. In particular, appending the same string as a PDF comment did not produce that detection in the local experiment.
- The **real HTTPS/PostgreSQL teacher upload journey passed** in about 11 seconds including setup: signed synthetic teacher launch → new reservation/upload → quarantine → encrypted filesystem and service restart → both real engines → encrypted decision/authenticated geometry → source discovery → assignment creation. Its executor state was removed only after worker and scanner drain. Canvas identity remained synthetic; no actual Canvas institution or student data was used.
- Default HTTPS composition still uses the clearly labeled exact-fixture scanner and separately passed **16 tests with the real case skipped**. That default result is not malware-scanner evidence.
- Lifecycle tests cover readiness before claim, late claim/get/scanner/completion/retry settlement, retained plaintext during uncooperative cancellation, no approval after abort, unknown create acknowledgement, foreign-container refusal, unavailable-daemon cleanup and stale-lock refusal.
- **23 PostgreSQL/TLS companion setup cases** cover minimal secret reads, restricted login ownership, exact credential reuse, unknown commits, all eight atomic-publication interruption points, original-file preservation, maintenance/idle-connection loss and suppression of credential-bearing PostgreSQL error statements. Docker readiness is mocked in this suite; real engine checks are separate.
- Two additional actual PostgreSQL transaction-loss regressions terminate the exact checked-out inspector backend after claim or decision writes. They verify real client error handling, retained operation lifetime, rollback, replacement-connection recovery and idempotent completion. The combined focused ingestion/runtime run passed **46 tests**.

Real tests create dedicated private state beneath repository `.local` so Docker Desktop can access test mounts. They do not mutate the persistent Canvas database. On uncertain cleanup they deliberately preserve ownership evidence instead of deleting the test directory.

## `cleanup_pending` and interrupted operator work

The executor acquires a private atomic `.executor-lock` for its entire lifetime. Jobs record random container name, owner UUID, exact image/profile and creation phase in fsynced `0600` journals **before** Docker creation. Journals contain no document IDs or content. One process per configured state directory is admitted; deployments must not create alternate state directories to bypass that single-worker operational limit.

After cancellation the executor identifies the exact owned container, stops it when running, waits as needed, removes it by full ID and confirms absence. A created-but-never-started container is removed without waiting for a start that may never occur. Ownership checks never authorize removing an unrelated container.

A lost create acknowledgement is especially conservative: an immediately empty container listing does not prove that an in-flight daemon request cannot create the container later. The journal and lock remain until the owned outcome is resolved. Cleanup makes three bounded attempts with backoff; unavailable Docker or unverifiable ownership yields `cleanup_pending`. The live owner can retry readiness/close after the daemon is restored. New work stays refused meanwhile.

After a process crash, an existing lock is not automatically reclaimed, even if its recorded PID appears stale. A PID can be reused, and the executor does not signal host processes. Recovery requires an operator to preserve the lock/journals, establish that the prior owner is stopped and no request is still in flight, inspect the configured daemon, and reconcile only containers whose full ID, random name, owner label and image match the journal. No turnkey stale-lock recovery command is implemented. Do not delete lock files as a routine retry mechanism, run broad Docker prune commands, or guess that an empty lookup resolves an unknown create.

Definition updates have their own `.update-lock/operation.json` and the same unknown-create preservation boundary. Interrupted updates leave existing published snapshots intact; uncertain owned-container cleanup retains the update lock. Malformed pointers, symlinks, hard links, unexpected files or hash drift require operator review and are never silently repaired.

## Remaining qualification

Persistent local activation and controlled lifecycle recovery are verified above. Forced process death with retained ownership locks still requires operator investigation; no automatic stale-lock adoption is supplied. The real engine evidence above does not demonstrate a deployed school workflow, a production key service, native Chromebook performance, malware coverage, image-heavy workload capacity, concurrent-user throughput or 100,000-user operation. The current serial local worker is intentionally bounded; production scheduling, resource isolation, patch/image release management, refresh monitoring, exhausted-job handling and capacity targets remain separate work.
