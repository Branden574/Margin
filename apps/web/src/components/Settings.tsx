import { useState } from 'react';
import {
  Monitor,
  Moon,
  Contrast,
  ShieldCheck,
  HardDrive,
  Download,
  Check,
  Keyboard,
  Eye,
  CloudUpload,
  CheckCircle2,
  Link2,
} from 'lucide-react';
import type { Preferences, DocumentRecord } from '@margin/core';
import { fileSize, downloadBlob } from '../lib/format';
import { encryptExport } from '../lib/vault';
interface Props {
  preferences: Preferences;
  onSave: (p: Preferences) => Promise<void>;
  documents: DocumentRecord[];
  token: string;
  onToken: (v: string) => void;
  onHelp: () => void;
}
export function Settings({ preferences, onSave, documents, token, onToken, onHelp }: Props) {
  const [name, setName] = useState(preferences.name);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function update(p: Preferences) {
    try {
      setError('');
      await onSave(p);
      setMessage('Preferences saved to this browser.');
      setTimeout(() => setMessage(''), 3500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preferences could not be saved.');
    }
  }
  return (
    <div className="library-page settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE YOURSELF AT HOME</div>
          <h1>Workspace settings</h1>
          <p>A workspace that works the way you do.</p>
        </div>
      </div>
      <div className="settings-sections">
        <section className="settings-section">
          <div className="settings-intro">
            <h2>Your profile</h2>
            <p>Personalize this local workspace.</p>
          </div>
          <div className="settings-controls">
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void update({ ...preferences, name: name.trim() });
              }}
            >
              <label>
                Display name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              <button className="button secondary" type="submit">
                Save name
              </button>
            </form>
            <label>
              Workspace view
              <select
                value={preferences.role}
                onChange={(e) =>
                  void update({ ...preferences, role: e.target.value as Preferences['role'] })
                }
              >
                <option value="teacher">Teacher</option>
                <option value="student">Student</option>
              </select>
            </label>
            <p className="field-note">
              Changes the tools you see. This local preference does not grant access permissions.
            </p>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-intro">
            <h2>Appearance</h2>
            <p>Find your comfortable contrast.</p>
          </div>
          <div className="settings-controls">
            <div className="theme-options">
              {(
                [
                  { id: 'light', label: 'Light', icon: Monitor },
                  { id: 'dark', label: 'Dark', icon: Moon },
                  { id: 'contrast', label: 'High contrast', icon: Contrast },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  className={`theme-option ${preferences.theme === id ? 'active' : ''}`}
                  onClick={() => void update({ ...preferences, theme: id })}
                  key={id}
                >
                  <span className={`theme-preview preview-${id}`}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <Icon size={15} />
                    {label}
                    {preferences.theme === id && <Check size={14} />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-intro">
            <h2>Reading & accessibility</h2>
            <p>Small adjustments that make a difference.</p>
          </div>
          <div className="settings-controls">
            <Toggle
              label="Comfortable reading font"
              description="Use a spacious, rounded font throughout the workspace."
              checked={preferences.dyslexiaFont}
              onChange={(v) => void update({ ...preferences, dyslexiaFont: v })}
              icon={<Eye size={18} />}
            />
            <Toggle
              label="Reduce motion"
              description="Keep transitions and movement to a minimum."
              checked={preferences.reducedMotion}
              onChange={(v) => void update({ ...preferences, reducedMotion: v })}
              icon={<Monitor size={18} />}
            />
            <Toggle
              label="Keyboard shortcuts"
              description="Quick access to tools and the command palette."
              checked={preferences.shortcuts}
              onChange={(v) => void update({ ...preferences, shortcuts: v })}
              icon={<Keyboard size={18} />}
            />
            <button className="text-button" onClick={onHelp}>
              View keyboard shortcuts →
            </button>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-intro">
            <h2>Documents & storage</h2>
            <p>Your work stays close to you.</p>
          </div>
          <div className="settings-controls">
            <div className="storage-detail">
              <HardDrive size={22} />
              <div>
                <strong>
                  {fileSize(documents.reduce((n, d) => n + d.size, 0))} stored locally
                </strong>
                <p>{documents.length} documents in this browser</p>
              </div>
              <span className="status-label">Local</span>
            </div>
            <p className="field-note">
              Documents, annotations, and metadata are encrypted in this device’s IndexedDB.
              Clearing browser data removes local files. Export encrypted .margin files from the
              editor to keep a separate copy.
            </p>
            <button
              className="button secondary"
              onClick={() =>
                void encryptExport(
                  new Blob(
                    [
                      JSON.stringify(
                        { exportedAt: new Date().toISOString(), documents, preferences },
                        null,
                        2,
                      ),
                    ],
                    { type: 'application/json' },
                  ),
                  { name: 'workspace-index.json', mimeType: 'application/json' },
                )
                  .then((blob) => downloadBlob(blob, `margin-index-${Date.now()}.margin`))
                  .catch((e) => setError(String(e)))
              }
            >
              <Download size={15} />
              Export encrypted index
            </button>
            <p className="field-note">
              The index includes document metadata and preferences; PDF content and annotations are
              exported as encrypted .margin files from each document.
            </p>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-intro">
            <h2>Encrypted server storage</h2>
            <p>Optional resumable document uploads.</p>
          </div>
          <div className="settings-controls">
            <label>
              Server access token
              <input
                type="password"
                autoComplete="off"
                placeholder="Paste the token from your local API server"
                value={token}
                onChange={(e) => onToken(e.target.value)}
              />
            </label>
            <p className="field-note">
              Start the companion API with <code>npm run dev:api</code>, then use “Upload encrypted
              copy” in a document’s menu. The token is held only in memory until you lock or
              refresh. Uploads use verified resumable chunks over HTTPS and remain quarantined until
              a scanner is connected. Annotation cloud sync is not connected.
            </p>
            <div className="privacy-line">
              <ShieldCheck size={16} />
              <span>{token ? 'Server token set for this session' : 'No server connected'}</span>
            </div>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-intro">
            <h2>Integrations</h2>
            <p>A considered foundation for your classroom.</p>
          </div>
          <div className="settings-controls">
            <div className="integration-row">
              <Link2 size={21} />
              <div>
                <strong>Margin for Chrome</strong>
                <p>Open a document link in your workspace.</p>
              </div>
              <button className="text-button" onClick={onHelp}>
                Setup guide →
              </button>
            </div>
            <p className="field-note">
              Google Drive, Classroom, Microsoft 365, OCR, and multi-user collaboration require
              configured services and are not connected in this local build.
            </p>
          </div>
        </section>
      </div>
      {message && (
        <div className="settings-confirmation" role="status">
          <CheckCircle2 size={16} />
          {message}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function Toggle({
  label,
  description,
  checked,
  onChange,
  icon,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon: React.ReactNode;
}) {
  return (
    <div className="toggle-row">
      {icon}
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`toggle ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
