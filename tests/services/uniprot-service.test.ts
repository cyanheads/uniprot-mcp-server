/**
 * @fileoverview Integration tests for UniProtService at its I/O boundary — the
 *   upstream HTTP layer is faked by stubbing fetchWithTimeout (and making
 *   withRetry a pass-through). Covers the parsing and classification logic that
 *   the tool handlers depend on but cannot exercise: 404 → typed notFound (the
 *   source of the not_found contract the handlers re-throw via ctx.fail), the
 *   upstream-error sanitizer (leak-free generic errors, and a 400's messages[]
 *   relayed bounded as InvalidParams — routed through the real fetchWithTimeout
 *   over a stubbed fetch), taxonomy-name phrase escaping, the HTML
 *   maintenance-page guard, FASTA parsing into canonical/isoform records,
 *   cursor extraction from the Link header, sparse-payload normalization that
 *   preserves absence, and the async ID-mapping run → poll → results loop.
 * @module tests/services/uniprot-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeRawEntry,
  expectMcpError,
  INACTIVE_STUBS,
  RAW_ENTRIES,
  RAW_HUMAN_PROTEOME,
  RAW_SEARCH_FACETS,
  rejectUnmockedFetch,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

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

const { UniProtService, isCursorRejection } = await import('@/services/uniprot/uniprot-service.js');

/**
 * The framework's real `fetchWithTimeout`, for tests that route a stubbed global
 * `fetch` through it so the status mapping and the error `data` it attaches are
 * the production ones rather than a hand-built copy.
 */
const { fetchWithTimeout: realFetchWithTimeout } = await vi.importActual<
  typeof import('@cyanheads/mcp-ts-core/utils')
>('@cyanheads/mcp-ts-core/utils');

/** Route the service's next request through the real fetchWithTimeout onto a stubbed `fetch`. */
function upstreamReplies(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  );
  fetchWithTimeoutMock.mockImplementation(realFetchWithTimeout);
}

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
  fetchWithTimeoutMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
  service = new UniProtService(mockConfig, mockStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    const err = await expectMcpError(service.getTaxonById(99999999, ctx()));
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
    const err = await expectMcpError(service.getFasta('Q6ZZZ9', false, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No sequence found for accession Q6ZZZ9.');
    expect(err.message).not.toMatch(/Status: 404|rest\.uniprot\.org/);
    expect(err.data).toMatchObject({ accession: 'Q6ZZZ9' });
  });

  it('throws notFound when no proteome matches the query', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await expectMcpError(service.getProteome({ taxonId: 99999999 }, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('throws notFound (by name) when the taxonomy search is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await expectMcpError(service.getTaxonByName('Nonexistus organismus', ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ name: 'Nonexistus organismus' });
  });

  it.each([
    ['Homo sapiens', 'scientific:"Homo sapiens"'],
    ['Homo "sapiens', 'scientific:"Homo \\"sapiens"'],
    ['Homo \\sapiens', 'scientific:"Homo \\\\sapiens"'],
    ['a\\"b', 'scientific:"a\\\\\\"b"'],
  ])(
    'getTaxonByName escapes \\ and " in %j so the phrase query stays valid',
    async (name, sent) => {
      fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
      const err = await expectMcpError(service.getTaxonByName(name, ctx()));
      const sentUrl = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
      expect(sentUrl.searchParams.get('query')).toBe(sent);
      // A name that matches nothing still fails not_found, echoing the name as given.
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data).toMatchObject({ name });
    },
  );

  it('guards an HTML maintenance page (200 with HTML body) as a transient ServiceUnavailable', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse('<!DOCTYPE html><html><body>maintenance</body></html>'),
    );
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
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
        // Off by default upstream since the framework stopped attaching it, but
        // reachable via includeUrl — the request URL echoes the caller's query.
        url: 'https://rest.uniprot.org/uniprotkb/search?query=gene%3ATP53&fields=accession',
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
    expect(data).not.toHaveProperty('url');
    // The message must not echo the raw upstream body, internal request id, or the
    // raw "Status: NNN / rest.uniprot.org" wording.
    expect(err.message).not.toMatch(/responseBody|req-internal|uniprot-7f9|gateway error/);
    expect(err.message).not.toMatch(/Status: \d{3}|rest\.uniprot\.org/);
  };

  it('search: a 503 ServiceUnavailable is re-thrown clean (no statusCode/responseBody/requestId)', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable); // classification preserved
    assertLeakFree(err);
    // The original is retained as cause for server-side logs only (never serialized to the client).
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(McpError);
  });

  it('search: a 429 RateLimited is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(frameworkError(JsonRpcErrorCode.RateLimited, 429));
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    assertLeakFree(err);
  });

  it('getEntries: a 500 InternalError is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(frameworkError(JsonRpcErrorCode.InternalError, 500));
    const err = await expectMcpError(service.getEntries(['P04637'], undefined, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.InternalError);
    assertLeakFree(err);
  });

  it('getProteome: a 502 ServiceUnavailable is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 502),
    );
    const err = await expectMcpError(service.getProteome({ taxonId: 9606 }, ctx()));
    assertLeakFree(err);
  });

  it('getTaxonById: a 400 for an unparseable taxon id is NotFound, like a 404', async () => {
    // UniProt parses the path id as a Java long: an id past that range answers 400 with
    // the parser's own text ('For input string: "…"'), where a well-formed unknown id
    // answers 404. Both mean the same thing to a caller: no record for that id.
    upstreamReplies(upstreamResponse(400, UNIPROT_400_BODIES.taxonIdUnparseable, 'Bad Request'));
    const err = await expectMcpError(service.getTaxonById(Number('100000000000000000000'), ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No taxonomy record for taxon ID 100000000000000000000.');
    expect(err.message).not.toContain('For input string');
    expect(err.data).toEqual({ taxonId: 1e20 });
    assertLeakFree(err);
  });

  it('getTaxonById: a non-404 (503) is re-thrown clean, not just 404', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    const err = await expectMcpError(service.getTaxonById(9606, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    assertLeakFree(err);
  });

  it('getFasta: a non-404 (429) is re-thrown clean, not just 404', async () => {
    fetchWithTimeoutMock.mockRejectedValue(frameworkError(JsonRpcErrorCode.RateLimited, 429));
    const err = await expectMcpError(service.getFasta('P04637', false, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    assertLeakFree(err);
  });

  it('mapIds (run submission): a 503 on the run POST is re-thrown clean', async () => {
    fetchWithTimeoutMock.mockRejectedValue(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    const err = await expectMcpError(
      service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx()),
    );
    assertLeakFree(err);
  });

  it('mapIds (results poll): a 503 on the status endpoint is re-thrown clean', async () => {
    fetchWithTimeoutMock
      // POST /idmapping/run → ok
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }))
      // GET /idmapping/status/job-1 → 503 framework error
      .mockRejectedValueOnce(frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503));
    const err = await expectMcpError(
      service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx()),
    );
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
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    assertLeakFree(err);
  });

  it('a clean domain error (notFound with safe data) is NOT mangled by the sanitizer', async () => {
    // The service's own notFound carries only { name } — no leaky keys — so it must
    // pass through unchanged (message and safe data intact).
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await expectMcpError(service.getTaxonByName('Nonexistus organismus', ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No taxonomy record matched the name "Nonexistus organismus".');
    expect(err.data).toMatchObject({ name: 'Nonexistus organismus' });
  });

  // A 400 is UniProt rejecting a caller-supplied value. Its body is { url, messages[] }:
  // messages[] names the rejected value and is relayed; url (and everything else) is not.
  // These route a real 400 Response through the framework's own fetchWithTimeout so the
  // error data the sanitizer reads is the production shape.

  it.each([
    [
      'search: a rejected query field',
      UNIPROT_400_BODIES.badQueryField,
      () => service.search('badfield:abc', {}, ctx()),
      "'badfield' is not a valid search field",
    ],
    [
      'getEntries: a rejected fields value',
      UNIPROT_400_BODIES.badFields,
      () => service.getEntries(['P04637'], 'definitely_not_a_uniprot_field', ctx()),
      "Invalid fields parameter value 'definitely_not_a_uniprot_field'",
    ],
    [
      'search: several messages, relayed in order joined by "; "',
      UNIPROT_400_BODIES.badQueryAndFields,
      () => service.search('badfield:abc', { fields: 'definitely_not_a_uniprot_field' }, ctx()),
      "'badfield' is not a valid search field; Invalid fields parameter value 'definitely_not_a_uniprot_field'",
    ],
    [
      'getProteomeProteins: a rejected query filter',
      UNIPROT_400_BODIES.invalidSyntax,
      () => service.getProteomeProteins('UP000005640', { query: '(gene:TP53' }, ctx()),
      'query parameter has an invalid syntax',
    ],
    [
      'mapIds (run submission): an unsupported db pair',
      UNIPROT_400_BODIES.unsupportedDbPair,
      () => service.mapIds('PDB', 'Gene_Name', ['1TUP'], undefined, ctx()),
      "The combination of 'from=PDB' and 'to=Gene_Name' parameters is invalid",
    ],
  ])(
    '%s — a 400 relays UniProt messages[] as InvalidParams with no data',
    async (_case, body, call, relayed) => {
      upstreamReplies(upstreamResponse(400, body, 'Bad Request'));
      const err = await expectMcpError(call());
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toBe(`UniProt rejected the request: ${relayed}`);
      expect(err.data).toBeUndefined();
      assertLeakFree(err);
      expect(err.message).not.toContain('Bad Request');
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(McpError);
    },
  );

  it('a 400 body the framework cut at its capture limit relays only the text before the cut', async () => {
    // fetchWithTimeout keeps 500 bytes of a longer error body: its head and tail joined by
    // an "…[N bytes elided]…" marker. Inside a JSON string that still parses — here joining
    // the head of the first message to the tail of the second — so the relay stops at the
    // marker rather than presenting the splice as one message.
    const long = {
      url: 'http://rest.uniprot.org/uniprotkb/search',
      messages: [
        `Invalid fields parameter value '${'a'.repeat(500)}'`,
        `'${'b'.repeat(500)}' is not a valid search field`,
      ],
    };
    upstreamReplies(upstreamResponse(400, long));
    const err = await expectMcpError(service.search('gene:TP53', { fields: 'x' }, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toMatch(
      /^UniProt rejected the request: Invalid fields parameter value 'a+…$/,
    );
    expect(err.message).not.toMatch(/elided|b{3}/);
    assertLeakFree(err);
  });

  /**
   * A 400 body whose framework capture (200-byte head + marker + 300-byte tail) splices
   * right after the opening quote of the message following `before`: `url` is padded so
   * the head ends exactly there, and the last message runs past the tail.
   */
  const spliceAfterOpeningQuote = (before: string[]) => {
    const head = (pad: string) =>
      `{"url":"${pad}","messages":[${before.map((m) => `${JSON.stringify(m)},`).join('')}"`;
    const pad = 'p'.repeat(200 - head('').length);
    expect(head(pad)).toHaveLength(200);
    return { url: pad, messages: [...before, `'${'z'.repeat(600)}' is not a valid search field`] };
  };

  it('drops only the message the splice emptied, relaying the intact ones before it', async () => {
    upstreamReplies(
      upstreamResponse(400, spliceAfterOpeningQuote(["'badfield' is not a valid search field"])),
    );
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    expect(err.message).toBe(
      "UniProt rejected the request: 'badfield' is not a valid search field",
    );
    expect(err.message).not.toMatch(/; …|elided|z{3}/);
    assertLeakFree(err);
  });

  it.each([
    [
      'a non-JSON body, never relaying the raw body',
      () => '<html><body>upstream gateway error: pod uniprot-7f9</body></html>',
    ],
    [
      'a JSON body with no string in messages[]',
      () => ({ url: 'http://rest.uniprot.org/uniprotkb/search', messages: [7] }),
    ],
    [
      'a capture spliced right after a message opens, never relaying a bare "…"',
      () => spliceAfterOpeningQuote([]),
    ],
  ])('a 400 with %s yields the fixed message', async (_case, body) => {
    upstreamReplies(upstreamResponse(400, body()));
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toBe('UniProt rejected the request as invalid.');
    assertLeakFree(err);
  });

  it('bounds the relayed text: at most 5 messages, each cut to a fixed length', async () => {
    // Defense in depth below the framework's capture limit: hand the sanitizer a
    // body larger than any it would see today.
    const messages = Array.from({ length: 7 }, (_, i) => `m${i} ${'y'.repeat(1_000)}`);
    fetchWithTimeoutMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        status: 400,
        statusCode: 400,
        body: JSON.stringify({ url: 'http://rest.uniprot.org/uniprotkb/search', messages }),
        errorSource: 'FetchHttpError',
      }),
    );
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    const relayed = err.message.replace('UniProt rejected the request: ', '').split('; ');
    expect(relayed).toHaveLength(5);
    expect(relayed.map((m) => m.slice(0, 2))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    for (const m of relayed) {
      expect(m.length).toBeLessThanOrEqual(300);
      expect(m.endsWith('…')).toBe(true);
    }
    assertLeakFree(err);
  });

  /** UniProt's answer to a cursor it cannot continue from (captured 2026-10-12). */
  const cursorRejected500 = () =>
    upstreamResponse(500, {
      url: 'http://rest.uniprot.org/uniprotkb/search',
      messages: ['Internal server error'],
    });

  it('a 500 whose body carries messages[] stays generic when no cursor was sent', async () => {
    upstreamReplies(cursorRejected500());
    const err = await expectMcpError(service.search('gene:TP53', {}, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('uniprot.search failed upstream (-32000).');
    assertLeakFree(err);
  });

  it.each([
    ['search', () => service.search('gene:TP53', { cursor: 'garbage' }, ctx())],
    [
      'proteome protein listing',
      () => service.getProteomeProteins('UP000005640', { cursor: 'garbage' }, ctx()),
    ],
    ['taxonomy children', () => service.getChildren(1883, { cursor: 'garbage' }, ctx())],
  ])(
    'a 500 to a %s request that carried a cursor is the cursor rejected, typed invalid_cursor',
    async (_label, call) => {
      upstreamReplies(cursorRejected500());
      const err = await expectMcpError(call());
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toBe(
        'UniProt could not continue from the cursor: it answered HTTP 500, so the cursor is malformed or truncated.',
      );
      expect(err.data).toEqual({ reason: 'invalid_cursor' });
      expect(isCursorRejection(err)).toBe(true);
      assertLeakFree(err);
    },
  );

  it.each([
    [503, 'Service Unavailable'],
    [502, 'Bad Gateway'],
    [429, 'Too Many Requests'],
  ])(
    'a %i to a request that carried a cursor stays an upstream error — restarting would not help',
    async (status, statusText) => {
      upstreamReplies(upstreamResponse(status, { messages: ['x'] }, statusText));
      const err = await expectMcpError(service.search('gene:TP53', { cursor: 'c2' }, ctx()));
      expect(err.code).not.toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.message).toMatch(/^uniprot\.search failed upstream \(-\d+\)\.$/);
      expect(isCursorRejection(err)).toBe(false);
    },
  );

  it('a 500 that lands after the caller cancelled stays an upstream error, not invalid_cursor', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        controller.abort();
        return Promise.resolve(cursorRejected500());
      }),
    );
    fetchWithTimeoutMock.mockImplementation(realFetchWithTimeout);
    const cancelled = createMockContext({ signal: controller.signal });
    const err = await expectMcpError(service.search('gene:TP53', { cursor: 'c2' }, cancelled));
    expect(err.code).not.toBe(JsonRpcErrorCode.InvalidParams);
    expect(isCursorRejection(err)).toBe(false);
  });

  it('a 400 to a request that carried a cursor is still the relayed rejection, not invalid_cursor', async () => {
    upstreamReplies(upstreamResponse(400, UNIPROT_400_BODIES.badQueryField, 'Bad Request'));
    const err = await expectMcpError(service.search('badfield:abc', { cursor: 'c2' }, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.message).toBe(
      "UniProt rejected the request: 'badfield' is not a valid search field",
    );
    expect(isCursorRejection(err)).toBe(false);
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

  it('merges the mandatory identity fields into a caller-supplied search projection', async () => {
    // UniProt omits id/length/organism/score/existence unless requested, so a custom
    // `fields` (e.g. accession,gene_names) that drops them would crash the required
    // ProteinHit output schema. The service must always carry the identity columns.
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [] }, { 'x-total-results': '0' }),
    );

    await service.search('gene:TP53', { fields: 'accession,gene_names' }, ctx());

    const sentUrl = String(fetchWithTimeoutMock.mock.calls[0]?.[0]);
    const sentFields = new Set((new URL(sentUrl).searchParams.get('fields') ?? '').split(','));
    // Identity/provenance columns are present even though the caller did not request them.
    expect(sentFields).toContain('id');
    expect(sentFields).toContain('organism_name');
    expect(sentFields).toContain('length');
    expect(sentFields).toContain('annotation_score');
    expect(sentFields).toContain('protein_existence');
    // The caller's requested column survives the merge.
    expect(sentFields).toContain('gene_names');
  });
});

describe('UniProtService — taxonomy children page', () => {
  const link = (cursor: string) =>
    `<https://rest.uniprot.org/taxonomy/search?format=json&query=parent%3A1883&cursor=${cursor}&size=100>; rel="next"`;

  it('reads the page, the x-total-results total, and the next cursor from the Link header', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse(
        { results: [{ taxonId: 1885, scientificName: 'Streptomyces actuosus', rank: 'species' }] },
        { 'x-total-results': '1181', link: link('md9gwv5i6w0o') },
      ),
    );
    const page = await service.getChildren(1883, {}, ctx());
    expect(page).toEqual({
      children: [{ taxonId: 1885, scientificName: 'Streptomyces actuosus', rank: 'species' }],
      totalChildren: 1181,
      cursor: 'md9gwv5i6w0o',
    });
    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.pathname).toBe('/taxonomy/search');
    expect(sent.searchParams.get('query')).toBe('parent:1883');
    expect(sent.searchParams.get('size')).toBe('100');
    expect(sent.searchParams.has('cursor')).toBe(false);
  });

  it('sends a given cursor and returns no cursor on the terminal page', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse(
        { results: [{ taxonId: 3065, scientificName: 'Streptomyces sp. 3065' }] },
        {
          'x-total-results': '1181',
        },
      ),
    );
    const page = await service.getChildren(1883, { cursor: 'c12' }, ctx());
    expect(page).toEqual({
      children: [{ taxonId: 3065, scientificName: 'Streptomyces sp. 3065', rank: 'no rank' }],
      totalChildren: 1181,
    });
    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.searchParams.get('cursor')).toBe('c12');
  });

  it('falls back to the page length when x-total-results is absent, and handles no results', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({}));
    expect(await service.getChildren(63221, {}, ctx())).toEqual({ children: [], totalChildren: 0 });
  });
});

describe('UniProtService — FASTA parsing', () => {
  it('routes include_isoforms through the search endpoint and parses canonical + isoform records', async () => {
    const fasta = [
      '>sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4',
      'MEEPQSDPSV',
      'EPPLSQETFS',
      '>sp|P04637-2|P53_HUMAN Isoform 2',
      'MEEPQSDPSV',
      '',
    ].join('\n');
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse(fasta));

    const { accession, mergedFrom, records } = await service.getFasta('P04637', true, ctx());
    expect(accession).toBe('P04637');
    expect(mergedFrom).toBeUndefined();
    expect(records).toHaveLength(2);
    const canonical = records.find((r) => !r.isoformId);
    expect(canonical?.length).toBe(20); // two 10-residue lines joined
    const isoform = records.find((r) => r.isoformId === 'P04637-2');
    expect(isoform?.length).toBe(10);

    // The per-accession .fasta endpoint silently ignores includeIsoform and only ever
    // returns the canonical record, so the isoform path must hit the search endpoint.
    const sentUrl = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sentUrl.pathname).toBe('/uniprotkb/search');
    expect(sentUrl.searchParams.get('query')).toBe('accession:P04637');
    expect(sentUrl.searchParams.get('includeIsoform')).toBe('true');
    expect(sentUrl.searchParams.get('format')).toBe('fasta');
  });

  it('uses the per-accession FASTA endpoint (not search) when isoforms are not requested', async () => {
    const fasta = ['>sp|P04637|P53_HUMAN Cellular tumor antigen p53', 'MEEPQSDPSV', ''].join('\n');
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse(fasta));

    await service.getFasta('P04637', false, ctx());
    const sentUrl = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sentUrl.pathname).toBe('/uniprotkb/P04637.fasta');
    expect(sentUrl.searchParams.has('includeIsoform')).toBe(false);
  });

  it('throws notFound when the FASTA body parses to zero records (empty body)', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse(''));
    const err = await expectMcpError(service.getFasta('P04637', false, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it.each([
    'https://rest.uniprot.org/uniprotkb/P02768.fasta?from=Q13140',
    // Another redirect URL shape: the label comes from the canonical header, not the URL.
    'https://rest.uniprot.org/uniprotkb/P02768?format=fasta&from=Q13140',
  ])(
    'labels a FASTA redirected to %s with the target its header names, and names the requested accession',
    async (url) => {
      fetchWithTimeoutMock.mockResolvedValue({
        ...jsonResponse('>sp|P02768|ALBU_HUMAN Albumin\nMKWVTFISLL\n'),
        redirected: true,
        url,
      });
      const result = await service.getFasta('Q13140', false, ctx());
      expect(result.accession).toBe('P02768');
      expect(result.mergedFrom).toBe('Q13140');
      expect(result.records[0]?.header).toContain('|P02768|');
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves an empty body a plain not-found, disclosed, when the inactive-status lookup fails', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse('')).mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
        status: 503,
        statusCode: 503,
        body: 'down',
        responseBody: 'down',
      }),
    );
    const err = await expectMcpError(service.getFasta('P62158', false, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe(
      'No sequence found for accession P62158. Whether it is inactive (merged, demerged, or deleted) could not be checked; retry, or resolve it with uniprot_map_ids.',
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a cancellation during the inactive-status lookup instead of a not-found', async () => {
    const controller = new AbortController();
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse('')).mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new McpError(JsonRpcErrorCode.RequestCancelled, 'Request cancelled.'));
    });
    const err = await expectMcpError(
      service.getFasta('P62158', false, createMockContext({ signal: controller.signal })),
    );
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('fetches the merge target in isoform mode, where the search does not redirect', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse(''))
      .mockResolvedValueOnce(jsonResponse({ results: [INACTIVE_STUBS.merged] }))
      .mockResolvedValueOnce(
        jsonResponse(
          '>sp|P02768|ALBU_HUMAN Albumin\nMKWVTFISLL\n>sp|P02768-2|ALBU_HUMAN Isoform 2 of Albumin\nMKWV\n',
        ),
      );
    const result = await service.getFasta('Q13140', true, ctx());
    expect(result.accession).toBe('P02768');
    expect(result.mergedFrom).toBe('Q13140');
    expect(result.records.map((r) => r.isoformId)).toEqual([undefined, 'P02768-2']);
    const queries = fetchWithTimeoutMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get('query'),
    );
    expect(queries).toEqual(['accession:Q13140', 'accession:(Q13140)', 'accession:P02768']);
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

    const { entries, inactive } = await service.getEntries(['P04637', 'Q99999'], undefined, ctx());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.accession).toBe('P04637');
    expect(inactive).toEqual([]);
  });

  it('reports inactive stubs with their reason and pointer instead of normalizing them', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: [
          activeRawEntry('P04637', 'P53_HUMAN'),
          INACTIVE_STUBS.merged,
          INACTIVE_STUBS.demerged,
          INACTIVE_STUBS.deleted,
          { ...INACTIVE_STUBS.deleted, primaryAccession: 'Q9ZZZ8', inactiveReason: null },
        ],
      }),
    );

    const { entries, inactive } = await service.getEntries(
      ['P04637', 'Q13140', 'P62158', 'Q9ZZZ9', 'Q9ZZZ8'],
      undefined,
      ctx(),
    );
    expect(entries.map((e) => e.accession)).toEqual(['P04637']);
    expect(inactive).toEqual([
      { accession: 'Q13140', reason: 'MERGED', replacedBy: ['P02768'], uniParcId: 'UPI000016A1A8' },
      {
        accession: 'P62158',
        reason: 'DEMERGED',
        replacedBy: ['P0DP25', 'P0DP23', 'P0DP24'],
        uniParcId: 'UPI0000020B41',
      },
      {
        accession: 'Q9ZZZ9',
        reason: 'DELETED',
        deletedReason: 'Not part of a reference proteome',
        uniParcId: 'UPI000008B5B6',
      },
      // A stub naming no reason keeps only what it carries — nothing is invented.
      { accession: 'Q9ZZZ8', uniParcId: 'UPI000008B5B6' },
    ]);
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

    const { entries } = await service.getEntries(
      ['P04637'],
      'accession,gene_names,cc_function',
      ctx(),
    );
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
        jsonResponse({
          results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }],
          failedIds: ['ZZZNOTAREALGENE'],
        }),
      );

    const result = await service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx());
    expect(result.status).toBe('finished');
    if (result.status === 'finished') {
      expect(result.results).toEqual([{ from: 'TP53', to: 'P04637' }]);
      expect(result.failedIds).toEqual(['ZZZNOTAREALGENE']);
    }
  });

  it('recognizes a finished 303 status without following the results redirect', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-303' }))
      .mockImplementationOnce((_url, _timeout, _context, options) => {
        expect(options).toMatchObject({ redirect: 'manual', expectedStatuses: [303] });
        return Promise.reject(
          new McpError(JsonRpcErrorCode.InternalError, 'Status endpoint returned 303.', {
            status: 303,
            statusCode: 303,
            body: '{"jobStatus":"FINISHED"}',
            responseBody: '{"jobStatus":"FINISHED"}',
          }),
        );
      })
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }] }),
      );

    const result = await service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx());
    expect(result.status).toBe('finished');
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    expect(String(fetchWithTimeoutMock.mock.calls[2]?.[0])).toContain('/idmapping/results/job-303');
  });

  it('returns one completed page and a continuation without fetching the next page', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-pages' }))
      .mockResolvedValueOnce(jsonResponse({ jobStatus: 'FINISHED' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }],
            failedIds: ['ZZZNOTAREALGENE'],
          },
          {
            link: '<https://rest.uniprot.org/idmapping/results/job-pages?format=json&size=500&cursor=cursor-2>; rel="next"',
          },
        ),
      );

    const result = await service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, ctx());
    expect(result).toEqual({
      status: 'finished',
      results: [{ from: 'TP53', to: 'P04637' }],
      failedIds: ['ZZZNOTAREALGENE'],
      continuation: { jobId: 'job-pages', cursor: 'cursor-2' },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    expect(String(fetchWithTimeoutMock.mock.calls[2]?.[0])).not.toContain('cursor=cursor-2');
  });

  it('uses a completed-page continuation and propagates another page without probing status or re-submitting', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse(
        {
          results: [{ from: 'BRCA1', to: 'P38398' }],
          failedIds: ['ZZZNOTAREALGENE'],
        },
        {
          link: '<https://rest.uniprot.org/idmapping/results/job-pages?format=json&size=500&cursor=cursor-3>; rel="next"',
        },
      ),
    );

    const result = await service.resumeMappingPage(
      { jobId: 'job-pages', cursor: 'cursor-2' },
      ctx(),
    );
    expect(result).toEqual({
      status: 'finished',
      results: [{ from: 'BRCA1', to: 'P38398' }],
      failedIds: ['ZZZNOTAREALGENE'],
      continuation: { jobId: 'job-pages', cursor: 'cursor-3' },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const sentUrl = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sentUrl.pathname).toBe('/idmapping/results/job-pages');
    expect(sentUrl.searchParams.get('cursor')).toBe('cursor-2');
    expect(sentUrl.searchParams.get('size')).toBe('500');
  });

  it('returns an empty terminal page when a continuation is past the remaining rows', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ results: [], failedIds: [] }));

    const result = await service.resumeMappingPage(
      { jobId: 'job-pages', cursor: 'past-end' },
      ctx(),
    );
    expect(result).toEqual({ status: 'finished', results: [], failedIds: [] });
  });

  it('marks inactive targets on a continuation page, row by source and target, by re-reading that page from the uniprotkb endpoint', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            results: [
              { from: 'Q9ZZZ9', to: 'Q9ZZZ9' },
              { from: 'GENE7', to: 'Q9ZZZ9' },
              { from: 'P04637', to: 'P04637' },
              { from: 'GENE9', to: 'P04637' },
              { from: 'GENE9', to: 'Q9ZZZ9' },
            ],
            failedIds: [],
            obsoleteCount: 3,
          },
          {
            link: '<https://rest.uniprot.org/idmapping/results/job-p?format=json&cursor=CUR3&size=500>; rel="next"',
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { from: 'Q9ZZZ9', to: INACTIVE_STUBS.deletedMappingTarget },
            // Same target from another source: still matched on its own row only.
            { from: 'GENE7', to: INACTIVE_STUBS.deletedMappingTarget },
            {
              from: 'P04637',
              to: { entryType: 'UniProtKB reviewed (Swiss-Prot)', primaryAccession: 'P04637' },
            },
            // One source mapping to an active and an inactive target: only the inactive row is marked.
            {
              from: 'GENE9',
              to: { entryType: 'UniProtKB reviewed (Swiss-Prot)', primaryAccession: 'P04637' },
            },
            { from: 'GENE9', to: INACTIVE_STUBS.deletedMappingTarget },
            // A row not on the generic page marks nothing.
            { from: 'ELSEWHERE', to: INACTIVE_STUBS.merged },
          ],
          obsoleteCount: 3,
        }),
      );

    const result = await service.resumeMappingPage({ jobId: 'job-p', cursor: 'CUR2' }, ctx());
    const deleted = {
      reason: 'DELETED',
      deletedReason: 'Not part of a reference proteome',
      uniParcId: 'UPI000008B5B6',
    };
    expect(result).toEqual({
      status: 'finished',
      results: [
        { from: 'Q9ZZZ9', to: 'Q9ZZZ9', inactive: deleted },
        { from: 'GENE7', to: 'Q9ZZZ9', inactive: deleted },
        { from: 'P04637', to: 'P04637' },
        { from: 'GENE9', to: 'P04637' },
        { from: 'GENE9', to: 'Q9ZZZ9', inactive: deleted },
      ],
      failedIds: [],
      continuation: { jobId: 'job-p', cursor: 'CUR3' },
    });
    const reread = new URL(String(fetchWithTimeoutMock.mock.calls[1]?.[0]));
    expect(reread.pathname).toBe('/idmapping/uniprotkb/results/job-p');
    expect(reread.searchParams.get('cursor')).toBe('CUR2');
    expect(reread.searchParams.get('fields')).toBe('accession');
  });

  it('propagates a cancellation during the inactive-target re-read instead of an unmarked page', async () => {
    const controller = new AbortController();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ from: 'Q9ZZZ9', to: 'Q9ZZZ9' }], obsoleteCount: 1 }),
      )
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(
          new McpError(JsonRpcErrorCode.RequestCancelled, 'Request cancelled.'),
        );
      });
    const err = await expectMcpError(
      service.resumeMappingPage(
        { jobId: 'job-c', cursor: 'C' },
        createMockContext({ signal: controller.signal }),
      ),
    );
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('discloses a re-read page that lacks a generic-page row as unchecked, not silently unmarked', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { from: 'P04637', to: 'P04637' },
            { from: 'Q9ZZZ9', to: 'Q9ZZZ9' },
          ],
          obsoleteCount: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              from: 'P04637',
              to: { entryType: 'UniProtKB reviewed (Swiss-Prot)', primaryAccession: 'P04637' },
            },
          ],
          obsoleteCount: 1,
        }),
      );
    const result = await service.resumeMappingPage({ jobId: 'job-d', cursor: 'D' }, ctx());
    expect(result).toEqual({
      status: 'finished',
      results: [
        { from: 'P04637', to: 'P04637' },
        { from: 'Q9ZZZ9', to: 'Q9ZZZ9' },
      ],
      failedIds: [],
      inactiveUnchecked: 1,
    });
  });

  it('discloses a re-read page whose rows name other source IDs as unchecked', async () => {
    // Same target, different source: a row is matched on source and target together,
    // so GENE2's inactive target never marks GENE1's row.
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ from: 'GENE1', to: 'Q9ZZZ9' }], obsoleteCount: 1 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ from: 'GENE2', to: INACTIVE_STUBS.deletedMappingTarget }],
          obsoleteCount: 1,
        }),
      );
    const result = await service.resumeMappingPage({ jobId: 'job-h', cursor: 'H' }, ctx());
    expect(result).toEqual({
      status: 'finished',
      results: [{ from: 'GENE1', to: 'Q9ZZZ9' }],
      failedIds: [],
      inactiveUnchecked: 1,
    });
  });

  it('throws ServiceUnavailable when the run submission returns no jobId', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse({ messages: ['Invalid from/to combination'] }),
    );
    const err = await expectMcpError(
      service.mapIds('PomBase', 'WormBase_Protein', ['x'], undefined, ctx()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('Invalid from/to combination');
  });

  it('resumeMapping returns running when the job has not finished', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ jobStatus: 'RUNNING' }));
    const result = await service.resumeMapping('job-1', ctx());
    expect(result.status).toBe('running');
    if (result.status === 'running') expect(result.ticket).toBe('job-1');
  });

  it('resumeMapping returns normalized results when the job has finished', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ jobStatus: 'FINISHED' }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }],
          failedIds: ['ZZZNOTAREALGENE'],
        }),
      );

    const result = await service.resumeMapping('job-1', ctx());
    expect(result.status).toBe('finished');
    if (result.status === 'finished') {
      expect(result.results).toEqual([{ from: 'TP53', to: 'P04637' }]);
      expect(result.failedIds).toEqual(['ZZZNOTAREALGENE']);
    }
  });

  it('throws ServiceUnavailable naming "unknown" when the run submission returns neither jobId nor messages', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({}));
    const err = await expectMcpError(
      service.mapIds('Gene_Name', 'UniProtKB', ['TP53'], undefined, ctx()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('ID-mapping job submission did not return a jobId: unknown');
  });

  it.each([
    [9606, '9606'],
    [undefined, null],
  ])(
    'submits the job form with taxId %j sent as %j — only when one is given',
    async (taxId, sent) => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ jobId: 'job-tax' }))
        .mockResolvedValueOnce(jsonResponse({ jobStatus: 'FINISHED' }))
        .mockResolvedValueOnce(jsonResponse({ results: [] }));

      await service.mapIds('Gene_Name', 'UniProtKB', ['TP53', 'BRCA1'], taxId, ctx());
      const form = fetchWithTimeoutMock.mock.calls[0]?.[3]?.body as FormData;
      expect(form.get('from')).toBe('Gene_Name');
      expect(form.get('to')).toBe('UniProtKB');
      expect(form.get('ids')).toBe('TP53,BRCA1');
      expect(form.get('taxId')).toBe(sent);
    },
  );

  describe('poll loop timing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits and polls again while the job runs (a status with no jobStatus counts as running)', async () => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ jobId: 'job-slow' }))
        .mockResolvedValueOnce(jsonResponse({ jobStatus: 'RUNNING' }))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ jobStatus: 'FINISHED' }))
        .mockResolvedValueOnce(
          jsonResponse({ results: [{ from: 'TP53', to: { primaryAccession: 'P04637' } }] }),
        );

      const pending = service.mapIds('Gene_Name', 'UniProtKB', ['TP53'], 9606, ctx());
      // Two 500 ms pauses separate the three status polls.
      await vi.advanceTimersByTimeAsync(499);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(501);
      const result = await pending;

      expect(result).toEqual({
        status: 'finished',
        results: [{ from: 'TP53', to: 'P04637' }],
        failedIds: [],
      });
      const urls = fetchWithTimeoutMock.mock.calls.map(([url]) => String(url));
      expect(urls.filter((u) => u.endsWith('/idmapping/status/job-slow'))).toHaveLength(3);
      expect(urls[4]).toContain('/idmapping/results/job-slow');
    });

    it('returns the resumable ticket once the budget elapses with the job still running', async () => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ jobId: 'job-long' }))
        .mockImplementation(() => Promise.resolve(jsonResponse({ jobStatus: 'RUNNING' })));

      const pending = service.mapIds('Gene_Name', 'UniProtKB', ['TP53'], 9606, ctx());
      await vi.advanceTimersByTimeAsync(8_500);
      const result = await pending;

      expect(result).toEqual({ status: 'running', ticket: 'job-long' });
      // One poll at t=0 and one after each 500 ms pause inside the 8 s default budget.
      const polls = fetchWithTimeoutMock.mock.calls.filter(([url]) =>
        String(url).includes('/idmapping/status/'),
      );
      expect(polls).toHaveLength(16);
      expect(
        fetchWithTimeoutMock.mock.calls.some(([url]) => String(url).includes('/results/')),
      ).toBe(false);
    });

    it('stops polling and returns the ticket when the caller cancels between polls', async () => {
      const controller = new AbortController();
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ jobId: 'job-cancel' }))
        .mockImplementationOnce(() => {
          controller.abort();
          return Promise.resolve(jsonResponse({ jobStatus: 'RUNNING' }));
        });

      const pending = service.mapIds(
        'Gene_Name',
        'UniProtKB',
        ['TP53'],
        9606,
        createMockContext({ signal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual({ status: 'running', ticket: 'job-cancel' });
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    });
  });

  it('a status poll answered with an HTML page stays a clean ServiceUnavailable, not FINISHED', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse('<!DOCTYPE html><html><body>maintenance</body></html>'),
    );
    const err = await expectMcpError(service.resumeMapping('job-1', ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('HTML page instead of JSON');
  });

  it('throws ServiceUnavailable for a next-page link that carries no cursor', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse(
        { results: [{ from: 'TP53', to: 'P04637' }] },
        {
          link: '<https://rest.uniprot.org/idmapping/results/job-1?format=json&size=500>; rel="next"',
        },
      ),
    );
    const err = await expectMcpError(
      service.resumeMappingPage({ jobId: 'job-1', cursor: 'c1' }, ctx()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('UniProt returned an ID-mapping next-page link without a cursor.');
  });
});

describe('UniProtService — full entry normalization', () => {
  it('normalizes every curated section of a full entry', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [RAW_ENTRIES.pah] }));

    const { entries, inactive } = await service.getEntries(['P00439'], undefined, ctx());

    expect(inactive).toEqual([]);
    expect(entries).toEqual([
      {
        accession: 'P00439',
        entryName: 'PH4H_HUMAN',
        proteinName: 'Phenylalanine-4-hydroxylase',
        genes: ['PAH'],
        organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
        length: 452,
        reviewed: true,
        annotationScore: 5,
        proteinExistence: '1: Evidence at protein level',
        function: [
          {
            value: 'Catalyzes the hydroxylation of L-phenylalanine to L-tyrosine',
            evidence: ['PubMed:18460651', 'PubMed:18835579'],
          },
        ],
        catalyticActivity: [
          {
            name: RAW_ENTRIES.pah.comments[1].reaction.name,
            ecNumber: '1.14.16.1',
            rheaId: 'RHEA:20273',
          },
        ],
        cofactors: [{ name: 'Fe(2+)', chebiId: 'CHEBI:29033' }],
        disease: [
          {
            name: 'Phenylalanine hydroxylase deficiency',
            diseaseId: 'DI-02159',
            acronym: 'PAH deficiency',
            description: RAW_ENTRIES.pah.comments[3].disease.description,
            omimId: '261600',
          },
        ],
        ptms: [
          {
            type: 'Modified residue',
            description: 'Phosphoserine; by PKA',
            location: { start: 16, end: 16 },
          },
        ],
        variants: [
          {
            description: 'in PAH deficiency; severe; uncertain significance; dbSNP:rs62642946',
            location: { start: 16, end: 16 },
            original: 'S',
            variation: 'P',
            featureId: 'VAR_000869',
          },
          {
            description: 'in PAH deficiency; severe; abolishes phenylalanine binding',
            location: { start: 63, end: 64 },
            original: 'TH',
            variation: 'PN',
            featureId: 'VAR_000881',
          },
          // An empty alternativeSequence leaves original/variation absent, not invented.
          {
            description: 'in PAH deficiency; severe',
            location: { start: 39, end: 39 },
            featureId: 'VAR_000871',
          },
        ],
        domains: [{ type: 'Domain', description: 'ACT', location: { start: 36, end: 114 } }],
        goTerms: [
          { id: 'GO:0005829', term: 'cytosol', aspect: 'C' },
          { id: 'GO:0005506', term: 'iron ion binding', aspect: 'F' },
        ],
        keywords: [
          { id: 'KW-0002', name: '3D-structure', category: 'Technical term' },
          { id: 'KW-0021', name: 'Allosteric enzyme', category: 'Molecular function' },
        ],
        xrefs: {
          PDB: ['1DMW', '1J8T'],
          RefSeq: ['NP_000268.1'],
          ChEMBL: ['CHEMBL3076'],
          Ensembl: ['ENST00000553106.6'],
        },
      },
    ]);
  });

  it('keeps synonyms, isoforms, and locations, and drops a DISEASE comment that holds only a note', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [RAW_ENTRIES.p53, RAW_ENTRIES.rhodopsin] }),
    );

    const { entries } = await service.getEntries(['P04637', 'P08100'], undefined, ctx());
    const [p53, rhodopsin] = entries;

    expect(p53?.genes).toEqual(['TP53', 'P53']);
    expect(p53?.subcellularLocation).toEqual([{ location: 'Cytoplasm' }, { location: 'Nucleus' }]);
    expect(p53?.isoforms).toEqual([
      { isoformId: 'P04637-1', name: '1', sequenceStatus: 'Displayed' },
      { isoformId: 'P04637-2', name: '2', sequenceStatus: 'Described' },
    ]);
    expect(p53?.disease).toEqual([
      {
        name: 'Esophageal cancer',
        diseaseId: 'DI-01537',
        acronym: 'ESCR',
        description: 'A malignancy of the esophagus.',
        omimId: '133239',
      },
    ]);
    expect(p53?.domains).toEqual([
      { type: 'Region', description: 'Interaction with HIPK1', location: { start: 100, end: 370 } },
    ]);
    expect(p53?.ptms).toEqual([
      {
        type: 'Modified residue',
        description: 'Phosphoserine; by HIPK4',
        location: { start: 9, end: 9 },
      },
    ]);
    // Sections UniProt did not send stay absent rather than empty.
    for (const key of [
      'function',
      'catalyticActivity',
      'cofactors',
      'variants',
      'goTerms',
      'keywords',
      'xrefs',
    ]) {
      expect(p53).not.toHaveProperty(key);
    }

    expect(rhodopsin?.genes).toEqual(['RHO', 'OPN2']);
    expect(rhodopsin?.subcellularLocation).toEqual([
      { location: 'Photoreceptor outer segment membrane', topology: 'Multi-pass membrane protein' },
    ]);
  });

  it('reads disulfide bonds from a caller projection as PTMs spanning their range, dropping an empty description', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [RAW_ENTRIES.insulin] }));

    const { entries } = await service.getEntries(['P01308'], 'ft_disulfid', ctx());

    const sentFields = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).searchParams.get(
      'fields',
    );
    expect(sentFields?.split(',')).toContain('ft_disulfid');
    expect(entries[0]?.ptms).toEqual([
      {
        type: 'Disulfide bond',
        description: 'Interchain (between B and A chains)',
        location: { start: 31, end: 96 },
      },
      { type: 'Disulfide bond', location: { start: 95, end: 100 } },
    ]);
    expect(entries[0]?.ptms?.[1]).not.toHaveProperty('description');
  });
});

describe('UniProtService — search facets', () => {
  it('requests the facets and page size, and normalizes facet values, using the value where UniProt sends no label', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse(
        { results: [RAW_ENTRIES.p53], facets: RAW_SEARCH_FACETS },
        { 'x-total-results': '581' },
      ),
    );

    const page = await service.search(
      'gene:TP53',
      { facets: 'reviewed,annotation_score', size: 1 },
      ctx(),
    );

    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.searchParams.get('facets')).toBe('reviewed,annotation_score');
    expect(sent.searchParams.get('size')).toBe('1');
    expect(page.totalResults).toBe(581);
    expect(page.facets).toEqual([
      {
        name: 'reviewed',
        label: 'Status',
        values: [
          { value: 'true', label: 'Reviewed (Swiss-Prot)', count: 34 },
          { value: 'false', label: 'Unreviewed (TrEMBL)', count: 547 },
        ],
      },
      {
        name: 'annotation_score',
        label: 'Annotation score',
        values: [
          { value: '5', label: '5', count: 87 },
          { value: '4', label: '4', count: 69 },
        ],
      },
    ]);
    expect(page).not.toHaveProperty('cursor');
  });

  it('omits facets when none were requested', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [] }, { 'x-total-results': '0' }),
    );
    const page = await service.search('gene:NOPE', {}, ctx());
    expect(
      new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).searchParams.has('facets'),
    ).toBe(false);
    expect(page).toEqual({ results: [], inactive: [], totalResults: 0 });
  });
});

describe('UniProtService — proteomes', () => {
  const humanProteome = {
    upid: 'UP000005640',
    proteomeType: 'Reference proteome',
    organism: {
      scientificName: 'Homo sapiens',
      commonName: 'Human',
      taxonId: 9606,
      mnemonic: 'HUMAN',
    },
    proteinCount: 147520,
    busco: {
      complete: 13716,
      completeSingle: 5103,
      completeDuplicated: 8613,
      fragmented: 5,
      missing: 59,
      total: 13780,
      lineageDb: 'primates_odb10',
      score: 99,
    },
    genomeAssembly: 'GCA_000001405.29',
  };

  it('finds the reference proteome by taxon id and normalizes BUSCO and the assembly', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [RAW_HUMAN_PROTEOME] }));

    const proteome = await service.getProteome({ taxonId: 9606 }, ctx());

    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.pathname).toBe('/proteomes/search');
    expect(sent.searchParams.get('query')).toBe('(organism_id:9606) AND (reference:true)');
    expect(sent.searchParams.get('size')).toBe('1');
    expect(proteome).toEqual(humanProteome);
  });

  it('looks a proteome up by UPID when one is given', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [RAW_HUMAN_PROTEOME] }));
    await service.getProteome({ upid: 'UP000005640' }, ctx());
    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.searchParams.get('query')).toBe('(upid:UP000005640)');
  });

  it('lists proteome proteins with the filter grouped, the page size, the cursor, and the next cursor', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse(
        { results: [RAW_ENTRIES.p53] },
        {
          'x-total-results': '20420',
          link: '<https://rest.uniprot.org/uniprotkb/search?query=x&cursor=next-1&size=1>; rel="next"',
        },
      ),
    );

    const page = await service.getProteomeProteins(
      'UP000005640',
      { query: 'gene:TP53 OR gene:BRCA1', size: 1, cursor: 'cur-0' },
      ctx(),
    );

    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.searchParams.get('query')).toBe(
      'proteome:UP000005640 AND (gene:TP53 OR gene:BRCA1)',
    );
    expect(sent.searchParams.get('size')).toBe('1');
    expect(sent.searchParams.get('cursor')).toBe('cur-0');
    expect(page.totalResults).toBe(20420);
    expect(page.cursor).toBe('next-1');
    expect(page.proteins.map((p) => [p.accession, p.proteinName, p.geneNames])).toEqual([
      ['P04637', 'Cellular tumor antigen p53', ['TP53', 'P53']],
    ]);
  });

  it('lists a terminal proteome page with the default page size and no cursor', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [] }, { 'x-total-results': '0' }),
    );

    const page = await service.getProteomeProteins('UP000005640', {}, ctx());

    const sent = new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0]));
    expect(sent.searchParams.get('query')).toBe('proteome:UP000005640');
    expect(sent.searchParams.get('size')).toBe('25');
    expect(sent.searchParams.has('cursor')).toBe(false);
    expect(page).toEqual({ proteins: [], totalResults: 0 });
  });
});

describe('UniProtService — taxonomy records', () => {
  /**
   * `/taxonomy/9606?format=json` as rest.uniprot.org returned it (captured
   * 2026-10-12), with `lineage` cut to its last three ancestors, `otherNames`
   * to three, and the `links`/`statistics` blocks dropped.
   */
  const rawHuman = {
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    taxonId: 9606,
    mnemonic: 'HUMAN',
    parent: { scientificName: 'Homo', taxonId: 9605 },
    rank: 'species',
    hidden: false,
    active: true,
    otherNames: ['Homo sapiens Linnaeus, 1758', 'human', 'Home sapiens'],
    lineage: [
      {
        scientificName: 'Hominidae',
        commonName: 'great apes',
        taxonId: 9604,
        rank: 'family',
        hidden: false,
      },
      { scientificName: 'Homininae', taxonId: 207598, rank: 'subfamily', hidden: true },
      { scientificName: 'Homo', taxonId: 9605, rank: 'genus', hidden: false },
    ],
  };
  const human = {
    taxonId: 9606,
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    mnemonic: 'HUMAN',
    rank: 'species',
    parent: { taxonId: 9605, scientificName: 'Homo' },
    lineage: [
      { taxonId: 9604, scientificName: 'Hominidae', commonName: 'great apes', rank: 'family' },
      { taxonId: 207598, scientificName: 'Homininae', rank: 'subfamily' },
      { taxonId: 9605, scientificName: 'Homo', rank: 'genus' },
    ],
    otherNames: ['Homo sapiens Linnaeus, 1758', 'human', 'Home sapiens'],
  };

  it('getTaxonById normalizes the full record: names, rank, parent, lineage, other names', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse(rawHuman));
    await expect(service.getTaxonById(9606, ctx())).resolves.toEqual(human);
    expect(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).toBe(
      'https://rest.uniprot.org/taxonomy/9606?format=json',
    );
  });

  it('getTaxonByName returns the first search match, normalized', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [rawHuman] }));
    await expect(service.getTaxonByName('Homo sapiens', ctx())).resolves.toEqual(human);
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
