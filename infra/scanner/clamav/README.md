# ClamAV document inspection

This directory pins the official native Linux ARM64 ClamAV 1.4.6 Debian image by
its platform manifest digest. The derived image has a fixed per-document
entrypoint. It starts neither the official image's daemon supervisor nor
FreshClam during document inspection.

Build locally, then record the exact image ID from `docker image inspect`:

```sh
docker build --platform linux/arm64 --network=none --tag margin-clamav:1.4.6-local infra/scanner/clamav
docker image inspect margin-clamav:1.4.6-local --format '{{.Id}}'
node scripts/setup-scanner-definitions.mjs --image sha256:<exact-built-image-id>
```

The setup command checks an existing fresh snapshot without starting Docker. An
explicit `--refresh` checks for official updates even while the current snapshot
is fresh. Existing verified CVDs seed each update, avoiding an unnecessary full
download. An expired confirmation also triggers this update path. No automatic
scheduler or inspector database account is installed by this command.

## Wire contract and containment

`scan.sh` reads **1 through 100 MiB** of raw bytes from stdin into the fixed
`/work/input.pdf` file. It emits one bounded line:

```json
{
  "protocol": "margin-av-inspection-v1",
  "engine": "clamav",
  "engineVersion": "1.4.6",
  "status": "clean"
}
```

- Exit 0: `clean`.
- Exit 10: `malware`, `unsupported` for encrypted documents or invalid input size,
  or `resource_limit` for incomplete scans. The host must quarantine resource
  limits, never approve them as clean.
- Exit 20: infrastructure or unexpected engine failure, with no verdict.

The host must supply an immutable image ID, `--pull=never`, no network, read-only
root, its nonzero UID/GID, 4 GiB memory with no extra container swap allowance,
one CPU, 64 PIDs, all capabilities dropped, no-new-privileges, no Docker log
driver, and bounded non-executable `/work` and `/tmp` tmpfs mounts. Mount only the
selected definition snapshot at `/definitions`, read-only. No document host
path, API configuration, encryption key, or Docker socket belongs in the scan
container. The supervisor must prove exact owned-container termination before
releasing admission after timeout or cancellation.

Engine output remains in a 64 KiB bounded tmpfs report. Only a single exact clean
line is accepted; additional warnings fail closed. Explicit alert-on-limit flags
prevent ClamAV's default skip-as-clean behavior for extraction limits. The
engine's internal scan-time skip is disabled; a 35-second external process
deadline produces `resource_limit`. The host's combined AV/parser deadline is
still authoritative. A clean AV verdict alone does not establish PDF validity
or safe structural content; the independent PDF parser must also accept it.

tmpfs does not prove zero disk persistence: VM or host memory can swap. Container
isolation is also not a replacement for a separately reviewed production worker
trust boundary.

## Official definition snapshots

The updater is a **separate networked container** with a single writable staging
definition directory. It has no documents or application secrets. FreshClam
downloads official CVDs, load-tests them, and `sigtool --info` verifies each CVD
before publication. Scripted updates are disabled so published files remain
signed CVD archives, rather than unpacked CLD databases. Signed official bytecode
remains enabled; unsigned databases/bytecode are not accepted by the scanner.

The default root is `.local/scanner`, with owner-only directories. Each update
creates a new UUID under `definitions/`, containing exactly `bytecode.cvd`,
`daily.cvd`, `main.cvd`, and `manifest.json`. Published files are mode 0400.
Directories remain 0700 for macOS compatibility. Snapshots are immutable by the
publisher's new-UUID contract; a trusted owner can still change permissions.
The mode-0600 `current.json` pointer is atomically replaced only after files and
directories have been flushed. Previous snapshots are preserved.

`readScannerDefinitions()` rejects links, hard links, foreign ownership,
permission drift, noncanonical/duplicate-key JSON, unknown fields or files,
incorrect image/version identity, and hash/header mismatches. It streams at most
512 MiB across all databases, uses bounded metadata reads, and checks file
identity before and after each read. CVD versions and dates must agree with the
actual 512-byte archive headers. Confirmation expires after 24 hours; daily
definitions expire after 48 hours. Future timestamps are rejected. Expiry means
unavailable, not a clean scan. `readScannerDefinitionsForUpdate()` ignores only
expiry so the updater can reuse old verified CVDs; it never authorizes scanning.

The updater records a private operation journal **before** requesting container
creation. SIGINT/SIGTERM stops the attached client and independently removes only
the exact container matching the journal's name, owner label, and image. An
unknown Docker outcome retains `.update-lock/operation.json` and blocks another
update. An operator must reconcile that exact journal with Docker and prove the
container removed before clearing the lock. Never delete a lock merely because
an immediate container listing is empty. Pending directories and prior
snapshots remain available for investigation; no automatic pruning runs.

## Evidence and sources

On the current Apple Silicon host, real isolated AV scans of a small synthetic
PDF and the standard EICAR test string returned `clean` in 5.64 seconds and
`malware` in 5.58 seconds respectively; empty input returned `unsupported` in
0.17 seconds. These are small-fixture timings, not a throughput or maximum-size
guarantee. The first official snapshot totaled 112,796,581 bytes; a full warm
hash/header validation took approximately 77 ms. Unit tests exercise snapshot
validation, atomic publication, cache reuse, failure preservation, and uncertain
creation without downloading definitions.

Primary references:

- [Official Docker guidance and memory requirements](https://docs.clamav.net/manual/Installing/Docker.html)
- [Official signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html)
- [ClamAV 1.4.6 scanner options](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.6/docs/man/clamscan.1.in)
- [ClamAV 1.4.6 FreshClam configuration](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.6/etc/freshclam.conf.sample)
- [Official Debian image](https://hub.docker.com/r/clamav/clamav-debian)
