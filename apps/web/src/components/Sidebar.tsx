import {
  LockKeyhole,
  Home,
  Files,
  Star,
  BookOpen,
  Trash2,
  Plus,
  Settings2,
  ChevronDown,
  Folder,
  CircleHelp,
  PanelLeftClose,
  WifiOff,
  HardDrive,
  GraduationCap,
} from 'lucide-react';
import type { FolderRecord, Preferences } from '@margin/core';
import { Brand } from './Brand';
export type Page =
  | 'home'
  | 'documents'
  | 'starred'
  | 'assignments'
  | 'templates'
  | 'trash'
  | 'settings'
  | `folder:${string}`;
export function Sidebar({
  page,
  onNavigate,
  folders,
  preferences,
  onCreateFolder,
  onHelp,
  online,
  mobileOpen,
  onClose,
  onLock,
}: {
  onLock: () => void;
  page: Page;
  onNavigate: (p: Page) => void;
  folders: FolderRecord[];
  preferences: Preferences;
  onCreateFolder: () => void;
  onHelp: () => void;
  online: boolean;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const nav = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'documents', label: 'My documents', icon: Files },
    { id: 'starred', label: 'Starred', icon: Star },
    { id: 'assignments', label: 'Assignments', icon: GraduationCap },
    { id: 'templates', label: 'Templates', icon: BookOpen },
  ] as const;
  return (
    <>
      <div className={`sidebar-scrim ${mobileOpen ? 'visible' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="brand-row">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button className="workspace-switch" onClick={() => onNavigate('settings')}>
          <span className="workspace-avatar">{preferences.name.charAt(0)}</span>
          <span>
            My workspace<small>Personal workspace</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <nav aria-label="Main navigation">
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => onNavigate(id)}
            >
              <Icon size={18} strokeWidth={1.65} />
              <span>{label}</span>
              {id === 'templates' && <span className="new-label">NEW</span>}
            </button>
          ))}
        </nav>
        <div className="folder-label">
          <span>YOUR FOLDERS</span>
          <button className="icon-button" onClick={onCreateFolder} aria-label="Create folder">
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="Folders">
          {folders.map((f) => (
            <button
              key={f.id}
              className={`nav-item folder-nav ${page === `folder:${f.id}` ? 'active' : ''}`}
              onClick={() => onNavigate(`folder:${f.id}`)}
            >
              <Folder size={17} color={f.color} fill={f.color + '22'} />
              <span>{f.name}</span>
            </button>
          ))}
        </nav>
        <button
          className={`nav-item trash-nav ${page === 'trash' ? 'active' : ''}`}
          onClick={() => onNavigate('trash')}
        >
          <Trash2 size={17} />
          <span>Trash</span>
        </button>
        <div className="sidebar-bottom">
          <div className="local-storage-note">
            <span className={`connection-dot ${online ? '' : 'offline'}`} />
            <strong>{online ? 'Your work, kept close.' : 'You’re working offline.'}</strong>
            <p>
              Encrypted on this device.
              <br />
              Keep creating, even offline.
            </p>
            <span className="storage-caption">
              {online ? <HardDrive size={12} /> : <WifiOff size={12} />} Local workspace
            </span>
          </div>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => onNavigate('settings')}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
          <button className="nav-item" onClick={onHelp}>
            <CircleHelp size={17} />
            <span>Help & shortcuts</span>
            <span className="help-key">?</span>
          </button>
          <button className="nav-item" onClick={onLock}>
            <LockKeyhole size={17} />
            <span>Lock workspace</span>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">
              {preferences.name
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              <strong>{preferences.name}</strong>
              <small>{preferences.role === 'teacher' ? 'Teacher' : 'Student'} workspace</small>
            </div>
            <button
              className="icon-button"
              onClick={() => onNavigate('settings')}
              aria-label="Profile settings"
            >
              <ChevronDown size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
