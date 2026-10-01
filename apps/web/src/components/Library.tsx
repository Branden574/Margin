import { useState } from 'react';
import {
  ArrowUpRight,
  Plus,
  ChevronDown,
  Grid2X2,
  List,
  Folder,
  FileText,
  MoreHorizontal,
  Star,
  ArrowDown,
  Upload,
  Search,
  Check,
  Leaf,
  ArrowRight,
  Trash2,
} from 'lucide-react';
import type { DocumentRecord, FolderRecord } from '@margin/core';
import type { Page } from './Sidebar';
import { DocumentCover } from './DocumentCover';
import { fileSize, relativeDate } from '../lib/format';
export type DocumentAction =
  | 'rename'
  | 'move'
  | 'duplicate'
  | 'download'
  | 'trash'
  | 'restore'
  | 'delete'
  | 'sync';
interface Props {
  page: Page;
  documents: DocumentRecord[];
  folders: FolderRecord[];
  search: string;
  name: string;
  onOpen: (doc: DocumentRecord) => void;
  onUpload: () => void;
  onNew: () => void;
  onFolder: () => void;
  onNavigate: (p: Page) => void;
  onStar: (doc: DocumentRecord) => void;
  onAction: (action: DocumentAction, doc: DocumentRecord) => void;
  onTemplate: (doc: DocumentRecord) => void;
}
export function Library({
  page,
  documents,
  folders,
  search,
  name,
  onOpen,
  onUpload,
  onNew,
  onFolder,
  onNavigate,
  onStar,
  onAction,
  onTemplate,
}: Props) {
  const [layout, setLayout] = useState<'grid' | 'list'>('list');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [filter, setFilter] = useState<'all' | 'mine' | 'sample'>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const isHome = page === 'home' && !search;
  const isTemplate = page === 'templates';
  const folder = page.startsWith('folder:')
    ? folders.find((f) => f.id === page.slice(7))
    : undefined;
  const visible = documents
    .filter(
      (d) =>
        d.trashed === (page === 'trash') &&
        (page !== 'starred' || d.starred) &&
        (!folder || d.folderId === folder.id) &&
        (!isTemplate || d.source === 'sample') &&
        (!search || d.name.toLowerCase().includes(search.toLowerCase())) &&
        (isTemplate ||
          page === 'trash' ||
          filter === 'all' ||
          (filter === 'mine' ? d.source !== 'sample' : d.source === 'sample')),
    )
    .sort((a, b) => (sort === 'recent' ? b.updatedAt - a.updatedAt : a.name.localeCompare(b.name)));
  const recent = visible.slice(0, 4);
  const titles: Partial<Record<Page, string>> = {
    home: `Welcome back, ${name.split(' ')[0]}.`,
    documents: 'My documents',
    starred: 'Starred documents',
    templates: 'A head start for your next lesson.',
    trash: 'Trash',
  };
  const title = search
    ? `Results for “${search}”`
    : (folder?.name ?? titles[page] ?? 'My documents');
  const desc = search
    ? `${visible.length} document${visible.length === 1 ? '' : 's'} in this view`
    : folder
      ? 'Everything for this subject, in one place.'
      : page === 'trash'
        ? 'Restore a document or permanently remove it from this browser.'
        : page === 'templates'
          ? 'Original sample worksheets. Make a copy and make it your own.'
          : page === 'starred'
            ? 'The documents you want to keep within reach.'
            : isHome
              ? 'Pick up where you left off, or start something new.'
              : 'Your documents, notes, and ideas. All in one place.';
  function toggle(id: string) {
    setSelected((v) => {
      const n = new Set(v);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  const docMenu = (doc: DocumentRecord) => (
    <div className="document-menu" role="menu">
      {(page === 'trash'
        ? [
            ['restore', 'Restore document'],
            ['delete', 'Delete permanently'],
          ]
        : [
            ['rename', 'Rename'],
            ['move', 'Move to folder'],
            ['duplicate', 'Make a copy'],
            ['download', 'Export encrypted original'],
            ['sync', 'Upload encrypted copy'],
            ['trash', 'Move to trash'],
          ]
      ).map(([key, label]) => (
        <button
          key={key}
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
            onAction(key as DocumentAction, doc);
          }}
          className={key === 'trash' || key === 'delete' ? 'danger-text' : ''}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div className="library-page" onClick={() => menu && setMenu(null)}>
      <div className="page-heading">
        <div>
          {isHome && <div className="eyebrow">YOUR SPACE TO LEARN</div>}
          <h1>{title}</h1>
          <p>{desc}</p>
        </div>
        {page !== 'trash' && (
          <div className="heading-actions">
            <button className="button secondary" onClick={onNew}>
              <Plus size={16} />
              Blank document
            </button>
            <button className="button primary" onClick={onUpload}>
              <Upload size={16} />
              Upload document
            </button>
          </div>
        )}
      </div>
      {isHome && (
        <>
          <section className="recent-section" aria-label="Recent documents">
            <div className="section-title">
              <h2>
                Jump back in <span className="section-dot" />
              </h2>
              <button className="text-button" onClick={() => onNavigate('documents')}>
                View all documents <ArrowRight size={14} />
              </button>
            </div>
            <div className="recent-grid">
              {recent.map((doc) => (
                <article className="recent-card" key={doc.id}>
                  <button
                    className="cover-button"
                    onClick={() => onOpen(doc)}
                    aria-label={`Open ${doc.name}`}
                  >
                    <DocumentCover document={doc} />
                  </button>
                  <div className="recent-info">
                    <div className="recent-name-row">
                      <button onClick={() => onOpen(doc)}>{doc.name}</button>
                      <button
                        className={`icon-button star-button ${doc.starred ? 'is-starred' : ''}`}
                        onClick={() => onStar(doc)}
                        aria-label={`${doc.starred ? 'Unstar' : 'Star'} ${doc.name}`}
                      >
                        <Star size={16} fill={doc.starred ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                    <p>
                      <span className="pdf-mark">PDF</span>
                      <span>{doc.pageCount} pages</span>
                      <span>·</span>
                      <span>{relativeDate(doc.updatedAt)}</span>
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="folder-section" aria-label="Folders">
            <div className="section-title">
              <h2>Your folders</h2>
              <button className="text-button" onClick={onFolder}>
                <Plus size={15} />
                New folder
              </button>
            </div>
            <div className="folder-grid">
              {folders.slice(0, 4).map((f) => (
                <button
                  className="folder-card"
                  key={f.id}
                  onClick={() => onNavigate(`folder:${f.id}`)}
                >
                  <span
                    className="folder-icon"
                    style={{ color: f.color, background: f.color + '13' }}
                  >
                    <Folder size={23} fill={f.color + '22'} strokeWidth={1.4} />
                  </span>
                  <span>
                    <strong>{f.name}</strong>
                    <small>
                      {documents.filter((d) => !d.trashed && d.folderId === f.id).length} documents
                    </small>
                  </span>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      <section className="all-documents" aria-label={isHome ? 'All documents' : 'Document library'}>
        <div className="section-title file-section-title">
          <h2>
            {isHome
              ? 'All documents'
              : isTemplate
                ? 'Explore templates'
                : `${visible.length} document${visible.length === 1 ? '' : 's'}`}
          </h2>
          <div className="table-tools">
            <label className="sort-control">
              <ArrowDown size={14} />
              <select
                aria-label="Sort documents"
                value={sort}
                onChange={(e) => setSort(e.target.value as 'recent' | 'name')}
              >
                <option value="recent">Last modified</option>
                <option value="name">Name A–Z</option>
              </select>
              <ChevronDown size={13} />
            </label>
            <div className="segmented">
              <button
                aria-label="List view"
                title="List view"
                className={layout === 'list' ? 'selected' : ''}
                onClick={() => setLayout('list')}
              >
                <List size={17} />
              </button>
              <button
                aria-label="Grid view"
                title="Grid view"
                className={layout === 'grid' ? 'selected' : ''}
                onClick={() => setLayout('grid')}
              >
                <Grid2X2 size={16} />
              </button>
            </div>
          </div>
        </div>
        {!isTemplate && page !== 'trash' && (
          <div className="file-tabs">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              All files <span>{documents.filter((d) => !d.trashed).length}</span>
            </button>
            <button className={filter === 'mine' ? 'active' : ''} onClick={() => setFilter('mine')}>
              Created by me
            </button>
            <button
              className={filter === 'sample' ? 'active' : ''}
              onClick={() => setFilter('sample')}
            >
              Sample documents
            </button>
          </div>
        )}
        {selected.size > 0 && (
          <div className="selection-bar">
            <span>
              <Check size={15} />
              {selected.size} selected
            </span>
            <button
              className="text-button"
              onClick={() => {
                visible
                  .filter((d) => selected.has(d.id))
                  .forEach((d) => onAction(page === 'trash' ? 'restore' : 'trash', d));
                setSelected(new Set());
              }}
            >
              <Trash2 size={14} />
              {page === 'trash' ? 'Restore selected' : 'Move to trash'}
            </button>
            <button className="text-button" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}
        {!visible.length ? (
          <div className="empty-state">
            <span>
              <Search size={29} strokeWidth={1.3} />
            </span>
            <h3>
              {search
                ? 'No matching documents'
                : page === 'trash'
                  ? 'Nothing in the trash'
                  : 'A little room for something new'}
            </h3>
            <p>
              {search
                ? 'Try a different document name.'
                : page === 'starred'
                  ? 'Star a document to find it here.'
                  : page === 'trash'
                    ? 'Documents you remove will appear here.'
                    : 'Upload a PDF or create a blank document to get started.'}
            </p>
            {!search && page !== 'starred' && page !== 'trash' && (
              <button className="button secondary" onClick={onUpload}>
                <Upload size={15} />
                Upload a document
              </button>
            )}
          </div>
        ) : layout === 'grid' || isTemplate ? (
          <div className="document-grid">
            {visible.map((doc) => (
              <article key={doc.id} className="recent-card">
                <button
                  className="cover-button"
                  onClick={() => (isTemplate ? onTemplate(doc) : onOpen(doc))}
                  aria-label={`${isTemplate ? 'Use template' : 'Open'} ${doc.name}`}
                >
                  <DocumentCover document={doc} />
                </button>
                <div className="recent-info">
                  <div className="recent-name-row">
                    <button onClick={() => (isTemplate ? onTemplate(doc) : onOpen(doc))}>
                      {doc.name}
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Actions for ${doc.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(menu === doc.id ? null : doc.id);
                      }}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    {menu === doc.id && docMenu(doc)}
                  </div>
                  <p>
                    {isTemplate
                      ? 'Make your own copy'
                      : `${doc.pageCount} pages · ${relativeDate(doc.updatedAt)}`}
                  </p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="document-table">
              <thead>
                <tr>
                  <th className="checkbox-cell">
                    <input
                      type="checkbox"
                      aria-label="Select all documents"
                      checked={visible.length > 0 && visible.every((d) => selected.has(d.id))}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(visible.map((d) => d.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th>
                    Name <ArrowDown size={12} />
                  </th>
                  <th>Location</th>
                  <th>Last modified</th>
                  <th>Size</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((doc) => (
                  <tr key={doc.id}>
                    <td className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${doc.name}`}
                        checked={selected.has(doc.id)}
                        onChange={() => toggle(doc.id)}
                      />
                    </td>
                    <td>
                      <button className="table-document" onClick={() => onOpen(doc)}>
                        <span className={`file-icon file-${doc.cover}`}>
                          <FileText size={19} strokeWidth={1.5} />
                        </span>
                        <span>
                          {doc.name}
                          <small>
                            PDF document{' '}
                            {doc.source === 'sample' && <span className="sample-tag">SAMPLE</span>}
                          </small>
                        </span>
                        {doc.starred && <Star size={13} fill="#b8984d" color="#b8984d" />}
                      </button>
                    </td>
                    <td>
                      <span className="table-folder">
                        <Folder size={14} />
                        {folders.find((f) => f.id === doc.folderId)?.name ?? 'My documents'}
                      </span>
                    </td>
                    <td>{relativeDate(doc.updatedAt)}</td>
                    <td>{fileSize(doc.size)}</td>
                    <td className="action-cell">
                      <button
                        className="icon-button"
                        aria-label={`Actions for ${doc.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu(menu === doc.id ? null : doc.id);
                        }}
                      >
                        <MoreHorizontal size={19} />
                      </button>
                      {menu === doc.id && docMenu(doc)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {isHome && (
        <div className="workspace-footer">
          <Leaf size={14} />
          <span>A calmer place for your documents.</span>
          <span className="footer-right">Made for the way you learn.</span>
        </div>
      )}
    </div>
  );
}
