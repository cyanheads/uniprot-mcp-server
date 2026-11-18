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
import p00533Mutagenesis from '../fixtures/p00533-mutagenesis.json' with { type: 'json' };
import p00533Sections from '../fixtures/p00533-sections.json' with { type: 'json' };
import p04637Sections from '../fixtures/p04637-sections.json' with { type: 'json' };
import p07477Default from '../fixtures/p07477-default.json' with { type: 'json' };
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
    // P04637 serializes to ~420 KB live (both surfaces); a record over the outline budget must come
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
    // Identity summary is preserved so the outline names the protein it describes: every identity key.
    expect(result).toMatchObject({
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
    });
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

describe('entryResource #35 sections (real service over captured rows)', () => {
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');
  const p04637 = required(p04637Sections.results[0], 'the P04637 fixture row');
  const p00533 = required(p00533Sections.results[0], 'the P00533 fixture row');
  const mutagenesis = required(p00533Mutagenesis.results[0], 'the P00533 mutagenesis row').features;

  /** The sections #35 adds, every one a list. */
  const NEW_KEYS = [
    'alternativeNames',
    'ecNumbers',
    'sites',
    'topology',
    'processing',
    'mutagenesis',
    'comments',
    'interactions',
    'ensemblGenes',
  ];

  /** Answer the batch search with this raw row and read the resource through the real service. */
  async function read(row: object, accession: string) {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, { results: [row] })
          : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const ctx = createMockContext({ errors: entryResource.errors });
    const result = await entryResource.handler(paramsSchema.parse({ accession }), ctx);
    return result as Record<string, unknown>;
  }

  it('returns P07477’s new sections in the record body', async () => {
    const result = await read(p07477, 'P07477');

    expect(result.kind).toBeUndefined();
    expect(result.ecNumbers).toEqual(['3.4.21.4']);
    expect(result.alternativeNames).toHaveLength(7);
    expect(result.sites).toHaveLength(8);
    expect((result.sites as unknown[])[3]).toEqual({
      type: 'Binding site',
      location: { start: 75, end: 75 },
      ligand: { name: 'Ca(2+)', chebiId: 'CHEBI:29108' },
    });
    expect((result.processing as { type: string }[]).map((f) => f.type)).toEqual([
      'Signal',
      'Propeptide',
      'Chain',
      'Chain',
      'Chain',
    ]);
    expect((result.comments as { type: string }[]).map((c) => c.type)).toEqual([
      'SUBUNIT',
      'PTM',
      'PTM',
    ]);
    expect(result.ensemblGenes).toEqual(['ENSG00000204983.15', 'ENSG00000274247.4']);
  });

  it('outlines an over-budget record, listing every new section with its byte size', async () => {
    // Synthetic variants carry the captured sections past the 24,000-byte outline budget.
    const padding = Array.from({ length: 30 }, (_, i) => ({
      type: 'Natural variant',
      location: {
        start: { value: i + 1, modifier: 'EXACT' },
        end: { value: i + 1, modifier: 'EXACT' },
      },
      description: `Synthetic variant ${i} that carries the record past the outline budget`,
      featureId: `VAR_9${String(i).padStart(5, '0')}`,
      alternativeSequence: { originalSequence: 'A', alternativeSequences: ['V'] },
    }));
    const row = {
      ...p07477,
      features: [
        ...p07477.features,
        ...p04637.features,
        ...p00533.features,
        ...mutagenesis,
        ...padding,
      ],
      comments: [...p07477.comments, ...p04637.comments, ...p00533.comments],
    };

    const result = await read(row, 'P07477');
    expect(result.kind).toBe('outline');
    const { entries } = await realService.getEntries(['P07477'], undefined, createMockContext());
    const record = entries[0] as unknown as Record<string, unknown>;
    const sections = result.sections as { name: string; bytes: number }[];
    for (const key of NEW_KEYS) {
      const value = record[key];
      expect(value).toBeDefined();
      expect(sections).toContainEqual({
        name: key,
        bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
      });
      expect(result).not.toHaveProperty(key);
    }
  });
});

describe('entryResource default record (#34, real service)', () => {
  it('fetches the default entry projection, so a disulfide bond and the AlphaFoldDB id come back', async () => {
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search'
        ? upstreamResponse(200, {
            results: [
              {
                entryType: 'UniProtKB reviewed (Swiss-Prot)',
                primaryAccession: 'P07477',
                uniProtkbId: 'TRY1_HUMAN',
                annotationScore: 5,
                proteinExistence: '1: Evidence at protein level',
                organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
                sequence: { length: 247 },
                features: [
                  {
                    type: 'Disulfide bond',
                    location: { start: { value: 30 }, end: { value: 160 } },
                    description: '',
                  },
                ],
                uniProtKBCrossReferences: [{ database: 'AlphaFoldDB', id: 'P07477' }],
              },
            ],
          })
        : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const ctx = createMockContext({ errors: entryResource.errors });

    const result = (await entryResource.handler(
      paramsSchema.parse({ accession: 'P07477' }),
      ctx,
    )) as Entry;
    const fields = new URL(String(fetchStub.mock.calls[0]?.[0])).searchParams
      .get('fields')
      ?.split(',');
    expect(fields).toEqual(expect.arrayContaining(['ft_disulfid', 'xref_alphafolddb']));
    expect(fields).not.toContain('ft_mutagen');
    expect(fields).not.toContain('cc_interaction');
    expect(result.ptms).toEqual([{ type: 'Disulfide bond', location: { start: 30, end: 160 } }]);
    expect(result.xrefs).toEqual({ AlphaFoldDB: ['P07477'] });
  });
});
