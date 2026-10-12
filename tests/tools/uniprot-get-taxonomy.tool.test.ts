/**
 * @fileoverview Tests for the uniprot_get_taxonomy tool — handler behavior with
 *   a stubbed UniProtService: the missing_identifier and not_found ctx.fail
 *   contracts (the not_found regression — a service NotFound from either the
 *   by-id or by-name path must surface as data.reason === 'not_found', not a
 *   leaked raw throw), by-id vs by-name dispatch, the include_children branch,
 *   and format() rendering.
 * @module tests/tools/uniprot-get-taxonomy.tool.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Taxon, TaxonChild } from '@/services/uniprot/types.js';
import {
  contentText,
  errorEnvelope,
  expectMcpError,
  rejectUnmockedFetch,
  requestedUrls,
  routeUpstream,
  upstreamResponse,
} from '../helpers.js';

const getTaxonByIdMock = vi.fn();
const getTaxonByNameMock = vi.fn();
const getChildrenMock = vi.fn();

// Only the accessor is stubbed; the module's error predicates stay real.
vi.mock('@/services/uniprot/uniprot-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/uniprot/uniprot-service.js')>()),
  getUniProtService: () => ({
    getTaxonById: getTaxonByIdMock,
    getTaxonByName: getTaxonByNameMock,
    getChildren: getChildrenMock,
  }),
}));

const { getTaxonomy } = await import('@/mcp-server/tools/definitions/uniprot-get-taxonomy.tool.js');

const human: Taxon = {
  taxonId: 9606,
  scientificName: 'Homo sapiens',
  commonName: 'Human',
  mnemonic: 'HUMAN',
  rank: 'species',
  parent: { taxonId: 9605, scientificName: 'Homo' },
  lineage: [
    { taxonId: 2759, scientificName: 'Eukaryota', rank: 'superkingdom' },
    { taxonId: 9605, scientificName: 'Homo', rank: 'genus' },
  ],
  otherNames: ['Homo sapiens Linnaeus, 1758'],
};

/** The real service, for tests that drive upstream responses through its parsing and error mapping. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getTaxonomy', () => {
  it('bounds taxon_id to safe integers at the schema, below the ids UniProt cannot parse', async () => {
    // UniProt answers 400 only past its long range; the int schema stops far below it.
    const result = await runToolContract(getTaxonomy, { taxon_id: 1e20 });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(getTaxonByIdMock).not.toHaveBeenCalled();
    expect(getTaxonomy.input.safeParse({ taxon_id: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  });

  it('throws missing_identifier when neither taxon_id nor name is provided', async () => {
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({});
    await expect(getTaxonomy.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_identifier' },
    });
    expect(getTaxonByIdMock).not.toHaveBeenCalled();
    expect(getTaxonByNameMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only name as absent', async () => {
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ name: '   ' });
    await expect(getTaxonomy.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_identifier' },
    });
  });

  it('throws conflicting_identifier when both taxon_id and name are provided', async () => {
    // The tool tells callers to provide exactly one — contradictory identifiers must
    // be rejected, not silently resolved down the taxon_id path (which would answer
    // the wrong organism relative to the caller's intent).
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606, name: 'Mus musculus' });
    await expect(getTaxonomy.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_identifier' },
    });
    expect(getTaxonByIdMock).not.toHaveBeenCalled();
    expect(getTaxonByNameMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only name alongside a taxon_id as non-conflicting', async () => {
    // A form client may submit name:"" with a real taxon_id — that is the taxon_id
    // path, not a conflict.
    getTaxonByIdMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606, name: '   ' });

    const result = await getTaxonomy.handler(input, ctx);
    expect(getTaxonByIdMock).toHaveBeenCalledWith(9606, ctx);
    expect(result.taxon.taxonId).toBe(9606);
  });

  it('routes a by-id NotFound through ctx.fail("not_found") with a clean typed error', async () => {
    getTaxonByIdMock.mockRejectedValue(
      notFound('No taxonomy record for taxon ID 99999999.', { taxonId: 99999999 }),
    );
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 99999999 });

    const err = await expectMcpError(getTaxonomy.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });

    // The framework fills the declared recovery hint onto the envelope.
    const result = await runToolContract(getTaxonomy, { taxon_id: 99999999 });
    const envelope = (
      result.structuredContent as { error?: { data?: { recovery?: { hint?: string } } } }
    ).error;
    expect(envelope?.data?.recovery?.hint).toBe(
      'Check the spelling or the NCBI taxon ID and try again.',
    );
  });

  it('lets a non-404 lookup failure bubble with its own code, not as not_found', async () => {
    getTaxonByIdMock.mockRejectedValue(
      serviceUnavailable('uniprot.getTaxonById failed upstream (-32000).'),
    );
    const result = await runToolContract(getTaxonomy, { taxon_id: 9606 });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.message).toBe('uniprot.getTaxonById failed upstream (-32000).');
    expect(envelope.data?.reason).toBeUndefined();
  });

  it('lets a children-page outage bubble untyped, not as invalid_cursor, even with a cursor', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    getChildrenMock.mockRejectedValue(
      serviceUnavailable('uniprot.getChildren failed upstream (-32000).'),
    );
    const result = await runToolContract(getTaxonomy, {
      taxon_id: 9606,
      include_children: true,
      cursor: '9606.c2',
    });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.message).toBe('uniprot.getChildren failed upstream (-32000).');
    expect(envelope.data?.reason).toBeUndefined();
    expect(getChildrenMock).toHaveBeenCalledWith(9606, { cursor: 'c2' }, expect.anything());
  });

  it('format() renders each lineage ancestor with its common name when UniProt has one', () => {
    const blocks = getTaxonomy.format!({
      taxon: { taxonId: 9606, scientificName: 'Homo sapiens', rank: 'species' },
      lineage: [
        { taxonId: 2759, scientificName: 'Eukaryota', commonName: 'eukaryotes', rank: 'domain' },
        { taxonId: 9604, scientificName: 'Hominidae', commonName: 'great apes', rank: 'family' },
        { taxonId: 9605, scientificName: 'Homo', rank: 'genus' },
      ],
    });
    const lines = blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .split('\n');
    expect(lines).toContain(
      '**Lineage:** Eukaryota (eukaryotes) [2759, domain] > Hominidae (great apes) [9604, family] > Homo [9605, genus]',
    );
  });

  it('routes a by-name NotFound through ctx.fail("not_found")', async () => {
    getTaxonByNameMock.mockRejectedValue(
      notFound('No taxonomy record matched the name "Nonexistus organismus".'),
    );
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ name: 'Nonexistus organismus' });

    const err = await expectMcpError(getTaxonomy.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
    expect(getTaxonByNameMock).toHaveBeenCalledWith('Nonexistus organismus', ctx);
  });

  it('resolves by taxon_id and splits lineage out of the taxon record', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606 });

    const result = await getTaxonomy.handler(input, ctx);
    expect(getTaxonByIdMock).toHaveBeenCalledWith(9606, ctx);
    expect(result.taxon.taxonId).toBe(9606);
    expect(result.lineage).toHaveLength(2);
    // lineage is hoisted to the top level, not nested on taxon.
    expect((result.taxon as Record<string, unknown>).lineage).toBeUndefined();
    expect(result.children).toBeUndefined();
    expect(result).toEqual(expect.schemaMatching(getTaxonomy.output));
  });

  it('resolves by name when no taxon_id is given', async () => {
    getTaxonByNameMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ name: 'Homo sapiens' });

    await getTaxonomy.handler(input, ctx);
    expect(getTaxonByNameMock).toHaveBeenCalledWith('Homo sapiens', ctx);
    expect(getTaxonByIdMock).not.toHaveBeenCalled();
  });

  it('fetches children and enriches childCount when include_children is true', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    const children: TaxonChild[] = [
      { taxonId: 63221, scientificName: 'Homo sapiens neanderthalensis', rank: 'subspecies' },
    ];
    getChildrenMock.mockResolvedValue({ children, totalChildren: 1 });
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606, include_children: true });

    const result = await getTaxonomy.handler(input, ctx);
    expect(getChildrenMock).toHaveBeenCalledWith(9606, {}, ctx);
    expect(getTaxonomy.output.parse(result).children).toEqual(children);
    expect(getEnrichment(ctx)).toMatchObject({ childCount: 1, totalChildren: 1 });
  });

  it('treats an empty-string cursor as absent (form-client payload)', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    getChildrenMock.mockResolvedValue({ children: [], totalChildren: 0 });
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606, include_children: true, cursor: '' });

    await getTaxonomy.handler(input, ctx);
    expect(getChildrenMock).toHaveBeenCalledWith(9606, {}, ctx);
  });

  it('does not call getChildren when include_children is false', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606 });

    await getTaxonomy.handler(input, ctx);
    expect(getChildrenMock).not.toHaveBeenCalled();
  });

  it('format() renders the lineage, rank, and parent', () => {
    const blocks = getTaxonomy.format!({
      taxon: {
        taxonId: 9606,
        scientificName: 'Homo sapiens',
        commonName: 'Human',
        mnemonic: 'HUMAN',
        rank: 'species',
        parent: { taxonId: 9605, scientificName: 'Homo' },
        otherNames: ['Homo sapiens Linnaeus, 1758'],
      },
      lineage: human.lineage,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Homo sapiens');
    expect(text).toContain('species');
    expect(text).toContain('HUMAN');
    expect(text).toContain('Eukaryota');
    expect(text).toContain('9605'); // parent + lineage taxon id
  });

  it('format() renders children when present', () => {
    const blocks = getTaxonomy.format!({
      taxon: { taxonId: 9606, scientificName: 'Homo sapiens', rank: 'species' },
      lineage: [],
      children: [
        { taxonId: 63221, scientificName: 'Homo sapiens neanderthalensis', rank: 'subspecies' },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Children (1)');
    expect(text).toContain('neanderthalensis');
  });
});

describe('getTaxonomy include_children paging (real service, through runToolContract)', () => {
  /** A raw child taxon as taxonomy/search returns it; `rank` is absent on some rows. */
  const rawChild = (taxonId: number, name: string, rank?: string) => ({
    taxonId,
    scientificName: name,
    ...(rank ? { rank } : {}),
  });

  /** A raw taxonomy record for the by-id lookup. */
  const rawTaxon = (taxonId: number, name: string, rank: string) => ({
    taxonId,
    scientificName: name,
    rank,
    lineage: [{ taxonId: 131567, scientificName: 'cellular organisms', rank: 'no rank' }],
  });

  /** One taxonomy/search page as UniProt sends it: x-total-results plus a Link cursor when more remain. */
  const childrenPage = (parent: number, rows: object[], total: number, next?: string) => {
    const response = upstreamResponse(200, { results: rows });
    response.headers.set('x-total-results', String(total));
    if (next) {
      response.headers.set(
        'link',
        `<https://rest.uniprot.org/taxonomy/search?format=json&query=parent%3A${parent}&cursor=${next}&size=100>; rel="next"`,
      );
    }
    return response;
  };

  /** Stub UniProt with one taxon record and its children pages keyed by cursor ('' = first page). */
  function upstreamTaxon(
    record: object & { taxonId: number },
    pages: Record<string, () => Response>,
  ) {
    const fetchStub = routeUpstream((url) => {
      if (url.pathname === `/taxonomy/${record.taxonId}`) return upstreamResponse(200, record);
      if (url.pathname !== '/taxonomy/search') return;
      return pages[url.searchParams.get('cursor') ?? '']?.();
    });
    vi.stubGlobal('fetch', fetchStub);
    getTaxonByIdMock.mockImplementation(realService.getTaxonById.bind(realService));
    getChildrenMock.mockImplementation(realService.getChildren.bind(realService));
    return fetchStub;
  }

  const homoChildren = [
    rawChild(9606, 'Homo sapiens', 'species'),
    rawChild(63221, 'Homo sapiens neanderthalensis', 'subspecies'),
    rawChild(741158, "Homo sapiens subsp. 'Denisova'", 'subspecies'),
    rawChild(2813598, 'Homo sp.'),
  ];

  it("returns a small taxon's children with the true total and no cursor or truncation fields (characterization)", async () => {
    const fetchStub = upstreamTaxon(rawTaxon(9605, 'Homo', 'genus'), {
      '': () => childrenPage(9605, homoChildren, 4),
    });

    const result = await runToolContract(getTaxonomy, { taxon_id: 9605, include_children: true });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { children: TaxonChild[] } & Record<string, unknown>;
    expect(out.children).toEqual([
      { taxonId: 9606, scientificName: 'Homo sapiens', rank: 'species' },
      { taxonId: 63221, scientificName: 'Homo sapiens neanderthalensis', rank: 'subspecies' },
      { taxonId: 741158, scientificName: "Homo sapiens subsp. 'Denisova'", rank: 'subspecies' },
      { taxonId: 2813598, scientificName: 'Homo sp.', rank: 'no rank' },
    ]);
    expect(out).toMatchObject({ childCount: 4, totalChildren: 4 });
    for (const key of ['cursor', 'truncated', 'shown', 'cap', 'notice']) {
      expect(out).not.toHaveProperty(key);
    }
    const text = contentText(result);
    expect(text).toContain('## Children (4)');
    for (const c of out.children)
      expect(text).toContain(`- ${c.scientificName} [${c.taxonId}] (${c.rank})`);
    expect(text).toContain('**totalChildren:** 4');
    expect(text).not.toMatch(/cursor|truncated/i);
    const search = requestedUrls(fetchStub).find((u) => u.pathname === '/taxonomy/search');
    expect(search?.searchParams.get('query')).toBe('parent:9605');
    expect(search?.searchParams.get('size')).toBe('100');
  });

  /** Streptomyces (1883): 1181 children over 12 pages of 100; one row per page has no rank. */
  const streptomycesPage = (page: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const id = 1885 + page * 100 + i;
      return rawChild(id, `Streptomyces sp. ${id}`, i === 7 ? undefined : 'species');
    });

  it("walks a large taxon's children page by page with the cursor, disclosing the total each time", async () => {
    // The emitted cursor names its taxon ("1883.c2"); UniProt receives only its own part.
    const fetchStub = upstreamTaxon(rawTaxon(1883, 'Streptomyces', 'genus'), {
      '': () => childrenPage(1883, streptomycesPage(0, 100), 1181, 'c2'),
      c2: () => childrenPage(1883, streptomycesPage(1, 100), 1181, 'c3'),
      c12: () => childrenPage(1883, streptomycesPage(11, 81), 1181),
    });

    // First page: capped, with the cursor to the second.
    const first = await runToolContract(getTaxonomy, { taxon_id: 1883, include_children: true });
    expect(first.isError).toBeFalsy();
    const firstOut = first.structuredContent as { children: TaxonChild[] } & Record<
      string,
      unknown
    >;
    expect(firstOut.children).toHaveLength(100);
    expect(firstOut).toMatchObject({
      childCount: 100,
      totalChildren: 1181,
      cursor: '1883.c2',
      truncated: true,
      shown: 100,
      cap: 100,
    });
    expect(firstOut.notice).toBe(
      'This page lists 100 of 1181 immediate children. Pass cursor to fetch the next page.',
    );
    const firstText = contentText(first);
    expect(firstText).toContain('## Children (100)');
    // Every child on the page reaches content[], not a 50-row slice of it.
    for (const c of firstOut.children)
      expect(firstText).toContain(`- ${c.scientificName} [${c.taxonId}] (${c.rank})`);
    expect(firstText).toContain('- Streptomyces sp. 1892 [1892] (no rank)');
    expect(firstText).toContain('1883.c2');
    expect(firstText).toContain('This page lists 100 of 1181 immediate children.');

    // Second page: the cursor reaches UniProt and the next one comes back.
    const second = await runToolContract(getTaxonomy, {
      taxon_id: 1883,
      include_children: true,
      cursor: '1883.c2',
    });
    const secondOut = second.structuredContent as { children: TaxonChild[] } & Record<
      string,
      unknown
    >;
    expect(secondOut.children[0]).toEqual({
      taxonId: 1985,
      scientificName: 'Streptomyces sp. 1985',
      rank: 'species',
    });
    expect(secondOut).toMatchObject({
      childCount: 100,
      totalChildren: 1181,
      cursor: '1883.c3',
      truncated: true,
    });
    expect(contentText(second)).toContain('- Streptomyces sp. 2084 [2084] (species)');

    // Last page: 81 children, the total still reported, no cursor and no truncation.
    const last = await runToolContract(getTaxonomy, {
      taxon_id: 1883,
      include_children: true,
      cursor: '1883.c12',
    });
    const lastOut = last.structuredContent as { children: TaxonChild[] } & Record<string, unknown>;
    expect(lastOut.children).toHaveLength(81);
    expect(lastOut).toMatchObject({ childCount: 81, totalChildren: 1181 });
    for (const key of ['cursor', 'truncated', 'shown', 'cap', 'notice']) {
      expect(lastOut).not.toHaveProperty(key);
    }
    expect(contentText(last)).toContain('## Children (81)');
    expect(contentText(last)).toContain('- Streptomyces sp. 3065 [3065] (species)');

    const searches = requestedUrls(fetchStub).filter((u) => u.pathname === '/taxonomy/search');
    expect(searches.map((u) => u.searchParams.get('cursor'))).toEqual([null, 'c2', 'c12']);
    for (const u of searches) {
      expect(u.searchParams.get('query')).toBe('parent:1883');
      expect(u.searchParams.get('size')).toBe('100');
    }
  });

  it("reports a leaf taxon's empty child list with a zero total", async () => {
    upstreamTaxon(rawTaxon(63221, 'Homo sapiens neanderthalensis', 'subspecies'), {
      '': () => childrenPage(63221, [], 0),
    });

    const result = await runToolContract(getTaxonomy, { taxon_id: 63221, include_children: true });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({ children: [], childCount: 0, totalChildren: 0 });
    expect(out).not.toHaveProperty('cursor');
    expect(contentText(result)).toContain('## Children (0)');
    expect(contentText(result)).toContain('No immediate child taxa.');
  });

  it.each([
    // Issued for Streptomyces (1883), sent with Bacillus (1386): UniProt would answer it with
    // a page from the middle of 1386's list and no next link, so it never reaches UniProt.
    [{ taxon_id: 1386 }, '1883.c2', 'The cursor was not issued for the children of taxon 1386.'],
    // A bare upstream cursor, with no taxon in front.
    [{ taxon_id: 1386 }, 'c2', 'The cursor was not issued for the children of taxon 1386.'],
    // A taxon with nothing after it.
    [{ taxon_id: 1386 }, '1386.', 'The cursor was not issued for the children of taxon 1386.'],
    // Resolved by name, the cursor is checked against the taxon the name resolved to.
    [{ name: 'Bacillus' }, '1883.c2', 'The cursor was not issued for the children of taxon 1386.'],
  ])(
    'rejects %j with cursor %j as invalid_cursor before any children request',
    async (identifier, cursor, message) => {
      // Any children page UniProt is asked for answers, so a request that went out would show.
      const page = () => childrenPage(1386, streptomycesPage(1, 100), 1181, 'c3');
      const fetchStub = upstreamTaxon(rawTaxon(1386, 'Bacillus', 'genus'), {
        '': page,
        c2: page,
        '1883.c2': page,
        '1386.': page,
      });
      getTaxonByNameMock.mockResolvedValue({
        taxonId: 1386,
        scientificName: 'Bacillus',
        rank: 'genus',
        lineage: [],
      } satisfies Taxon);
      const result = await runToolContract(getTaxonomy, {
        ...identifier,
        include_children: true,
        cursor,
      });
      const envelope = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.message).toBe(message);
      expect(envelope.data).toMatchObject({ reason: 'invalid_cursor' });
      const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
      expect(hint).toContain('no cursor');
      const text = contentText(result);
      expect(text).toContain(message);
      expect(text).toContain('(reason invalid_cursor');
      expect(requestedUrls(fetchStub).map((u) => u.pathname)).not.toContain('/taxonomy/search');
      expect(getChildrenMock).not.toHaveBeenCalled();
    },
  );

  it('sends everything after the first "." to UniProt, so an upstream cursor may hold a dot', async () => {
    const fetchStub = upstreamTaxon(rawTaxon(1883, 'Streptomyces', 'genus'), {
      'a.b': () => childrenPage(1883, streptomycesPage(11, 81), 1181),
      '1883.a.b': () => childrenPage(1883, [], 1181),
    });
    const result = await runToolContract(getTaxonomy, {
      taxon_id: 1883,
      include_children: true,
      cursor: '1883.a.b',
    });
    expect(result.isError).toBeFalsy();
    const searches = requestedUrls(fetchStub).filter((u) => u.pathname === '/taxonomy/search');
    expect(searches.map((u) => u.searchParams.get('cursor'))).toEqual(['a.b']);
  });

  it('a cursor UniProt cannot continue from (its 500) fails invalid_cursor, not a generic upstream error', async () => {
    // Real service, retry included, so the backoff runs on fake timers.
    upstreamTaxon(rawTaxon(1883, 'Streptomyces', 'genus'), {
      garbage: () =>
        upstreamResponse(500, { messages: ['Internal server error'] }, 'Internal Server Error'),
    });
    vi.useFakeTimers();
    try {
      const pending = runToolContract(getTaxonomy, {
        taxon_id: 1883,
        include_children: true,
        cursor: '1883.garbage',
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.message).toContain('UniProt could not continue from the cursor');
      expect(envelope.data).toMatchObject({ reason: 'invalid_cursor' });
      expect(contentText(result)).toContain('(reason invalid_cursor');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a cursor when include_children is false — no children lookup is made', async () => {
    const fetchStub = upstreamTaxon(rawTaxon(1883, 'Streptomyces', 'genus'), {});
    const result = await runToolContract(getTaxonomy, { taxon_id: 1883, cursor: 'c2' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('children');
    expect(requestedUrls(fetchStub).map((u) => u.pathname)).toEqual(['/taxonomy/1883']);
  });
});
