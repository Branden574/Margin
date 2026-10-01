import { describe, expect, it } from 'vitest';
// @ts-expect-error The extension intentionally ships dependency-free native JavaScript.
import { workspaceUrl, handoffUrl } from '../apps/extension/urls.js';
describe('extension handoff trust boundary', () => {
  it('requires HTTPS even on exact local development hosts', () => {
    expect(workspaceUrl('https://localhost:5173/path').origin).toBe('https://localhost:5173');
    expect(workspaceUrl('https://margin.example').protocol).toBe('https:');
    for (const url of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://margin.example',
      'http://localhost.attacker.example',
      'javascript:alert(1)',
      'https://user:secret@margin.example',
    ])
      expect(() => workspaceUrl(url)).toThrow();
  });
  it('encodes ordinary sources and rejects credential-bearing or privileged URLs', () => {
    const link = new URL(
      handoffUrl('https://margin.example/', 'https://school.example/lesson.pdf'),
    );
    expect(link.searchParams.get('source')).toBe('https://school.example/lesson.pdf');
    for (const url of [
      'http://school.example/lesson.pdf',
      'file:///secret.pdf',
      'chrome://settings',
      'https://school.example/a.pdf?token=secret',
      'https://school.example/a.pdf#token',
      'https://user:secret@school.example/a.pdf',
    ])
      expect(() => handoffUrl('https://margin.example', url)).toThrow();
  });
});
