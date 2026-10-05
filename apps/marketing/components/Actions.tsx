'use client';
import { useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, Chrome, Copy, Download, X } from 'lucide-react';
import { workspaceUrl } from '../lib/config';
export function WebAppLink({
  className = 'button secondary',
  children = 'Try the web app',
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a className={className} href={workspaceUrl}>
      {children}
      <ArrowUpRight size={16} />
    </a>
  );
}
export function AccessButton({
  kind = 'install',
  className = 'button primary',
  children,
}: {
  kind?: 'install' | 'access' | 'district';
  className?: string;
  children?: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [school, setSchool] = useState('');
  const [focus, setFocus] = useState('Document editing and recovery');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const brief = `Margin school evaluation brief\n\nOrganization: ${school || 'Not specified'}\nEvaluation focus: ${focus}\n\nReview: local PDF editing, encrypted storage, recovery, accessibility, and Chromebook behavior. Local OCR recognizes printed English one page at a time and stores recognized text encrypted beside the original PDF for selection, copy, search, highlighting, and read aloud with available local voices.\nPlanned capabilities to discuss: batch OCR, other OCR languages, translation, searchable-PDF export, hosted OCR, school identity, collaboration, LMS integration, managed policies, and production data protection.\n\nThis brief is prepared locally. It has not been submitted or sent to anyone.\n`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(brief);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([brief], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'margin-school-evaluation.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <button className={className} onClick={() => dialog.current?.showModal()}>
        {children ||
          (kind === 'install' ? (
            <>
              <Chrome size={17} />
              Add to Chrome
            </>
          ) : kind === 'district' ? (
            'Request a school demo'
          ) : (
            'Sign in'
          ))}
      </button>
      <dialog
        className="access-dialog"
        ref={dialog}
        aria-labelledby={title}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <button
          className="dialog-close icon-control"
          aria-label="Close dialog"
          onClick={() => dialog.current?.close()}
        >
          <X size={21} />
        </button>
        <span className="eyebrow">
          {kind === 'district' ? 'LET’S ASK BETTER QUESTIONS' : 'THE LOCAL EDITION'}
        </span>
        <h2 id={title}>
          {kind === 'install'
            ? 'A small extension.\nAn open door.'
            : kind === 'access'
              ? 'Your workspace, on this device.'
              : 'Build your evaluation brief.'}
        </h2>
        {kind === 'install' ? (
          <>
            <p>
              Margin’s extension is available to load locally from this project. There is no Chrome
              Web Store listing yet.
            </p>
            <ol className="setup-steps">
              <li>Start the Margin web workspace and complete its HTTPS certificate setup.</li>
              <li>
                In Chrome, open <code>chrome://extensions</code> and enable Developer mode.
              </li>
              <li>
                Choose <strong>Load unpacked</strong> and select <code>apps/extension</code> from
                your project checkout.
              </li>
              <li>Pin Margin. Open an ordinary HTTPS PDF link, then choose Margin.</li>
            </ol>
            <p className="fine-print">
              Requires the project source and a running workspace. The extension asks for activeTab,
              contextMenus, and storage; no broad website permissions.
            </p>
            <WebAppLink />
          </>
        ) : kind === 'access' ? (
          <>
            <p>
              This edition uses a private local vault, not an online account. Open the web app to
              create or unlock your workspace with your passphrase.
            </p>
            <p className="fine-print">
              School accounts and managed sign-in are planned. The local app must be running; no
              remote service is implied.
            </p>
            <WebAppLink />
          </>
        ) : (
          <>
            <p>
              School demos aren’t scheduled automatically. Prepare a brief to share with your
              project contact. Nothing is sent from this page.
            </p>
            <label>
              School or organization
              <input
                value={school}
                onChange={(e) => {
                  setSchool(e.target.value);
                  setCopied(false);
                  setCopyError(false);
                }}
                maxLength={120}
                placeholder="Optional — stays in this tab"
              />
            </label>
            <label>
              What would you like to evaluate?
              <select
                value={focus}
                onChange={(e) => {
                  setFocus(e.target.value);
                  setCopied(false);
                  setCopyError(false);
                }}
              >
                <option>Document editing and recovery</option>
                <option>Student accessibility</option>
                <option>Security and district deployment</option>
                <option>Teacher assignment workflows</option>
              </select>
            </label>
            <div className="button-row">
              <button className="button primary" onClick={copy}>
                {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
                {copied ? 'Copied' : 'Copy brief'}
              </button>
              <button className="button secondary" onClick={download}>
                <Download size={16} />
                Download brief
              </button>
            </div>
            {copyError && <p role="status">Clipboard unavailable. Download the brief instead.</p>}
          </>
        )}
      </dialog>
    </>
  );
}
