/**
 * @fileoverview Tests for the uniprot_get_proteome tool — handler behavior with
 *   a stubbed UniProtService: the missing_identifier and not_found ctx.fail
 *   contracts (the not_found regression — the service's NotFound must reach the
 *   wire as data.reason === 'not_found', not a leaked raw HTTP throw), UPID vs
 *   taxon-id dispatch, the include_proteins pagination/truncation path, and
 *   format() rendering.
 * @module tests/tools/uniprot-get-proteome.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { queryCursor } from '@/services/uniprot/query-cursor.js';
import type { Proteome, ProteomeProteinPage } from '@/services/uniprot/types.js';
import {
  contentText,
  errorEnvelope,
  expectMcpError,
  RAW_ENTRIES,
  RAW_HUMAN_PROTEOME,
  RAW_PROTEOMES,
  RAW_SNIPPET_ROWS,
  rejectUnmockedFetch,
  requestedUrls,
  required,
  routeUpstream,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

const getProteomeMock = vi.fn();
const getProteomeProteinsMock = vi.fn();

// Only the accessor is stubbed; the module's error predicates stay real.
vi.mock('@/services/uniprot/uniprot-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uniprot/uniprot-service.js')>()),
  getUniProtService: () => ({
    getProteome: getProteomeMock,
    getProteomeProteins: getProteomeProteinsMock,
  }),
}));

const { getProteome } = await import('@/mcp-server/tools/definitions/uniprot-get-proteome.tool.js');

/** The real service, for tests that drive an upstream response through its sanitizer. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

const humanProteome: Proteome = {
  upid: 'UP000005640',
  proteomeType: 'Reference proteome',
  organism: {
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    taxonId: 9606,
    mnemonic: 'HUMAN',
  },
  proteinCount: 147506,
  busco: {
    complete: 13780,
    completeSingle: 13520,
    completeDuplicated: 260,
    fragmented: 40,
    missing: 60,
    total: 13880,
    lineageDb: 'primates_odb10',
    score: 99,
  },
  genomeAssembly: 'GCA_000001405.29',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getProteome size cap (#41)', () => {
  const p53Hit = {
    accession: 'P04637',
    entryName: 'P53_HUMAN',
    geneNames: ['TP53'],
    organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
    length: 393,
    reviewed: true,
    annotationScore: 5,
    proteinExistence: '1: Evidence at protein level',
  };
  /** The `size` property as `tools/list` advertises it. */
  const advertisedSize = () =>
    (
      z.toJSONSchema(getProteome.input, { io: 'input', target: 'draft-2020-12' }) as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.size as Record<string, unknown>;

  beforeEach(() => {
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockResolvedValue({
      proteins: [p53Hit],
      totalResults: 147506,
      cursor: 'NEXT_CURSOR',
    } satisfies ProteomeProteinPage);
  });

  afterEach(() => {
    getServerConfig().clampLimits = true;
  });

  it.each([501, 1e20])(
    'requests size %s as 500, its notice beside the truncation guidance on both surfaces',
    async (size) => {
      const result = await runToolContract(getProteome, {
        upid: 'UP000005640',
        include_proteins: true,
        size,
      });

      expect(result.isError).toBeFalsy();
      expect(getProteomeProteinsMock).toHaveBeenCalledWith(
        'UP000005640',
        expect.objectContaining({ size: 500 }),
        expect.anything(),
      );
      const out = result.structuredContent as { notice: string; cap: number; cursor: string };
      expect(out.notice).toContain(
        `size ${String(size)} is above UniProt's page maximum of 500, so this page was requested at size 500.`,
      );
      expect(out.notice).toContain('Walk the cursor for more');
      expect(out.cap).toBe(500);
      expect(contentText(result)).toContain(out.notice);
      expect(queryCursor.decode(out.cursor, 'uniprot_get_proteome', 'proteome:UP000005640')).toBe(
        'NEXT_CURSOR',
      );
    },
  );

  it('keeps the clamp notice beside "No proteins matched" on an empty last page, on both surfaces', async () => {
    getProteomeProteinsMock.mockResolvedValue({
      proteins: [],
      totalResults: 0,
    } satisfies ProteomeProteinPage);
    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
      size: 501,
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { notice: string; shown: number };
    expect(out.notice).toBe(
      "size 501 is above UniProt's page maximum of 500, so this page was requested at size 500. No proteins matched this proteome page.",
    );
    expect(out.shown).toBe(0);
    expect(out).not.toHaveProperty('cursor');
    expect(contentText(result)).toContain(out.notice);
  });

  it('sends size 500 as asked, with no clamp notice', async () => {
    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
      size: 500,
    });
    expect(getProteomeProteinsMock).toHaveBeenCalledWith(
      'UP000005640',
      expect.objectContaining({ size: 500 }),
      expect.anything(),
    );
    expect((result.structuredContent as { notice: string }).notice).not.toContain('page maximum');
  });

  it('leaves a size without include_proteins unclamped and unmentioned', async () => {
    const result = await runToolContract(getProteome, { upid: 'UP000005640', size: 501 });
    expect(result.isError).toBeFalsy();
    expect(getProteomeProteinsMock).not.toHaveBeenCalled();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('rejects a fractional size as an integer mistake, before any request', async () => {
    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
      size: 1.5,
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(result).message).toContain('expected int');
    expect(getProteomeMock).not.toHaveBeenCalled();
  });

  it('advertises size as an integer with a minimum and no maximum', () => {
    expect(advertisedSize()).toMatchObject({ type: 'integer', minimum: 1 });
    expect(advertisedSize().maximum).toBeUndefined();
  });

  it('under UNIPROT_CLAMP_LIMITS=false advertises maximum 500 and rejects 501 before any request', async () => {
    getServerConfig().clampLimits = false;
    expect(advertisedSize()).toMatchObject({ type: 'integer', minimum: 1, maximum: 500 });
    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
      size: 501,
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(result).message).toContain('<=500');
    expect(getProteomeMock).not.toHaveBeenCalled();
  });
});

describe('getProteome function snippet (#36, real service)', () => {
  /** A first FUNCTION text of five evidence-tagged sentences, well past 400 characters. */
  const LONG_FUNCTION =
    'Multifunctional transcription factor that induces cell cycle arrest, DNA repair or apoptosis upon binding to its target DNA sequence (PubMed:11025664, PubMed:12524540, PubMed:12810724). Acts as a tumor suppressor in many tumor types; induces growth arrest or apoptosis depending on the physiological circumstances and cell type (PubMed:11025664). Involved in cell cycle regulation as a trans-activator that acts to negatively regulate cell division by controlling a set of genes required for this process (PubMed:15340061). One of the activated genes is an inhibitor of cyclin-dependent kinases (By similarity). Apoptosis induction seems to be mediated either by stimulation of BAX and FAS antigen expression, or by repression of Bcl-2 expression (PubMed:12524540).';
  /** Its first sentence, evidence stripped: 133 characters, where adding the second would run past 250. */
  const SNIPPET =
    'Multifunctional transcription factor that induces cell cycle arrest, DNA repair or apoptosis upon binding to its target DNA sequence.';

  it('bounds a long FUNCTION text on an include_proteins row on both surfaces, omitting it for a row without one', async () => {
    expect(LONG_FUNCTION.length).toBeGreaterThan(400);
    getProteomeMock.mockResolvedValue(humanProteome);
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) => {
        if (url.pathname !== '/uniprotkb/search') return;
        const p53 = {
          ...RAW_ENTRIES.p53,
          comments: [
            { commentType: 'FUNCTION', texts: [{ value: LONG_FUNCTION }] },
            ...RAW_ENTRIES.p53.comments,
          ],
        };
        const response = upstreamResponse(200, { results: [p53, RAW_ENTRIES.rhodopsin] });
        response.headers.set('x-total-results', '2');
        return response;
      }),
    );
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));

    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      proteins: { accession: string; functionSnippet?: string }[];
    };
    expect(out.proteins.map((hit) => hit.accession)).toEqual(['P04637', 'P08100']);
    expect(out.proteins[0]?.functionSnippet).toBe(SNIPPET);
    expect(out.proteins[1]).not.toHaveProperty('functionSnippet');
    const lines = contentText(result).split('\n');
    const p53At = lines.indexOf('- **P04637** (P53_HUMAN) Cellular tumor antigen p53 [TP53, P53]');
    expect(p53At).toBeGreaterThan(-1);
    // The snippet follows P04637's meta line; P08100, which has no FUNCTION, gets no snippet line.
    expect(lines.slice(p53At + 2, p53At + 4)).toEqual([
      `  ${SNIPPET}`,
      expect.stringMatching(/^- \*\*P08100\*\* /),
    ]);
    expect(lines.filter((line) => line.startsWith('  ') && !line.includes(' · '))).toEqual([
      `  ${SNIPPET}`,
    ]);
  });
});

describe('getProteome function snippet molecule (#45, real service)', () => {
  it("labels an include_proteins row's snippet with its FUNCTION comment's molecule on both surfaces, and an unqualified one not at all", async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, { results: [RAW_SNIPPET_ROWS.P01275, RAW_SNIPPET_ROWS.P04637] })
          : undefined,
      ),
    );
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));

    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      proteins: { accession: string; functionSnippetMolecule?: string }[];
    };
    expect(out.proteins.map((hit) => [hit.accession, hit.functionSnippetMolecule])).toEqual([
      ['P01275', 'Glucagon'],
      ['P04637', undefined],
    ]);
    expect(out.proteins[1]).not.toHaveProperty('functionSnippetMolecule');
    expect(
      contentText(result)
        .split('\n')
        .filter((line) => line.startsWith('  ') && !line.includes(' · ')),
    ).toEqual([
      '  Glucagon: Plays a key role in glucose metabolism and homeostasis. Regulates blood glucose by increasing gluconeogenesis and decreasing glycolysis. A counterregulatory hormone of insulin, raises plasma glucose levels in response to insulin-induced hypoglycemia.',
      '  Multifunctional transcription factor that induces cell cycle arrest, DNA repair or apoptosis upon binding to its target DNA sequence.',
    ]);
  });
});

describe('getProteome sequence flags (real service)', () => {
  it('qualifies a flagged include_proteins row’s length on both surfaces, and leaves an unflagged one bare', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    // P01275 carries "Precursor" as rest.uniprot.org sent it (2026-11-23); P04637 carries no flag.
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, { results: [RAW_SNIPPET_ROWS.P01275, RAW_SNIPPET_ROWS.P04637] })
          : undefined,
      ),
    );
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));

    const result = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      proteins: { accession: string; sequenceFlags?: string[] }[];
    };
    expect(out.proteins.map((hit) => [hit.accession, hit.sequenceFlags])).toEqual([
      ['P01275', ['Precursor']],
      ['P04637', undefined],
    ]);
    expect(out.proteins[1]).not.toHaveProperty('sequenceFlags');
    expect(
      contentText(result)
        .split('\n')
        .filter((line) => line.includes(' · score ')),
    ).toEqual([
      '  reviewed · score 5/5 · 180 aa (Precursor) · 1: Evidence at protein level · Homo sapiens (Human) [taxon 9606]',
      '  reviewed · score 5/5 · 393 aa · 1: Evidence at protein level · Homo sapiens (Human) [taxon 9606]',
    ]);
  });
});

describe('getProteome', () => {
  it('echoes an empty protein filter and no-match notice on both surfaces', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockResolvedValue({ proteins: [], totalResults: 0 });
    const result = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      query: 'gene:ZZZNOTAGENE',
    });
    expect(result.structuredContent).toMatchObject({
      proteins: [],
      query: 'gene:ZZZNOTAGENE',
      notice: 'No proteins matched the filter "gene:ZZZNOTAGENE".',
    });
    expect(contentText(result)).toContain('gene:ZZZNOTAGENE');
    expect(contentText(result)).toContain('No proteins matched');
  });

  it('renders descendant UPID and taxon guidance with ambiguity recovery on both surfaces', async () => {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) => {
        const exact = url.searchParams.get('query')?.includes('organism_id:');
        return upstreamResponse(200, {
          results: exact ? [] : [RAW_HUMAN_PROTEOME, { ...RAW_HUMAN_PROTEOME, id: 'UP000000002' }],
        });
      }),
    );
    getProteomeMock.mockImplementation(realService.getProteome.bind(realService));
    const result = await runToolContract(getProteome, { taxon_id: 9605 });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'ambiguous_proteome' });
    for (const surface of [errorEnvelope(result).message, contentText(result)]) {
      expect(surface).toContain('UP000005640');
      expect(surface).toContain('UP000000002');
      expect(surface).toContain('9606');
      expect(surface).toContain('Homo sapiens');
    }
    expect(contentText(result)).toContain('Recovery:');
  });
  it('continues across resolved identifier aliases and page sizes, rejecting another proteome or query before paging', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const response = upstreamResponse(200, { results: [RAW_ENTRIES.p53] });
      response.headers.set('x-total-results', '3');
      const position = url.searchParams.get('cursor');
      if (position !== 'third')
        response.headers.set(
          'link',
          `<https://rest.uniprot.org/uniprotkb/search?cursor=${position === 'second' ? 'third' : 'second'}>; rel="next"`,
        );
      return response;
    });
    vi.stubGlobal('fetch', fetchStub);
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));
    const first = await runToolContract(getProteome, {
      upid: 'UP000005640',
      include_proteins: true,
    });
    const cursor = (first.structuredContent as { cursor: string }).cursor;
    expect(contentText(first)).toContain(cursor);
    const second = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      cursor,
      size: 2,
    });
    const secondCursor = (second.structuredContent as { cursor: string }).cursor;
    expect(contentText(second)).toContain(secondCursor);
    const third = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      cursor: secondCursor,
      size: 3,
    });
    expect(third.isError).toBeFalsy();
    expect(third.structuredContent).not.toHaveProperty('cursor');
    expect(requestedUrls(fetchStub).map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'second',
      'third',
    ]);
    getProteomeProteinsMock.mockClear();
    const changedQuery = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      query: 'reviewed:true',
      cursor,
    });
    expect(errorEnvelope(changedQuery).data).toMatchObject({ reason: 'invalid_cursor' });
    getProteomeMock.mockResolvedValue({ ...humanProteome, upid: 'UP000000625' });
    const changedProteome = await runToolContract(getProteome, {
      upid: 'UP000000625',
      include_proteins: true,
      cursor,
    });
    expect(errorEnvelope(changedProteome).data).toMatchObject({ reason: 'invalid_cursor' });
    expect(getProteomeProteinsMock).not.toHaveBeenCalled();
  });
  it('throws missing_identifier when neither upid nor taxon_id is provided', async () => {
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({});
    await expect(getProteome.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_identifier' },
    });
    expect(getProteomeMock).not.toHaveBeenCalled();
  });

  it('treats an empty-string upid as absent (form-client payload)', async () => {
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ upid: '' });
    await expect(getProteome.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_identifier' },
    });
    expect(getProteomeMock).not.toHaveBeenCalled();
  });

  it('throws conflicting_identifier when both upid and taxon_id are provided', async () => {
    // Contradictory identifiers must be rejected, not silently resolved down the upid
    // path (which would return the wrong proteome relative to the caller's intent).
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ upid: 'UP000005640', taxon_id: 10090 });
    await expect(getProteome.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_identifier' },
    });
    expect(getProteomeMock).not.toHaveBeenCalled();
  });

  it('treats an empty-string upid alongside a taxon_id as non-conflicting', async () => {
    // A form client may submit upid:"" with a real taxon_id — that is the taxon_id
    // path, not a conflict.
    getProteomeMock.mockResolvedValue(humanProteome);
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ upid: '', taxon_id: 9606 });

    const result = await getProteome.handler(input, ctx);
    expect(getProteomeMock).toHaveBeenCalledWith({ taxonId: 9606 }, ctx);
    expect(result.proteome.upid).toBe('UP000005640');
  });

  it('routes the service NotFound through ctx.fail("not_found") with a clean typed error', async () => {
    getProteomeMock.mockRejectedValue(
      notFound('No reference proteome found for taxon 99999999.', { taxonId: 99999999 }),
    );
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ taxon_id: 99999999 });

    const err = await expectMcpError(getProteome.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });

    // Recovery guidance reaches the wire so the agent knows its next move — the
    // framework fills the declared hint onto the envelope.
    const result = await runToolContract(getProteome, { taxon_id: 99999999 });
    const envelope = (
      result.structuredContent as { error?: { data?: { recovery?: { hint?: string } } } }
    ).error;
    expect(envelope?.data?.recovery?.hint).toBe(
      'Check the UPID. For a taxon ID with no reference proteome, re-call with a parent taxon ID from its uniprot_get_taxonomy lineage to list the reference proteomes of related organisms.',
    );
  });

  it('returns metadata only when include_proteins is false (taxon-id dispatch)', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ taxon_id: 9606 });

    const result = await getProteome.handler(input, ctx);
    expect(getProteomeMock).toHaveBeenCalledWith({ taxonId: 9606 }, ctx);
    expect(result.proteome.upid).toBe('UP000005640');
    expect(result.proteins).toBeUndefined();
    expect(getProteomeProteinsMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.schemaMatching(getProteome.output));
  });

  it('dispatches by upid when given one', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ upid: 'UP000005640' });

    await getProteome.handler(input, ctx);
    expect(getProteomeMock).toHaveBeenCalledWith({ upid: 'UP000005640' }, ctx);
  });

  it('returns a capped protein page and discloses truncation when a cursor remains', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    const page: ProteomeProteinPage = {
      proteins: [
        {
          accession: 'P04637',
          entryName: 'P53_HUMAN',
          geneNames: ['TP53'],
          organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
          length: 393,
          reviewed: true,
          annotationScore: 5,
          proteinExistence: '1: Evidence at protein level',
        },
      ],
      totalResults: 147506,
      cursor: 'NEXT_CURSOR',
    };
    getProteomeProteinsMock.mockResolvedValue(page);
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ taxon_id: 9606, include_proteins: true, size: 1 });

    const result = await getProteome.handler(input, ctx);
    expect(getProteomeProteinsMock).toHaveBeenCalledWith(
      'UP000005640',
      expect.objectContaining({ size: 1 }),
      ctx,
    );
    expect(result.proteins).toHaveLength(1);
    // Truncation disclosure + forward cursor surfaced via enrichment, not a silent cap.
    expect(getEnrichment(ctx)).toMatchObject({
      truncated: true,
      cap: 1,
      shown: 1,
      totalProteinsMatched: 147506,
    });
    expect(
      queryCursor.decode(
        getEnrichment(ctx).cursor as string,
        'uniprot_get_proteome',
        'proteome:UP000005640',
      ),
    ).toBe('NEXT_CURSOR');
  });

  it('declares the truncation guidance so it reaches content[], not only the store', async () => {
    // Regression: ctx.enrich.truncated() writes a `notice` guidance string, but
    // unless `notice` is declared in the enrichment block the effective-output parse
    // strips it from both structuredContent and the content[] trailer — leaving
    // text-only clients with the cap but not how to page past it.
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockResolvedValue({
      proteins: [
        {
          accession: 'P04637',
          entryName: 'P53_HUMAN',
          geneNames: ['TP53'],
          organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
          length: 393,
          reviewed: true,
          annotationScore: 5,
          proteinExistence: '1: Evidence at protein level',
        },
      ],
      totalResults: 147506,
      cursor: 'NEXT_CURSOR',
    } satisfies ProteomeProteinPage);
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ taxon_id: 9606, include_proteins: true, size: 1 });

    const result = await getProteome.handler(input, ctx);
    // The effective output the framework builds (output + enrichment) — what both
    // structuredContent and the content[] trailer are rendered from.
    const effective = getProteome.output
      .extend(required(getProteome.enrichment, 'getProteome.enrichment'))
      .parse({ ...result, ...getEnrichment(ctx) });
    expect(effective.notice).toBeDefined();
    expect(effective.notice).toContain('cursor');
  });

  it('does not disclose truncation on the last protein page', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockResolvedValue({
      proteins: [
        {
          accession: 'P04637',
          entryName: 'P53_HUMAN',
          geneNames: ['TP53'],
          organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
          length: 393,
          reviewed: true,
          annotationScore: 5,
          proteinExistence: '1: Evidence at protein level',
        },
      ],
      totalResults: 1,
    } satisfies ProteomeProteinPage);
    const ctx = createMockContext({ errors: getProteome.errors });
    const input = getProteome.input.parse({ taxon_id: 9606, include_proteins: true });

    await getProteome.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.cursor).toBeUndefined();
    expect(enrichment.shown).toBe(1);
  });

  it('rejects a malformed upid with the UPID message, not the compiled pattern', async () => {
    const result = await runToolContract(getProteome, { upid: 'UP12345' } as never);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.data).toMatchObject({ reason: 'invalid_arguments' });
    const expected =
      'Must be a proteome UPID: "UP" followed by 9 digits, e.g. "UP000005640". Or pass taxon_id instead.';
    expect(envelope.message).toContain(expected);
    expect(contentText(result)).toContain(expected);
    expect(envelope.message).not.toContain('must match pattern');
    expect(getProteomeMock).not.toHaveBeenCalled();
  });

  it("a rejected query filter fails invalid_query with UniProt's message and a recovery hint", async () => {
    // Real service (sanitizer included) over a stubbed fetch answering UniProt's 400
    // to the proteome-scoped UniProtKB search.
    getProteomeMock.mockResolvedValue(humanProteome);
    const fetchStub = vi.fn((_input: string | URL | Request) =>
      Promise.resolve(upstreamResponse(400, UNIPROT_400_BODIES.badQueryField, 'Bad Request')),
    );
    vi.stubGlobal('fetch', fetchStub);
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));

    const result = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      query: 'badfield:abc',
    });
    const envelope = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.message).toBe(
      "UniProt rejected the request: 'badfield' is not a valid search field",
    );
    expect(envelope.data).toMatchObject({ reason: 'invalid_query' });
    const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
    expect(hint).toContain('omit query');
    const text = contentText(result);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('(reason invalid_query');
    expect(JSON.stringify(result)).not.toMatch(
      /rest\.uniprot\.org|Bad Request|"url"|responseBody|statusCode/,
    );
    const sent = new URL(String(fetchStub.mock.calls[0]?.[0]));
    expect(sent.searchParams.get('query')).toBe('proteome:UP000005640 AND (badfield:abc)');
  });

  it('rejects an unbalanced query filter as invalid_query before any UniProt request', async () => {
    // The filter is sent as "proteome:<upid> AND (<query>)": a stray ")" would close that
    // group early and leave the rest of the filter outside the proteome scope.
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockResolvedValue({ proteins: [], totalResults: 0 });
    const result = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      query: 'reviewed:true) OR (gene:TP53',
    });
    const envelope = errorEnvelope(result);
    const message =
      'Unbalanced parentheses in query: the ")" at character 14 closes a group that was never opened.';
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.message).toBe(message);
    expect(envelope.data).toMatchObject({ reason: 'invalid_query' });
    const text = contentText(result);
    expect(text).toContain(message);
    expect(text).toContain('(reason invalid_query');
    expect(getProteomeMock).not.toHaveBeenCalled();
    expect(getProteomeProteinsMock).not.toHaveBeenCalled();
  });

  it('ignores an unbalanced query when include_proteins is false — the filter is unused', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    const result = await runToolContract(getProteome, {
      taxon_id: 9606,
      query: 'reviewed:true) OR (gene:TP53',
    });
    expect(result.isError).toBeFalsy();
    expect(getProteomeProteinsMock).not.toHaveBeenCalled();
  });

  it('passes a balanced query with a quoted parenthesis through to the proteome search', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockResolvedValue({ proteins: [], totalResults: 0 });
    const result = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      query: 'protein_name:"p53 (tumor"',
    });
    expect(result.isError).toBeFalsy();
    expect(getProteomeProteinsMock).toHaveBeenCalledWith(
      'UP000005640',
      expect.objectContaining({ query: 'protein_name:"p53 (tumor"' }),
      expect.anything(),
    );
  });

  it.each([
    ['gene:TP53\\', 'proteome:UP000005640 AND (gene:TP53\\ )'],
    ['gene:TP53\\\\', 'proteome:UP000005640 AND (gene:TP53\\\\)'],
  ])(
    'sends a query filter %j so a trailing backslash cannot escape its group (real service)',
    async (query, sent) => {
      getProteomeMock.mockResolvedValue(humanProteome);
      const fetchStub = routeUpstream((url) =>
        url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: [] }) : undefined,
      );
      vi.stubGlobal('fetch', fetchStub);
      getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));
      const result = await runToolContract(getProteome, {
        taxon_id: 9606,
        include_proteins: true,
        query,
      });
      expect(result.isError).toBeFalsy();
      expect(requestedUrls(fetchStub).map((u) => u.searchParams.get('query'))).toEqual([sent]);
    },
  );

  it('a protein cursor UniProt cannot continue from (its 500) fails invalid_cursor, not invalid_query', async () => {
    // Real service, retry included, so the backoff runs on fake timers.
    getProteomeMock.mockResolvedValue(humanProteome);
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search'
        ? upstreamResponse(500, { messages: ['Internal server error'] }, 'Internal Server Error')
        : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));
    vi.useFakeTimers();
    try {
      const pending = runToolContract(getProteome, {
        taxon_id: 9606,
        include_proteins: true,
        query: 'reviewed:true',
        cursor: queryCursor.encode(
          'garbage',
          'uniprot_get_proteome',
          'proteome:UP000005640 AND (reviewed:true)',
        ),
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      const envelope = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.message).toContain('UniProt could not continue from the cursor');
      expect(envelope.data).toMatchObject({ reason: 'invalid_cursor' });
      const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
      expect(hint).toContain('no cursor');
      const text = contentText(result);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).toContain('(reason invalid_cursor');
      expect(requestedUrls(fetchStub)[0]?.searchParams.get('cursor')).toBe('garbage');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-400 failure listing proteins is not classified as invalid_query', async () => {
    getProteomeMock.mockResolvedValue(humanProteome);
    getProteomeProteinsMock.mockRejectedValue(
      serviceUnavailable('uniprot.search failed upstream (-32000).'),
    );
    const result = await runToolContract(getProteome, { taxon_id: 9606, include_proteins: true });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.data?.reason).toBeUndefined();
  });

  it('a non-404 failure fetching the proteome itself is not classified as not_found', async () => {
    getProteomeMock.mockRejectedValue(
      serviceUnavailable('uniprot.getProteome failed upstream (-32000).'),
    );
    const result = await runToolContract(getProteome, { taxon_id: 9606 });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.message).toBe('uniprot.getProteome failed upstream (-32000).');
    expect(envelope.data?.reason).toBeUndefined();
    expect(getProteomeProteinsMock).not.toHaveBeenCalled();
  });

  it('renders the proteome and each listed protein on content[] (real service, cursor walked forward)', async () => {
    /**
     * An unreviewed row as `/uniprotkb/search` returned it under the default
     * search projection (captured 2026-10-12): no genes, a function comment.
     */
    const tremblRow = {
      entryType: 'UniProtKB unreviewed (TrEMBL)',
      primaryAccession: 'A0A140VJC8',
      uniProtkbId: 'A0A140VJC8_HUMAN',
      annotationScore: 5.0,
      organism: {
        scientificName: 'Homo sapiens',
        commonName: 'Human',
        taxonId: 9606,
        evidences: [{ evidenceCode: 'ECO:0000313', source: 'EMBL', id: 'AEE60915.1' }],
      },
      proteinExistence: '2: Evidence at transcript level',
      proteinDescription: {
        recommendedName: {
          fullName: {
            evidences: [{ evidenceCode: 'ECO:0000256', source: 'RuleBase', id: 'RU367156' }],
            value: 'Amyloid-beta A4 protein',
          },
        },
      },
      comments: [
        {
          texts: [
            {
              evidences: [{ evidenceCode: 'ECO:0000256', source: 'RuleBase', id: 'RU367156' }],
              value:
                'Functions as a cell surface receptor and performs physiological functions on the surface of neurons relevant to neurite growth, neuronal adhesion and axonogenesis',
            },
          ],
          commentType: 'FUNCTION',
        },
      ],
      sequence: { length: 770 },
      extraAttributes: { uniParcId: 'UPI000002DB1C' },
    };
    const fetchStub = routeUpstream((url) => {
      if (url.pathname === '/proteomes/search') {
        return upstreamResponse(200, { results: [RAW_HUMAN_PROTEOME] });
      }
      if (url.pathname === '/uniprotkb/search') {
        const response = upstreamResponse(200, { results: [RAW_ENTRIES.p53, tremblRow] });
        response.headers.set('x-total-results', '20420');
        response.headers.set(
          'link',
          '<https://rest.uniprot.org/uniprotkb/search?query=x&cursor=cur-1&size=2>; rel="next"',
        );
        return response;
      }
      return;
    });
    vi.stubGlobal('fetch', fetchStub);
    getProteomeMock.mockImplementation(realService.getProteome.bind(realService));
    getProteomeProteinsMock.mockImplementation(realService.getProteomeProteins.bind(realService));

    const result = await runToolContract(getProteome, {
      taxon_id: 9606,
      include_proteins: true,
      size: 2,
      cursor: queryCursor.encode('cur-0', 'uniprot_get_proteome', 'proteome:UP000005640'),
    });

    expect(result.isError).toBeFalsy();
    const [proteomeUrl, proteinsUrl] = requestedUrls(fetchStub);
    expect(proteomeUrl?.searchParams.get('query')).toBe('(organism_id:9606) AND (reference:true)');
    expect(proteinsUrl?.searchParams.get('query')).toBe('proteome:UP000005640');
    expect(proteinsUrl?.searchParams.get('cursor')).toBe('cur-0');
    expect(proteinsUrl?.searchParams.get('size')).toBe('2');

    const text = contentText(result);
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        '# Homo sapiens (Human) — UP000005640',
        '**Type:** Reference proteome · **Proteins:** 147520 · **Taxon:** 9606 (HUMAN)',
        '**Genome assembly:** GCA_000001405.29',
        '**BUSCO:** 99% complete (primates_odb10) — complete 13716 (single 5103, duplicated 8613), fragmented 5, missing 59 of 13780',
        '## Proteins (2 shown)',
        '- **P04637** (P53_HUMAN) Cellular tumor antigen p53 [TP53, P53]',
        '  reviewed · score 5/5 · 393 aa · 1: Evidence at protein level · Homo sapiens (Human) [taxon 9606]',
        '- **A0A140VJC8** (A0A140VJC8_HUMAN) Amyloid-beta A4 protein',
        '  unreviewed · score 5/5 · 770 aa · 2: Evidence at transcript level · Homo sapiens (Human) [taxon 9606]',
        '  Functions as a cell surface receptor and performs physiological functions on the surface of neurons relevant to neurite growth, neuronal adhesion and axonogenesis',
      ]),
    );
    // The page continues: the next cursor and the total ride the enrichment.
    const nextCursor = (result.structuredContent as { cursor: string }).cursor;
    expect(queryCursor.decode(nextCursor, 'uniprot_get_proteome', 'proteome:UP000005640')).toBe(
      'cur-1',
    );
    expect(text).toContain(nextCursor);
    expect(text).toContain('Showing 2 of 20420 proteins.');
  });

  it('format() renders proteome metadata and BUSCO completeness', () => {
    const blocks = getProteome.format!({ proteome: humanProteome });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('UP000005640');
    expect(text).toContain('Homo sapiens');
    expect(text).toContain('147506');
    expect(text).toContain('GCA_000001405.29');
    expect(text).toContain('99% complete');
    expect(text).toContain('primates_odb10');
  });

  it('format() renders a sparse proteome (no BUSCO, no assembly) without fabricating sections', () => {
    const sparse: Proteome = {
      upid: 'UP000000001',
      proteomeType: 'Other proteome',
      organism: { scientificName: 'Unknown organism', taxonId: 1 },
      proteinCount: 0,
    };
    const blocks = getProteome.format!({ proteome: sparse });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('UP000000001');
    expect(text).not.toContain('BUSCO');
    expect(text).not.toContain('Genome assembly');
    expect(text).not.toContain('**Genes:**');
    expect(text).not.toContain('proteins:**');
    expect(text).not.toContain('CPD');
    expect(text).not.toContain('undefined');
  });

  describe('gene count, protein statistics, CPD status, and exclusion reasons (#49, real service)', () => {
    /** One upid call through the real service, `/proteomes/search` answering with `raw`. */
    const callWith = (raw: { id: string }) => {
      vi.stubGlobal(
        'fetch',
        routeUpstream((url) =>
          url.pathname === '/proteomes/search'
            ? upstreamResponse(200, { results: [raw] })
            : undefined,
        ),
      );
      getProteomeMock.mockImplementation(realService.getProteome.bind(realService));
      return runToolContract(getProteome, { upid: raw.id });
    };
    const COUNT_KEYS = [
      'geneCount',
      'reviewedProteinCount',
      'unreviewedProteinCount',
      'isoformProteinCount',
      'cpdStatus',
      'exclusionReasons',
    ];
    const countsOf = (result: { structuredContent?: unknown }) =>
      Object.fromEntries(
        Object.entries((result.structuredContent as { proteome: object }).proteome).filter(
          ([key]) => COUNT_KEYS.includes(key),
        ),
      );
    /** The content[] lines that carry the #49 fields and the type, in render order. */
    const metadataLines = (result: { content: { type: string; text?: string }[] }) =>
      contentText(result)
        .split('\n')
        .filter((line) => /^\*\*(Type|Genes|Reviewed|CPD)/.test(line));

    it('renders the human reference proteome counts and CPD status on both surfaces', async () => {
      const result = await callWith(RAW_PROTEOMES.human);
      expect(result.isError).toBeFalsy();
      expect(countsOf(result)).toStrictEqual({
        geneCount: 20652,
        reviewedProteinCount: 20414,
        unreviewedProteinCount: 243472,
        isoformProteinCount: 22131,
        cpdStatus: 'Outlier (high value)',
      });
      expect(metadataLines(result)).toEqual([
        '**Type:** Reference proteome · **Proteins:** 263886 · **Taxon:** 9606 (HUMAN)',
        '**Genes:** 20652 · **Reviewed proteins:** 20414 · **Unreviewed proteins:** 243472 · **Additional isoforms:** 22131',
        '**CPD status:** Outlier (high value)',
      ]);
    });

    it("renders E. coli K-12's real 0 unreviewed count on both surfaces", async () => {
      const result = await callWith(RAW_PROTEOMES.ecoli);
      expect(countsOf(result)).toStrictEqual({
        geneCount: 4403,
        reviewedProteinCount: 4403,
        unreviewedProteinCount: 0,
        isoformProteinCount: 12,
        cpdStatus: 'Close to standard (low value)',
      });
      expect(metadataLines(result)).toEqual([
        '**Type:** Reference proteome · **Proteins:** 4403 · **Taxon:** 83333 (ECOLI)',
        '**Genes:** 4403 · **Reviewed proteins:** 4403 · **Unreviewed proteins:** 0 · **Additional isoforms:** 12',
        '**CPD status:** Close to standard (low value)',
      ]);
    });

    it("omits a non-reference proteome's placeholder zeros on both surfaces, keeping its CPD status", async () => {
      const result = await callWith(RAW_PROTEOMES.nonReference);
      expect(countsOf(result)).toStrictEqual({ cpdStatus: 'Close to standard (low value)' });
      expect(metadataLines(result)).toEqual([
        '**Type:** Non Reference proteome · **Proteins:** 4227 · **Taxon:** 83333 (ECOLI)',
        '**CPD status:** Close to standard (low value)',
      ]);
    });

    it("names an excluded proteome's exclusion reasons beside its type on both surfaces", async () => {
      const result = await callWith(RAW_PROTEOMES.excluded);
      expect(countsOf(result)).toStrictEqual({
        cpdStatus: 'Outlier (low value)',
        exclusionReasons: ['genome length too small'],
      });
      expect(metadataLines(result)).toEqual([
        '**Type:** Excluded (genome length too small) · **Proteins:** 3547 · **Taxon:** 1110693 (ECOLI)',
        '**CPD status:** Outlier (low value)',
      ]);
    });

    it('joins several exclusion reasons and renders a lone statistic without its siblings', () => {
      const text = contentText({
        content: getProteome.format!({
          proteome: {
            ...humanProteome,
            proteomeType: 'Excluded',
            exclusionReasons: ['contaminated', 'unverified source organism'],
            isoformProteinCount: 0,
          },
        }),
      });
      expect(text).toContain(
        '**Type:** Excluded (contaminated; unverified source organism) · **Proteins:** 147506',
      );
      expect(text).toContain('\n**Additional isoforms:** 0\n');
    });
  });
});
