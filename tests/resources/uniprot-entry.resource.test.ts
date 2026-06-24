/**
 * @fileoverview Tests for the uniprot://entry/{accession} resource — the happy
 *   path, param validation (malformed accession rejected at the edge), and the
 *   not_found contract: an accession absent from the batch result must surface as
 *   ctx.fail("not_found") (data.reason === 'not_found' + the accession in data),
 *   not a silent miss.
 * @module tests/resources/uniprot-entry.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/services/uniprot/types.js';

const getEntriesMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getEntries: getEntriesMock }),
}));

const { entryResource } = await import(
  '@/mcp-server/resources/definitions/uniprot-entry.resource.js'
);

const p53: Entry = {
  accession: 'P04637',
  entryName: 'P53_HUMAN',
  proteinName: 'Cellular tumor antigen p53',
  genes: ['TP53'],
  organism: {
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    taxonId: 9606,
    mnemonic: 'HUMAN',
  },
  length: 393,
  reviewed: true,
  annotationScore: 5,
  proteinExistence: '1: Evidence at protein level',
  function: [{ value: 'Acts as a tumor suppressor.' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('entryResource', () => {
  it('rejects a malformed accession at the param edge', () => {
    expect(() => entryResource.params.parse({ accession: 'lowercase' })).toThrow();
  });

  it('returns the curated entry for a valid accession', async () => {
    getEntriesMock.mockResolvedValue([p53]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = entryResource.params.parse({ accession: 'P04637' });

    const result = await entryResource.handler(params, ctx);
    expect(getEntriesMock).toHaveBeenCalledWith(['P04637'], undefined, ctx);
    expect(result.accession).toBe('P04637');
    expect(result.entryName).toBe('P53_HUMAN');
  });

  it('throws ctx.fail("not_found") when the accession is absent from the batch result', async () => {
    // Well-formed accession, but UniProtKB returns no matching entry.
    getEntriesMock.mockResolvedValue([]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = entryResource.params.parse({ accession: 'Q99999' });

    const err = await entryResource.handler(params, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found', accession: 'Q99999' });
    expect((err.data as { recovery?: unknown }).recovery).toBeDefined();
  });

  it('throws not_found when the result holds only a different accession', async () => {
    // A mismatched record must not be returned for the requested accession.
    getEntriesMock.mockResolvedValue([p53]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = entryResource.params.parse({ accession: 'P38398' });

    await expect(entryResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', accession: 'P38398' },
    });
  });
});
