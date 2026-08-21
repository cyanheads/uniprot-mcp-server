/**
 * @fileoverview Tests for the uniprot_get_proteome tool — handler behavior with
 *   a stubbed UniProtService: the missing_identifier and not_found ctx.fail
 *   contracts (the not_found regression — the service's NotFound must reach the
 *   wire as data.reason === 'not_found', not a leaked raw HTTP throw), UPID vs
 *   taxon-id dispatch, the include_proteins pagination/truncation path, and
 *   format() rendering.
 * @module tests/tools/uniprot-get-proteome.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proteome, ProteomeProteinPage } from '@/services/uniprot/types.js';
import { expectMcpError, required } from '../helpers.js';

const getProteomeMock = vi.fn();
const getProteomeProteinsMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({
    getProteome: getProteomeMock,
    getProteomeProteins: getProteomeProteinsMock,
  }),
}));

const { getProteome } = await import('@/mcp-server/tools/definitions/uniprot-get-proteome.tool.js');

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
});

describe('getProteome', () => {
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
    // Recovery guidance reaches the wire so the agent knows its next move.
    expect((err.data as { recovery?: unknown }).recovery).toBeDefined();
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
      cursor: 'NEXT_CURSOR',
      totalProteinsMatched: 147506,
    });
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
    expect(text).not.toContain('undefined');
  });
});
