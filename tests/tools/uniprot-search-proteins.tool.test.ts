/**
 * @fileoverview Tests for the uniprot_search_proteins tool. Two layers:
 *   query-mode validation (the text_search/query split contracts) and format()
 *   rendering (including a sparse hit with only required fields); plus handler
 *   behavior with a stubbed UniProtService — effective-query assembly (reviewed
 *   default, organism_id ANDing, honoring a caller-pinned reviewed: clause),
 *   cursor/total enrichment, and the empty-result notice.
 * @module tests/tools/uniprot-search-proteins.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchPage } from '@/services/uniprot/types.js';

const searchMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ search: searchMock }),
}));

const { searchProteins } = await import(
  '@/mcp-server/tools/definitions/uniprot-search-proteins.tool.js'
);

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
  totalResults: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchProteins validation', () => {
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

  it('appends reviewed:false when reviewed is disabled', async () => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'kinase', reviewed: false });

    await searchProteins.handler(input, ctx);
    expect(searchMock.mock.calls[0]![0]).toContain('reviewed:false');
  });

  it('does not append a reviewed clause when the query already pins one', async () => {
    searchMock.mockResolvedValue(onePage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ query: 'gene:TP53 AND reviewed:false' });

    await searchProteins.handler(input, ctx);
    const sentQuery = searchMock.mock.calls[0]![0] as string;
    // Caller's reviewed:false stays; the default reviewed:true is not also appended.
    expect(sentQuery).toContain('reviewed:false');
    expect(sentQuery).not.toContain('reviewed:true');
  });

  it('surfaces the forward cursor through enrichment', async () => {
    searchMock.mockResolvedValue({ ...onePage, cursor: 'NEXT' });
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'kinase' });

    await searchProteins.handler(input, ctx);
    expect(getEnrichment(ctx)).toMatchObject({ cursor: 'NEXT' });
  });

  it('emits a broaden-the-search notice on zero results', async () => {
    searchMock.mockResolvedValue({ results: [], totalResults: 0 } satisfies SearchPage);
    const ctx = createMockContext({ errors: searchProteins.errors });
    const input = searchProteins.input.parse({ text_search: 'zzzznotarealquery' });

    const result = await searchProteins.handler(input, ctx);
    expect(result.results).toHaveLength(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No proteins matched');
    expect(notice).toContain('TrEMBL');
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
});
