/**
 * @fileoverview Tests for the uniprot_get_taxonomy tool — handler behavior with
 *   a stubbed UniProtService: the missing_identifier and not_found ctx.fail
 *   contracts (the not_found regression — a service NotFound from either the
 *   by-id or by-name path must surface as data.reason === 'not_found', not a
 *   leaked raw throw), by-id vs by-name dispatch, the include_children branch,
 *   and format() rendering.
 * @module tests/tools/uniprot-get-taxonomy.tool.test
 */

import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Taxon, TaxonChild } from '@/services/uniprot/types.js';

const getTaxonByIdMock = vi.fn();
const getTaxonByNameMock = vi.fn();
const getChildrenMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getTaxonomy', () => {
  it('throws missing_identifier when neither taxon_id nor name is provided', async () => {
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({});
    await expect(getTaxonomy.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
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

  it('routes a by-id NotFound through ctx.fail("not_found") with a clean typed error', async () => {
    getTaxonByIdMock.mockRejectedValue(
      notFound('No taxonomy record for taxon ID 99999999.', { taxonId: 99999999 }),
    );
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 99999999 });

    const err = await getTaxonomy.handler(input, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
    expect((err.data as { recovery?: unknown }).recovery).toBeDefined();
  });

  it('routes a by-name NotFound through ctx.fail("not_found")', async () => {
    getTaxonByNameMock.mockRejectedValue(
      notFound('No taxonomy record matched the name "Nonexistus organismus".'),
    );
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ name: 'Nonexistus organismus' });

    const err = await getTaxonomy.handler(input, ctx).catch((e) => e as McpError);
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
    getChildrenMock.mockResolvedValue(children);
    const ctx = createMockContext({ errors: getTaxonomy.errors });
    const input = getTaxonomy.input.parse({ taxon_id: 9606, include_children: true });

    const result = await getTaxonomy.handler(input, ctx);
    expect(getChildrenMock).toHaveBeenCalledWith(9606, ctx);
    expect(result.children).toEqual(children);
    expect(getEnrichment(ctx)).toMatchObject({ childCount: 1 });
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
