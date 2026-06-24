/**
 * @fileoverview Integration tests for UniProtService at its I/O boundary — the
 *   upstream HTTP layer is faked by stubbing fetchWithTimeout (and making
 *   withRetry a pass-through). Covers the parsing and classification logic that
 *   the tool handlers depend on but cannot exercise: 404 → typed notFound (the
 *   source of the not_found contract the handlers re-throw via ctx.fail), the
 *   HTML maintenance-page guard, FASTA parsing into canonical/isoform records,
 *   cursor extraction from the Link header, sparse-payload normalization that
 *   preserves absence, and the async ID-mapping run → poll → results loop.
 * @module tests/services/uniprot-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithTimeoutMock = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
    // Pass-through: exercise the fetch+parse pipeline once, without retry timing.
    withRetry: (fn: () => Promise<unknown>) => fn(),
  };
});

const { UniProtService } = await import('@/services/uniprot/uniprot-service.js');

/** Build a Response-like stub with the body text and optional headers. */
function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    headers: new Headers(headers),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

/** A minimal config/storage pair — the service reads config from getServerConfig() env defaults. */
const mockConfig = {} as never;
const mockStorage = {} as never;

let service: InstanceType<typeof UniProtService>;
const ctx = () => createMockContext();

beforeEach(() => {
  vi.clearAllMocks();
  service = new UniProtService(mockConfig, mockStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UniProtService — error classification', () => {
  it('rewrites a framework NotFound from the taxonomy endpoint to a clean domain message', async () => {
    // fetchWithTimeout maps a 404 to McpError(NotFound) with a "Fetch failed … Status: 404"
    // message — the service must detect it by code, not by string-matching, and replace the
    // leaky raw-URL message with a domain one.
    fetchWithTimeoutMock.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'Fetch failed for https://rest.uniprot.org/taxonomy/99999999. Status: 404',
        { statusCode: 404 },
      ),
    );
    const err = await service.getTaxonById(99999999, ctx()).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No taxonomy record for taxon ID 99999999.');
    expect(err.message).not.toMatch(/Status: 404|rest\.uniprot\.org/);
    expect(err.data).toMatchObject({ taxonId: 99999999 });
  });

  it('rewrites a framework NotFound on the FASTA endpoint to a clean domain message', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'Fetch failed for https://rest.uniprot.org/uniprotkb/Q6ZZZ9.fasta. Status: 404',
        { statusCode: 404 },
      ),
    );
    const err = await service.getFasta('Q6ZZZ9', false, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No sequence found for accession Q6ZZZ9.');
    expect(err.message).not.toMatch(/Status: 404|rest\.uniprot\.org/);
    expect(err.data).toMatchObject({ accession: 'Q6ZZZ9' });
  });

  it('throws notFound when no proteome matches the query', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await service.getProteome({ taxonId: 99999999 }, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('throws notFound (by name) when the taxonomy search is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await service
      .getTaxonByName('Nonexistus organismus', ctx())
      .catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ name: 'Nonexistus organismus' });
  });

  it('guards an HTML maintenance page (200 with HTML body) as a transient ServiceUnavailable', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse('<!DOCTYPE html><html><body>maintenance</body></html>'),
    );
    const err = await service.search('gene:TP53', {}, ctx()).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});

describe('UniProtService — upstream-error leak prevention', () => {
  // fetchWithTimeout attaches { statusCode, statusText, responseBody, requestId,
  // operation, errorSource } to the status-mapped McpError it throws on any
  // non-2xx / timeout / network failure. The handler boundary copies error.data
  // verbatim onto structuredContent.error.data, so a raw framework error reaching
  // the client leaks the raw upstream body and internal request metadata. The
  // service must re-throw clean on EVERY failure path, not just 404.
  //
  // A representative framework error: the leaky data + the raw, status-and-URL
  // bearing message exactly as fetchWithTimeout builds it.
  const frameworkError = (code: JsonRpcErrorCode, status: number) =>
    new McpError(
      code,
      `Fetch failed for https://rest.uniprot.org/uniprotkb/search. Status: ${status}`,
      {
        requestId: 'req-internal-abc123',
        operation: 'uniprot.search',
        statusCode: status,
        statusText: 'Service Unavailable',
        responseBody:
          '<html><head><title>503</title></head><body>upstream gateway error: pod uniprot-7f9 unreachable</body></html>',
        errorSource: 'FetchHttpError',
      },
    );

  /** Assert a thrown error carries none of the raw upstream internals on its wire-facing surface. */
  const assertLeakFree = (err: McpError) => {
    expect(err).toBeInstanceOf(McpError);
    // The data payload (copied verbatim to structuredContent.error.data) must not
    // carry any framework HTTP internal.
    const data = (err.data ?? {}) as Record<string, unknown>;
    expect(data).not.toHaveProperty('responseBody');
    expect(data).not.toHaveProperty('statusCode');
    expect(data).not.toHaveProperty('statusText');
    expect(data).not.toHaveProperty('requestId');
    expect(data).not.toHaveProperty('operation');
    expect(data).not.toHaveProperty('errorSource');
    // The message must not echo the raw upstream body, internal request id, or the
    // raw "Status: NNN / rest.uniprot.org" wording.
    expect(err.message).not.toMatch(/responseBody|req-internal|uniprot-7f9|gateway error/);
    expect(err.message).not.toMatch(/Status: \d{3}|rest\.uniprot\.org/);
  };

  it('search: a 503 ServiceUnavailable is re-thrown clean (no statusCode/responseBody/requestId)', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    const err = await service.search('gene:TP53', {}, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable); // classification preserved
    assertLeakFree(err);
    // The original is retained as cause for server-side logs only (never serialized to the client).
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(McpError);
  });

  it('search: a 429 RateLimited is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(frameworkError(JsonRpcErrorCode.RateLimited, 429));
    const err = await service.search('gene:TP53', {}, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    assertLeakFree(err);
  });

  it('getEntries: a 500 InternalError is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(frameworkError(JsonRpcErrorCode.InternalError, 500));
    const err = await service.getEntries(['P04637'], undefined, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.InternalError);
    assertLeakFree(err);
  });

  it('getProteome: a 502 ServiceUnavailable is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 502),
    );
    const err = await service.getProteome({ taxonId: 9606 }, ctx()).catch((e) => e as McpError);
    assertLeakFree(err);
  });

  it('getTaxonById: a non-404 (503) is re-thrown clean, not just 404', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    const err = await service.getTaxonById(9606, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    assertLeakFree(err);
  });

  it('getFasta: a non-404 (429) is re-thrown clean, not just 404', async () => {
    fetchWithTimeoutMock.mockRejectedValue(frameworkError(JsonRpcErrorCode.RateLimited, 429));
    const err = await service.getFasta('P04637', false, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    assertLeakFree(err);
  });

  it('mapIds (run submission): a 503 on the run POST is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    const err = await service
      .mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx())
      .catch((e) => e as McpError);
    assertLeakFree(err);
  });

  it('mapIds (results poll): a 503 on the status endpoint is re-thrown clean', async () => {
    fetchWithTimeoutMock
      // POST /idmapping/run → ok
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }))
      // GET /idmapping/status/job-1 → 503 framework error
      .mockRejectedValueOnce(frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503));
    const err = await service
      .mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx())
      .catch((e) => e as McpError);
    assertLeakFree(err);
  });

  it('a timeout (no leaky data on the error) passes through untouched — code and message preserved', async () => {
    // fetchWithTimeout's timeout() error carries { requestId, operation, errorSource } —
    // still leaky (requestId/operation), so it must also be sanitized.
    fetchWithTimeoutMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.Timeout, 'fetch GET https://rest.uniprot.org/… timed out.', {
        requestId: 'req-internal-xyz',
        operation: 'uniprot.search',
        errorSource: 'FetchTimeout',
      }),
    );
    const err = await service.search('gene:TP53', {}, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    assertLeakFree(err);
  });

  it('a clean domain error (notFound with safe data) is NOT mangled by the sanitizer', async () => {
    // The service's own notFound carries only { name } — no leaky keys — so it must
    // pass through unchanged (message and safe data intact).
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await service
      .getTaxonByName('Nonexistus organismus', ctx())
      .catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No taxonomy record matched the name "Nonexistus organismus".');
    expect(err.data).toMatchObject({ name: 'Nonexistus organismus' });
  });
});

describe('UniProtService — search parsing', () => {
  it('reads totalResults from x-total-results and the cursor from the Link header', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse(
        {
          results: [
            {
              primaryAccession: 'P04637',
              uniProtkbId: 'P53_HUMAN',
              entryType: 'UniProtKB reviewed (Swiss-Prot)',
              annotationScore: 5,
              proteinExistence: '1: Evidence at protein level',
              sequence: { length: 393 },
              proteinDescription: { recommendedName: { fullName: { value: 'p53' } } },
              genes: [{ geneName: { value: 'TP53' } }],
              organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
            },
          ],
        },
        {
          'x-total-results': '4457',
          link: '<https://rest.uniprot.org/uniprotkb/search?cursor=ABC123&query=x>; rel="next"',
        },
      ),
    );

    const page = await service.search('gene:TP53', {}, ctx());
    expect(page.totalResults).toBe(4457);
    expect(page.cursor).toBe('ABC123');
    expect(page.results[0]?.accession).toBe('P04637');
    expect(page.results[0]?.reviewed).toBe(true);
  });

  it('normalizes a sparse hit (no protein name, no function) preserving absence', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            primaryAccession: 'A0A0A0A0A0',
            uniProtkbId: 'A0A0A0A0A0_BACSU',
            entryType: 'UniProtKB unreviewed (TrEMBL)',
            // no annotationScore, no proteinExistence, no proteinDescription, no genes
            sequence: { length: 120 },
            organism: { scientificName: 'Bacillus subtilis', taxonId: 1423 },
          },
        ],
      }),
    );

    const page = await service.search('organism_id:1423', {}, ctx());
    const hit = page.results[0]!;
    expect(hit.accession).toBe('A0A0A0A0A0');
    expect(hit.reviewed).toBe(false);
    expect(hit.geneNames).toEqual([]);
    // Absent upstream fields are not fabricated — they stay omitted, not "undefined".
    expect(hit.proteinName).toBeUndefined();
    expect(hit.functionSnippet).toBeUndefined();
    // Defaulted scalars where the schema requires a value.
    expect(hit.annotationScore).toBe(0);
    expect(hit.proteinExistence).toBe('unknown');
  });

  it('strips evidence parentheticals from the function snippet', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            primaryAccession: 'P04637',
            uniProtkbId: 'P53_HUMAN',
            entryType: 'UniProtKB reviewed (Swiss-Prot)',
            sequence: { length: 393 },
            organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
            comments: [
              {
                commentType: 'FUNCTION',
                texts: [{ value: 'Acts as a tumor suppressor (PubMed:11025664).' }],
              },
            ],
          },
        ],
      }),
    );

    const page = await service.search('gene:TP53', {}, ctx());
    expect(page.results[0]?.functionSnippet).toBe('Acts as a tumor suppressor.');
  });
});

describe('UniProtService — FASTA parsing', () => {
  it('parses canonical + isoform records and derives lengths', async () => {
    const fasta = [
      '>sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4',
      'MEEPQSDPSV',
      'EPPLSQETFS',
      '>sp|P04637-2|P53_HUMAN Isoform 2',
      'MEEPQSDPSV',
      '',
    ].join('\n');
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse(fasta));

    const records = await service.getFasta('P04637', true, ctx());
    expect(records).toHaveLength(2);
    const canonical = records.find((r) => !r.isoformId);
    expect(canonical?.length).toBe(20); // two 10-residue lines joined
    const isoform = records.find((r) => r.isoformId === 'P04637-2');
    expect(isoform?.length).toBe(10);
  });

  it('throws notFound when the FASTA body parses to zero records (empty body)', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse(''));
    const err = await service.getFasta('P04637', false, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });
});

describe('UniProtService — getEntries batch', () => {
  it('returns only the entries upstream actually resolved (caller diffs the requested set)', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            primaryAccession: 'P04637',
            uniProtkbId: 'P53_HUMAN',
            entryType: 'UniProtKB reviewed (Swiss-Prot)',
            sequence: { length: 393 },
            organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
          },
        ],
      }),
    );

    const entries = await service.getEntries(['P04637', 'Q99999'], undefined, ctx());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.accession).toBe('P04637');
  });

  it('merges the mandatory identity fields into a caller-supplied fields projection', async () => {
    // UniProt omits `id` (entryName) unless requested, so a custom `fields` that drops it would
    // crash the required EntrySchema. The service must always carry the identity columns.
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            primaryAccession: 'P04637',
            uniProtkbId: 'P53_HUMAN',
            entryType: 'UniProtKB reviewed (Swiss-Prot)',
            sequence: { length: 393 },
            organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
          },
        ],
      }),
    );

    const entries = await service.getEntries(['P04637'], 'accession,gene_names,cc_function', ctx());
    expect(entries[0]?.entryName).toBe('P53_HUMAN');

    const sentUrl = String(fetchWithTimeoutMock.mock.calls[0]?.[0]);
    const sentFields = new URL(sentUrl).searchParams.get('fields') ?? '';
    const fieldSet = new Set(sentFields.split(','));
    // Identity/provenance columns are present even though the caller did not request them.
    expect(fieldSet).toContain('id');
    expect(fieldSet).toContain('length');
    expect(fieldSet).toContain('annotation_score');
    expect(fieldSet).toContain('protein_existence');
    // The caller's requested section field survives the merge.
    expect(fieldSet).toContain('cc_function');
  });
});

describe('UniProtService — ID mapping loop', () => {
  it('runs, polls to FINISHED, and returns normalized from→to mappings', async () => {
    fetchWithTimeoutMock
      // POST /idmapping/run
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }))
      // GET /idmapping/status/job-1 → FINISHED
      .mockResolvedValueOnce(jsonResponse({ jobStatus: 'FINISHED' }))
      // GET /idmapping/results/job-1 → results (object-form `to`)
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }] }),
      );

    const result = await service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx());
    expect(result.status).toBe('finished');
    if (result.status === 'finished') {
      expect(result.results).toEqual([{ from: 'TP53', to: 'P04637' }]);
    }
  });

  it('throws ServiceUnavailable when the run submission returns no jobId', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ messages: ['Invalid from/to combination'] }),
    );
    const err = await service
      .mapIds('PomBase', 'WormBase_Protein', ['x'], undefined, ctx())
      .catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('Invalid from/to combination');
  });

  it('resumeMapping returns running when the job has not finished', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ jobStatus: 'RUNNING' }));
    const result = await service.resumeMapping('job-1', ctx());
    expect(result.status).toBe('running');
    if (result.status === 'running') expect(result.ticket).toBe('job-1');
  });
});

describe('UniProtService — accessor guard', () => {
  it('getUniProtService throws before init and resolves after', async () => {
    // Fresh module copy so the singleton starts uninitialized.
    vi.resetModules();
    const mod = await import('@/services/uniprot/uniprot-service.js');
    expect(() => mod.getUniProtService()).toThrow(/not initialized/);
    mod.initUniProtService(mockConfig, mockStorage);
    expect(mod.getUniProtService()).toBeInstanceOf(mod.UniProtService);
  });
});
