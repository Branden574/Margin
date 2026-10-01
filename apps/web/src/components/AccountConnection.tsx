import { useEffect, useRef, useState } from 'react';
import { lockVault } from '../lib/vault';

interface AccountSession {
  authenticated: true;
  sessionId: string;
  userId: string;
  organizationId: string;
  role: string;
  expiresAt: number;
  csrfToken: string;
}
interface SessionSummary {
  sessionId: string;
  organizationId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  current: boolean;
}

/** Explicit account connection. Existing local documents are never silently adopted. */
export function AccountConnection() {
  const [mode, setMode] = useState<'unchecked' | 'local' | 'oidc'>('unchecked');
  const [session, setSession] = useState<AccountSession | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [organization, setOrganization] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.any([abort.current!.signal, AbortSignal.timeout(10_000)]),
      headers: { ...options.headers, ...(session ? { 'X-CSRF-Token': session.csrfToken } : {}) },
    });
    if (response.status === 401) {
      setSession(null);
      setSessions([]);
      if (path === '/api/auth/session') return null;
    }
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result?.error?.message ?? 'The account service could not complete this request.',
      );
    return result;
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      if (!abort.current.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'The account service is unavailable.');
    } finally {
      if (!abort.current.signal.aborted) setBusy(false);
    }
  }
  function check() {
    void run(async () => {
      const health = await request('/api/health');
      if (health?.authentication !== 'oidc-session') {
        setMode('local');
        setSession(null);
        setSessions([]);
        return;
      }
      setMode('oidc');
      const current = await request('/api/auth/session');
      setSession(current);
      setSessions(current ? (await request('/api/auth/sessions')).sessions : []);
    });
  }
  return (
    <section className="settings-section">
      <div className="settings-intro">
        <h2>Organization account</h2>
        <p>Connect through your school’s identity provider.</p>
      </div>
      <div className="settings-controls">
        <p className="field-note">
          Your files stay in this private device workspace. Organization sign-in does not upload
          them. Cloud document synchronization is not connected yet.
        </p>
        <button className="button secondary" disabled={busy} onClick={check}>
          {busy ? 'Checking account…' : 'Check account connection'}
        </button>
        {mode === 'local' ? (
          <p role="status">
            Organization sign-in is not configured on this server. Your local workspace remains
            available.
          </p>
        ) : null}
        {mode === 'oidc' && !session ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const parameters = new URLSearchParams({ returnTo: '/' });
              if (organization.trim()) parameters.set('organizationId', organization.trim());
              window.location.assign(`/api/auth/login?${parameters}`);
            }}
          >
            <label>
              Organization ID (if supplied by your administrator)
              <input
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
                maxLength={36}
                pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                autoComplete="off"
              />
            </label>
            <p className="field-note">
              Sign-in opens your configured identity provider. After returning, unlock this device
              workspace with its existing passphrase.
            </p>
            <button className="button primary" disabled={busy}>
              Sign in with your organization
            </button>
          </form>
        ) : null}
        {session ? (
          <>
            <p role="status">Signed in · {session.role.replaceAll('_', ' ')}</p>
            <p className="field-note">
              Organization: {session.organizationId}. Session expires{' '}
              {new Date(session.expiresAt).toLocaleString()}.
            </p>
            <h3>Active sessions</h3>
            <ul className="account-sessions">
              {sessions.map((item) => (
                <li key={item.sessionId}>
                  <span>
                    {item.current ? 'This session' : 'Another signed-in session'}
                    <small>Last active {new Date(item.lastSeenAt).toLocaleString()}</small>
                  </span>
                  {!item.current ? (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await request(
                            `/api/auth/sessions/${encodeURIComponent(item.sessionId)}`,
                            { method: 'DELETE' },
                          );
                          setSessions((previous) =>
                            previous.filter((entry) => entry.sessionId !== item.sessionId),
                          );
                        })
                      }
                    >
                      Revoke session
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request('/api/auth/logout', { method: 'POST' });
                  setSession(null);
                  setSessions([]);
                  await lockVault();
                })
              }
            >
              Sign out and lock workspace
            </button>
          </>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
