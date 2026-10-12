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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdMappingResult } from '@/services/uniprot/types.js';
import {
  contentText,
  errorEnvelope,
  expectMcpError,
  expectRejection,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  rejectUnmockedFetch,
  requestedUrls,
  required,
  routeUpstream,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

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

/** The real service, for tests that drive an upstream response through its sanitizer. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

beforeEach(() => {
  mapIdsMock.mockReset();
  resumeMappingMock.mockReset();
  resumeMappingPageMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('rejects UniProtKB_AC-ID as a target at input validation, with no service call', async () => {
    // UniProt answers 400 to to=UniProtKB_AC-ID for every source; it is a source only.
    const result = await runToolContract(mapIds, {
      from_db: 'Gene_Name',
      to_db: 'UniProtKB_AC-ID',
      ids: ['TP53'],
      tax_id: 9606,
    } as never);
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(mapIdsMock).not.toHaveBeenCalled();
  });

  it('still accepts UniProtKB_AC-ID as a source and no surface offers it as a target', async () => {
    mapIdsMock.mockResolvedValue({
      status: 'finished',
      results: [{ from: 'P04637', to: 'P04637' }],
      failedIds: [],
    } satisfies IdMappingResult);
    const result = await runToolContract(mapIds, {
      from_db: 'UniProtKB_AC-ID',
      to_db: 'UniProtKB',
      ids: ['P04637'],
    });
    expect(result.isError).toBeFalsy();
    expect(mapIdsMock).toHaveBeenCalledWith(
      'UniProtKB_AC-ID',
      'UniProtKB',
      ['P04637'],
      undefined,
      expect.anything(),
    );
    // The descriptions name UniProtKB, not UniProtKB_AC-ID, as the TrEMBL-inclusive target.
    expect(mapIds.description).not.toMatch(/UniProtKB_AC-ID to include|\/ UniProtKB_AC-ID/);
    expect(mapIds.input.shape.to_db.description).not.toContain('UniProtKB_AC-ID');
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

  it("keeps unsupported_db_pair for UniProt's real 400 now that the service relays 400 messages", async () => {
    // Real service (sanitizer included) over a stubbed fetch: the run POST answers the
    // 400 UniProt sends for PDB → Gene_Name. The service's relayed InvalidParams must
    // still land on this tool's own reason and message.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(upstreamResponse(400, UNIPROT_400_BODIES.unsupportedDbPair, 'Bad Request')),
      ),
    );
    mapIdsMock.mockImplementation(realService.mapIds.bind(realService));

    const result = await runToolContract(mapIds, {
      from_db: 'PDB',
      to_db: 'Gene_Name',
      ids: ['1TUP'],
    });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(envelope.data).toMatchObject({ reason: 'unsupported_db_pair' });
    expect(envelope.message).toBe('Mapping PDB → Gene_Name is not supported.');
    expect(contentText(result)).toContain('(reason unsupported_db_pair');
    expect(JSON.stringify(result)).not.toMatch(/rest\.uniprot\.org|Bad Request|"url"/);
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

describe('mapIds inactive targets (real service, through runToolContract)', () => {
  /**
   * A finished UniProtKB-target job, shaped as rest.uniprot.org answers it (probed
   * 2026-10-12): `/idmapping/results/{job}` carries plain `to` strings plus a
   * job-wide `obsoleteCount` when any target is inactive; only
   * `/idmapping/uniprotkb/results/{job}` carries the entry objects with the stub.
   * `rows` are the uniprotkb-endpoint rows; the generic page is derived from them.
   */
  function jobReturns(
    rows: { from: string; to: { primaryAccession: string; entryType: string } }[],
  ) {
    const obsoleteCount = rows.filter((r) => r.to.entryType === 'Inactive').length;
    const counted = obsoleteCount ? { obsoleteCount } : {};
    const fetchStub = routeUpstream((url) => {
      if (url.pathname === '/idmapping/run')
        return upstreamResponse(200, { jobId: 'job-inactive' });
      if (url.pathname === '/idmapping/status/job-inactive') {
        return upstreamResponse(200, { jobStatus: 'FINISHED' });
      }
      if (url.pathname === '/idmapping/results/job-inactive') {
        const results = rows.map((r) => ({ from: r.from, to: r.to.primaryAccession }));
        return upstreamResponse(200, { results, failedIds: [], ...counted });
      }
      if (url.pathname === '/idmapping/uniprotkb/results/job-inactive') {
        return upstreamResponse(200, { results: rows, ...counted });
      }
      return;
    });
    vi.stubGlobal('fetch', fetchStub);
    mapIdsMock.mockImplementation(realService.mapIds.bind(realService));
    return fetchStub;
  }

  const activeTarget = (accession: string) => ({
    primaryAccession: accession,
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
  });

  it('keeps active targets as bare from/to rows at no extra request (characterization)', async () => {
    const fetchStub = jobReturns([
      { from: 'Q13140', to: activeTarget('P02768') },
      { from: 'P04637', to: activeTarget('P04637') },
    ]);
    const result = await runToolContract(mapIds, {
      from_db: 'UniProtKB_AC-ID',
      to_db: 'UniProtKB',
      ids: ['Q13140', 'P04637'],
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { results: object[] };
    expect(out.results).toEqual([
      { from: 'Q13140', to: 'P02768' },
      { from: 'P04637', to: 'P04637' },
    ]);
    expect(contentText(result)).not.toContain('nactive');
    // run, status, results — nothing more for a job with no inactive target.
    expect(requestedUrls(fetchStub).map((u) => u.pathname)).toEqual([
      '/idmapping/run',
      '/idmapping/status/job-inactive',
      '/idmapping/results/job-inactive',
    ]);
  });

  it('keeps the rows and discloses the gap when the inactive-target lookup fails', async () => {
    const fetchStub = jobReturns([{ from: 'Q9ZZZ9', to: INACTIVE_STUBS.deletedMappingTarget }]);
    const route = fetchStub.getMockImplementation();
    fetchStub.mockImplementation((input: unknown) =>
      String(input).includes('/idmapping/uniprotkb/results/')
        ? Promise.resolve(upstreamResponse(404, { messages: ['gone'] }, 'Not Found'))
        : (route?.(input) ?? Promise.reject(new Error('unrouted'))),
    );
    const result = await runToolContract(mapIds, {
      from_db: 'UniProtKB_AC-ID',
      to_db: 'UniProtKB',
      ids: ['Q9ZZZ9'],
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { results: object[]; notice?: string };
    expect(out.results).toEqual([{ from: 'Q9ZZZ9', to: 'Q9ZZZ9' }]);
    expect(out.notice).toBe(
      'UniProt reports 1 inactive (merged, demerged, or deleted) target accession(s) in this job, but they could not be identified on this page. Retry the call to mark them, or check a target with uniprot_get_entry.',
    );
    expect(contentText(result)).toContain('could not be identified');
  });

  it.each([
    [
      'merged',
      INACTIVE_STUBS.merged,
      { reason: 'MERGED', replacedBy: ['P02768'], uniParcId: 'UPI000016A1A8' },
      INACTIVE_MESSAGES.merged,
    ],
    [
      'demerged',
      INACTIVE_STUBS.demerged,
      {
        reason: 'DEMERGED',
        replacedBy: ['P0DP25', 'P0DP23', 'P0DP24'],
        uniParcId: 'UPI0000020B41',
      },
      INACTIVE_MESSAGES.demerged,
    ],
    [
      'deleted',
      INACTIVE_STUBS.deletedMappingTarget,
      {
        reason: 'DELETED',
        deletedReason: 'Not part of a reference proteome',
        uniParcId: 'UPI000008B5B6',
      },
      INACTIVE_MESSAGES.deleted,
    ],
  ])(
    'marks a row whose target is a %s accession with its pointer',
    async (_type, stub, marker, message) => {
      const fetchStub = jobReturns([
        { from: 'GENE1', to: stub },
        { from: 'P04637', to: activeTarget('P04637') },
      ]);
      const result = await runToolContract(mapIds, {
        from_db: 'Gene_Name',
        to_db: 'UniProtKB',
        ids: ['GENE1', 'P04637'],
        tax_id: 9606,
      });

      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as { results: object[]; mappedCount: number };
      expect(out.results).toEqual([
        { from: 'GENE1', to: stub.primaryAccession, inactive: marker },
        { from: 'P04637', to: 'P04637' },
      ]);
      // The row stays a mapping — it is not dropped from the count.
      expect(out.mappedCount).toBe(2);
      expect(contentText(result)).toContain(message);
      // Format parity: the marker's uniParcId reaches content[] too.
      expect(contentText(result)).toContain(marker.uniParcId);
      // One extra read of the same page from the endpoint that carries the stub.
      const reread = requestedUrls(fetchStub).at(-1);
      expect(reread?.pathname).toBe('/idmapping/uniprotkb/results/job-inactive');
      expect(reread?.searchParams.get('fields')).toBe('accession');
      expect(reread?.searchParams.get('size')).toBe('500');
    },
  );
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

  it.each([
    ['ticket', { ticket: 'job-1' }, resumeMappingMock],
    ['continuation', { continuation: { jobId: 'job-1', cursor: 'c1' } }, resumeMappingPageMock],
  ] as const)(
    'lets a non-404 failure resuming by %s bubble with its own code, not as an invalid resume input',
    async (_mode, input, mock) => {
      mock.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'uniprot.mappingStatus failed upstream.'),
      );
      const result = await runToolContract(mapIds, input);
      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(envelope.message).toBe('uniprot.mappingStatus failed upstream.');
      expect(envelope.data?.reason).toBeUndefined();
    },
  );
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

    // The framework fills the declared recovery hint onto the envelope.
    const contract = await runToolContract(mapIds, {
      continuation: { jobId: 'expired-job', cursor: 'expired' },
    });
    const envelope = (
      contract.structuredContent as { error?: { data?: { recovery?: { hint?: string } } } }
    ).error;
    expect(envelope?.data?.recovery?.hint).toBe(
      'Restart the mapping job and use each returned continuation before it expires.',
    );
  });
});

describe('mapIds job id shape (real service, through runToolContract)', () => {
  /** Answer every request as a finished, empty job, so only a pre-request check can fail the call. */
  function upstreamAnswersEverything() {
    const fetchStub = routeUpstream(() =>
      upstreamResponse(200, { jobStatus: 'FINISHED', results: [], failedIds: [] }),
    );
    vi.stubGlobal('fetch', fetchStub);
    resumeMappingMock.mockImplementation(realService.resumeMapping.bind(realService));
    resumeMappingPageMock.mockImplementation(realService.resumeMappingPage.bind(realService));
    return fetchStub;
  }

  const MALFORMED_JOB_IDS = [
    '../../uniprotkb/search?query=x',
    'a.b',
    'job/1',
    'job 1',
    'job%2F1',
    '#',
  ];

  it.each(MALFORMED_JOB_IDS)(
    'rejects the malformed job id %j in a ticket as invalid_ticket before any request',
    async (ticket) => {
      const fetchStub = upstreamAnswersEverything();
      const result = await runToolContract(mapIds, { ticket });
      const envelope = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
      expect(envelope.message).toBe(
        'Mapping ticket is not a UniProt job ID: it may hold only letters, digits, "-", and "_".',
      );
      expect(envelope.data).toMatchObject({ reason: 'invalid_ticket' });
      expect(contentText(result)).toContain('(reason invalid_ticket');
      expect(requestedUrls(fetchStub)).toEqual([]);
    },
  );

  it.each(MALFORMED_JOB_IDS)(
    'rejects the malformed job id %j in a continuation as invalid_continuation before any request',
    async (jobId) => {
      const fetchStub = upstreamAnswersEverything();
      const result = await runToolContract(mapIds, { continuation: { jobId, cursor: 'c1' } });
      const envelope = errorEnvelope(result);
      expect(result.isError).toBe(true);
      expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
      expect(envelope.message).toBe(
        'Continuation jobId is not a UniProt job ID: it may hold only letters, digits, "-", and "_".',
      );
      expect(envelope.data).toMatchObject({ reason: 'invalid_continuation' });
      expect(contentText(result)).toContain('(reason invalid_continuation');
      expect(requestedUrls(fetchStub)).toEqual([]);
    },
  );

  it('sends a well-formed job id to the status and results endpoints as one path segment', async () => {
    const fetchStub = upstreamAnswersEverything();
    const ticket = await runToolContract(mapIds, { ticket: '3OVYSqg8Mm' });
    expect(ticket.isError).toBeFalsy();
    const page = await runToolContract(mapIds, {
      continuation: { jobId: 'job_42-a', cursor: 'c1' },
    });
    expect(page.isError).toBeFalsy();
    expect(requestedUrls(fetchStub).map((u) => u.pathname)).toEqual([
      '/idmapping/status/3OVYSqg8Mm',
      '/idmapping/results/3OVYSqg8Mm',
      '/idmapping/results/job_42-a',
    ]);
  });

  it('keeps the advertised ticket and continuation schemas free of a pattern', () => {
    const shape = mapIds.input.shape;
    expect(shape.ticket.safeParse('a.b').success).toBe(true);
    expect(shape.continuation.safeParse({ jobId: 'a.b', cursor: 'c' }).success).toBe(true);
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

  it('format() keeps the mapping table and lists only the inactive targets below it', () => {
    const blocks = mapIds.format!({
      status: 'finished',
      results: [
        { from: 'P04637', to: 'P04637' },
        { from: 'Q9ZZZ9', to: 'Q9ZZZ9', inactive: { reason: 'DELETED' } },
        { from: 'GENE2', to: 'Q00002', inactive: {} },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('| Q9ZZZ9 | Q9ZZZ9 |');
    expect(text).toContain('- Q9ZZZ9 → Q9ZZZ9 was deleted from UniProtKB.');
    expect(text).toContain('- GENE2 → Q00002 is inactive in UniProtKB.');
    expect(text).not.toContain('- P04637 →');
  });
});
