import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FormValue, PdfFormChange, PdfFormInspection } from './formTypes';
import './forms.css';

export function FormsDialog({
  inspection,
  busy,
  error,
  onSave,
  onClose,
  onDirtyChange,
}: {
  inspection: PdfFormInspection;
  busy: boolean;
  error: string;
  onSave: (changes: PdfFormChange[]) => Promise<void>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    Object.fromEntries(inspection.fields.map((field) => [field.name, field.value])),
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const changes = inspection.fields
    .filter((field) => JSON.stringify(field.value) !== JSON.stringify(values[field.name]))
    .map((field) => ({ name: field.name, value: values[field.name] }));
  useEffect(() => {
    onDirtyChange(changes.length > 0);
  }, [changes.length, onDirtyChange]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      previous?.focus();
    };
  }, []);
  const close = () => {
    if (busy) return;
    if (changes.length) setConfirmDiscard(true);
    else onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="editor-dialog forms-dialog"
      aria-labelledby="forms-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && changes.length) void onSave(changes);
        }}
      >
        <div className="editor-dialog-heading">
          <h2 id="forms-title">Fill PDF form</h2>
          <button
            type="button"
            className="editor-icon"
            aria-label="Close form editor"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          Update the document’s existing fields, then save them together. Changes stay private on
          this device and can be undone in one step.
        </p>
        {!inspection.fields.length ? (
          <p role="status">
            This PDF has no supported fillable fields. Use the Text tool to add an annotation to a
            flat worksheet.
          </p>
        ) : (
          <div className="forms-fields">
            {inspection.fields.map((field, index) => {
              const id = `pdf-form-field-${index}`;
              const value = values[field.name];
              const disabled = busy || field.readOnly;
              const change = (next: FormValue) => {
                setConfirmDiscard(false);
                setValues((old) => ({ ...old, [field.name]: next }));
              };
              return (
                <div className="forms-field" key={field.name}>
                  <label htmlFor={id}>
                    {field.label}
                    {field.required ? ' (required)' : ''}
                    {field.readOnly ? ' · read-only' : ''}
                  </label>
                  {field.kind === 'checkbox' ? (
                    <input
                      id={id}
                      type="checkbox"
                      checked={value === true}
                      disabled={disabled}
                      aria-required={field.required || undefined}
                      onChange={(event) => change(event.target.checked)}
                    />
                  ) : field.kind === 'text' ? (
                    field.multiline ? (
                      <textarea
                        id={id}
                        value={value as string}
                        maxLength={field.maxLength}
                        disabled={disabled}
                        aria-required={field.required || undefined}
                        rows={3}
                        onChange={(event) => change(event.target.value)}
                      />
                    ) : (
                      <input
                        id={id}
                        value={value as string}
                        maxLength={field.maxLength}
                        disabled={disabled}
                        aria-required={field.required || undefined}
                        onChange={(event) => change(event.target.value)}
                      />
                    )
                  ) : (
                    <select
                      id={id}
                      disabled={disabled}
                      aria-required={field.required || undefined}
                      multiple={field.multiselect}
                      value={value as string | string[]}
                      size={field.multiselect ? Math.min(6, field.options!.length) : undefined}
                      onChange={(event) =>
                        change(
                          field.multiselect
                            ? Array.from(event.target.selectedOptions, (option) => option.value)
                            : event.target.value,
                        )
                      }
                    >
                      {!field.multiselect && (
                        <option
                          value=""
                          disabled={
                            field.kind === 'radio' && !field.allowClear && Boolean(field.value)
                          }
                        >
                          Choose an option
                        </option>
                      )}
                      {field.options!.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  )}
                  {field.multiselect && (
                    <span className="forms-hint">
                      Hold Command on Mac or Control on Windows to choose multiple options.
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && (
          <p role="alert" className="forms-error">
            {error}
          </p>
        )}
        {confirmDiscard && (
          <div className="forms-discard" role="alert">
            <p>Your form changes have not been saved.</p>
            <button
              type="button"
              className="editor-secondary"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
            <button type="button" className="editor-secondary" onClick={onClose}>
              Discard changes
            </button>
          </div>
        )}
        <div className="editor-dialog-actions">
          <button type="button" className="editor-secondary" disabled={busy} onClick={close}>
            {inspection.fields.length ? 'Cancel' : 'Close'}
          </button>
          {!!inspection.fields.length && (
            <button className="editor-primary" type="submit" disabled={busy || !changes.length}>
              {busy ? 'Saving form…' : 'Save form changes'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
