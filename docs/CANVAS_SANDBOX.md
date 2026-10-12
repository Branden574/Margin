# Private Canvas development environment

For development without institutional administrator access, use a private Canvas instance under the project operator's control. Create synthetic teacher/student accounts and courses there, then repeat the workflow in an institution-approved staging environment before a school pilot. This is a project recommendation, not evidence that Margin has been installed in Canvas.

Instructure documents a [Docker development setup](https://github.com/instructure/canvas-lms/blob/master/doc/docker/getting_docker.md) and its [development environment](https://github.com/instructure/canvas-lms/blob/master/doc/docker/README.md). The macOS instructions require at least 8 GB of memory allocated to Docker. The documented default `http://canvas.docker` needs additional HTTPS configuration for Margin's strict issuer/endpoint checks. Do not deploy a development installation as the public school service.

The October 11 read-only environment check found Docker Desktop running on ARM64 with about 7.75 GiB allocated memory and 30 GiB of host disk space free. Existing unrelated containers were left running; no images were pulled or pruned. These are point-in-time measurements, not a demonstrated Canvas resource budget. The separate persistent Margin database/API/web startup was verified locally; Canvas itself is still not installed. No Canvas account, paid service, public tunnel or certificate trust change was made. The existing personal workspace remains at its original browser origin and retains its own encrypted vault.

## Margin prerequisites

The explicit [runtime factory](RUNTIME_COMPOSITION.md) now has a separate [persistent local startup path](CANVAS_LOCAL_STARTUP.md). Before connecting Canvas:

1. Create an isolated persistent PostgreSQL database/cluster for Margin; do not reuse an unrelated database listening on this Mac. Apply versioned migrations with an operator account and provision distinct restricted runtime/reader/worker logins with verified database TLS.
2. Persist independent session/lookup/resource secrets, a tool signing key and a development wrapping key outside Git. Use a dedicated encrypted artifact directory. The local filesystem adapter preserves authenticated exact-version receipts and never marks source files inspected.
3. Run the separate local startup after its protected configuration and database checks pass. It calls `createCanvasRuntime`, mounts its API services and schedules provisioning and materialization. LTI-only authentication avoids requiring a separate OIDC provider; it does not bypass signed launches, persisted identity links or current enrollment checks.
4. Connect teacher source intake to the inspection registry and a real isolated scanner/structure validator. Keep unknown uploaded files quarantined. The deterministic PDF inspector in tests accepts only a generated fixture and must never be enabled for user files.
5. Export the tool's public JWKS and register the exact HTTPS issuer, client ID, deployment ID, redirect/launch/Deep Linking targets and public signing key in the private Canvas instance. The operator must also provision the corresponding Margin installation/account/course mappings. Never infer identity by email or grant roles from the local teacher/student preference.

The local bootstrap/startup and sequential scheduling are implemented. Canvas installation and identity/course operator provisioning, source intake and scanning remain open. The default `npm run dev:api` still runs the encrypted local upload service. Use the separate `dev:canvas:api` command for the persistent LTI-only composition.

## HTTPS and network boundary

Use stable private HTTPS names and certificates trusted by each actual caller. A certificate trusted by the macOS browser is not automatically trusted by Node or a Canvas container. Add the appropriate private CA to those clients using supported trust configuration; never set `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable TLS verification. In a container, `127.0.0.1` refers to that container, not the host. Choose the registered tool URL and routing before generating the Canvas configuration.

Prefer private routing while using synthetic accounts. A public tunnel is not required for the initial locally controlled setup and would need an explicit exposure decision. Local filesystem/key providers remain development adapters; hosted school use requires managed storage/keys, reviewed operational access, backup/recovery, retention, scanning and load qualification.

## Required integration evidence

Verify actual signed teacher and student launches through Canvas, then teacher source selection/Deep Linking, separate student work, save/reopen/retry, frozen capture/preparation and author-only review. Repeat after restarting the API and storage, changing enrollment, revoking source access and expiring sessions. Check the teacher sees the frozen work and cannot access a later private student edit.

Teacher feedback release, rubric/grade handling and confirmed Canvas submission are further product work; a locally materialized capture is not a Canvas submission receipt. Institution-specific iframe/cookie behavior, administrator policies, scope grants and school devices must be tested in the later institution environment. A private sandbox pass would not establish 100,000-user capacity or production readiness.
