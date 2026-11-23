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

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { queryCursor } from '@/services/uniprot/query-cursor.js';
import type { SearchPage } from '@/services/uniprot/types.js';
import {
  activeRawEntry,
  contentText,
  errorEnvelope,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  RAW_SNIPPET_ROWS,
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
  '## Cellular tumor antigen p53 (P04637)\n**Entry:** P53_HUMAN\nReviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level\n**Organism:** Homo sapiens (Human) [taxon 9606]\n**Genes:** TP53\n\n\nQuery: `gene:TP53`\n**totalResults:** 1';

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

describe('searchProteins inactive stubs under the reviewed and organism filters (#44)', () => {
  /** The Q15086 stub as rest.uniprot.org returned it (release 2026_04, captured 2026-11-23). */
  const Q15086_STUB = {
    entryType: 'Inactive',
    primaryAccession: 'Q15086',
    uniProtkbId: 'Q15086',
    annotationScore: 0.0,
    inactiveReason: { inactiveReasonType: 'MERGED', mergeDemergeTo: ['P04637'] },
    extraAttributes: { uniParcId: 'UPI000006CFA4' },
  };
  const brca1Row = activeRawEntry('P38398', 'BRCA1_HUMAN', 1863);

  /**
   * Answer as UniProt does: a stub carries no review tier and no organism, so a
   * reviewed:true or taxonomy_id: conjunct excludes it unless active:false is OR'ed in
   * beside the filters; the active human BRCA1 row matches whenever the query names it.
   */
  function uniprotFilters() {
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const query = url.searchParams.get('query') ?? '';
      const filtered = /reviewed:true|taxonomy_id:/.test(query);
      const rows = [
        ...(query.includes('P38398') ? [brca1Row] : []),
        ...(/q15086/i.test(query) && (!filtered || query.includes(' OR active:false)'))
          ? [Q15086_STUB]
          : []),
      ];
      const response = upstreamResponse(200, { results: rows });
      response.headers.set('x-total-results', String(rows.length));
      return response;
    });
    vi.stubGlobal('fetch', fetchStub);
    searchMock.mockImplementation(realService.search.bind(realService));
    return fetchStub;
  }

  type Out = {
    results: { accession: string }[];
    inactive?: object[];
    totalResults: number;
    effectiveQuery: string;
    notice?: string;
  };
  const Q15086_INACTIVE = {
    accession: 'Q15086',
    reason: 'MERGED',
    replacedBy: ['P04637'],
    uniParcId: 'UPI000006CFA4',
  };

  it.each([
    [{ query: 'accession:Q15086' }, '(accession:Q15086) AND ((reviewed:true) OR active:false)'],
    [
      { query: 'accession:Q15086', reviewed: false, organism_id: 9606 },
      '(accession:Q15086) AND ((taxonomy_id:9606) OR active:false)',
    ],
    [{ text_search: 'Q15086' }, '(Q15086) AND ((reviewed:true) OR active:false)'],
  ])('returns the merged Q15086 in inactive[] for %j on both surfaces', async (args, sent) => {
    const fetchStub = uniprotFilters();
    const result = await runToolContract(searchProteins, args as never);

    expect(result.isError).toBeFalsy();
    expect(requestedUrls(fetchStub)[0]?.searchParams.get('query')).toBe(sent);
    const out = result.structuredContent as Out;
    expect(out.effectiveQuery).toBe(sent);
    expect(out.results).toEqual([]);
    expect(out.inactive).toEqual([Q15086_INACTIVE]);
    expect(out.totalResults).toBe(1);
    expect(out.notice).toBeUndefined();
    const text = contentText(result);
    expect(text).toContain(
      '- **Q15086** — Q15086 is inactive in UniProtKB: merged into P04637. Retry with P04637. UniParc: UPI000006CFA4.',
    );
    expect(text).toContain(`Query: \`${sent}\``);
    expect(text.split('\n')).toContain('**totalResults:** 1');
    expect(text).not.toContain('No proteins matched');
  });

  it('returns an active hit in results[] and a named stub in inactive[] under organism_id', async () => {
    uniprotFilters();
    const result = await runToolContract(searchProteins, {
      query: 'accession:Q15086 OR accession:P38398',
      organism_id: 9606,
    });

    expect(result.isError).toBeFalsy();
    const sent =
      '(accession:Q15086 OR accession:P38398) AND ((taxonomy_id:9606 AND reviewed:true) OR active:false)';
    const out = result.structuredContent as Out;
    expect(out.effectiveQuery).toBe(sent);
    expect(out.results.map((hit) => hit.accession)).toEqual(['P38398']);
    expect(out.inactive).toEqual([Q15086_INACTIVE]);
    expect(out.totalResults).toBe(2);
    const text = contentText(result);
    expect(text.split('\n')).toContain('**totalResults:** 2');
    expect(text).toContain('(P38398)');
    expect(text).toContain('- **Q15086** — Q15086 is inactive in UniProtKB: merged into P04637.');
    expect(text).toContain(`Query: \`${sent}\``);
  });

  it('still raises the no-match notice when a named accession matches nothing', async () => {
    uniprotFilters();
    const result = await runToolContract(searchProteins, { query: 'accession:Q99999' });

    const out = result.structuredContent as Out;
    expect(out.effectiveQuery).toBe('(accession:Q99999) AND ((reviewed:true) OR active:false)');
    expect(out.results).toEqual([]);
    expect(out).not.toHaveProperty('inactive');
    expect(out.notice).toBe(
      'No proteins matched the query. Broaden the terms or set reviewed: false to search both Swiss-Prot and unreviewed TrEMBL. Check field syntax in query.',
    );
    expect(contentText(result)).toContain(out.notice);
  });

  /** `count` distinct accession-shaped tokens: P00000, P00001, … */
  const accessions = (count: number, prefix = 'P') =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`);
  const orList = (count: number, prefix?: string) =>
    accessions(count, prefix)
      .map((accession) => `accession:${accession}`)
      .join(' OR ');

  it.each([
    // An accession-shaped token, any case, admits the stubs the clause names.
    [{ query: 'accession:q15086' }, '(accession:q15086) AND ((reviewed:true) OR active:false)'],
    [
      { text_search: 'P04637-2 isoform', organism_id: 9606 },
      String.raw`(P04637\-2 isoform) AND ((taxonomy_id:9606 AND reviewed:true) OR active:false)`,
    ],
    // A caller-pinned tier still takes the appended organism filter, and the branch with it.
    [
      { query: 'accession:Q15086 OR reviewed:false', organism_id: 9606 },
      '(accession:Q15086 OR reviewed:false) AND ((taxonomy_id:9606) OR active:false)',
    ],
    // Nothing appended, nothing branched: the clause goes out as written.
    [{ query: 'accession:Q15086 AND reviewed:true' }, 'accession:Q15086 AND reviewed:true'],
    [{ query: 'accession:Q15086', reviewed: false }, 'accession:Q15086'],
    // No accession-shaped token: today's assembly, so a negation or match-all admits no stub.
    [
      { query: 'gene_exact:TP53', organism_id: 9606 },
      '(gene_exact:TP53) AND taxonomy_id:9606 AND reviewed:true',
    ],
    [{ query: '*', organism_id: 9606 }, '(*) AND taxonomy_id:9606 AND reviewed:true'],
    [{ query: 'NOT gene:TP53' }, '(NOT gene:TP53) AND reviewed:true'],
    [{ text_search: 'C9orf72 P53_HUMAN' }, '(C9orf72 P53_HUMAN) AND reviewed:true'],
  ])('assembles %j into %j', async (args, sent) => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    await searchProteins.handler(searchProteins.input.parse(args), ctx);
    expect(searchMock.mock.calls[0]![0]).toBe(sent);
    expect(getEnrichment(ctx).effectiveQuery).toBe(sent);
  });

  // UniProt answers a query holding more than 100 OR conditions with a 400, and the branch
  // adds two, so a clause holding more than 98 is sent as before.
  it.each([
    ['98 OR-ed accessions (97 ORs)', { query: orList(98) }, true],
    ['99 OR-ed accessions (98 ORs)', { query: orList(99) }, false],
    // 97 ORs over two groups is 99 conditions: each group's terms count.
    [
      'two OR groups of 50 and 49 accessions (97 ORs)',
      { query: `(${orList(50)}) AND (${orList(49, 'Q')})` },
      false,
    ],
    ['98 space-separated accessions', { text_search: accessions(98).join(' ') }, true],
    ['99 space-separated accessions', { text_search: accessions(99).join(' ') }, false],
  ])('branches %s: %#', async (_what, args, branched) => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    await searchProteins.handler(searchProteins.input.parse(args), ctx);
    const clause = 'query' in args ? args.query : args.text_search;
    expect(searchMock.mock.calls[0]![0]).toBe(
      branched
        ? `(${clause}) AND ((reviewed:true) OR active:false)`
        : `(${clause}) AND reviewed:true`,
    );
  });

  it('round-trips the cursor of a branched query', async () => {
    searchMock.mockResolvedValue({ ...onePage, cursor: 'NEXT' });
    const first = await runToolContract(searchProteins, { query: 'accession:Q15086' });
    const cursor = (first.structuredContent as { cursor: string }).cursor;
    expect(
      queryCursor.decode(
        cursor,
        'uniprot_search_proteins',
        '(accession:Q15086) AND ((reviewed:true) OR active:false)',
      ),
    ).toBe('NEXT');
    searchMock.mockClear();
    const second = await runToolContract(searchProteins, { query: 'accession:Q15086', cursor });
    expect(second.isError).toBeFalsy();
    expect(searchMock).toHaveBeenCalledWith(
      '(accession:Q15086) AND ((reviewed:true) OR active:false)',
      { cursor: 'NEXT' },
      expect.anything(),
    );
  });

  it('rejects a cursor saved under the unbranched query before any request', async () => {
    const cursor = queryCursor.encode(
      'NEXT',
      'uniprot_search_proteins',
      '(accession:Q15086) AND reviewed:true',
    );
    const result = await runToolContract(searchProteins, { query: 'accession:Q15086', cursor });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_cursor' });
    expect(contentText(result)).toContain('no cursor');
    expect(searchMock).not.toHaveBeenCalled();
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

  it('rejects a size above the cap at the schema edge under UNIPROT_CLAMP_LIMITS=false', () => {
    getServerConfig().clampLimits = false;
    try {
      expect(() => searchProteins.input.parse({ text_search: 'x', size: 501 })).toThrow();
    } finally {
      getServerConfig().clampLimits = true;
    }
  });
});

describe('searchProteins size cap (#41)', () => {
  /** The `size` property as `tools/list` advertises it. */
  const advertisedSize = () =>
    (
      z.toJSONSchema(searchProteins.input, { io: 'input', target: 'draft-2020-12' }) as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.size as Record<string, unknown>;

  afterEach(() => {
    getServerConfig().clampLimits = true;
  });

  it.each([501, 1e20])(
    'requests size %s as 500, with a notice naming both values on both surfaces and the cursor intact',
    async (size) => {
      searchMock.mockResolvedValue({ ...onePage, totalResults: 4457, cursor: 'NEXT' });
      const result = await runToolContract(searchProteins, { text_search: 'kinase', size });

      expect(result.isError).toBeFalsy();
      expect(searchMock).toHaveBeenCalledWith(expect.any(String), { size: 500 }, expect.anything());
      const out = result.structuredContent as { notice: string; cursor: string };
      expect(out.notice).toBe(
        `size ${String(size)} is above UniProt's page maximum of 500, so this page was requested at size 500.`,
      );
      expect(contentText(result)).toContain(out.notice);
      expect(
        queryCursor.decode(out.cursor, 'uniprot_search_proteins', '(kinase) AND reviewed:true'),
      ).toBe('NEXT');
    },
  );

  it('sends size 500 as asked, with no notice', async () => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, { text_search: 'kinase', size: 500 });
    expect(searchMock).toHaveBeenCalledWith(expect.any(String), { size: 500 }, expect.anything());
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('carries the clamp notice beside the no-match notice', async () => {
    searchMock.mockResolvedValue({ results: [], inactive: [], totalResults: 0 });
    const result = await runToolContract(searchProteins, { text_search: 'kinase', size: 501 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('No proteins matched');
    expect(notice).toContain('size 501');
    expect(contentText(result)).toContain(notice);
  });

  it('rejects a fractional size as an integer mistake, before any request', async () => {
    const result = await runToolContract(searchProteins, { text_search: 'kinase', size: 1.5 });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(result).message).toContain('expected int');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('advertises size as an integer with a minimum and no maximum', () => {
    expect(advertisedSize()).toMatchObject({ type: 'integer', minimum: 1 });
    expect(advertisedSize().maximum).toBeUndefined();
  });

  it('under UNIPROT_CLAMP_LIMITS=false advertises maximum 500 and rejects 501 before any request', async () => {
    getServerConfig().clampLimits = false;
    expect(advertisedSize()).toMatchObject({ type: 'integer', minimum: 1, maximum: 500 });
    const result = await runToolContract(searchProteins, { text_search: 'kinase', size: 501 });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(result).message).toContain('<=500');
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('searchProteins function snippet (#36, real service)', () => {
  /** A first FUNCTION text of five evidence-tagged sentences, well past 400 characters. */
  const LONG_FUNCTION =
    'Receptor tyrosine kinase binding ligands of the EGF family and activating several signaling cascades to convert extracellular cues into appropriate cellular responses (PubMed:10805725, PubMed:2790960). Known ligands include EGF, TGFA/TGF-alpha, AREG and BTC/betacellulin (PubMed:12297049). Ligand binding triggers receptor homo- and/or heterodimerization and autophosphorylation on key cytoplasmic residues (By similarity). The phosphorylated receptor recruits adapter proteins like GRB2 which in turn activates complex downstream signaling cascades (PubMed:17909029). Activates at least 4 major downstream signaling cascades including the RAS-RAF-MEK-ERK, PI3 kinase-AKT, PLCgamma-PKC and STATs modules (PubMed:27153536).';
  /** Its first two sentences, evidence stripped: 237 characters, where the third would run past 250. */
  const SNIPPET =
    'Receptor tyrosine kinase binding ligands of the EGF family and activating several signaling cascades to convert extracellular cues into appropriate cellular responses. Known ligands include EGF, TGFA/TGF-alpha, AREG and BTC/betacellulin.';

  it('bounds a long first FUNCTION text to whole sentences on both surfaces', async () => {
    expect(LONG_FUNCTION.length).toBeGreaterThan(400);
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) => {
        if (url.pathname !== '/uniprotkb/search') return;
        const row = {
          ...activeRawEntry('P00533', 'EGFR_HUMAN', 1210),
          comments: [{ commentType: 'FUNCTION', texts: [{ value: LONG_FUNCTION }] }],
        };
        const response = upstreamResponse(200, { results: [row] });
        response.headers.set('x-total-results', '1');
        return response;
      }),
    );
    searchMock.mockImplementation(realService.search.bind(realService));

    const result = await runToolContract(searchProteins, { query: 'gene:EGFR' });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { results: { functionSnippet?: string }[] };
    expect(out.results[0]?.functionSnippet).toBe(SNIPPET);
    const text = contentText(result);
    expect(text.split('\n')).toContain(`**Function:** ${SNIPPET}`);
    expect(text).not.toContain('Ligand binding triggers');
  });
});

describe('searchProteins function snippet molecule (#45, real service)', () => {
  it("labels a snippet with its FUNCTION comment's molecule on both surfaces, and an unqualified one not at all", async () => {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, { results: [RAW_SNIPPET_ROWS.P01275, RAW_SNIPPET_ROWS.P04637] })
          : undefined,
      ),
    );
    searchMock.mockImplementation(realService.search.bind(realService));

    const result = await runToolContract(searchProteins, {
      query: 'accession:P01275 OR accession:P04637',
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      results: { accession: string; functionSnippetMolecule?: string }[];
    };
    expect(out.results.map((hit) => [hit.accession, hit.functionSnippetMolecule])).toEqual([
      ['P01275', 'Glucagon'],
      ['P04637', undefined],
    ]);
    expect(out.results[1]).not.toHaveProperty('functionSnippetMolecule');
    expect(
      contentText(result)
        .split('\n')
        .filter((line) => line.startsWith('**Function:**')),
    ).toEqual([
      '**Function:** Glucagon: Plays a key role in glucose metabolism and homeostasis. Regulates blood glucose by increasing gluconeogenesis and decreasing glycolysis. A counterregulatory hormone of insulin, raises plasma glucose levels in response to insulin-induced hypoglycemia.',
      '**Function:** Multifunctional transcription factor that induces cell cycle arrest, DNA repair or apoptosis upon binding to its target DNA sequence.',
    ]);
  });
});

describe('searchProteins sequence flags (real service)', () => {
  it('keeps a fragment’s flag when a custom fields list leaves out protein_name', async () => {
    // UniProt sends proteinDescription (which carries the flag) only when protein_name is requested.
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const requested = url.searchParams.get('fields')?.split(',') ?? [];
      return upstreamResponse(200, {
        results: [
          {
            ...activeRawEntry('P0DJE4', 'P0DJE4_TEST', 202),
            ...(requested.includes('protein_name')
              ? {
                  proteinDescription: {
                    recommendedName: { fullName: { value: 'Protein P0DJE4' } },
                    flag: 'Fragments',
                  },
                }
              : {}),
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchStub);
    searchMock.mockImplementation(realService.search.bind(realService));

    const result = await runToolContract(searchProteins, {
      query: 'gene:X',
      fields: 'accession,length',
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      results: { accession: string; length: number; sequenceFlags?: string[] }[];
    };
    expect(out.results[0]).toMatchObject({ length: 202, sequenceFlags: ['Fragments'] });
    expect(contentText(result)).toContain('202 aa (Fragments)');
  });

  it('qualifies a flagged hit’s length on both surfaces, and leaves an unflagged one bare', async () => {
    // Flag values as rest.uniprot.org sent them under the default projection (2026-11-23).
    const flagged = (accession: string, length: number, flag?: string) => ({
      ...activeRawEntry(accession, `${accession}_TEST`, length),
      proteinDescription: {
        recommendedName: { fullName: { value: `Protein ${accession}` } },
        ...(flag ? { flag } : {}),
      },
    });
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, {
              results: [
                flagged('P0DJE4', 202, 'Fragments'),
                flagged('P13838', 378, 'Fragment,Precursor'),
                flagged('P04637', 393),
              ],
            })
          : undefined,
      ),
    );
    searchMock.mockImplementation(realService.search.bind(realService));

    const result = await runToolContract(searchProteins, { query: 'gene:X' });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      results: { accession: string; sequenceFlags?: string[] }[];
    };
    expect(out.results.map((hit) => [hit.accession, hit.sequenceFlags])).toEqual([
      ['P0DJE4', ['Fragments']],
      ['P13838', ['Fragment', 'Precursor']],
      ['P04637', undefined],
    ]);
    expect(out.results[2]).not.toHaveProperty('sequenceFlags');
    expect(
      contentText(result)
        .split('\n')
        .filter((line) => line.startsWith('Reviewed (Swiss-Prot)')),
    ).toEqual([
      'Reviewed (Swiss-Prot) · Score 5/5 · 202 aa (Fragments) · 1: Evidence at protein level',
      'Reviewed (Swiss-Prot) · Score 5/5 · 378 aa (Fragment, Precursor) · 1: Evidence at protein level',
      'Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level',
    ]);
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
      { query: 'kinase (apoptosis' },
      'Unbalanced parentheses in query: the "(" at character 8 is never closed.',
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
      { query: '🧬 kinase)' },
      'Unbalanced parentheses in query: the ")" at character 9 closes a group that was never opened.',
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
      String.raw`(p53\\\\\\) AND taxonomy_id:9606 AND reviewed:true`,
    ],
    [{ query: 'gene:TP53\\\\' }, '(gene:TP53\\\\) AND reviewed:true'],
    // Nothing appended, nothing wrapped: the clause goes out as written, as it always did.
    [{ query: 'reviewed:true AND gene:TP53\\' }, 'reviewed:true AND gene:TP53\\'],
  ])('sends %j with a trailing backslash that cannot escape the wrapper', async (args, sent) => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, args as never);
    expect(result.isError).toBeFalsy();
    expect(searchMock.mock.calls[0]![0]).toBe(sent);
    expect(contentText(result)).toContain(`Query: \`${sent}\``);
  });

  it('escapes an unclosed quote in plain text', async () => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, { text_search: 'kinase "apoptosis' });
    expect(result.isError).toBeFalsy();
    expect(searchMock.mock.calls[0]![0]).toBe(String.raw`(kinase \"apoptosis) AND reviewed:true`);
  });
});

describe('searchProteins literal text and descendant scope', () => {
  it.each([
    ['kinase apoptosis', '(kinase apoptosis) AND reviewed:true'],
    ['IL-6 receptor: signaling', String.raw`(IL\-6 receptor\: signaling) AND reviewed:true`],
    [
      'ATP synthase [mitochondrial]',
      String.raw`(ATP synthase \[mitochondrial\]) AND reviewed:true`,
    ],
    ['kinase ~ apoptosis^2', String.raw`(kinase \~ apoptosis\^2) AND reviewed:true`],
    ['kinase (apoptosis', String.raw`(kinase \(apoptosis) AND reviewed:true`],
    ['🧬 kinase)', String.raw`(🧬 kinase\)) AND reviewed:true`],
    ['p53* + kinase?', String.raw`(p53\* \+ kinase\?) AND reviewed:true`],
    [
      'kinase AND NOT apoptosis OR TP53',
      '(kinase "AND" "NOT" apoptosis "OR" TP53) AND reviewed:true',
    ],
    ['βNOT NOTCH1 ORF1', '(βNOT NOTCH1 ORF1) AND reviewed:true'],
    ['reviewed:false', String.raw`(reviewed\:false) AND reviewed:true`],
    ['a && b || !c / d {e}', String.raw`(a \&\& b \|\| \!c \/ d \{e\}) AND reviewed:true`],
  ])('sends plain text %j as words rather than query syntax', async (text_search, expected) => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, { text_search });
    expect(result.isError).toBeFalsy();
    expect(searchMock.mock.calls[0]![0]).toBe(expected);
    expect(result.structuredContent).toMatchObject({ effectiveQuery: expected });
    expect(contentText(result)).toContain(expected);
  });

  it('keeps explicit exact-node Lucene filters alongside descendant convenience scope', async () => {
    searchMock.mockResolvedValue(onePage);
    const result = await runToolContract(searchProteins, {
      query: 'gene_exact:gyrA AND organism_id:83333',
      organism_id: 562,
    });
    expect(result.structuredContent).toMatchObject({
      effectiveQuery:
        '(gene_exact:gyrA AND organism_id:83333) AND taxonomy_id:562 AND reviewed:true',
    });
    expect(searchMock.mock.calls[0]![0]).toBe(
      '(gene_exact:gyrA AND organism_id:83333) AND taxonomy_id:562 AND reviewed:true',
    );
  });

  it('rejects a saved exact-node convenience cursor instead of applying it to descendants', async () => {
    const cursor = queryCursor.encode(
      'NEXT',
      'uniprot_search_proteins',
      '(gene:TP53) AND organism_id:9606 AND reviewed:true',
    );
    const result = await runToolContract(searchProteins, {
      query: 'gene:TP53',
      organism_id: 9606,
      cursor,
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_cursor' });
    expect(contentText(result)).toContain('no cursor');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('does not offer field syntax as a remedy for literal text with no matches', async () => {
    searchMock.mockResolvedValue({ results: [], inactive: [], totalResults: 0 });
    const result = await runToolContract(searchProteins, { text_search: 'kinase ~ nothing' });
    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('No proteins matched');
    expect(notice).toContain('reviewed: false');
    expect(notice).not.toContain('field syntax');
    expect(contentText(result)).toContain(notice);
  });

  // Thread-CPU oracle: a wall-clock timeout measures machine load, not this code (timeout 0).
  // An accession-shaped token sends the whole text through the OR-condition count (#44).
  it.each(['NOT ( [ ', '  \r\n', '\\', '§1 x', 'Q15086 OR '])(
    'assembles long plain text with bounded CPU growth: %j',
    async (unit) => {
      searchMock.mockResolvedValue(onePage);
      const context = createMockContext({ errors: searchProteins.errors });
      const samples: number[] = [];
      for (const size of [5_000, 20_000, 80_000, 320_000]) {
        const text = `${unit.repeat(Math.ceil(size / unit.length)).slice(0, size)}\ny`;
        const input = searchProteins.input.parse({ text_search: text });
        const measurements: number[] = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          searchMock.mockClear();
          const start = process.threadCpuUsage();
          await searchProteins.handler(input, context);
          const elapsed = process.threadCpuUsage(start);
          measurements.push(elapsed.user + elapsed.system);
        }
        const cpuUs = Math.min(...measurements);
        samples.push(cpuUs);
        expect(cpuUs).toBeLessThan(500_000);
        if (samples.length > 1) expect(cpuUs / samples[0]!).toBeLessThan(256);
      }
      expect(searchMock).toHaveBeenCalledTimes(1);
    },
    0,
  );
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
    expect(sentQuery).toContain('taxonomy_id:9606');
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
      '(gene:TP53) AND taxonomy_id:9606',
    ],
    // A caller-pinned reviewed clause stays; nothing is appended, so it is sent unwrapped.
    [{ query: 'gene:TP53 AND reviewed:false' }, 'gene:TP53 AND reviewed:false'],
    // ...but it is wrapped when organism_id is still appended.
    [
      { query: 'gene:TP53 OR reviewed:false', organism_id: 9606 },
      '(gene:TP53 OR reviewed:false) AND taxonomy_id:9606',
    ],
    // UniProtKB binds AND tighter than OR: unwrapped, reviewed:true would apply to the
    // last branch only and TrEMBL hits would leak in through the first.
    [{ query: 'gene:TP53 OR gene:MDM2' }, '(gene:TP53 OR gene:MDM2) AND reviewed:true'],
    [
      { query: 'gene:TP53 OR gene:MDM2', organism_id: 9606 },
      '(gene:TP53 OR gene:MDM2) AND taxonomy_id:9606 AND reviewed:true',
    ],
    [
      { text_search: 'insulin OR glucagon', organism_id: 9606 },
      '(insulin "OR" glucagon) AND taxonomy_id:9606 AND reviewed:true',
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
    const wrapped = '(gene:TP53 OR gene:MDM2) AND taxonomy_id:9606 AND reviewed:true';
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
        '(kinase) AND taxonomy_id:9606 AND reviewed:true',
      ),
    ).toBe('NEXT');
    expect(effective.effectiveQuery).toContain('taxonomy_id:9606');
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
    expect(notice).toContain('No proteins matched the plain-text search.');
    expect(notice).not.toContain('reviewed: false');
  });

  it('passes a mandatory-columns-only hit through without an output-validation crash', async () => {
    // The shape a restrictive custom `fields` yields for an entry with no recommended
    // name once the service merges in MANDATORY_FIELDS — only the required ProteinHit
    // columns, no proteinName/functionSnippet/commonName. Must still satisfy the output schema.
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
    ['query syntax', UNIPROT_400_BODIES.invalidSyntax, { query: 'kinase "apoptosis' }],
    // Text that is not a field name goes upstream as sent (captured 2026-11-17, release 2026_04).
    [
      'fields value',
      {
        url: 'http://rest.uniprot.org/uniprotkb/search',
        messages: ["Invalid fields parameter value 'not-a-field'"],
      } as const,
      { query: 'gene:TP53', fields: 'not-a-field' },
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
      expect(text).toContain(relayed.replaceAll('[', '\\[').replaceAll(']', '\\]'));
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

describe('searchProteins return fields (#34, real service, through runToolContract)', () => {
  type Out = {
    results: { accession: string; geneNames: string[] }[];
    ignoredFields?: string[];
    notice?: string;
  };
  const IDENTITY_FIELDS =
    'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence';

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

  const sentFields = (fetchStub: ReturnType<typeof routeUpstream>) =>
    requestedUrls(fetchStub)[0]?.searchParams.get('fields');

  const egfrRow = {
    ...activeRawEntry('P00533', 'EGFR_HUMAN', 1210),
    genes: [{ geneName: { value: 'EGFR' }, synonyms: [{ value: 'ERBB' }, { value: 'ERBB1' }] }],
  };

  it('sends none of the fields a hit cannot carry, and names them with a route to uniprot_get_entry', async () => {
    const fetchStub = searchReturns(egfrRow);
    const result = await runToolContract(searchProteins, {
      query: 'gene:EGFR',
      organism_id: 9606,
      fields: 'accession,ec,cc_subcellular_location,xref_pdb,ft_act_site',
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub)).toBe(IDENTITY_FIELDS);
    const out = result.structuredContent as Out;
    expect(out.results.map((r) => r.accession)).toEqual(['P00533']);
    expect(out.ignoredFields).toEqual(['ec', 'cc_subcellular_location', 'xref_pdb', 'ft_act_site']);
    const notice = required(out.notice, 'the ignored-field notice');
    expect(notice).toContain(
      'Ignored fields: ec, cc_subcellular_location, xref_pdb, ft_act_site — search hits do not carry them, so they were not requested from UniProt.',
    );
    expect(notice).toContain(
      'uniprot_get_entry returns ec, cc_subcellular_location, xref_pdb, ft_act_site: pass these results\' accessions with fields:"ec,cc_subcellular_location,xref_pdb,ft_act_site".',
    );
    const text = contentText(result);
    expect(text).toContain(
      '**Ignored fields:** ec, cc_subcellular_location, xref_pdb, ft_act_site',
    );
    expect(text).toContain(`> ${notice}`);
  });

  it('keeps a projection a hit renders whole, with no ignoredFields and no notice', async () => {
    const fetchStub = searchReturns(egfrRow);
    const result = await runToolContract(searchProteins, {
      query: 'gene:EGFR',
      fields: 'accession,gene_names,cc_function',
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub)).toBe(`${IDENTITY_FIELDS},cc_function`);
    const out = result.structuredContent as Out;
    expect(out).not.toHaveProperty('ignoredFields');
    expect(out).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('Ignored fields');
  });

  it('lists P0A7V8’s ordered-locus names among the hit’s gene names', async () => {
    searchReturns({
      ...activeRawEntry('P0A7V8', 'RS4_ECOLI', 206),
      genes: [
        {
          geneName: { value: 'rpsD' },
          synonyms: [{ value: 'ramA' }],
          orderedLocusNames: [{ value: 'b3296' }, { value: 'JW3258' }],
        },
      ],
    });
    const result = await runToolContract(searchProteins, { query: 'gene:rpsD' });

    expect((result.structuredContent as Out).results[0]?.geneNames).toEqual([
      'rpsD',
      'ramA',
      'b3296',
      'JW3258',
    ]);
    expect(contentText(result)).toContain('**Genes:** rpsD, ramA, b3296, JW3258');
  });

  it('joins the ignored-field notice to the no-match notice, on both surfaces', async () => {
    searchReturns();
    const result = await runToolContract(searchProteins, { query: 'gene:NOPE', fields: 'ec' });

    const notice = required((result.structuredContent as Out).notice, 'the joined notice');
    expect(notice).toContain('Ignored fields: ec — ');
    expect(notice).toContain('No proteins matched the query.');
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('joins the ignored-field notice to the size-clamp notice, on both surfaces', async () => {
    const fetchStub = searchReturns(egfrRow);
    const result = await runToolContract(searchProteins, {
      query: 'gene:EGFR',
      size: 501,
      fields: 'accession,ec',
    });

    expect(result.isError).toBeFalsy();
    expect(requestedUrls(fetchStub)[0]?.searchParams.get('size')).toBe('500');
    const out = result.structuredContent as Out;
    expect(out.ignoredFields).toEqual(['ec']);
    const notice = required(out.notice, 'the joined notice');
    expect(notice).toContain(
      "size 501 is above UniProt's page maximum of 500, so this page was requested at size 500.",
    );
    expect(notice).toContain(
      'Ignored fields: ec — search hits do not carry them, so they were not requested from UniProt.',
    );
    const text = contentText(result);
    expect(text).toContain('**Ignored fields:** ec');
    expect(text).toContain(`> ${notice}`);
  });

  it('sends only the identity columns when every requested field is ignored, so no hit carries a function snippet', async () => {
    // Answers as UniProt does: the FUNCTION comment comes back only when cc_function is requested.
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const requested = url.searchParams.get('fields')?.split(',') ?? [];
      const row = requested.includes('cc_function')
        ? {
            ...egfrRow,
            comments: [
              { commentType: 'FUNCTION', texts: [{ value: 'Receptor tyrosine kinase.' }] },
            ],
          }
        : egfrRow;
      const response = upstreamResponse(200, { results: [row] });
      response.headers.set('x-total-results', '1');
      return response;
    });
    vi.stubGlobal('fetch', fetchStub);
    searchMock.mockImplementation(realService.search.bind(realService));

    const result = await runToolContract(searchProteins, { query: 'gene:EGFR', fields: 'ec' });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub)).toBe(IDENTITY_FIELDS);
    const out = result.structuredContent as Out & { results: { functionSnippet?: string }[] };
    expect(out.results.map((r) => r.accession)).toEqual(['P00533']);
    expect(out.results[0]).not.toHaveProperty('functionSnippet');
    expect(out.ignoredFields).toEqual(['ec']);
    expect(contentText(result)).not.toContain('**Function:**');
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
