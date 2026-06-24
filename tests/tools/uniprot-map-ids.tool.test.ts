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
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdMappingResult } from '@/services/uniprot/types.js';

const mapIdsMock = vi.fn();
const resumeMappingMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ mapIds: mapIdsMock, resumeMapping: resumeMappingMock }),
}));

const { mapIds } = await import('@/mcp-server/tools/definitions/uniprot-map-ids.tool.js');

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe('mapIds start path', () => {
  it('returns finished mappings and enriches unmapped ids', async () => {
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
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
    mapIdsMock.mockResolvedValue({ status: 'finished', results: [] } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({
      from_db: 'Gene_Name',
      to_db: 'UniProtKB-Swiss-Prot',
      ids: ['NOSUCHGENE'],
    });

    const result = await mapIds.handler(input, ctx);
    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('No Gene_Name IDs mapped');
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

    const err = await mapIds.handler(input, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
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

    const err = await mapIds.handler(input, ctx).catch((e) => e as Error);
    expect(err.message).toContain('socket hang up');
    expect((err as McpError).data?.reason).toBeUndefined();
  });
});

describe('mapIds resume path', () => {
  it('fetches results for a ticket alone and enriches mappedCount', async () => {
    resumeMappingMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
    } satisfies IdMappingResult);
    const ctx = createMockContext({ errors: mapIds.errors });
    const input = mapIds.input.parse({ ticket: 'job-123' });

    const result = await mapIds.handler(input, ctx);
    expect(resumeMappingMock).toHaveBeenCalledWith('job-123', ctx);
    expect(mapIdsMock).not.toHaveBeenCalled();
    expect(result.status).toBe('finished');
    expect(getEnrichment(ctx)).toMatchObject({ mappedCount: 1 });
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

    const err = await mapIds.handler(input, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'invalid_ticket' });
    expect(err.message).not.toMatch(/Status: 404|rest\.uniprot\.org/);
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
