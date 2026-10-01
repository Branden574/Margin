import test from 'node:test';
import assert from 'node:assert/strict';
import { safeWorkspaceUrl, safeSiteUrl } from '../lib/config.ts';
import { splitMatches } from '../lib/demo-text.ts';

test('workspace CTAs reject insecure links and embedded credentials', () => {
  assert.equal(safeWorkspaceUrl('https://127.0.0.1:5173/'), 'https://127.0.0.1:5173/');
  for (const value of [
    'http://127.0.0.1:5173/',
    'javascript:alert(1)',
    'https://user:secret@example.com/',
    'https://example.com/?token=secret',
    'https://example.com/#token',
  ]) {
    assert.throws(() => safeWorkspaceUrl(value));
  }
});
test('social metadata permits loopback preview but rejects insecure published origins', () => {
  assert.equal(safeSiteUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(safeSiteUrl('https://margin.example'), 'https://margin.example/');
  for (const value of [
    'http://example.com',
    'https://margin.example/path',
    'https://user:secret@margin.example',
    'https://margin.example/?secret=x',
  ])
    assert.throws(() => safeSiteUrl(value));
});
test('sample search handles regular-expression punctuation literally without dropping text', () => {
  const source = 'Energy [energy] (.*) energy';
  for (const query of ['[', '(', '\\', '.*', '(.*)', '', 'ENERGY']) {
    const result = splitMatches(source, query);
    assert.equal(result.map((part) => part.text).join(''), source);
    for (const part of result.filter((part) => part.matched))
      assert.equal(part.text.toLowerCase(), query.toLowerCase());
  }
  assert.equal(splitMatches(source, 'ENERGY').filter((part) => part.matched).length, 3);
});
