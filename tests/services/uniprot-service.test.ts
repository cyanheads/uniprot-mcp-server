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
  it('classifies a 404 from the taxonomy endpoint as a typed notFound', async () => {
    fetchWithTimeoutMock.mockRejectedValue(new Error('Request failed with status code 404'));
    const err = await service.getTaxonById(99999999, ctx()).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ taxonId: 99999999 });
  });

  it('classifies a 404 on the FASTA endpoint as notFound', async () => {
    fetchWithTimeoutMock.mockRejectedValue(new Error('not found (status code 404)'));
    const err = await service.getFasta('Q99999', false, ctx()).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ accession: 'Q99999' });
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
