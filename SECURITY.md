# Security

Margin is a local development foundation. Do not expose the local API publicly or use this repository as evidence of school privacy compliance. The implemented controls and their boundaries are described in [local security](docs/LOCAL_SECURITY.md), [backend security](docs/security-backend.md) and [release gates](docs/PRODUCTION_READINESS.md).

## Reporting

Report a vulnerability privately to the repository owner through an established private channel. If GitHub private vulnerability reporting is enabled for this repository, use its Security tab. Do not put document contents, student information, real tokens or encryption keys in public issues. This repository does not yet have a staffed incident-response service or a guaranteed response time.

## Dependency policy

Direct dependency versions and the lockfile are committed. CI installs with `npm ci`, audits known high/critical advisories, generates a CycloneDX inventory and pins GitHub Actions by commit. Dependabot is configured for weekly dependency update pull requests. Review security advisories and update parser/crypto/platform dependencies promptly; a clean audit does not prove the absence of vulnerabilities. Do not install remotely supplied runtime scripts into the extension.

## Development incident procedure

1. Stop the affected local service and stop importing new material. Lock the vault when doing so will not lose unsaved work. Preserve minimal encrypted evidence with restricted access.
2. Revoke the affected local API token and restart with a new token. Investigate whether browser scripts, extensions or the host were compromised. Never assume encrypted at-rest data stayed private while the compromised workspace was unlocked.
3. If the server master key is suspected exposed, preserve an encrypted recovery snapshot with its required key under separate restricted custody. Provision a new key and re-encrypt through a reviewed migration. Replacing `.local/api.env` alone makes existing ciphertext unreadable and is not a key-rotation procedure.
4. Identify affected data and access from content-free correlation logs. These local logs are not tamper-resistant audit evidence. The local build has no automated account revocation, cross-device key revocation or remote deletion.
5. Repair, repeat the relevant regression tests, and verify recovery from encrypted exports/snapshots before resuming. Coordinate any contractual or legal notifications with the responsible organization; this repository does not supply that process.

## Production prerequisites

A deployed service needs managed identity/MFA/SSO, document grants, managed KMS and rotation, tenant-scoped private object storage, isolated parsing and malware scanning, immutable audit storage, tested backup/restore, retention/deletion jobs, monitoring and response ownership, independent penetration testing, and school privacy review. Browser workers are not a substitute for OS-isolated document processing. None of these operational services is provisioned by local setup.
