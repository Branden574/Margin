import { CheckCircle2, Send } from 'lucide-react';
import type { ReadonlyWorkValue, StudentWorkState } from '../lib/assignment-work/controllerTypes';

export function CanvasSubmissionStatus({
  state,
  disabled,
  submit,
  check,
  continueDraft,
}: {
  state: ReadonlyWorkValue<StudentWorkState>;
  disabled: boolean;
  submit(): void;
  check(): void;
  continueDraft(): void;
}) {
  const record = state.submissionRecord;
  const captured = record?.outcome?.state === 'captured' ? record.outcome.submission : null;
  const listed = state.submissionHistory[0];
  const status =
    captured && (!listed || listed.id !== captured.id || captured.revision >= listed.revision)
      ? captured
      : listed;
  const rejected = record?.outcome?.state === 'rejected' ? record.outcome : null;
  const prepared = record?.barrier && !record.outcome;
  const confirmed = status?.phase === 'confirmed';
  const descriptions = {
    processing: 'Preparing submission. Not submitted to Canvas yet.',
    queued: 'Waiting for Canvas. Delivery has not been confirmed.',
    sending: 'Sending the saved submission version to Canvas.',
    uncertain: 'Canvas delivery is awaiting confirmation. Your saved version is kept.',
    failed: 'Canvas could not receive this submission. Your saved version is kept.',
    confirmed: status?.confirmedAt
      ? `Submitted to Canvas at ${new Date(status.confirmedAt).toLocaleString()}.`
      : '',
  };
  return (
    <section className="canvas-submission" aria-label="Canvas submission">
      <div className="canvas-submission-copy" role="status">
        <strong>
          {confirmed ? (
            <>
              <CheckCircle2 size={16} aria-hidden="true" /> Submitted to Canvas
            </>
          ) : status ? (
            'Submission version saved'
          ) : prepared ? (
            'Confirm your saved submission request'
          ) : rejected?.state === 'rejected' && record?.barrier ? (
            'Submission was not created'
          ) : (
            'Submit your assignment'
          )}
        </strong>
        <p>
          {status
            ? descriptions[status.phase]
            : prepared
              ? 'The result is not confirmed. Editing is paused while you recover this exact request.'
              : rejected && record?.barrier
                ? rejected.code === 'cursor_changed'
                  ? 'Newer saved edits arrived before submission. Continue your draft to synchronize them.'
                  : 'A submission already exists. Continue your draft and check submission status.'
                : state.submissionAvailability === 'unavailable'
                  ? 'Submission is not configured for this Canvas launch. Your saved edits remain available.'
                  : 'All edits must be saved and synchronized before a submission version can be preserved.'}
        </p>
        {status && (
          <small>
            {record?.barrier
              ? 'Continue your draft when ready. Later edits will not change this submission version.'
              : 'Later draft edits are separate from this submission version. Additional attempts are not available yet.'}
          </small>
        )}
        {state.submissionError && state.submissionAvailability !== 'unavailable' && (
          <p className="canvas-work-error">{state.submissionError.message}</p>
        )}
      </div>
      <div className="canvas-work-actions">
        {prepared ? (
          <button className="editor-secondary" disabled={disabled} onClick={submit}>
            Confirm saved submission
          </button>
        ) : !record?.barrier && !status && state.submissionAvailability === 'available' ? (
          <button
            className="editor-primary"
            disabled={disabled || !!state.localError}
            onClick={submit}
          >
            <Send size={14} aria-hidden="true" /> Submit assignment
          </button>
        ) : null}
        {record?.barrier && record.outcome && (
          <button className="editor-secondary" disabled={disabled} onClick={continueDraft}>
            Continue draft
          </button>
        )}
        <button className="editor-secondary" disabled={disabled} onClick={check}>
          {status || record ? 'Check submission status' : 'Check submission availability'}
        </button>
      </div>
    </section>
  );
}
