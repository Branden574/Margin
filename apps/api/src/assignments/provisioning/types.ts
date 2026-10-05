/** Internal worker contract. Never accept a claim or prepared ticket from an HTTP caller. */
export interface StudentWorkClaim {
  workId: string;
  claimId: string;
  token: string;
  attempt: number;
  expiresAt: number;
}
export interface StudentWorkCompletion {
  workId: string;
  documentId: string;
  versionId: string;
  status: 'provisioned';
  duplicate: boolean;
}
/** Opaque, process-local, short-lived capability; only the issuing repository can consume it. */
export interface PreparedStudentWork {
  readonly kind: 'prepared-student-work';
}
export class StudentWorkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StudentWorkError';
  }
}
