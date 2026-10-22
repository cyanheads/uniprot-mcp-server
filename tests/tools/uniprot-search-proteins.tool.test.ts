/**
 * @fileoverview Tests for the uniprot_search_proteins tool. Two layers:
 *   query-mode validation (the text_search/query split contracts) and format()
 *   rendering (including a sparse hit with only required fields); plus handler
 *   behavior with a stubbed UniProtService — effective-query assembly (reviewed
 *   default, reviewed:false adding no tier clause, the caller clause parenthesized
 *   whenever a filter is appended, honoring a caller-pinned reviewed: clause),
 *   cursor/total enrichment, and the empty-result notice; plus the invalid_query
 *   contract for an upstream 400, driven through the real service over a stubbed
 *   fetch and read off both client surfaces.
 * @module tests/tools/uniprot-search-proteins.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryCursor } from '@/services/uniprot/query-cursor.js';
import type { SearchPage } from '@/services/uniprot/types.js';
import {
  activeRawEntry,
  contentText,
  errorEnvelope,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  rejectUnmockedFetch,
  requestedUrls,
  required,
  routeUpstream,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

/** An all-active search page's two client surfaces, as the tool rendered them before inactive[] existed. */
const ALL_ACTIVE_JSON =
  '{"results":[{"accession":"P04637","entryName":"P53_HUMAN","proteinName":"Cellular tumor antigen p53","geneNames":["TP53"],"organism":{"scientificName":"Homo sapiens","commonName":"Human","taxonId":9606},"length":393,"reviewed":true,"annotationScore":5,"proteinExistence":"1: Evidence at protein level"}],"totalResults":1,"effectiveQuery":"gene:TP53"}';
const ALL_ACTIVE_TEXT =
  '## Cellular tumor antigen p53 (P04637)\n**Entry:** P53_HUMAN\nReviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level\n**Organism:** Homo sapiens (Human) [taxon 9606]\n**Genes:** TP53\n\n\nQuery: gene:TP53\n**totalResults:** 1';

const searchMock = vi.fn();

// Only the accessor is stubbed; the module's error predicates stay real.
vi.mock('@/services/uniprot/uniprot-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uniprot/uniprot-service.js')>()),
  getUniProtService: () => ({ search: searchMock }),
}));

const { searchProteins } = await import(
  '@/mcp-server/tools/definitions/uniprot-search-proteins.tool.js'
);

/** The real service, for tests that drive an upstream response through its sanitizer. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

const onePage: SearchPage = {
  results: [
    {
      accession: 'P04637',
      entryName: 'P53_HUMAN',
      proteinName: 'Cellular tumor antigen p53',
      geneNames: ['TP53'],
      organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
      length: 393,
      reviewed: true,
      annotationScore: 5,
      proteinExistence: '1: Evidence at protein level',
    },
  ],
  inactive: [],
  totalResults: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchProteins inactive hits (real service, through runToolContract)', () => {
  /** Answer the search with these raw rows and a matching x-total-results. */
  function searchReturns(...rows: object[]) {
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const response = upstreamResponse(200, { results: rows });
      response.headers.set('x-total-results', String(rows.length));
      return response;
    });
    vi.stubGlobal('fetch', fetchStub);
    searchMock.mockImplementation(realService.search.bind(realService));
    return fetchStub;
  }

  const p53Row = {
    ...activeRawEntry('P04637', 'P53_HUMAN'),
    proteinDescription: { recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } } },
    genes: [{ geneName: { value: 'TP53' } }],
  };

  it('leaves an all-active page exactly as before (characterization)', async () => {
    searchReturns(p53Row);
    const result = await runToolContract(searchProteins, { query: 'gene:TP53', reviewed: false });

    expect(result.isError).toBeFalsy();
    // Byte-level: key order and every rendered character are pinned.
    expect(JSON.stringify(result.structuredContent)).toBe(ALL_ACTIVE_JSON);
    expect(contentText(result)).toBe(ALL_ACTIVE_TEXT);
  });

  it('moves inactive hits out of results[] into inactive[] with their reason and pointer', async () => {
    searchReturns(p53Row, INACTIVE_STUBS.merged, INACTIVE_STUBS.deleted, INACTIVE_STUBS.demerged);
    const result = await runToolContract(searchProteins, {
      query: 'accession:P04637 OR accession:Q13140 OR accession:Q9ZZZ9 OR accession:P62158',
      reviewed: false,
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      results: { accession: string }[];
      inactive?: object[];
    };
    expect(out.results.map((r) => r.accession)).toEqual(['P04637']);
    expect(out.inactive).toEqual([
      { accession: 'Q13140', reason: 'MERGED', replacedBy: ['P02768'], uniParcId: 'UPI000016A1A8' },
      {
        accession: 'Q9ZZZ9',
        reason: 'DELETED',
        deletedReason: 'Not part of a reference proteome',
        uniParcId: 'UPI000008B5B6',
      },
      {
        accession: 'P62158',
        reason: 'DEMERGED',
        replacedBy: ['P0DP25', 'P0DP23', 'P0DP24'],
        uniParcId: 'UPI0000020B41',
      },
    ]);
    const text = contentText(result);
    for (const message of Object.values(INACTIVE_MESSAGES)) expect(text).toContain(message);
    // Format parity: every uniParcId in structuredContent reaches content[], MERGED/DEMERGED
    // included, exactly once — the DELETED sentence already names its UniParc ID, so no
    // "UniParc:" suffix repeats it.
    for (const id of ['UPI000016A1A8', 'UPI000008B5B6', 'UPI0000020B41']) {
      expect(text.split(id).length - 1).toBe(1);
    }
    // No hollow hit is rendered for an inactive accession.
    expect(text).not.toContain('[taxon 0]');
    expect(text).not.toContain('(Q13140)');
    expect(JSON.stringify(out)).not.toMatch(/"taxonId":0|"scientificName":"unknown"/);
  });

  it('returns an empty results[] without the no-match notice when every hit is inactive', async () => {
    searchReturns(INACTIVE_STUBS.merged, INACTIVE_STUBS.deleted);
    const result = await runToolContract(searchProteins, {
      query: 'accession:Q13140 OR accession:Q9ZZZ9',
      reviewed: false,
    });

    const out = result.structuredContent as {
      results: object[];
      inactive?: { accession: string }[];
      notice?: string;
    };
    expect(out.results).toEqual([]);
    expect(out.inactive?.map((i) => i.accession)).toEqual(['Q13140', 'Q9ZZZ9']);
    expect(out.notice).toBeUndefined();
    const text = contentText(result);
    expect(text).toContain(INACTIVE_MESSAGES.merged);
    expect(text).toContain(INACTIVE_MESSAGES.deleted);
    expect(text).not.toContain('No matching proteins.');
  });
});

describe('searchProteins validation', () => {
  it('walks three real-service pages while fields, facets, and size change', async () => {
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const position = url.searchParams.get('cursor');
      const response = upstreamResponse(200, {
        results: [
          activeRawEntry(
            position === 'third' ? 'P00439' : position === 'second' ? 'P38398' : 'P04637',
            'ENTRY',
          ),
        ],
      });
      response.headers.set('x-total-results', '3');
      if (position !== 'third')
        response.headers.set(
          'link',
          `<https://rest.uniprot.org/uniprotkb/search?cursor=${position === 'second' ? 'third' : 'second'}>; rel="next"`,
        );
      return response;
    });
    vi.stubGlobal('fetch', fetchStub);
    searchMock.mockImplementation(realService.search.bind(realService));
    let cursor: string | undefined;
    const seen: string[] = [];
    for (const size of [1, 2, 3]) {
      const result = await runToolContract(searchProteins, {
        query: 'gene:TP53',
        cursor,
        size,
        ...(size > 1 ? { fields: 'accession', facets: 'reviewed' } : {}),
      });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as { results: { accession: string }[]; cursor?: string };
      seen.push(...out.results.map((hit) => hit.accession));
      cursor = out.cursor;
      if (cursor) expect(contentText(result)).toContain(cursor);
    }
    expect(seen).toEqual(['P04637', 'P38398', 'P00439']);
    expect(cursor).toBeUndefined();
    expect(requestedUrls(fetchStub).map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'second',
      'third',
    ]);
  });

  it.each([
    { query: 'gene:BRCA1' },
    { query: 'gene:TP53', organism_id: 9606 },
    { query: 'gene:TP53', reviewed: false },
  ])('rejects changed effective query before paging: %j', async (input) => {
    searchMock.mockResolvedValue({ ...onePage, cursor: 'next' });
    const first = await runToolContract(searchProteins, { query: 'gene:TP53' });
    const cursor = (first.structuredContent as { cursor: string }).cursor;
    searchMock.mockClear();
    const result = await runToolContract(searchProteins, { ...input, cursor });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_cursor' });
    expect(contentText(result)).toContain('no cursor');
    expect(searchMock).not.toHaveBeenCalled();
  });
  it('rejects legacy raw cursors before the service request with restart recovery', async () => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, {
      query: 'gene:TP53',
      cursor: 'raw-cursor',
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_cursor' });
    expect(contentText(result)).toContain('no cursor');
    expect(searchMock).not.toHaveBeenCalled();
  });
  it('throws missing_query when neither text_search nor query is provided', async () => {
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({});
    await expect(searchProteins.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_query' },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('throws conflicting_query when both text_search and query are provided', async () => {
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'kinase', query: 'gene:TP53' });
    await expect(searchProteins.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_query' },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('treats whitespace-only text_search as absent', async () => {
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: '   ' });
    await expect(searchProteins.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_query' },
    });
  });

  it('rejects a size above the cap at the schema edge', () => {
    expect(() => searchProteins.input.parse({ text_search: 'x', size: 501 })).toThrow();
  });
});

describe('searchProteins unbalanced parentheses (through runToolContract)', () => {
  // The caller clause is wrapped as "(<clause>) AND <filters>". A stray ")" closes that
  // wrapper early — "gene:TP53) OR (gene:MDM2" would bind reviewed:true to the last branch
  // only, and UniProt answers that with a 200 — so an unbalanced clause is rejected here,
  // before any request.
  it.each([
    [
      { query: 'gene:TP53) OR (gene:MDM2' },
      'Unbalanced parentheses in query: the ")" at character 10 closes a group that was never opened.',
    ],
    [
      { text_search: 'kinase (apoptosis' },
      'Unbalanced parentheses in text_search: the "(" at character 8 is never closed.',
    ],
    [
      { query: '((gene:TP53) AND reviewed:false', organism_id: 9606 },
      'Unbalanced parentheses in query: the "(" at character 1 is never closed.',
    ],
    [
      { query: 'gene:TP53)', reviewed: false },
      'Unbalanced parentheses in query: the ")" at character 10 closes a group that was never opened.',
    ],
    // Positions count characters as written, so an astral character counts once.
    [
      { text_search: '🧬 kinase)' },
      'Unbalanced parentheses in text_search: the ")" at character 9 closes a group that was never opened.',
    ],
    // Several unclosed groups: the first one opened is the one named.
    [
      { query: '(a (b' },
      'Unbalanced parentheses in query: the "(" at character 1 is never closed.',
    ],
  ])('rejects %j as invalid_query without calling UniProt', async (args, message) => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, args as never);
    const envelope = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.message).toBe(message);
    expect(envelope.data).toMatchObject({ reason: 'invalid_query' });
    const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
    expect(hint).toContain('balance parentheses');
    const text = contentText(result);
    expect(text).toContain(message);
    expect(text).toContain('(reason invalid_query');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['protein_name:"p53 (tumor"', '(protein_name:"p53 (tumor") AND reviewed:true'],
    ['protein_name:"a) b"', '(protein_name:"a) b") AND reviewed:true'],
    [
      'protein_name:"say \\"(hi\\"" AND gene:X',
      '(protein_name:"say \\"(hi\\"" AND gene:X) AND reviewed:true',
    ],
    ['gene:TP53\\)', '(gene:TP53\\)) AND reviewed:true'],
    [
      '(gene:TP53 OR gene:MDM2) AND (length:[100 TO 200])',
      '((gene:TP53 OR gene:MDM2) AND (length:[100 TO 200])) AND reviewed:true',
    ],
  ])(
    'sends %j, whose parentheses inside quotes or escapes do not count, wrapped as written',
    async (query, sent) => {
      searchMock.mockResolvedValue(onePage);
      const result = await runToolContract(searchProteins, { query });
      expect(result.isError).toBeFalsy();
      expect(searchMock.mock.calls[0]![0]).toBe(sent);
    },
  );

  // A clause ending in an unescaped "\" would escape the wrapper's ")" — UniProt answers
  // "(gene:TP53\) AND reviewed:true" with a 400 — so a space is set before the ")". An even
  // run of trailing backslashes is a literal backslash and is left alone.
  it.each([
    [{ query: 'gene:TP53\\' }, '(gene:TP53\\ ) AND reviewed:true'],
    [
      { text_search: 'p53\\\\\\', organism_id: 9606 },
      '(p53\\\\\\ ) AND organism_id:9606 AND reviewed:true',
    ],
    [{ query: 'gene:TP53\\\\' }, '(gene:TP53\\\\) AND reviewed:true'],
    // Nothing appended, nothing wrapped: the clause goes out as written, as it always did.
    [{ query: 'reviewed:true AND gene:TP53\\' }, 'reviewed:true AND gene:TP53\\'],
  ])('sends %j with a trailing backslash that cannot escape the wrapper', async (args, sent) => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, args as never);
    expect(result.isError).toBeFalsy();
    expect(searchMock.mock.calls[0]![0]).toBe(sent);
    expect(contentText(result)).toContain(`Query: ${sent}`);
  });

  it('leaves an unclosed quote to UniProt, which answers it with its own 400', async () => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, { text_search: 'kinase "apoptosis' });
    expect(result.isError).toBeFalsy();
    expect(searchMock.mock.calls[0]![0]).toBe('(kinase "apoptosis) AND reviewed:true');
  });
});

describe('searchProteins handler', () => {
  it('appends reviewed:true by default and ANDs the organism filter', async () => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({
      text_search: 'kinase apoptosis',
      organism_id: 9606,
    });

    const result = await searchProteins.handler(input, ctx);
    const sentQuery = searchMock.mock.calls[0]![0] as string;
    expect(sentQuery).toContain('kinase apoptosis');
    expect(sentQuery).toContain('organism_id:9606');
    expect(sentQuery).toContain('reviewed:true');
    expect(getEnrichment(ctx)).toMatchObject({
      effectiveQuery: sentQuery,
      totalResults: 1,
    });
    expect(result.results).toHaveLength(1);
    expect(result).toEqual(expect.schemaMatching(searchProteins.output));
  });

  it.each([
    // reviewed: false appends no tier clause, so both Swiss-Prot and TrEMBL come back.
    [{ text_search: 'kinase', reviewed: false }, 'kinase'],
    [
      { query: 'gene:TP53', organism_id: 9606, reviewed: false },
      '(gene:TP53) AND organism_id:9606',
    ],
    // A caller-pinned reviewed clause stays; nothing is appended, so it is sent unwrapped.
    [{ query: 'gene:TP53 AND reviewed:false' }, 'gene:TP53 AND reviewed:false'],
    // ...but it is wrapped when organism_id is still appended.
    [
      { query: 'gene:TP53 OR reviewed:false', organism_id: 9606 },
      '(gene:TP53 OR reviewed:false) AND organism_id:9606',
    ],
    // UniProtKB binds AND tighter than OR: unwrapped, reviewed:true would apply to the
    // last branch only and TrEMBL hits would leak in through the first.
    [{ query: 'gene:TP53 OR gene:MDM2' }, '(gene:TP53 OR gene:MDM2) AND reviewed:true'],
    [
      { query: 'gene:TP53 OR gene:MDM2', organism_id: 9606 },
      '(gene:TP53 OR gene:MDM2) AND organism_id:9606 AND reviewed:true',
    ],
    [
      { text_search: 'insulin OR glucagon', organism_id: 9606 },
      '(insulin OR glucagon) AND organism_id:9606 AND reviewed:true',
    ],
    // Wrapping is unconditional whenever a filter is appended, single terms included.
    [{ query: 'gene:TP53' }, '(gene:TP53) AND reviewed:true'],
  ])('assembles %j into the effective query %j', async (args, sent) => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    await searchProteins.handler(searchProteins.input.parse(args), ctx);
    expect(searchMock.mock.calls[0]![0]).toBe(sent);
    expect(getEnrichment(ctx).effectiveQuery).toBe(sent);
  });

  it('sends the wrapped effectiveQuery on both client surfaces', async () => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, {
      query: 'gene:TP53 OR gene:MDM2',
      organism_id: 9606,
    });
    const wrapped = '(gene:TP53 OR gene:MDM2) AND organism_id:9606 AND reviewed:true';
    expect((result.structuredContent as { effectiveQuery?: string }).effectiveQuery).toBe(wrapped);
    expect(contentText(result)).toContain(wrapped);
  });

  it('surfaces the forward cursor through enrichment', async () => {
    searchMock.mockResolvedValue({ ...onePage, cursor: 'NEXT' });
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'kinase' });

    await searchProteins.handler(input, ctx);
    expect(
      queryCursor.decode(
        getEnrichment(ctx).cursor as string,
        'uniprot_search_proteins',
        '(kinase) AND reviewed:true',
      ),
    ).toBe('NEXT');
  });

  it('passes the page size and a returned cursor through to the next search', async () => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({
      text_search: 'kinase',
      size: 5,
      cursor: queryCursor.encode('NEXT', 'uniprot_search_proteins', '(kinase) AND reviewed:true'),
    });

    await searchProteins.handler(input, ctx);
    expect(searchMock).toHaveBeenCalledWith(expect.any(String), { size: 5, cursor: 'NEXT' }, ctx);
  });

  it('declares cursor/total/effective-query so they reach content[], not only the store', async () => {
    // Parity guard: the follow-up metadata must be declared in the enrichment block,
    // or the effective-output parse strips it from both structuredContent and the
    // content[] trailer — leaving text-only clients without the next page or count.
    searchMock.mockResolvedValue({ ...onePage, totalResults: 4457, cursor: 'NEXT' });
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'kinase', organism_id: 9606 });

    const result = await searchProteins.handler(input, ctx);
    const effective = searchProteins.output
      .extend(required(searchProteins.enrichment, 'searchProteins.enrichment'))
      .parse({ ...result, ...getEnrichment(ctx) });
    expect(effective.totalResults).toBe(4457);
    expect(
      queryCursor.decode(
        effective.cursor,
        'uniprot_search_proteins',
        '(kinase) AND organism_id:9606 AND reviewed:true',
      ),
    ).toBe('NEXT');
    expect(effective.effectiveQuery).toContain('organism_id:9606');
  });

  it('emits a broaden-the-search notice on zero results', async () => {
    searchMock.mockResolvedValue({
      results: [],
      inactive: [],
      totalResults: 0,
    } satisfies SearchPage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'zzzznotarealquery' });

    const result = await searchProteins.handler(input, ctx);
    expect(result.results).toHaveLength(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No proteins matched');
    expect(notice).toContain('reviewed: false');
    expect(notice).toContain('both Swiss-Prot and unreviewed TrEMBL');
  });

  it('does not suggest reviewed: false on zero results when no tier filter was applied', async () => {
    searchMock.mockResolvedValue({
      results: [],
      inactive: [],
      totalResults: 0,
    } satisfies SearchPage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'zzzznotarealquery', reviewed: false });

    await searchProteins.handler(input, ctx);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No proteins matched "zzzznotarealquery"');
    expect(notice).not.toContain('reviewed: false');
  });

  it('passes a mandatory-columns-only hit through without an output-validation crash', async () => {
    // The shape a restrictive custom `fields` yields once the service merges in
    // MANDATORY_SEARCH_FIELDS — only the required ProteinHit columns, no
    // proteinName/functionSnippet/commonName. Must still satisfy the output schema.
    searchMock.mockResolvedValue({
      results: [
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
      inactive: [],
      totalResults: 1,
    } satisfies SearchPage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({
      query: 'gene:TP53',
      fields: 'accession,gene_names',
    });

    const result = await searchProteins.handler(input, ctx);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.proteinName).toBeUndefined();
    expect(result).toEqual(expect.schemaMatching(searchProteins.output));
  });

  it('passes facets through to the output when present', async () => {
    searchMock.mockResolvedValue({
      ...onePage,
      facets: [
        {
          name: 'reviewed',
          label: 'Status',
          values: [{ value: 'true', label: 'Reviewed (Swiss-Prot)', count: 4457 }],
        },
      ],
    } satisfies SearchPage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'kinase', facets: 'reviewed' });

    const result = await searchProteins.handler(input, ctx);
    expect(result.facets).toHaveLength(1);
    expect(result.facets?.[0]?.name).toBe('reviewed');
  });
});

describe('searchProteins upstream rejection (through runToolContract)', () => {
  // UniProt answers a bad query, text_search, fields, or facets value with a 400 whose
  // messages[] names the rejected value. These run the real service (sanitizer included)
  // over a stubbed fetch and read the envelope a client receives on both surfaces.
  it.each([
    ['query field', UNIPROT_400_BODIES.badQueryField, { query: 'badfield:abc' }],
    // An unclosed quote passes the local parenthesis check and reaches UniProt's own 400.
    ['text_search syntax', UNIPROT_400_BODIES.invalidSyntax, { text_search: 'kinase "apoptosis' }],
    [
      'fields value',
      UNIPROT_400_BODIES.badFields,
      { query: 'gene:TP53', fields: 'definitely_not_a_uniprot_field' },
    ],
    // UniProt's message lists the facets it accepts.
    ['facet', UNIPROT_400_BODIES.badFacet, { query: 'gene:TP53', facets: 'not_a_facet' }],
  ])(
    "a rejected %s fails invalid_query with UniProt's message and a recovery hint",
    async (_what, body, args) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(upstreamResponse(400, body, 'Bad Request'))),
      );
      searchMock.mockImplementation(realService.search.bind(realService));
      const relayed = body.messages[0];

      const result = await runToolContract(searchProteins, args as never);
      const envelope = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.message).toBe(`UniProt rejected the request: ${relayed}`);
      expect(envelope.data).toMatchObject({ reason: 'invalid_query' });
      const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
      expect(hint).toContain('named in the message');
      const text = contentText(result);
      expect(text).toContain(relayed);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).toContain('(reason invalid_query');
      // Nothing else from the upstream body or HTTP layer reaches either surface.
      const wire = JSON.stringify(result);
      expect(wire).not.toMatch(/rest\.uniprot\.org|Bad Request|"url"|responseBody|statusCode/);
    },
  );

  it('a cursor UniProt cannot continue from (its 500) fails invalid_cursor, not invalid_query', async () => {
    // Real service, retry included: UniProt's 500 is retried before it settles, so the
    // backoff runs on fake timers.
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        upstreamResponse(
          500,
          { url: 'http://rest.uniprot.org/uniprotkb/search', messages: ['Internal server error'] },
          'Internal Server Error',
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchStub);
    searchMock.mockImplementation(realService.search.bind(realService));
    vi.useFakeTimers();
    try {
      const pending = runToolContract(searchProteins, {
        query: 'gene:TP53',
        cursor: queryCursor.encode(
          'garbage',
          'uniprot_search_proteins',
          '(gene:TP53) AND reviewed:true',
        ),
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      const envelope = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.message).toBe(
        'UniProt could not continue from the cursor: it answered HTTP 500, so the cursor is malformed or truncated.',
      );
      expect(envelope.data).toMatchObject({ reason: 'invalid_cursor' });
      const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
      expect(hint).toContain('no cursor');
      const text = contentText(result);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).toContain('(reason invalid_cursor');
      expect(JSON.stringify(result)).not.toMatch(/rest\.uniprot\.org|Internal server error/);
      expect(fetchStub.mock.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-400 upstream failure is not classified as invalid_query', async () => {
    searchMock.mockRejectedValue(serviceUnavailable('uniprot.search failed upstream (-32000).'));
    const result = await runToolContract(searchProteins, { query: 'gene:TP53' });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.data?.reason).toBeUndefined();
  });
});

describe('searchProteins format', () => {
  it('format() renders a hit with all fields, including the entry name', () => {
    const blocks = searchProteins.format!({
      results: [
        {
          accession: 'P04637',
          entryName: 'P53_HUMAN',
          proteinName: 'Cellular tumor antigen p53',
          geneNames: ['TP53', 'P53'],
          organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
          length: 393,
          reviewed: true,
          annotationScore: 5,
          proteinExistence: '1: Evidence at protein level',
          functionSnippet: 'Multifunctional transcription factor.',
        },
      ],
      facets: [
        {
          name: 'reviewed',
          label: 'Status',
          values: [{ value: 'true', label: 'Reviewed (Swiss-Prot)', count: 4457 }],
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('P04637');
    expect(text).toContain('P53_HUMAN');
    expect(text).toContain('Reviewed (Swiss-Prot)');
    expect(text).toContain('TP53');
    expect(text).toContain('true');
  });

  it('format() renders a sparse hit (no proteinName/functionSnippet) without fabricating values', () => {
    const blocks = searchProteins.format!({
      results: [
        {
          accession: 'A0A0A0A0A0',
          entryName: 'A0A0A0A0A0_BACSU',
          geneNames: [],
          organism: { scientificName: 'Bacillus subtilis', taxonId: 1423 },
          length: 120,
          reviewed: false,
          annotationScore: 1,
          proteinExistence: '4: Predicted',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('A0A0A0A0A0');
    expect(text).toContain('Unreviewed (TrEMBL)');
    // No fabricated function/protein-name strings.
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('format() renders a fallback line when there are no results', () => {
    const blocks = searchProteins.format!({ results: [] });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('No matching proteins.');
  });

  it('format() names every pointer of an irregular inactive entry and invents none for a bare one', () => {
    const blocks = searchProteins.format!({
      results: [],
      inactive: [
        { accession: 'Q00001' },
        { accession: 'Q00002', reason: 'MERGED', replacedBy: ['P00001', 'P00002'] },
        { accession: 'Q00003', reason: 'DELETED' },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('- **Q00001** — Q00001 is inactive in UniProtKB.');
    // A merge with two targets is not the single-target retry case: both are named.
    expect(text).toContain('Q00002 is inactive in UniProtKB (MERGED): replaced by P00001, P00002.');
    expect(text).toContain('Q00003 was deleted from UniProtKB.');
    expect(text).not.toContain('UniParc');
    expect(text).not.toContain('No matching proteins.');
  });
});
