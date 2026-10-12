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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/services/uniprot/types.js';
import { ACCESSION_MESSAGE } from '@/services/uniprot/types.js';
import {
  expectMcpError,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  rejectUnmockedFetch,
  required,
  routeUpstream,
  upstreamResponse,
} from '../helpers.js';

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

/** The real service, for tests that drive an upstream response through its normalizer. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

/** A service batch result holding only active entries. */
function batch(...entries: Entry[]) {
  return { entries, inactive: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const paramsSchema = required(entryResource.params, 'entryResource.params');

describe('entryResource', () => {
  it('rejects a malformed accession at the param edge', () => {
    expect(() => paramsSchema.parse({ accession: 'lowercase' })).toThrow();
  });

  it('names the accession format and where to find one, not the compiled pattern', () => {
    const parsed = paramsSchema.safeParse({ accession: 'not-valid' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([ACCESSION_MESSAGE]);
    expect(parsed.error?.message).not.toContain('must match pattern');
  });

  it('returns the full curated entry for an accession within the outline budget', async () => {
    getEntriesMock.mockResolvedValue(batch(p53));
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
    getEntriesMock.mockResolvedValue(batch(heavyEntry));
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
    getEntriesMock.mockResolvedValue(batch());
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = paramsSchema.parse({ accession: 'Q99999' });

    const err = await expectMcpError(entryResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    // The declared recovery hint is filled in by the framework's resource
    // handler, not by this throw site.
    expect(err.data).toMatchObject({ reason: 'not_found', accession: 'Q99999' });
  });

  it.each([
    ['merged', INACTIVE_STUBS.merged, INACTIVE_MESSAGES.merged],
    ['demerged', INACTIVE_STUBS.demerged, INACTIVE_MESSAGES.demerged],
    ['deleted', INACTIVE_STUBS.deleted, INACTIVE_MESSAGES.deleted],
  ])(
    'throws not_found naming the pointer for a %s accession instead of a hollow body',
    async (_type, stub, message) => {
      // Real service over a stubbed fetch answering the batch search with the inactive stub.
      const fetchStub = routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, { results: [stub] })
          : undefined,
      );
      vi.stubGlobal('fetch', fetchStub);
      getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
      const ctx = createMockContext({ errors: entryResource.errors });
      const params = paramsSchema.parse({ accession: stub.primaryAccession });

      const err = await expectMcpError(entryResource.handler(params, ctx));
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toBe(message);
      expect(err.data).toMatchObject({ reason: 'not_found', accession: stub.primaryAccession });
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it('throws not_found when the result holds only a different accession', async () => {
    // A mismatched record must not be returned for the requested accession.
    getEntriesMock.mockResolvedValue(batch(p53));
    const ctx = createMockContext({ errors: entryResource.errors });
    const params = paramsSchema.parse({ accession: 'P38398' });

    await expect(entryResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found', accession: 'P38398' },
    });
  });
});
