/**
 * @fileoverview Query-bound cursor compatibility and rejection at the shared boundary.
 * @module tests/services/query-cursor.test
 */
import { describe, expect, it } from 'vitest';
import { queryCursor } from '@/services/uniprot/query-cursor.js';

describe('queryCursor', () => {
  it('preserves arbitrary upstream values and empty caller cursors', () => {
    const token = queryCursor.encode(
      'raw.opaque+/==\nβ',
      'uniprot_search_proteins',
      '(gene:TP53) AND reviewed:true',
    );
    expect(
      queryCursor.decode(token, 'uniprot_search_proteins', '(gene:TP53) AND reviewed:true'),
    ).toBe('raw.opaque+/==\nβ');
    expect(queryCursor.decode('', 'tool', 'query')).toBeUndefined();
    expect(queryCursor.decode(undefined, 'tool', 'query')).toBeUndefined();
  });

  it.each([
    ['different query', 'uniprot_search_proteins', 'gene:BRCA1'],
    ['different tool', 'uniprot_get_proteome', 'gene:TP53'],
    ['different exact spelling', 'uniprot_search_proteins', 'gene:tp53'],
  ])('rejects %s', (_name, tool, query) => {
    const token = queryCursor.encode('NEXT', 'uniprot_search_proteins', 'gene:TP53');
    expect(() => queryCursor.decode(token, tool, query)).toThrow(
      expect.objectContaining({ data: { reason: 'invalid_cursor' } }),
    );
  });

  it.each([
    'raw',
    '!!!',
    Buffer.from('not JSON').toString('base64url'),
    Buffer.from(JSON.stringify({ version: 2, fingerprint: 'x', cursor: 'raw' })).toString(
      'base64url',
    ),
    Buffer.from('null').toString('base64url'),
  ])('rejects malformed and legacy token %s', (token) => {
    expect(() => queryCursor.decode(token, 'tool', 'query')).toThrow(
      expect.objectContaining({ data: { reason: 'invalid_cursor' } }),
    );
  });
});
