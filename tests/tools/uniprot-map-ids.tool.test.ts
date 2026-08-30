/**
 * @fileoverview Tests for the uniprot_map_ids tool. Two layers: missing-inputs
 *   validation and format() rendering of the finished/running result shapes;
 *   plus handler behavior with a stubbed UniProtService — the resume-ticket path
 *   (running + finished), the start path with unmapped-id enrichment, the
 *   budget-overflow "running" result variant (a poll-again signal, not an error),
 *   the unsupported_db_pair ctx.fail contract, and the empty-mappings notice.
 * @module tests/tools/uniprot-map-ids.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdMappingResult } from '@/services/uniprot/types.js';
import { expectMcpError, expectRejection, required } from '../helpers.js';

const mapIdsMock = vi.fn();
const resumeMappingMock = vi.fn();
const resumeMappingPageMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({
    mapIds: mapIdsMock,
    resumeMapping: resumeMappingMock,
    resumeMappingPage: resumeMappingPageMock,
  }),
}));

const { mapIds } = await import('@/mcp-server/tools/definitions/uniprot-map-ids.tool.js');

beforeEach(() => {
  mapIdsMock.mockReset();
  resumeMappingMock.mockReset();
  resumeMappingPageMock.mockReset();
});

describe('mapIds validation', () => {
  it('throws missing_inputs when neither a ticket nor from/to/ids is provided', async () => {
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({});
    await expect(mapIds.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_inputs' },
    });
    expect(mapIdsMock).not.toHaveBeenCalled();
  });

  it('throws missing_inputs when from_db/to_db are given but ids is empty', async () => {
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB-Swiss-Prot',
      ids: [],
    });
    await expect(mapIds.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_inputs' },
    });
  });

  it('rejects an out-of-enum from_db at the schema edge', () => {
    expect(() =>
      mapIds.input.parse({ from_db: 'NotADatabase', to_db: 'UniProtKB', ids: ['TP53'] }),
    ).toThrow();
  });

  it('rejects an empty completed-page continuation at the schema edge', () => {
    expect(() => mapIds.input.parse({ continuation: { jobId: 'job-123', cursor: '' } })).toThrow();
  });

  it('advertises continuation as an alternative to submission fields', () => {
    for (const field of ['from_db', 'to_db', 'ids'] as const) {
      expect(mapIds.input.shape[field].description).toContain('continuation');
    }
  });

  it('throws conflicting_inputs when running-job and completed-page resume inputs are mixed', async () => {
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      ticket: 'job-123',
      continuation: { jobId: 'job-123', cursor: 'cursor-2' },
    });

    await expect(mapIds.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'conflicting_inputs' },
    });
    expect(resumeMappingMock).not.toHaveBeenCalled();
    expect(resumeMappingPageMock).not.toHaveBeenCalled();
  });
});

describe('mapIds start path', () => {
  it('returns finished mappings and enriches unmapped ids', async () => {
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
      failedIds: ['NOSUCHGENE'],
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB-Swiss-Prot',
      ids: ['TP53', 'NOSUCHGENE'],
      tax_id: 9606,
    });

    const result = await mapIds.handler(input, ctx);
    expect(mapIdsMock).toHaveBeenCalledWith(
      'Gene_Name',
      'UniProtKB-Swiss-Prot',
      ['TP53', 'NOSUCHGENE'],
      9606,
      ctx,
    );
    expect(result.status).toBe('finished');
    expect(result.results).toEqual([{ from: 'TP53', to: 'P04637' }]);
    // The unmapped input id is surfaced, not silently dropped.
    expect(getEnrichment(ctx)).toMatchObject({ mappedCount: 1, unmappedIds: ['NOSUCHGENE'] });
    expect(result).toEqual(expect.schemaMatching(mapIds.output));
  });

  it('declares unmapped ids/mapped count so they reach content[], not only the store', async () => {
    // Parity guard: the follow-up metadata must be declared in the enrichment block
    // (unmappedIds also carries an enrichmentTrailer renderer), or the effective-output
    // parse strips it from both structuredContent and the content[] trailer — leaving
    // text-only clients unaware which inputs failed to map.
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
      failedIds: ['NOSUCHGENEUNIPROT'],
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB-Swiss-Prot',
      ids: ['TP53', 'NOSUCHGENEUNIPROT'],
    });

    const result = await mapIds.handler(input, ctx);
    const effective = mapIds.output
      .extend(required(mapIds.enrichment, 'mapIds.enrichment'))
      .parse({ ...result, ...getEnrichment(ctx) });
    expect(effective.mappedCount).toBe(1);
    expect(effective.unmappedIds).toEqual(['NOSUCHGENEUNIPROT']);
  });

  it('uses upstream failedIds instead of subtracting normalized successful identifiers', async () => {
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
      failedIds: ['ZZZNOTAREALGENE'],
    } satisfies IdMappingResult);
    const input = {
      from_db: 'Gene_Name' as const,
      to_db: 'UniProtKB-Swiss-Prot' as const,
      ids: ['tp53', 'Tp53', 'TP53', 'ZZZNOTAREALGENE'],
      tax_id: 9606,
    };

    const contract = await runToolContract(mapIds, input);
    expect(contract).toMatchObject({
      structuredContent: {
        status: 'finished',
        results: [{ from: 'TP53', to: 'P04637' }],
        mappedCount: 1,
        unmappedIds: ['ZZZNOTAREALGENE'],
      },
    });
    const text = contract.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('**Unmapped IDs:** ZZZNOTAREALGENE');
    expect(text).not.toMatch(/Unmapped IDs:.*(?:tp53|Tp53)/);
  });

  it('returns a completed-page continuation at the 500-row page cap', async () => {
    const results = Array.from({ length: 500 }, (_, index) => ({
      from: `GENE${index}`,
      to: `P${String(index).padStart(5, '0')}`,
    }));
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results,
      failedIds: [],
      continuation: { jobId: 'job-pages', cursor: 'cursor-2' },
    } satisfies IdMappingResult);

    const contract = await runToolContract(mapIds, {
      from_db: 'Gene_Name',
      to_db: 'UniProtKB-Swiss-Prot',
      ids: ['GENE0'],
    });
    expect(contract).toMatchObject({
      structuredContent: {
        status: 'finished',
        continuation: { jobId: 'job-pages', cursor: 'cursor-2' },
        mappedCount: 500,
      },
    });
    const text = contract.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('cursor-2');
    expect(text).toContain('job-pages');
  });

  it('returns a running ticket when the inline budget is exceeded (poll-again, not an error)', async () => {
    mapIdsMock.mockResolvedValue({
      status: 'running',
      ticket: 'job-123',
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB',
      ids: ['TP53'],
    });

    const result = await mapIds.handler(input, ctx);
    expect(result.status).toBe('running');
    expect(result.ticket).toBe('job-123');
    expect(getEnrichment(ctx).notice).toContain('job-123');
  });

  it('emits a no-mappings notice when the job finishes empty', async () => {
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results: [],
      failedIds: ['NOSUCHGENE'],
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB-Swiss-Prot',
      ids: ['NOSUCHGENE'],
    });

    const result = await mapIds.handler(input, ctx);
    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('no mappings');
    expect(getEnrichment(ctx).unmappedIds).toEqual(['NOSUCHGENE']);
  });

  it('maps an unsupported db pair (400 from the service) to the unsupported_db_pair contract', async () => {
    // fetchWithTimeout maps a 400 to McpError(InvalidParams) with a "Fetch failed … Status: 400"
    // message — the handler must detect it by code, not by string-matching the message.
    mapIdsMock.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Fetch failed for https://rest.uniprot.org/idmapping/run. Status: 400',
        { statusCode: 400 },
      ),
    );
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'PomBase',
      to_db: 'WormBase_Protein',
      ids: ['SPBC1234.05'],
    });

    const err = await expectMcpError(mapIds.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'unsupported_db_pair' });
    expect(err.message).not.toMatch(/Status: 400|rest\.uniprot\.org/);
  });

  it('lets an unrelated service error bubble (not coerced to unsupported_db_pair)', async () => {
    mapIdsMock.mockRejectedValue(new Error('socket hang up'));
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB',
      ids: ['TP53'],
    });

    const err = await expectRejection(mapIds.handler(input, ctx));
    expect(err.message).toContain('socket hang up');
    expect((err as McpError).data?.reason).toBeUndefined();
  });
});

describe('mapIds resume path', () => {
  it('fetches results for a ticket alone and enriches mappedCount', async () => {
    resumeMappingMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
      failedIds: ['ZZZNOTAREALGENE'],
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({ ticket: 'job-123' });

    const result = await mapIds.handler(input, ctx);
    expect(resumeMappingMock).toHaveBeenCalledWith('job-123', ctx);
    expect(mapIdsMock).not.toHaveBeenCalled();
    expect(result.status).toBe('finished');
    expect(getEnrichment(ctx)).toMatchObject({
      mappedCount: 1,
      unmappedIds: ['ZZZNOTAREALGENE'],
    });
  });

  it('returns running again when the resumed job is still in progress', async () => {
    resumeMappingMock.mockResolvedValue({
      status: 'running',
      ticket: 'job-123',
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({ ticket: 'job-123' });

    const result = await mapIds.handler(input, ctx);
    expect(result.status).toBe('running');
    expect(result.ticket).toBe('job-123');
    expect(getEnrichment(ctx).notice).toContain('still running');
  });

  it('maps an unknown/expired ticket (404 from the status endpoint) to the invalid_ticket contract', async () => {
    // The status endpoint 404s for a stale ticket; fetchWithTimeout surfaces it as
    // McpError(NotFound) with a leaky raw-URL message the handler must replace.
    resumeMappingMock.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'Fetch failed for https://rest.uniprot.org/idmapping/status/stale-job. Status: 404',
        { statusCode: 404 },
      ),
    );
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({ ticket: 'stale-job' });

    const err = await expectMcpError(mapIds.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'invalid_ticket' });
    expect(err.message).not.toMatch(/Status: 404|rest\.uniprot\.org/);
  });
});

describe('mapIds completed-page continuation', () => {
  it('propagates failed IDs and another continuation without resuming the running-job path', async () => {
    resumeMappingPageMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'BRCA1', to: 'P38398' }],
      failedIds: ['ZZZNOTAREALGENE'],
      continuation: { jobId: 'job-pages', cursor: 'cursor-3' },
    } satisfies IdMappingResult);
    const continuation = { jobId: 'job-pages', cursor: 'cursor-2' };

    const contract = await runToolContract(mapIds, { continuation });
    expect(resumeMappingPageMock).toHaveBeenCalledWith(continuation, expect.anything());
    expect(resumeMappingMock).not.toHaveBeenCalled();
    expect(mapIdsMock).not.toHaveBeenCalled();
    expect(contract).toMatchObject({
      structuredContent: {
        status: 'finished',
        results: [{ from: 'BRCA1', to: 'P38398' }],
        continuation: { jobId: 'job-pages', cursor: 'cursor-3' },
        mappedCount: 1,
        unmappedIds: ['ZZZNOTAREALGENE'],
      },
    });
    const textBlocks = contract.content.map((block) => (block.type === 'text' ? block.text : ''));
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0]).toContain('P38398');
    expect(textBlocks[0]).toContain('cursor-3');
    expect(textBlocks[1]).toContain('**Unmapped IDs:** ZZZNOTAREALGENE');
  });

  it('returns an empty terminal page without another continuation', async () => {
    resumeMappingPageMock.mockResolvedValue({
      status: 'finished',
      results: [],
      failedIds: [],
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });

    const result = await mapIds.handler(
      mapIds.input.parse({ continuation: { jobId: 'job-pages', cursor: 'past-end' } }),
      ctx,
    );
    expect(result).toEqual({ status: 'finished', results: [] });
    expect(getEnrichment(ctx).notice).toContain('no mappings');
  });

  it('maps an unknown or expired completed-page continuation to invalid_continuation', async () => {
    resumeMappingPageMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Mapping page not found.'),
    );
    const ctx = createMockContext({ errors: mapIds.errors });

    const err = await expectMcpError(
      mapIds.handler(
        mapIds.input.parse({ continuation: { jobId: 'expired-job', cursor: 'expired' } }),
        ctx,
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'invalid_continuation' });
    expect(err.data?.recovery).toBeDefined();
  });
});

describe('mapIds format', () => {
  it('format() renders the finished result as a from→to table', () => {
    const blocks = mapIds.format!({
      status: 'finished',
      results: [
        { from: 'TP53', to: 'P04637' },
        { from: 'BRCA1', to: 'P38398' },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('finished');
    expect(text).toContain('TP53');
    expect(text).toContain('P04637');
    expect(text).toContain('P38398');
  });

  it('format() renders a completed-page continuation separately from a running ticket', () => {
    const blocks = mapIds.format!({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
      continuation: { jobId: 'job-pages', cursor: 'cursor-2' },
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Next page');
    expect(text).toContain('job-pages');
    expect(text).toContain('cursor-2');
    expect(text).not.toContain('**Ticket:**');
  });

  it('format() renders the running result with its ticket', () => {
    const blocks = mapIds.format!({ status: 'running', ticket: 'abc123' });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('running');
    expect(text).toContain('abc123');
  });

  it('format() renders a no-mappings line when finished with empty results', () => {
    const blocks = mapIds.format!({ status: 'finished', results: [] });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('No mappings resolved.');
  });
});
