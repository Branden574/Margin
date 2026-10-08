import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresIdentityRepository } from '../apps/api/src/identity/postgres';
import { PostgresLmsRepository } from '../apps/api/src/lms/postgres';
import { PostgresAssignmentRepository } from '../apps/api/src/assignments';
import { PostgresStudentWorkProvisioner } from '../apps/api/src/assignments/provisioning';
import { PostgresIngestionRepository } from '../apps/api/src/ingestion';
import { SyncPool } from '../apps/api/src/sync/pool';
import { WorkPool } from '../apps/api/src/assignments/work/pool';
import { ReviewPool } from '../apps/api/src/assignments/review/pool';
import { PostgresSubmissionProcessor } from '../apps/api/src/assignments/submissions/processing/postgres';
import { submissionFixture as f } from './helpers/submission-fixture';
import { withAssignmentRoleMembership } from './helpers/provisioner-role';

async function rejectsMixedRole<T extends { close(): Promise<void> }>(
  repository: T,
  run: (repository: T) => Promise<unknown>,
  message: string,
) {
  try {
    await expect(run(repository)).rejects.toThrow(message);
  } finally {
    await repository.close();
  }
}

describe.skipIf(!f.available)(
  'reviewer credentials remain isolated from request and processor runtimes',
  () => {
    let assignment: Awaited<ReturnType<typeof f.ready>>;
    beforeAll(async () => {
      await f.boot({ review: true });
      // These assertions require the real migration-created reviewer role,
      // never the empty compatibility role used by older migration fixture suites.
      expect(
        (
          await f.admin.query(
            "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='margin_submission_reviewer'",
          )
        ).rows,
      ).toEqual([
        {
          rolcanlogin: false,
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        },
      ]);
      assignment = await f.ready();
    }, 30000);
    afterAll(() => f.stop());
    it.each(
      [
        'margin_identity_runtime',
        'margin_lms_runtime',
        'margin_sync_runtime',
        'margin_sync_provisioner',
        'margin_assignments_runtime',
        'margin_ingestion_runtime',
        'margin_ingestion_inspector',
        'margin_ingestion_reader',
        'margin_assignment_provisioner',
        'margin_assignment_work_runtime',
        'margin_submission_runtime',
        'margin_submission_processor',
      ].flatMap((runtime) => [true, false].map((inherit) => ({ runtime, inherit }))),
    )(
      'rejects reviewer membership on $runtime inherited=$inherit',
      async ({ runtime, inherit }) => {
        await withAssignmentRoleMembership(
          f.admin,
          f.config('postgres'),
          runtime,
          'margin_submission_reviewer',
          inherit,
          async (unsafe) => {
            if (runtime === 'margin_identity_runtime')
              await rejectsMixedRole(
                new PostgresIdentityRepository(unsafe),
                (repository) => repository.findIdentity('a'.repeat(64)),
                'mixed application role',
              );
            else if (runtime === 'margin_lms_runtime')
              await rejectsMixedRole(
                new PostgresLmsRepository(unsafe, randomBytes(32)),
                (repository) => repository.findById(randomUUID()),
                'must not',
              );
            else if (runtime === 'margin_sync_runtime' || runtime === 'margin_sync_provisioner') {
              const run = vi.fn(async () => undefined);
              await rejectsMixedRole(
                new SyncPool(unsafe, runtime === 'margin_sync_runtime' ? 'runtime' : 'provisioner'),
                (repository) => repository.transaction(undefined, run),
                'dedicated',
              );
              expect(run).not.toHaveBeenCalled();
            } else if (runtime === 'margin_assignments_runtime')
              await rejectsMixedRole(
                new PostgresAssignmentRepository(unsafe, f.kms),
                (repository) =>
                  repository.get(
                    assignment.teacherP,
                    assignment.enrollment(assignment.teacherP),
                    assignment.assignment.id,
                  ),
                'least-privilege',
              );
            else if (runtime === 'margin_ingestion_runtime')
              await rejectsMixedRole(
                new PostgresIngestionRepository(unsafe, f.kms, 'runtime'),
                (repository) =>
                  repository.get(assignment.teacherP, assignment.source.identity.artifactId),
                'least-privilege',
              );
            else if (runtime === 'margin_ingestion_inspector')
              await rejectsMixedRole(
                new PostgresIngestionRepository(unsafe, f.kms, 'inspector'),
                (repository) => repository.claimNext(),
                'least-privilege',
              );
            else if (runtime === 'margin_ingestion_reader')
              await rejectsMixedRole(
                new PostgresIngestionRepository(unsafe, f.kms, 'reader'),
                (repository) => repository.readySnapshot(assignment.manifest.source),
                'least-privilege',
              );
            else if (runtime === 'margin_assignment_provisioner')
              await rejectsMixedRole(
                new PostgresStudentWorkProvisioner(unsafe, f.kms),
                (repository) => repository.claimNext(),
                'least-privilege',
              );
            else if (
              runtime === 'margin_assignment_work_runtime' ||
              runtime === 'margin_submission_runtime'
            ) {
              const work = vi.fn(async () => undefined);
              await rejectsMixedRole(
                new WorkPool(unsafe, runtime),
                (repository) => repository.transaction(assignment.studentP, work),
                'least-privilege',
              );
              expect(work).not.toHaveBeenCalled();
            } else if (runtime === 'margin_submission_processor') {
              const processor = new PostgresSubmissionProcessor(unsafe, f.kms);
              try {
                await expect(processor.claimNext()).rejects.toMatchObject({
                  code: 'dedicated_processor_credentials_required',
                });
              } finally {
                await processor.close();
              }
            } else throw new Error('Missing runtime test implementation.');
            // The reviewer also refuses these credentials before running any content query.
            const review = new ReviewPool(unsafe),
              run = vi.fn(async () => undefined);
            try {
              await expect(review.transaction(assignment.teacherP, run)).rejects.toThrow(
                'dedicated least-privilege',
              );
              expect(run).not.toHaveBeenCalled();
            } finally {
              await review.close();
            }
          },
        );
      },
    );
  },
);
