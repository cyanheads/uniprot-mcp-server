/**
 * @fileoverview Tests for the uniprot://entry/{accession} resource — the happy
 *   path, param validation (malformed accession rejected at the edge), and the
 *   not_found contract: an accession absent from the batch result must surface as
 *   ctx.fail("not_found") (data.reason === 'not_found' + the accession in data),
 *   not a silent miss.
 * @module tests/resources/uniprot-entry.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/services/uniprot/types.js';
import { expectMcpError, required } from '../helpers.js';

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

const paramsSchema = required(entryResource.params, 'entryResource.params');

describe('entryResource', () => {
  it('rejects a malformed accession at the param edge', () => {
    expect(() => paramsSchema.parse({ accession: 'lowercase' })).toThrow();
  });

  it('returns the full curated entry for an accession within the outline budget', async () => {
    getEntriesMock.mockResolvedValue([p53]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = paramsSchema.parse({ accession: 'P04637' });

    const result = (await entryResource.handler(params, ctx)) as Record<string, unknown>;
    expect(getEntriesMock).toHaveBeenCalledWith(['P04637'], undefined, ctx);
    expect(result.accession).toBe('P04637');
    expect(result.entryName).toBe('P53_HUMAN');
    // A small entry is returned whole — no outline, full curated sections intact.
    expect(result.kind).toBeUndefined();
    expect(result.function).toEqual([{ value: 'Acts as a tumor suppressor.' }]);
  });

  it('outlines an annotation-heavy entry instead of injecting the full record', async () => {
    // P04637 serializes to ~360 KB live; a record over the outline budget must come
    // back as a bounded identity summary + section outline, not the whole payload.
    const heavyEntry: Entry = {
      ...p53,
      variants: Array.from({ length: 3000 }, (_, i) => ({
        description: `Natural variant number ${i} associated with a phenotype of interest`,
        location: { start: i + 1, end: i + 1 },
        original: 'A',
        variation: 'V',
        featureId: `VAR_${String(i).padStart(6, '0')}`,
      })),
    };
    getEntriesMock.mockResolvedValue([heavyEntry]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = paramsSchema.parse({ accession: 'P04637' });

    const result = (await entryResource.handler(params, ctx)) as Record<string, unknown>;
    expect(result.kind).toBe('outline');
    // Identity summary is preserved so the outline names the protein it describes.
    expect(result.accession).toBe('P04637');
    expect(result.entryName).toBe('P53_HUMAN');
    // Section outline carries names + serialized byte sizes; the heavy section is listed.
    const sections = result.sections as Array<{ name: string; bytes: number }>;
    const variantsSection = sections.find((s) => s.name === 'variants');
    expect(variantsSection).toBeDefined();
    expect(variantsSection!.bytes).toBeGreaterThan(1000);
    // The full high-cardinality section is NOT inlined into the outline.
    expect(result.variants).toBeUndefined();
    // Re-call guidance routes to the tool, since the resource URI has no sections arg.
    expect(result.notice).toContain('uniprot_get_entry');
    expect(result.notice).toContain('sections');
  });

  it('throws ctx.fail("not_found") when the accession is absent from the batch result', async () => {
    // Well-formed accession, but UniProtKB returns no matching entry.
    getEntriesMock.mockResolvedValue([]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = paramsSchema.parse({ accession: 'Q99999' });

    const err = await expectMcpError(entryResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found', accession: 'Q99999' });
    expect((err.data as { recovery?: unknown }).recovery).toBeDefined();
  });

  it('throws not_found when the result holds only a different accession', async () => {
    // A mismatched record must not be returned for the requested accession.
    getEntriesMock.mockResolvedValue([p53]);
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = paramsSchema.parse({ accession: 'P38398' });

    await expect(entryResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', accession: 'P38398' },
    });
  });
});
