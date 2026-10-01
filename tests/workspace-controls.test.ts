import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentRecord, Preferences } from '@margin/core';
import { Library } from '../apps/web/src/components/Library';
import { Settings } from '../apps/web/src/components/Settings';

// Render the retained source-filter state without a browser or a user's vault.
const retained = vi.hoisted(() => ({ filter: 'all' }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: <T>(initial: T | (() => T)) => {
    const value = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [value === 'all' ? retained.filter : value, vi.fn()];
  },
}));

const preferences: Preferences = {
  name: 'Reader',
  role: 'teacher',
  theme: 'light',
  dyslexiaFont: false,
  reducedMotion: false,
  shortcuts: true,
};
function document(id: string, source: DocumentRecord['source'], trashed = false): DocumentRecord {
  return {
    id,
    name: id,
    source,
    trashed,
    mimeType: 'application/pdf',
    size: 4,
    pageCount: 1,
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    starred: false,
    cover: 'blank',
  };
}
function library(page: Parameters<typeof Library>[0]['page'], documents: DocumentRecord[]) {
  return renderToStaticMarkup(
    createElement(Library, {
      page,
      documents,
      folders: [],
      search: '',
      name: 'Reader',
      onOpen: vi.fn(),
      onUpload: vi.fn(),
      onNew: vi.fn(),
      onFolder: vi.fn(),
      onNavigate: vi.fn(),
      onStar: vi.fn(),
      onAction: vi.fn(),
      onTemplate: vi.fn(),
    }),
  );
}
type ControlProps = {
  children?: ReactNode;
  onClick?: () => void;
  onChange?: (value: boolean) => void;
  label?: string;
};
function elements(node: ReactNode): ReactElement<ControlProps>[] {
  if (!isValidElement<ControlProps>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}
beforeEach(() => {
  retained.filter = 'all';
});

describe('workspace control regressions', () => {
  it('shows templates after retaining the Created by me filter from the library', () => {
    retained.filter = 'mine';
    const documents = [document('Sample worksheet', 'sample'), document('My notes', 'created')];
    expect(library('documents', documents)).not.toContain('Sample worksheet');
    const templates = library('templates', documents);
    expect(templates).toContain('Use template Sample worksheet');
    expect(templates).not.toContain('My notes');
  });
  it.each(['mine', 'sample'])('shows every trashed source with a retained %s filter', (filter) => {
    retained.filter = filter;
    const trash = library('trash', [
      document('Trashed sample', 'sample', true),
      document('Trashed personal file', 'created', true),
      document('Kept file', 'created'),
    ]);
    expect(trash).toContain('Trashed sample');
    expect(trash).toContain('Trashed personal file');
    expect(trash).not.toContain('Kept file');
  });
  it('sends only changed preference fields when two controls save before props update', async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onSave = vi.fn(() => pending);
    const controls = elements(
      Settings({
        preferences,
        onSave,
        documents: [],
        token: '',
        onToken: vi.fn(),
        onHelp: vi.fn(),
      }),
    );
    controls.find(
      (element) => element.type === 'button' && renderToStaticMarkup(element).includes('>Dark<'),
    )!.props.onClick!();
    controls.find((element) => element.props.label === 'Reduce motion')!.props.onChange!(true);
    expect(onSave.mock.calls).toEqual([[{ theme: 'dark' }], [{ reducedMotion: true }]]);
    finish!();
    await pending;
  });
});
