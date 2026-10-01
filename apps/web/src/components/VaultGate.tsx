import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck, Loader2, BookOpen, Eye, EyeOff } from 'lucide-react';
import { Brand } from './Brand';
import { createVault, unlockVault, vaultStatus } from '../lib/vault';
export function VaultGate({ children }: { children: ReactNode }) {
  const [locking, setLocking] = useState(false);
  const [status, setStatus] = useState<'new' | 'locked' | 'unlocked' | 'loading'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const lockingChange = (event: Event) =>
      setLocking(
        Boolean(
          (event as CustomEvent<{ active?: boolean; locking?: boolean }>).detail?.active ??
            (event as CustomEvent<{ locking?: boolean }>).detail?.locking,
        ),
      );
    window.addEventListener('margin-vault-locking', lockingChange);
    void vaultStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)));
    const change = (event: Event) => {
      setError((event as CustomEvent<{ error?: string }>).detail?.error || '');
      void vaultStatus().then(setStatus);
    };
    window.addEventListener('margin-vault-change', change);
    return () => {
      window.removeEventListener('margin-vault-change', change);
      window.removeEventListener('margin-vault-locking', lockingChange);
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const data = new FormData(e.currentTarget);
    const passphrase = String(data.get('passphrase'));
    if (status === 'new' && passphrase !== String(data.get('confirm'))) {
      setError('The passphrases do not match. Try them again.');
      return;
    }
    setBusy(true);
    try {
      if (status === 'new') await createVault(passphrase);
      else await unlockVault(passphrase);
      setStatus('unlocked');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The workspace could not be unlocked.');
    } finally {
      setBusy(false);
    }
  }
  if (status === 'unlocked')
    return (
      <>
        <div inert={locking} aria-hidden={locking || undefined}>
          {children}
        </div>
        {error && (
          <div className="vault-notice" role="alert">
            <p>{error}</p>
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        {locking && (
          <div className="vault-locking-overlay" role="status">
            <LockKeyhole size={28} />
            <h2>Saving and locking your workspace…</h2>
            <p>Waiting for open tabs to finish saving.</p>
          </div>
        )}
      </>
    );
  if (status === 'loading')
    return (
      <div className="app-loading">
        <Brand />
        <Loader2 className="spin" size={20} />
        {error && <p role="alert">{error}</p>}
      </div>
    );
  return (
    <main className="vault-gate">
      <div className="vault-brand">
        <Brand />
        <span>ROOM FOR YOUR IDEAS</span>
      </div>
      <div className="vault-layout">
        <section className="vault-story">
          <div className="eyebrow">A MORE THOUGHTFUL WORKSPACE</div>
          <h1>
            A little space.
            <br />
            <em>Endless possibility.</em>
          </h1>
          <p>
            Read with curiosity. Write in the margins.
            <br />
            Keep your work close, and your ideas yours.
          </p>
          <div className="vault-art" aria-hidden="true">
            <div className="vault-paper paper-back">
              <span>IDEAS TAKE SHAPE HERE</span>
              <svg viewBox="0 0 180 180" fill="none">
                <path
                  d="M20 90h140M90 20v140M40 140Q90-40 140 140"
                  stroke="#839b86"
                  strokeWidth="1.2"
                />
                <circle cx="90" cy="50" r="5" fill="#a1b490" />
              </svg>
            </div>
            <div className="vault-paper paper-front">
              <span>NOTES TO MY FUTURE SELF</span>
              <strong>
                Keep asking
                <br />
                good questions.
              </strong>
              <i />
              <i />
              <i />
              <div className="drawn-circle">what if?</div>
            </div>
            <div className="vault-seal">
              <BookOpen size={24} strokeWidth={1.2} />
            </div>
          </div>
          <div className="vault-story-footer">
            <span />A calmer place for your documents.
          </div>
        </section>
        <section className="vault-form-panel" aria-labelledby="vault-heading">
          <span className="vault-lock-icon">
            <LockKeyhole size={25} strokeWidth={1.4} />
          </span>
          <h2 id="vault-heading">
            {status === 'new' ? 'Make this space yours.' : 'Welcome back to Margin.'}
          </h2>
          <p>
            {status === 'new'
              ? 'Create a passphrase to encrypt this browser’s workspace.'
              : 'Unlock your private workspace to pick up where you left off.'}
          </p>
          <form onSubmit={submit} className="form-stack">
            <label>
              Workspace passphrase
              <div className="password-field">
                <input
                  name="passphrase"
                  type={visible ? 'text' : 'password'}
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete={status === 'new' ? 'new-password' : 'current-password'}
                  autoFocus
                  placeholder={
                    status === 'new' ? 'At least 12 characters' : 'Enter your workspace passphrase'
                  }
                />
                <button
                  type="button"
                  aria-label={visible ? 'Hide passphrase' : 'Show passphrase'}
                  onClick={() => setVisible((v) => !v)}
                >
                  {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            {status === 'new' && (
              <label>
                Confirm passphrase
                <input
                  name="confirm"
                  type="password"
                  required
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                  placeholder="Enter it once more"
                />
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary vault-submit" disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={17} className="spin" />
                  {status === 'new' ? 'Creating your workspace…' : 'Unlocking…'}
                </>
              ) : (
                <>
                  {status === 'new' ? 'Create private workspace' : 'Unlock workspace'}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
          <div className="vault-privacy">
            <ShieldCheck size={17} />
            <p>
              Your documents are encrypted on this device. Your passphrase is never stored or sent
              to a server.
            </p>
          </div>
          <p className="vault-recovery">
            {status === 'new'
              ? 'Keep your passphrase somewhere safe. There is no password reset for this local vault.'
              : 'For shared devices, lock the workspace when you finish. Your passphrase is required each time you reopen it.'}
          </p>
          <div className="vault-local-label">
            LOCAL ENCRYPTED WORKSPACE <span>·</span> NO CLOUD ACCOUNT REQUIRED
          </div>
        </section>
      </div>
      <footer className="vault-footer">
        <span>Thoughtfully made for the way you learn.</span>
        <span>Margin · Local preview</span>
      </footer>
    </main>
  );
}
