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
import biophysicochemicalRows from '../fixtures/biophysicochemical.json' with { type: 'json' };
import p00533Sections from '../fixtures/p00533-sections.json' with { type: 'json' };
import p04637Sections from '../fixtures/p04637-sections.json' with { type: 'json' };
import p07477Default from '../fixtures/p07477-default.json' with { type: 'json' };
import qualifiedComments from '../fixtures/qualified-comments.json' with { type: 'json' };
import sectionRows from '../fixtures/section-rows.json' with { type: 'json' };
import {
  activeRawEntry,
  expectMcpError,
  type FeatureLocationAccession,
  featureLocationRow,
  INACTIVE_STUBS,
  RAW_ENTRIES,
  RAW_HUMAN_PROTEOME,
  RAW_PROTEOMES,
  RAW_SEARCH_FACETS,
  RAW_SNIPPET_ROWS,
  rejectUnmockedFetch,
  required,
  TWO_TEXT_BIOPHYSICOCHEMICAL_ROW,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

const fetchWithTimeoutMock = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) =>
      String(args[0]).includes('/idmapping/details/')
        ? Promise.resolve(Response.json({ to: 'PDB' }))
        : fetchWithTimeoutMock(...args),
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
    expect(err.message).toBe('No reference proteome found for taxon 99999999.');
  });

  it('names a missing UPID without calling it a reference proteome', async () => {
    // A UPID can name a non-reference or excluded proteome, so its miss says only that no proteome has it.
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const err = await expectMcpError(service.getProteome({ upid: 'UP000000000' }, ctx()));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No proteome found for UPID UP000000000.');
    expect(err.data).toMatchObject({ upid: 'UP000000000' });
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
      expect(sentUrl.searchParams.get('query')).toContain(`(${sent})`);
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
      service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, 100, ctx()),
    );
    assertLeakFree(err);
  });

  it('resumeMapping (ticket poll): a 503 on the first status check is re-thrown clean', async () => {
    // A caller's ticket that never answered a status check has not shown the job exists.
    fetchWithTimeoutMock.mockRejectedValueOnce(
      frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503),
    );
    assertLeakFree(await expectMcpError(service.resumeMapping('job-1', 100, ctx())));
  });

  it('mapIds (results poll): a 503 on the status check after submission keeps the job as running', async () => {
    fetchWithTimeoutMock
      // POST /idmapping/run → ok
      .mockResolvedValueOnce(jsonResponse({ jobId: 'job-1' }))
      // GET /idmapping/status/job-1 → 503 framework error
      .mockRejectedValueOnce(frameworkError(JsonRpcErrorCode.ServiceUnavailable, 503));
    await expect(
      service.mapIds('Gene_Name', 'UniProtKB-Swiss-Prot', ['TP53'], 9606, 100, ctx()),
    ).resolves.toEqual({ status: 'running', ticket: 'job-1', statusCheckFailed: true });
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
      () => service.mapIds('PDB', 'Gene_Name', ['1TUP'], undefined, 100, ctx()),
      "The combination of 'from=PDB' and 'to=Gene_Name' parameters is invalid",
    ],
  ])(
    '%s — a 400 relays UniProt messages[] as InvalidParams with no data',
    async (_case, body, call, relayed) => {
      upstreamReplies(upstreamResponse(400, body, 'Bad Request'));
      const err = await expectMcpError(call());
      expect(err.code).toBe(
        _case.startsWith('mapIds')
          ? JsonRpcErrorCode.ValidationError
          : JsonRpcErrorCode.InvalidParams,
      );
      expect(err.message).toBe(`UniProt rejected the request: ${relayed}`);
      expect(err.data).toEqual(
        _case.startsWith('mapIds') ? { reason: 'unsupported_db_pair' } : undefined,
      );
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

describe('UniProtService — bounded function snippet (#36)', () => {
  /** Search one page whose hits carry these first FUNCTION texts, in order; return each hit's snippet. */
  async function snippets(...texts: string[]): Promise<(string | undefined)[]> {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: texts.map((value, i) => ({
          primaryAccession: `P${10_000 + i}`,
          uniProtkbId: `T${i}_HUMAN`,
          entryType: 'UniProtKB reviewed (Swiss-Prot)',
          sequence: { length: 100 },
          organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
          comments: [{ commentType: 'FUNCTION', texts: [{ value }] }],
        })),
      }),
    );
    const page = await service.search('x', {}, ctx());
    return page.results.map((hit) => hit.functionSnippet);
  }

  /** Runs the sentence it follows past 250 characters, so only what precedes that sentence qualifies. */
  const LONG_TAIL = ` ${'continues with '.repeat(20)}more. Next sentence.`;

  it('returns a stripped first FUNCTION text of at most 250 characters whole', async () => {
    const text = `Acts as a kinase. Binds ATP. ${'Phosphorylates substrates. '.repeat(7)}Ends here`;
    expect(text.length).toBeLessThanOrEqual(250);
    const exactly250 = `Acts as a kinase. ${'x'.repeat(232)}`;
    expect(exactly250).toHaveLength(250);
    expect(await snippets(text, exactly250)).toEqual([text, exactly250]);
  });

  it('returns whole sentences while the snippet stays within 250 characters', async () => {
    const sentence = (n: number) => `Sentence ${n} ${'y'.repeat(88)}.`;
    expect(sentence(1)).toHaveLength(100);
    const text = `${sentence(1)} ${sentence(2)} ${sentence(3)}`;
    expect(await snippets(text)).toEqual([`${sentence(1)} ${sentence(2)}`]);
  });

  it('returns a first sentence of 251 to 400 characters whole, even past 250', async () => {
    const first = `Mediates ${'z'.repeat(290)}.`;
    expect(first).toHaveLength(300);
    expect(await snippets(`${first} Then more text follows.`)).toEqual([first]);
  });

  it('returns a single sentence of at most 400 characters with no end inside it whole', async () => {
    const text = `Mediates ${'z'.repeat(300)} without a sentence end`;
    expect(text.length).toBeLessThanOrEqual(400);
    expect(await snippets(text)).toEqual([text]);
  });

  it.each([
    [
      'cuts at the last space within 400 and drops a trailing comma',
      `${'x'.repeat(397)}, ${'z'.repeat(60)}. Next sentence.`,
      `${'x'.repeat(397)}…`,
    ],
    [
      'drops a trailing semicolon or colon the same way',
      `${'x'.repeat(390)}; a: ${'z'.repeat(60)}. Next sentence.`,
      `${'x'.repeat(390)}; a…`,
    ],
    [
      'cuts at a space at character 400 to the 401-character maximum',
      `${'x'.repeat(400)} ${'z'.repeat(60)}. Next sentence.`,
      `${'x'.repeat(400)}…`,
    ],
    [
      'cuts a 400-character run with no space at 400',
      `${'x'.repeat(500)}. Next sentence.`,
      `${'x'.repeat(400)}…`,
    ],
  ])('a first sentence over 400 characters %s', async (_case, text, expected) => {
    const [snippet] = await snippets(text);
    expect(snippet).toBe(expected);
    expect(snippet?.length).toBeLessThanOrEqual(401);
  });

  it.each([
    ['Requires Mg(2+).', ' Binds substrate'],
    ['(Microbial infection) Acts as a receptor for HCV.', ' Mediates entry'],
    ['Binds 2 Zn(2+) ions per subunit.', " 2',3'-cGAMP is a product"],
    ['Activates the kinase.', ' (In vitro) Binds Y'],
    ['Binds divalent cations (e.g. Ca(2+), Mg(2+)).', ' Required for X'],
    ['Apo(a) is the main constituent of lipoprotein(a) (Lp(a)).', ' It has activity'],
    ['Cleaves after Arg (EC 3.4.21.4) in substrates.', ' Next sentence'],
    ['Cleaves at EC 3.4.21.4 sites in substrates.', ' Next sentence'],
    ['Hydrolyzes peptides, e.g. Leu-enkephalin.', ' Also cleaves X'],
    ['Converts substrate i.e. ATP to ADP.', ' Next sentence'],
    ['Uses ATP, GTP, etc. Other nucleotides are poor substrates.', ' Next sentence'],
    ['Retains approx. 30% of wild-type activity.', ' Required for Y'],
    ['Binds ca. 2 ions per subunit.', ' Next sentence'],
    ['Resembles the cf. Smith model.', ' Next sentence'],
    ['Acts vs. Gram-negative bacteria.', ' Next sentence'],
    ['Reported by Smith et al. In vitro it binds zinc.', ' Next sentence'],
    ['Isolated from Bacillus sp. Strain 168 produces it.', ' Next sentence'],
    ['Found in Streptomyces spp. Most strains secrete it.', ' Next sentence'],
    ['Binds copper and zinc, resp. Both are required.', ' Next sentence'],
    ['Acts on S. Typhimurium effectors.', ' Next sentence'],
    ['Protein kinase. cAMP-dependent activation follows.', ' Next sentence'],
    ['Signals with insulin-like growth factor I receptor/IGF1R.', ' Mediates uptake'],
    ['Signal activation necessitates an association with IL6ST.', ' Activation leads to X'],
    ['Binds the platelet-surface receptor complex GPIb-IX-V.', ' Also binds collagen'],
    ['Forms a complex with ARID5B.', ' Mediates demethylation'],
  ])('ends the first sentence of %j where it ends', async (first, rest) => {
    expect(await snippets(`${first}${rest}${LONG_TAIL}`)).toEqual([first]);
  });

  /** Carries a first sentence past 250 characters with no period of its own. */
  const FILLER = ' and related substrates'.repeat(10);

  it.each([
    ['e.g.', `Hydrolyzes peptides, e.g. Leu-enkephalin,${FILLER}.`],
    ['a decimal EC number', `Cleaves after Arg in EC 3.4.21.4 sites${FILLER}.`],
    ['a single capital initial', `Acts on S. Typhimurium effectors${FILLER}.`],
    ['a period inside parentheses', `Binds divalent cations (e.g. Ca(2+). Mg(2+))${FILLER}.`],
  ])('keeps a first sentence past 250 characters whole across %s', async (_case, first) => {
    // Only a sentence past 250 characters shows a false end inside it: one within 250 is extended past it.
    expect(first.length).toBeGreaterThan(250);
    expect(first.length).toBeLessThanOrEqual(400);
    expect(await snippets(`${first} Next sentence.`)).toEqual([first]);
  });

  it.each([
    [
      'a 250-character text with an inner sentence end is returned whole',
      `Acts as a kinase. Binds ${'x'.repeat(226)}`,
      250,
      `Acts as a kinase. Binds ${'x'.repeat(226)}`,
    ],
    [
      'a 251-character text is cut to its whole sentences',
      `Acts as a kinase. Binds ${'x'.repeat(227)}`,
      251,
      'Acts as a kinase.',
    ],
    [
      'a sentence ending exactly at character 250 is kept',
      `Sentence one ${'y'.repeat(85)}. Sentence two ${'z'.repeat(136)}. Then more text follows.`,
      274,
      `Sentence one ${'y'.repeat(85)}. Sentence two ${'z'.repeat(136)}.`,
    ],
    [
      'a 400-character first sentence is kept whole, with no ellipsis',
      `Mediates ${'z'.repeat(390)}. Then more text follows.`,
      424,
      `Mediates ${'z'.repeat(390)}.`,
    ],
    [
      'a 400-character text with no sentence end is returned whole',
      `Mediates ${'z'.repeat(300)} ${'w'.repeat(90)}`,
      400,
      `Mediates ${'z'.repeat(300)} ${'w'.repeat(90)}`,
    ],
  ])('pins the snippet bounds: %s', async (_case, text, length, expected) => {
    expect(text).toHaveLength(length);
    expect(await snippets(text)).toEqual([expected]);
  });

  it('strips every evidence tag kind and the whitespace before it, keeping other parentheticals', async () => {
    expect(
      await snippets(
        'Acts as a tumor suppressor (PubMed:11025664).',
        'Binds ligands (PubMed:10805725, PubMed:12297050). Includes EGF (By similarity). A role (Probable) in X (UniProtKB:P12345). Seen (Ref.3) here',
        'Binds DNA  \n (PubMed:1). Binds Ca(2+) (in vitro) as well',
        '(PubMed:1) Binds DNA.',
        'Binds DNA (PubMed:1',
        'Binds DNA (PubMed:1 (see text)) as shown',
        'Seen (Ref.12) and (Ref.345, Ref.6) here',
        'Seen (Ref.x) here',
        'Seen (Ref.12345',
      ),
    ).toEqual([
      'Acts as a tumor suppressor.',
      'Binds ligands. Includes EGF. A role in X. Seen here',
      'Binds DNA. Binds Ca(2+) (in vitro) as well',
      'Binds DNA.',
      'Binds DNA (PubMed:1',
      'Binds DNA (PubMed:1 (see text)) as shown',
      'Seen and here',
      'Seen (Ref.x) here',
      'Seen (Ref.12345',
    ]);
  });

  it('strips evidence before sizing the snippet', async () => {
    const first = `Mediates ${'z'.repeat(230)}`;
    const tagged = `${first} (PubMed:12345678, PubMed:23456789, PubMed:34567890). Next ${'w'.repeat(200)}.`;
    expect(await snippets(tagged)).toEqual([`${first}.`]);
  });

  it('omits the snippet when the FUNCTION text is only evidence', async () => {
    expect(await snippets('(By similarity)')).toEqual([undefined]);
  });
});

describe('UniProtService — the molecule behind a function snippet (#45)', () => {
  /** One search page over these rows; each hit's snippet and its molecule, by accession. */
  async function snippetsOf(...rows: object[]) {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: rows }));
    const page = await service.search('x', {}, ctx());
    return page.results.map((hit) => ({
      accession: hit.accession,
      ...(hit.functionSnippet !== undefined ? { functionSnippet: hit.functionSnippet } : {}),
      ...(hit.functionSnippetMolecule !== undefined
        ? { functionSnippetMolecule: hit.functionSnippetMolecule }
        : {}),
    }));
  }

  it('names the molecule a first FUNCTION comment is about beside its unchanged snippet', async () => {
    expect(
      await snippetsOf(RAW_SNIPPET_ROWS.P01275, RAW_SNIPPET_ROWS.P00747, RAW_SNIPPET_ROWS.P04637),
    ).toStrictEqual([
      {
        accession: 'P01275',
        // Three whole sentences ending at exactly 250 characters.
        functionSnippet:
          'Plays a key role in glucose metabolism and homeostasis. Regulates blood glucose by increasing gluconeogenesis and decreasing glycolysis. A counterregulatory hormone of insulin, raises plasma glucose levels in response to insulin-induced hypoglycemia.',
        functionSnippetMolecule: 'Glucagon',
      },
      {
        accession: 'P00747',
        // Still the first FUNCTION comment's text, not the later unqualified one.
        functionSnippet:
          'Protease which primary function is to degrade fibrin, the main component of blood clots. Also cleaves other components of blood clots like thrombospondin-1/THBS1 and von Willebrand factor (VWF).',
        functionSnippetMolecule: 'Plasmin',
      },
      {
        accession: 'P04637',
        functionSnippet:
          'Multifunctional transcription factor that induces cell cycle arrest, DNA repair or apoptosis upon binding to its target DNA sequence.',
      },
    ]);
  });

  it('takes the molecule from the snippet’s own FUNCTION comment, never a later one that names one', async () => {
    /**
     * P05067 under the default search projection (UniProt release 2026_04, captured
     * 2026-11-23), cut to its first three FUNCTION comments, each text to its first
     * sentence: the first two name no molecule, the third is about Amyloid-beta protein 42.
     */
    const app = {
      entryType: 'UniProtKB reviewed (Swiss-Prot)',
      primaryAccession: 'P05067',
      uniProtkbId: 'A4_HUMAN',
      annotationScore: 5.0,
      organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
      proteinExistence: '1: Evidence at protein level',
      proteinDescription: {
        recommendedName: { fullName: { value: 'Amyloid-beta precursor protein' } },
        flag: 'Precursor',
      },
      genes: [{ geneName: { value: 'APP' } }],
      comments: [
        {
          commentType: 'FUNCTION',
          texts: [
            {
              value:
                'Functions as a cell surface receptor and performs physiological functions on the surface of neurons relevant to neurite growth, neuronal adhesion and axonogenesis.',
            },
          ],
        },
        {
          commentType: 'FUNCTION',
          texts: [
            {
              value:
                'Amyloid-beta peptides are lipophilic metal chelators with metal-reducing activity.',
            },
          ],
        },
        {
          commentType: 'FUNCTION',
          molecule: 'Amyloid-beta protein 42',
          texts: [{ value: 'More effective reductant than amyloid-beta protein 40.' }],
        },
      ],
      sequence: { length: 770 },
    };
    expect(await snippetsOf(app)).toStrictEqual([
      {
        accession: 'P05067',
        functionSnippet:
          'Functions as a cell surface receptor and performs physiological functions on the surface of neurons relevant to neurite growth, neuronal adhesion and axonogenesis.',
      },
    ]);
  });

  it('omits the molecule with the snippet when the qualified text is only evidence, or there is no FUNCTION', async () => {
    const evidenceOnly = {
      ...RAW_SNIPPET_ROWS.P01275,
      comments: [
        { commentType: 'FUNCTION', molecule: 'Glucagon', texts: [{ value: '(By similarity)' }] },
      ],
    };
    const noFunction = { ...RAW_SNIPPET_ROWS.P00747, comments: [] };
    expect(await snippetsOf(evidenceOnly, noFunction)).toStrictEqual([
      { accession: 'P01275' },
      { accession: 'P00747' },
    ]);
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

  it("hands the caller's abort signal to the batch fetch", async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [] }));
    const controller = new AbortController();

    await service.getEntries(
      ['P04637'],
      undefined,
      createMockContext({ signal: controller.signal }),
    );

    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [, , , options] = required(fetchWithTimeoutMock.mock.calls[0], 'the batch fetch call');
    // Identity, not equality: every AbortSignal deep-equals every other.
    expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
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

    const result = await service.mapIds(
      'Gene_Name',
      'UniProtKB-Swiss-Prot',
      ['TP53'],
      9606,
      100,
      ctx(),
    );
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

    const result = await service.mapIds(
      'Gene_Name',
      'UniProtKB-Swiss-Prot',
      ['TP53'],
      9606,
      100,
      ctx(),
    );
    expect(result.status).toBe('finished');
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
    expect(String(fetchWithTimeoutMock.mock.calls[2]?.[0])).toContain(
      '/idmapping/uniprotkb/results/job-303',
    );
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

    const result = await service.mapIds(
      'Gene_Name',
      'UniProtKB-Swiss-Prot',
      ['TP53'],
      9606,
      100,
      ctx(),
    );
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
      250,
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
    expect(sentUrl.searchParams.get('size')).toBe('250');
  });

  it('returns an empty terminal page when a continuation is past the remaining rows', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ results: [], failedIds: [] }));

    const result = await service.resumeMappingPage(
      { jobId: 'job-pages', cursor: 'past-end' },
      100,
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

    const result = await service.resumeMappingPage({ jobId: 'job-p', cursor: 'CUR2' }, 37, ctx());
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
    // The re-read addresses the same page: the cursor and the page's own size.
    expect(reread.searchParams.get('size')).toBe('37');
    expect(new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).searchParams.get('size')).toBe(
      '37',
    );
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
        100,
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
    const result = await service.resumeMappingPage({ jobId: 'job-d', cursor: 'D' }, 100, ctx());
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
    const result = await service.resumeMappingPage({ jobId: 'job-h', cursor: 'H' }, 100, ctx());
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
      service.mapIds('PomBase', 'WormBase_Protein', ['x'], undefined, 100, ctx()),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('Invalid from/to combination');
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

    const result = await service.resumeMapping('job-1', 100, ctx());
    expect(result.status).toBe('finished');
    if (result.status === 'finished') {
      expect(result.results).toEqual([{ from: 'TP53', to: 'P04637' }]);
      expect(result.failedIds).toEqual(['ZZZNOTAREALGENE']);
    }
  });

  it('throws ServiceUnavailable naming "unknown" when the run submission returns neither jobId nor messages', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({}));
    const err = await expectMcpError(
      service.mapIds('Gene_Name', 'UniProtKB', ['TP53'], undefined, 100, ctx()),
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

      await service.mapIds('Gene_Name', 'UniProtKB', ['TP53', 'BRCA1'], taxId, 100, ctx());
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

      const pending = service.mapIds('Gene_Name', 'UniProtKB', ['TP53'], 9606, 100, ctx());
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
      expect(urls[4]).toContain('/idmapping/uniprotkb/results/job-slow');
    });

    it('returns the resumable ticket once the budget elapses with the job still running', async () => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ jobId: 'job-long' }))
        .mockImplementation(() => Promise.resolve(jsonResponse({ jobStatus: 'RUNNING' })));

      const pending = service.mapIds('Gene_Name', 'UniProtKB', ['TP53'], 9606, 100, ctx());
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

    it('stops polling and propagates the cancellation when the caller cancels between polls', async () => {
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
        100,
        createMockContext({ signal: controller.signal }),
      );
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(500);

      await assertion;
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('ticket polling (#50)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls a running ticket until FINISHED, pausing between checks, then reads the page', async () => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ jobStatus: 'RUNNING' }))
        .mockResolvedValueOnce(jsonResponse({ jobStatus: 'RUNNING' }))
        .mockResolvedValueOnce(jsonResponse({ jobStatus: 'FINISHED' }))
        .mockResolvedValueOnce(jsonResponse({ results: [{ from: 'TP53', to: '1TUP' }] }));

      const pending = service.resumeMapping('job-t', 100, ctx());
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toEqual({
        status: 'finished',
        results: [{ from: 'TP53', to: '1TUP' }],
        failedIds: [],
      });
      const paths = fetchWithTimeoutMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
      expect(paths).toEqual([
        '/idmapping/status/job-t',
        '/idmapping/status/job-t',
        '/idmapping/status/job-t',
        '/idmapping/results/job-t',
      ]);
    });

    it('returns running with its ticket once the same budget a submission gets elapses', async () => {
      fetchWithTimeoutMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ jobStatus: 'RUNNING' })),
      );

      const pending = service.resumeMapping('job-1', 100, ctx());
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await pending;

      expect(result.status).toBe('running');
      if (result.status === 'running') expect(result.ticket).toBe('job-1');
      // One check at t=0 and one after each 500 ms pause inside the 8 s default budget.
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(16);
    });

    it('stops a ticket poll on caller cancellation during the pause, with no further status request', async () => {
      const controller = new AbortController();
      fetchWithTimeoutMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ jobStatus: 'RUNNING' })),
      );

      const pending = service.resumeMapping(
        'job-t',
        100,
        createMockContext({ signal: controller.signal }),
      );
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
      controller.abort();
      await assertion;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    });
  });

  it('a status poll answered with an HTML page stays a clean ServiceUnavailable, not FINISHED', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      jsonResponse('<!DOCTYPE html><html><body>maintenance</body></html>'),
    );
    const err = await expectMcpError(service.resumeMapping('job-1', 100, ctx()));
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
      service.resumeMappingPage({ jobId: 'job-1', cursor: 'c1' }, 100, ctx()),
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
        alternativeNames: ['Phe-4-monooxygenase'],
        genes: ['PAH'],
        organism: {
          scientificName: 'Homo sapiens',
          commonName: 'Human',
          taxonId: 9606,
          mnemonic: 'HUMAN',
        },
        length: 452,
        reviewed: true,
        annotationScore: 5,
        proteinExistence: '1: Evidence at protein level',
        ecNumbers: ['1.14.16.1'],
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
            evidence: ['PubMed:18460651'],
          },
        ],
        cofactors: [{ name: 'Fe(2+)', chebiId: 'CHEBI:29033', evidence: ['UniProtKB:P04176'] }],
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
          { id: 'GO:0005829', term: 'cytosol', aspect: 'C', evidenceType: 'TAS:Reactome' },
          { id: 'GO:0005506', term: 'iron ion binding', aspect: 'F', evidenceType: 'IEA:InterPro' },
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
        ensemblGenes: ['ENSG00000171759.11'],
      },
    ]);
  });

  it('keeps synonyms, isoforms, and locations, and files a DISEASE comment that holds only a note under comments', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [RAW_ENTRIES.p53, RAW_ENTRIES.rhodopsin] }),
    );

    const { entries } = await service.getEntries(['P04637', 'P08100'], undefined, ctx());
    const [p53, rhodopsin] = entries;

    expect(p53?.genes).toEqual(['TP53', 'P53']);
    expect(p53?.subcellularLocation).toEqual([
      { location: 'Cytoplasm', evidence: ['PubMed:15340061'] },
      { location: 'Nucleus', evidence: ['PubMed:15340061'] },
    ]);
    expect(p53?.isoforms).toEqual([
      {
        isoformId: 'P04637-1',
        name: '1',
        synonyms: ['p53', 'p53alpha'],
        sequenceStatus: 'Displayed',
      },
      {
        isoformId: 'P04637-2',
        name: '2',
        synonyms: ['I9RET', 'p53beta'],
        sequenceStatus: 'Described',
      },
    ]);
    expect(p53?.disease).toEqual([
      {
        name: 'Esophageal cancer',
        diseaseId: 'DI-01537',
        acronym: 'ESCR',
        description: 'A malignancy of the esophagus.',
        omimId: '133239',
        note: 'The disease is caused by variants affecting the gene represented in this entry',
      },
    ]);
    expect(p53?.comments).toEqual([
      {
        type: 'DISEASE',
        value: 'TP53 is found in increased amounts in a wide variety of transformed cells',
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
    // The row's evidence is the location's own; the topology's (PubMed:19934218) stays out.
    expect(rhodopsin?.subcellularLocation).toEqual([
      {
        location: 'Photoreceptor outer segment membrane',
        topology: 'Multi-pass membrane protein',
        evidence: ['PubMed:25664179'],
      },
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

/**
 * UniProt's sequence flag, `proteinDescription.flag`: one comma-separated string that
 * arrives with `protein_name`. The values are as rest.uniprot.org sent them (release
 * 2026_04, captured 2026-11-23): O35116 "Fragment", P0DJE4 "Fragments", O75339
 * "Precursor", P13838 "Fragment,Precursor".
 */
describe('UniProtService — sequence flags (Fragment, Fragments, Precursor)', () => {
  const flagged = (accession: string, flag?: string) => ({
    ...activeRawEntry(accession, `${accession}_TEST`, 264),
    proteinDescription: {
      recommendedName: { fullName: { value: `Protein ${accession}` } },
      ...(flag !== undefined ? { flag } : {}),
    },
  });
  const rows = [
    flagged('O35116', 'Fragment'),
    flagged('P0DJE4', 'Fragments'),
    flagged('O75339', 'Precursor'),
    flagged('P13838', 'Fragment,Precursor'),
    flagged('P04637'),
  ];
  const expected = [
    ['O35116', ['Fragment']],
    ['P0DJE4', ['Fragments']],
    ['O75339', ['Precursor']],
    ['P13838', ['Fragment', 'Precursor']],
    ['P04637', undefined],
  ];

  it('splits the flag of each search hit and leaves an unflagged hit without one', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: rows }));
    const { results } = await service.search('x', {}, ctx());
    expect(results.map((hit) => [hit.accession, hit.sequenceFlags])).toEqual(expected);
    expect(results[4]).not.toHaveProperty('sequenceFlags');
    expect(results[0]?.length).toBe(264);
  });

  it('splits the flag of each entry and leaves an unflagged entry without one', async () => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: rows }));
    const { entries } = await service.getEntries(
      rows.map((row) => row.primaryAccession),
      undefined,
      ctx(),
    );
    expect(entries.map((entry) => [entry.accession, entry.sequenceFlags])).toEqual(expected);
    expect(entries[4]).not.toHaveProperty('sequenceFlags');
  });

  it('trims spaces around each flag and drops an empty flag string', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({
        results: [flagged('P13838', ' Fragment , Precursor '), flagged('O35116', '')],
      }),
    );
    const { results } = await service.search('x', {}, ctx());
    expect(results[0]?.sequenceFlags).toEqual(['Fragment', 'Precursor']);
    expect(results[1]).not.toHaveProperty('sequenceFlags');
  });
});

/**
 * Fixtures captured from rest.uniprot.org (release 2026_04, 2026-11-17); every
 * object keeps the shape UniProt sent, and only lists are cut.
 *
 * - `p07477-default.json`: P07477 (TRY1_HUMAN) as the default entry projection returns it.
 * - `p04637-sections.json`: P04637 with its 9 DISEASE comments, 1 MISCELLANEOUS comment, 6 of
 *   its 187 interaction rows (both whose interactantOne is an isoform), its DNA-binding
 *   region, 2 of its GO terms, and all 22 Ensembl transcripts.
 * - `p00533-sections.json`: P00533 with its membrane topology, ACTIVITY REGULATION comment,
 *   and the first 25 of its 200 interaction rows.
 * - `section-rows.json`: single rows — P69905's heme binding site with a ligand part,
 *   P07477's Tyr-154 mutagenesis, and the rows of P29972 (topology), P01308 and P00505
 *   (processing), P00327 (labelled ligands), P0A7V8 and P34110 (gene_names).
 */
describe('UniProtService — sites, processing, topology, comments, and interactions', () => {
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');
  const p04637 = required(p04637Sections.results[0], 'the P04637 fixture row');
  const p00533 = required(p00533Sections.results[0], 'the P00533 fixture row');

  /** Normalize raw rows as the batch search returns them. */
  async function normalize(...rows: object[]) {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: rows }));
    return (await service.getEntries(['P00000'], undefined, ctx())).entries;
  }

  it('files active, binding, and other sites under sites, each binding site with its ligand', async () => {
    const [entry] = await normalize(p07477);
    const calcium = { name: 'Ca(2+)', chebiId: 'CHEBI:29108' };
    const charge = (start: number) => ({
      type: 'Active site',
      description: 'Charge relay system',
      location: { start, end: start },
    });
    const binding = (start: number) => ({
      type: 'Binding site',
      location: { start, end: start },
      ligand: calcium,
    });
    expect(entry?.sites).toEqual([
      charge(63),
      charge(107),
      charge(200),
      binding(75),
      binding(77),
      binding(80),
      binding(85),
      { type: 'Site', description: 'Required for specificity', location: { start: 194, end: 194 } },
    ]);
  });

  it('keeps a ligand part, a ligand with no ChEBI id, and a labelled ligand with its note', async () => {
    const [hba, aatm, adh] = await normalize(
      { ...activeRawEntry('P69905', 'HBA_HUMAN'), features: [sectionRows.P69905BindingSite] },
      sectionRows.P00505,
      sectionRows.P00327,
    );
    expect(hba?.sites).toEqual([
      {
        type: 'Binding site',
        description: 'proximal binding residue',
        location: { start: 88, end: 88 },
        ligand: { name: 'heme b', chebiId: 'CHEBI:60344' },
        ligandPart: { name: 'Fe', chebiId: 'CHEBI:18248' },
      },
    ]);
    expect(aatm?.sites?.[0]).toEqual({
      type: 'Binding site',
      location: { start: 65, end: 65 },
      ligand: { name: 'substrate' },
    });
    expect(adh?.sites).toEqual([
      {
        type: 'Binding site',
        location: { start: 47, end: 47 },
        ligand: { name: 'Zn(2+)', chebiId: 'CHEBI:29105', label: '1', note: 'catalytic' },
      },
      {
        type: 'Binding site',
        location: { start: 98, end: 98 },
        ligand: { name: 'Zn(2+)', chebiId: 'CHEBI:29105', label: '2' },
      },
    ]);
  });

  it('files signal, transit, propeptide, chain, peptide, and initiator methionine under processing', async () => {
    const [insulin, aatm, cnr, trypsin] = await normalize(
      sectionRows.P01308,
      sectionRows.P00505,
      sectionRows.P29972,
      p07477,
    );
    expect(insulin?.processing).toEqual([
      { type: 'Signal', location: { start: 1, end: 24 } },
      {
        type: 'Peptide',
        description: 'Insulin B chain',
        location: { start: 25, end: 54 },
        featureId: 'PRO_0000015819',
      },
      {
        type: 'Propeptide',
        description: 'C peptide',
        location: { start: 57, end: 87 },
        featureId: 'PRO_0000015820',
      },
      {
        type: 'Peptide',
        description: 'Insulin A chain',
        location: { start: 90, end: 110 },
        featureId: 'PRO_0000015821',
      },
    ]);
    expect(aatm?.processing).toEqual([
      { type: 'Transit peptide', description: 'Mitochondrion', location: { start: 1, end: 29 } },
    ]);
    expect(cnr?.processing).toEqual([
      { type: 'Initiator methionine', description: 'Removed', location: { start: 1, end: 1 } },
    ]);
    expect(trypsin?.processing?.map((f) => f.type)).toEqual([
      'Signal',
      'Propeptide',
      'Chain',
      'Chain',
      'Chain',
    ]);
  });

  it('files topological domains, transmembrane, and intramembrane segments under topology', async () => {
    const [egfr, cnr] = await normalize(p00533, sectionRows.P29972);
    expect(egfr?.topology).toEqual([
      {
        type: 'Topological domain',
        description: 'Extracellular',
        location: { start: 25, end: 645 },
      },
      { type: 'Transmembrane', description: 'Helical', location: { start: 646, end: 668 } },
      {
        type: 'Topological domain',
        description: 'Cytoplasmic',
        location: { start: 669, end: 1210 },
      },
    ]);
    const counts = new Map<string, number>();
    for (const f of cnr?.topology ?? []) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      'Topological domain': 9,
      Transmembrane: 6,
      Intramembrane: 2,
    });
    expect(cnr?.topology?.find((f) => f.type === 'Intramembrane')).toEqual({
      type: 'Intramembrane',
      location: { start: 69, end: 82 },
    });
  });

  it('reads a mutagenesis row with its original and substituted residues', async () => {
    const [entry] = await normalize({
      ...activeRawEntry('P07477', 'TRY1_HUMAN'),
      features: [sectionRows.P07477Mutagenesis],
    });
    expect(entry?.mutagenesis).toEqual([
      {
        description: 'Lack of sulfation.',
        location: { start: 154, end: 154 },
        original: 'Y',
        variation: 'F',
      },
    ]);
  });

  it('files free-text comments by type with their evidence and molecule', async () => {
    const [trypsin, p53, egfr] = await normalize(p07477, p04637, p00533);
    expect(trypsin?.comments).toEqual([
      // The COFACTOR comment's note, in the comment order UniProt sent.
      { type: 'COFACTOR', value: 'Binds 1 Ca(2+) ion per subunit.' },
      { type: 'SUBUNIT', value: 'Interacts with SERPINA1', evidence: ['PubMed:11057674'] },
      {
        type: 'PTM',
        value:
          'Occurs in a single-chain form and a two-chain form, produced by proteolytic cleavage after Arg-122',
      },
      {
        type: 'PTM',
        value:
          "Sulfation at Tyr-154 increases selectivity towards basic versus apolar residues at the P2' position of inhibitors that bind in a substrate-like fashion. Although the increase in selectivity is relatively small, it may facilitate digestion of a broader range of dietary proteins",
        evidence: ['PubMed:25010489'],
      },
    ]);
    expect(p53?.comments).toEqual([
      {
        type: 'DISEASE',
        value: p04637.comments[0]?.note?.texts[0]?.value,
      },
      {
        type: 'MISCELLANEOUS',
        molecule: 'Isoform 2',
        value:
          'Expressed in quiescent lymphocytes. Seems to be non-functional. May be produced at very low levels due to a premature stop codon in the mRNA, leading to nonsense-mediated mRNA decay',
        evidence: ['ECO:0000305'],
      },
    ]);
    expect(egfr?.comments?.map((c) => c.type)).toEqual(['ACTIVITY REGULATION']);
    expect(egfr?.comments?.[0]?.evidence).toHaveLength(6);
  });

  it('files every free-text comment type under comments, one row per text', async () => {
    // UniProtKB's free-text comment types: each one's content is texts[].
    const FREE_TEXT_TYPES = [
      'ACTIVITY REGULATION',
      'ALLERGEN',
      'BIOTECHNOLOGY',
      'CAUTION',
      'DEVELOPMENTAL STAGE',
      'DISRUPTION PHENOTYPE',
      'DOMAIN',
      'INDUCTION',
      'MISCELLANEOUS',
      'PATHWAY',
      'PHARMACEUTICAL',
      'POLYMORPHISM',
      'PTM',
      'SIMILARITY',
      'SUBUNIT',
      'TISSUE SPECIFICITY',
      'TOXIC DOSE',
    ];
    const [entry] = await normalize({
      ...activeRawEntry('P00000', 'TEST_HUMAN'),
      comments: FREE_TEXT_TYPES.map((commentType) => ({
        commentType,
        texts: [{ value: `${commentType} text` }],
      })),
    });
    expect(entry?.comments).toEqual(
      FREE_TEXT_TYPES.map((type) => ({ type, value: `${type} text` })),
    );
  });

  it('keeps every named disease with its involvement note, the note-only comment going to comments', async () => {
    const [p53] = await normalize(p04637);
    expect(p53?.disease).toHaveLength(8);
    expect(p53?.disease?.[0]).toEqual({
      name: 'Esophageal cancer',
      diseaseId: 'DI-01537',
      acronym: 'ESCR',
      description: p04637.comments[1]?.disease?.description,
      omimId: '133239',
      note: 'The disease is caused by variants affecting the gene represented in this entry',
    });
    expect(p53?.disease?.map((d) => d.note)).toEqual([
      'The disease is caused by variants affecting the gene represented in this entry',
      'The disease is caused by variants affecting the gene represented in this entry',
      'The gene represented in this entry is involved in disease pathogenesis',
      'The disease is caused by variants affecting the gene represented in this entry',
      'The disease is caused by variants affecting the gene represented in this entry',
      'The disease is caused by variants affecting the gene represented in this entry',
      'Disease susceptibility is associated with variants affecting the gene represented in this entry',
      'The disease is caused by variants affecting the gene represented in this entry',
    ]);
  });

  it('reads interaction partners, naming this entry’s isoform when UniProt gives one', async () => {
    const [p53, egfr] = await normalize(p04637, p00533);
    expect(p53?.interactions).toEqual([
      { partner: 'P00519', gene: 'ABL1', experiments: 2 },
      { partner: 'Q13155', gene: 'AIMP2', experiments: 6 },
      { partner: 'Q7L7W2', experiments: 2 },
      { partner: 'P26663', partnerChain: 'PRO_0000037536', experiments: 9, organismDiffer: true },
      { partner: 'P17844', gene: 'DDX5', experiments: 2, isoform: 'P04637-1' },
      { partner: 'P17844', gene: 'DDX5', experiments: 2, isoform: 'P04637-7' },
    ]);
    expect(egfr?.interactions).toHaveLength(25);
    expect(egfr?.interactions?.[0]).toEqual({ partner: 'P00519', gene: 'ABL1', experiments: 3 });
    expect(egfr?.interactions?.every((i) => !('isoform' in i))).toBe(true);
  });

  it('reads EC numbers off the recommended name', async () => {
    const [trypsin, aatm] = await normalize(p07477, sectionRows.P00505);
    expect(trypsin?.ecNumbers).toEqual(['3.4.21.4']);
    expect(aatm?.ecNumbers).toEqual(['2.6.1.1', '2.6.1.7']);
  });

  it('keeps each GO term’s evidence type', async () => {
    const [p53] = await normalize(p04637);
    expect(p53?.goTerms).toEqual([
      { id: 'GO:0005813', term: 'centrosome', aspect: 'C', evidenceType: 'IDA:UniProtKB' },
      { id: 'GO:0000785', term: 'chromatin', aspect: 'C', evidenceType: 'IDA:BHF-UCL' },
    ]);
  });

  it('lists the distinct Ensembl genes beside the transcript ids xrefs.Ensembl keeps', async () => {
    const [p53, trypsin] = await normalize(p04637, p07477);
    expect(p53?.ensemblGenes).toEqual(['ENSG00000141510.20']);
    expect(p53?.xrefs?.Ensembl).toHaveLength(22);
    expect(p53?.xrefs?.Ensembl?.every((id) => id.startsWith('ENST'))).toBe(true);
    expect(trypsin?.ensemblGenes).toEqual(['ENSG00000204983.15', 'ENSG00000274247.4']);
  });

  it('omits every new key on a record without those annotations, rather than emitting empty lists', async () => {
    const [bare] = await normalize(activeRawEntry('C9JYS6', 'C9JYS6_HUMAN', 120));
    for (const key of [
      'alternativeNames',
      'ecNumbers',
      'sites',
      'processing',
      'topology',
      'mutagenesis',
      'comments',
      'interactions',
      'ensemblGenes',
    ]) {
      expect(bare).not.toHaveProperty(key);
    }
  });

  it('reads the organism mnemonic from the entry name, omitting it when the name carries none', async () => {
    const [trypsin, adh, stub] = await normalize(p07477, sectionRows.P00327, {
      ...activeRawEntry('A0A000', 'A0A000'),
    });
    expect(trypsin?.organism).toEqual({
      scientificName: 'Homo sapiens',
      commonName: 'Human',
      taxonId: 9606,
      mnemonic: 'HUMAN',
    });
    expect(adh?.organism.mnemonic).toBe('HORSE');
    expect(stub?.organism).not.toHaveProperty('mnemonic');
  });

  it('keeps the alternative protein names beside the recommended one', async () => {
    const [aatm, trypsin] = await normalize(sectionRows.P00505, p07477);
    expect(aatm?.proteinName).toBe('Aspartate aminotransferase, mitochondrial');
    expect(aatm?.alternativeNames).toEqual([
      'Fatty acid-binding protein',
      'Glutamate oxaloacetate transaminase 2',
      'Kynurenine aminotransferase 4',
      'Kynurenine aminotransferase IV',
      'Kynurenine--oxoglutarate transaminase 4',
      'Kynurenine--oxoglutarate transaminase IV',
      'Plasma membrane-associated fatty acid-binding protein',
      'Transaminase A',
    ]);
    expect(trypsin?.alternativeNames).toHaveLength(7);
  });
});

/**
 * The one location reader behind every feature-built section, over the rows in
 * `feature-locations.json` (see `featureLocationRow` in tests/helpers.ts). Locations
 * are compared strictly, so a key the normalizer should leave out fails the match.
 */
describe('UniProtService — feature location modifiers and isoform numbering (#46)', () => {
  /** Normalize the captured rows of these accessions, as the batch search returns them. */
  async function normalize(...accessions: FeatureLocationAccession[]) {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: accessions.map((a) => featureLocationRow(a)) }),
    );
    return (await service.getEntries(['P00000'], undefined, ctx())).entries;
  }

  it('keeps an UNSURE, OUTSIDE, or UNKNOWN bound with its modifier, and an exact one as start and end alone', async () => {
    const [cilp1, ctnd2, klk10, nchl1, gde] = await normalize(
      'O75339',
      'O35116',
      'O43240',
      'O00533',
      'P35573',
    );
    expect(cilp1?.processing?.map((f) => f.location)).toStrictEqual([
      { start: 1, end: 21 },
      { start: 22, end: 724, endModifier: 'UNSURE' },
      { start: 725, end: 1184, startModifier: 'UNSURE' },
    ]);
    expect(ctnd2?.processing?.map((f) => f.location)).toStrictEqual([
      { start: 1, end: 264, startModifier: 'OUTSIDE', endModifier: 'OUTSIDE' },
    ]);
    // UNKNOWN carries no position: the bound is absent, its modifier says why.
    expect(klk10?.ptms).toStrictEqual([
      { type: 'Disulfide bond', location: { end: 263, startModifier: 'UNKNOWN' } },
    ]);
    expect(nchl1?.processing?.map((f) => f.location)).toStrictEqual([
      { start: 25, endModifier: 'UNKNOWN' },
    ]);
    expect(gde?.domains).toStrictEqual([
      {
        type: 'Region',
        description: '4-alpha-glucanotransferase',
        location: { start: 1, endModifier: 'UNKNOWN' },
      },
      {
        type: 'Region',
        description: 'Amylo-1,6-glucosidase',
        location: { end: 1532, startModifier: 'UNKNOWN' },
      },
    ]);
  });

  it('names the isoform a position is numbered on, in PTMs, variants, and mutagenesis', async () => {
    const [kif2a, hykk, ogt1] = await normalize('O00139', 'A2RU49', 'O15294');
    const phosphoserine = (at: number) => ({
      type: 'Modified residue',
      description: 'Phosphoserine',
      location: { start: at, end: at, isoform: 'O00139-4' },
    });
    expect(kif2a?.ptms).toStrictEqual([phosphoserine(556), phosphoserine(573)]);
    expect(hykk?.variants).toStrictEqual([
      {
        description: 'in dbSNP:4380026',
        location: { start: 165, end: 165, isoform: 'A2RU49-2' },
        original: 'V',
        variation: 'I',
        featureId: 'VAR_082892',
      },
    ]);
    expect(ogt1?.mutagenesis?.map((m) => m.location)).toStrictEqual([
      { start: 10, end: 10, isoform: 'O15294-4' },
    ]);
  });

  it('carries the modifier through membrane topology and a binding site', async () => {
    const [adrb2, kap2] = await normalize('O70431', 'P05207');
    expect(adrb2?.topology?.map((f) => f.location)).toStrictEqual([
      { start: 1, end: 21, startModifier: 'OUTSIDE' },
      { start: 232, end: 251, endModifier: 'OUTSIDE' },
    ]);
    expect(kap2?.sites).toStrictEqual([
      {
        type: 'Binding site',
        location: { start: 82, end: 155, endModifier: 'OUTSIDE' },
        ligand: { name: "3',5'-cyclic AMP", chebiId: 'CHEBI:58165', label: '1' },
      },
    ]);
  });
});

/**
 * `qualified-comments.json`: default-projection rows captured from rest.uniprot.org (release
 * 2026_04, 2026-11-23), each cut to the comment types named here and each reaction's
 * cross-references to its Rhea id — P04637 (SUBCELLULAR LOCATION, COFACTOR, ALTERNATIVE
 * PRODUCTS), P68871 (FUNCTION), O14975 (FUNCTION, CATALYTIC ACTIVITY), P19367 (CATALYTIC
 * ACTIVITY), P00751 and P00918 (COFACTOR), O00165 (SUBCELLULAR LOCATION, ALTERNATIVE PRODUCTS),
 * and B3KU38 (ALTERNATIVE PRODUCTS).
 */
describe('UniProtService — molecule, row evidence, and comment notes (#45)', () => {
  const row = (accession: string) =>
    required(
      qualifiedComments.results.find((r) => r.primaryAccession === accession),
      `the ${accession} fixture row`,
    );
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');

  async function normalizeOne(raw: object) {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [raw] }));
    const { entries } = await service.getEntries(['P00000'], undefined, ctx());
    return required(entries[0], 'the normalized entry');
  }

  it('leaves molecule and evidence off the rows UniProt sends neither for', async () => {
    const trypsin = await normalizeOne(p07477);
    expect(trypsin.catalyticActivity).toEqual([
      { name: 'Preferential cleavage: Arg-|-Xaa, Lys-|-Xaa.', ecNumber: '3.4.21.4' },
    ]);
    expect(trypsin.cofactors).toEqual([{ name: 'Ca(2+)', chebiId: 'CHEBI:29108' }]);
    expect(trypsin.subcellularLocation).toEqual([{ location: 'Secreted, extracellular space' }]);
    expect(trypsin.function?.every((f) => !('molecule' in f))).toBe(true);
  });

  it('keeps each location’s molecule and its own evidence, filing every location note under comments', async () => {
    const p53 = await normalizeOne(row('P04637'));
    const isoformRows = (molecule: string, ...locations: string[]) =>
      locations.map((location) => ({ location, molecule }));
    expect(p53.subcellularLocation).toEqual([
      {
        location: 'Cytoplasm',
        evidence: [
          'PubMed:15340061',
          'PubMed:17170702',
          'PubMed:19011621',
          'PubMed:19033443',
          'PubMed:21597459',
          'PubMed:22726440',
          'PubMed:22914926',
          'PubMed:24625977',
          'PubMed:26634371',
        ],
      },
      {
        location: 'Nucleus',
        evidence: [
          'PubMed:15340061',
          'PubMed:17170702',
          'PubMed:17591690',
          'PubMed:18206965',
          'PubMed:19011621',
          'PubMed:21597459',
          'PubMed:22914926',
          'PubMed:24625977',
          'PubMed:26634371',
        ],
      },
      {
        location: 'Nucleus, PML body',
        evidence: ['PubMed:11025664', 'PubMed:12810724', 'PubMed:36108750'],
      },
      { location: 'Endoplasmic reticulum', evidence: ['PubMed:17170702'] },
      {
        location: 'Mitochondrion matrix',
        evidence: ['PubMed:22726440', 'PubMed:25168243', 'PubMed:27323408'],
      },
      {
        location: 'Cytoplasm, cytoskeleton, microtubule organizing center, centrosome',
        evidence: ['PubMed:28842590'],
      },
      { location: 'Nucleus', evidence: ['PubMed:23752197'], molecule: 'Isoform 1' },
      { location: 'Cytoplasm', molecule: 'Isoform 1' },
      ...isoformRows('Isoform 2', 'Nucleus', 'Cytoplasm'),
      ...isoformRows('Isoform 3', 'Nucleus', 'Cytoplasm'),
      ...isoformRows('Isoform 4', 'Nucleus', 'Cytoplasm'),
      ...isoformRows('Isoform 7', 'Nucleus', 'Cytoplasm'),
      ...isoformRows('Isoform 8', 'Nucleus', 'Cytoplasm'),
      ...isoformRows('Isoform 9', 'Cytoplasm'),
    ]);
    expect(p53.cofactors).toEqual([
      {
        name: 'Zn(2+)',
        chebiId: 'CHEBI:29105',
        evidence: [
          'PubMed:14534297',
          'PubMed:16793544',
          'PubMed:17015838',
          'PubMed:18650397',
          'PubMed:19515728',
          'PubMed:20142040',
          'PubMed:20364130',
        ],
      },
    ]);
    // One row per note text, in comment order: the COFACTOR note, then the unqualified location
    // note, then six isoform notes. Isoform 9's comment has no note, nor does ALTERNATIVE PRODUCTS.
    const isoformNote = (molecule: string, value: string) => ({
      type: 'SUBCELLULAR LOCATION',
      value,
      molecule,
    });
    expect(p53.comments).toEqual([
      {
        type: 'COFACTOR',
        value: 'Binds 1 zinc ion per subunit.',
        evidence: [
          'PubMed:14534297',
          'PubMed:16793544',
          'PubMed:17015838',
          'PubMed:18650397',
          'PubMed:19515728',
          'PubMed:20142040',
          'PubMed:20364130',
        ],
      },
      {
        type: 'SUBCELLULAR LOCATION',
        value:
          'Recruited into PML bodies together with CHEK2 (PubMed:12810724). Translocates to mitochondria upon oxidative stress (PubMed:22726440). Translocates to mitochondria in response to mitomycin C treatment (PubMed:27323408). Competitive inhibition of TP53 interaction with HSPA9/MOT-2 by UBXN2A results in increased protein abundance and subsequent translocation of TP53 to the nucleus (PubMed:24625977)',
        evidence: ['PubMed:12810724', 'PubMed:22726440', 'PubMed:24625977', 'PubMed:27323408'],
      },
      isoformNote(
        'Isoform 1',
        'Predominantly nuclear but localizes to the cytoplasm when expressed with isoform 4',
      ),
      isoformNote(
        'Isoform 2',
        'Localized mainly in the nucleus with minor staining in the cytoplasm',
      ),
      isoformNote(
        'Isoform 3',
        'Localized in the nucleus in most cells but found in the cytoplasm in some cells',
      ),
      isoformNote(
        'Isoform 4',
        'Predominantly nuclear but translocates to the cytoplasm following cell stress',
      ),
      isoformNote(
        'Isoform 7',
        'Localized mainly in the nucleus with minor staining in the cytoplasm',
      ),
      isoformNote(
        'Isoform 8',
        'Localized in both nucleus and cytoplasm in most cells. In some cells, forms foci in the nucleus that are different from nucleoli',
      ),
    ]);
  });

  it('keeps the molecule a FUNCTION text is about, and the evidence it already carried', async () => {
    const hbb = await normalizeOne(row('P68871'));
    expect(hbb.function).toEqual([
      {
        value: 'Involved in oxygen transport from the lung to the various peripheral tissues',
        evidence: ['PubMed:28066926'],
      },
      {
        value:
          'LVV-hemorphin-7 potentiates the activity of bradykinin, causing a decrease in blood pressure',
      },
      {
        value:
          'Functions as an endogenous inhibitor of enkephalin-degrading enzymes such as DPP3, and as a selective antagonist of the P2RX3 receptor which is involved in pain signaling, these properties implicate it as a regulator of pain and inflammation',
        molecule: 'Spinorphin',
      },
    ]);
  });

  it('keeps each reaction’s isoform and its own evidence', async () => {
    const fatp2 = await normalizeOne(row('O14975'));
    expect(fatp2.function?.map((f) => f.molecule)).toEqual([undefined, 'Isoform 1', 'Isoform 2']);
    expect(fatp2.function?.[2]).toEqual({
      value:
        'Exhibits long-chain fatty acids (LCFA) transport activity but lacks acyl CoA synthetase towards very long-chain fatty acids',
      evidence: ['PubMed:21768100'],
      molecule: 'Isoform 2',
    });
    const reactions = fatp2.catalyticActivity ?? [];
    expect(reactions.map((r) => [r.rheaId, r.molecule])).toEqual([
      ['RHEA:38879', 'Isoform 1'],
      ['RHEA:33655', 'Isoform 1'],
      ['RHEA:38879', 'Isoform 2'],
      ['RHEA:15421', 'Isoform 1'],
      ['RHEA:19713', 'Isoform 1'],
      ['RHEA:30751', 'Isoform 1'],
      ['RHEA:33607', 'Isoform 1'],
      ['RHEA:21380', 'Isoform 1'],
      ['RHEA:44936', 'Isoform 1'],
      ['RHEA:47264', 'Isoform 1'],
      ['RHEA:36139', undefined],
      ['RHEA:54536', 'Isoform 1'],
      ['RHEA:33639', 'Isoform 1'],
      ['RHEA:44932', 'Isoform 1'],
      ['RHEA:22976', 'Isoform 1'],
    ]);
    expect(reactions[2]).toEqual({
      name: 'a fatty acid(in) = a fatty acid(out)',
      rheaId: 'RHEA:38879',
      evidence: ['PubMed:21768100'],
      molecule: 'Isoform 2',
    });
    expect(reactions[10]).toEqual({
      name: '(E)-hexadec-2-enoate + ATP + CoA = (2E)-hexadecenoyl-CoA + AMP + diphosphate',
      rheaId: 'RHEA:36139',
      evidence: ['PubMed:24269233'],
    });

    const hk1 = await normalizeOne(row('P19367'));
    expect(hk1.catalyticActivity?.map((r) => [r.rheaId, r.evidence])).toEqual([
      ['RHEA:22740', ['PubMed:1637300', 'PubMed:27374331']],
      ['RHEA:16125', ['UniProtKB:P05708']],
      ['RHEA:17825', ['UniProtKB:P05708']],
      ['RHEA:11028', ['UniProtKB:P05708']],
      ['RHEA:10948', ['PubMed:27374331']],
    ]);
  });

  it('keeps each cofactor’s chain and its own evidence, filing a cofactor note under comments', async () => {
    const cfb = await normalizeOne(row('P00751'));
    expect(cfb.cofactors).toEqual([
      {
        name: 'Mg(2+)',
        chebiId: 'CHEBI:18420',
        evidence: [
          'PubMed:15068800',
          'PubMed:19503103',
          'PubMed:19574954',
          'PubMed:21205667',
          'PubMed:3638964',
        ],
        molecule: 'Complement factor B Bb',
      },
      {
        name: 'Mn(2+)',
        chebiId: 'CHEBI:29035',
        evidence: ['PubMed:15016353'],
        molecule: 'Complement factor B Bb',
      },
    ]);
    // A COFACTOR comment without a note adds no comments row.
    expect(cfb).not.toHaveProperty('comments');

    const ca2 = await normalizeOne(row('P00918'));
    expect(ca2.cofactors?.map((c) => [c.name, c.evidence?.length])).toEqual([
      ['Zn(2+)', 22],
      ['Co(2+)', 1],
    ]);
    expect(ca2.cofactors?.[0]?.evidence?.every((e) => e.startsWith('PubMed:'))).toBe(true);
    expect(ca2.comments).toEqual([
      {
        type: 'COFACTOR',
        value:
          'Zinc. Can also use cobalt(II) with lower efficiency, but not copper(II), nickel(II) and manganese(II).',
        evidence: ['PubMed:19583303'],
      },
    ]);
  });

  it('files each text of a multi-text note as its own row, with that text’s evidence and the comment’s molecule', async () => {
    const pubmedEvidence = (id: string) => [{ evidenceCode: 'ECO:0000269', source: 'PubMed', id }];
    const entry = await normalizeOne({
      ...activeRawEntry('P00000', 'TEST_HUMAN'),
      comments: [
        {
          commentType: 'COFACTOR',
          molecule: 'Isoform 2',
          cofactors: [{ name: 'Mg(2+)', evidences: pubmedEvidence('1') }],
          note: {
            texts: [
              { value: 'Binds 2 magnesium ions.', evidences: pubmedEvidence('2') },
              { value: 'Can also use manganese.' },
            ],
          },
        },
        { commentType: 'SUBCELLULAR LOCATION', note: { texts: [{ value: 'Note only.' }] } },
      ],
    });
    expect(entry.cofactors).toEqual([
      { name: 'Mg(2+)', evidence: ['PubMed:1'], molecule: 'Isoform 2' },
    ]);
    expect(entry.comments).toEqual([
      {
        type: 'COFACTOR',
        value: 'Binds 2 magnesium ions.',
        evidence: ['PubMed:2'],
        molecule: 'Isoform 2',
      },
      { type: 'COFACTOR', value: 'Can also use manganese.', molecule: 'Isoform 2' },
      { type: 'SUBCELLULAR LOCATION', value: 'Note only.' },
    ]);
    // A location comment that carries only a note leaves the section absent.
    expect(entry).not.toHaveProperty('subcellularLocation');
  });
});

describe('UniProtService — location orientation, alternative-products notes, and isoform synonyms', () => {
  const row = (accession: string) =>
    required(
      qualifiedComments.results.find((r) => r.primaryAccession === accession),
      `the ${accession} fixture row`,
    );

  async function normalizeOne(raw: object) {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [raw] }));
    const { entries } = await service.getEntries(['P00000'], undefined, ctx());
    return required(entries[0], 'the normalized entry');
  }

  it('keeps a location’s orientation after its topology, and only on the row that has one', async () => {
    const pex = await normalizeOne(row('O00165'));
    const locations = pex.subcellularLocation ?? [];
    expect(locations).toHaveLength(15);
    expect(locations.filter((l) => 'orientation' in l)).toEqual([
      {
        location: 'Cell membrane',
        topology: 'Peripheral membrane protein',
        orientation: 'Cytoplasmic side',
        evidence: ['PubMed:26997484'],
      },
    ]);
    expect(locations.filter((l) => 'topology' in l)).toHaveLength(1);
  });

  it('carries the location’s own evidence, never the topology’s or the orientation’s', async () => {
    const entry = await normalizeOne({
      ...activeRawEntry('P00000', 'TEST_HUMAN'),
      comments: [
        {
          commentType: 'SUBCELLULAR LOCATION',
          subcellularLocations: [
            {
              location: {
                value: 'Cell membrane',
                evidences: [{ evidenceCode: 'ECO:0000269', source: 'PubMed', id: '1' }],
              },
              topology: {
                value: 'Peripheral membrane protein',
                evidences: [{ evidenceCode: 'ECO:0000269', source: 'PubMed', id: '2' }],
              },
              orientation: {
                value: 'Cytoplasmic side',
                evidences: [{ evidenceCode: 'ECO:0000269', source: 'PubMed', id: '3' }],
              },
            },
            // UniProt can record an orientation without a topology.
            { location: { value: 'Membrane' }, orientation: { value: 'Extracellular side' } },
          ],
        },
      ],
    });
    expect(entry.subcellularLocation).toEqual([
      {
        location: 'Cell membrane',
        topology: 'Peripheral membrane protein',
        orientation: 'Cytoplasmic side',
        evidence: ['PubMed:1'],
      },
      { location: 'Membrane', orientation: 'Extracellular side' },
    ]);
  });

  it('files an ALTERNATIVE PRODUCTS note under comments and keeps each isoform’s synonyms', async () => {
    const pex = await normalizeOne(row('O00165'));
    expect(pex.comments?.filter((c) => c.type === 'ALTERNATIVE PRODUCTS')).toEqual([
      { type: 'ALTERNATIVE PRODUCTS', value: 'Additional isoforms seem to exist.' },
    ]);
    expect(pex.isoforms).toHaveLength(6);
    expect(pex.isoforms?.every((i) => !('synonyms' in i))).toBe(true);

    const schip = await normalizeOne(row('B3KU38'));
    expect(schip).not.toHaveProperty('comments');
    expect(schip.isoforms).toEqual([
      { isoformId: 'B3KU38-1', name: 'IQCJ-SCHIP1-1', sequenceStatus: 'Displayed' },
      { isoformId: 'B3KU38-2', name: 'IQCJ-SCHIP1-2', sequenceStatus: 'Described' },
      {
        isoformId: 'P0DPB3-1',
        name: 'SCHIP1-1',
        synonyms: ['SCHIP-1', 'SCHIP-1a'],
        sequenceStatus: 'External',
      },
      {
        isoformId: 'P0DPB3-2',
        name: 'SCHIP1-2',
        synonyms: ['SCHIP-1-D241/253'],
        sequenceStatus: 'External',
      },
      {
        isoformId: 'P0DPB3-3',
        name: 'SCHIP1-3',
        synonyms: ['SCHIP-1-D22/253'],
        sequenceStatus: 'External',
      },
      { isoformId: 'P0DPB3-4', name: 'SCHIP1-4', sequenceStatus: 'External' },
      { isoformId: 'Q1A5X6-1', name: 'IQCJ-1', sequenceStatus: 'External' },
      { isoformId: 'Q1A5X6-2', name: 'IQCJ-2', sequenceStatus: 'External' },
      { isoformId: 'Q1A5X6-3', name: 'IQCJ-3', sequenceStatus: 'External' },
    ]);
  });
});

/**
 * `biophysicochemical.json`: rows captured from rest.uniprot.org (release 2026_04, 2026-11-23)
 * with the identity fields and the five BIOPHYSICOCHEMICAL PROPERTIES return fields (kinetics,
 * ph_dependence, temp_dependence, redox_potential, absorption), each as UniProt sent it.
 */
describe('UniProtService — biophysicochemical properties (#47)', () => {
  const row = (accession: string) =>
    required(
      biophysicochemicalRows.results.find((r) => r.primaryAccession === accession),
      `the ${accession} fixture row`,
    );

  async function normalizeOne(raw: object) {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [raw] }));
    const { entries } = await service.getEntries(['P00000'], undefined, ctx());
    return required(entries[0], 'the normalized entry');
  }

  it('keeps every KM row with its own evidence, and the pH text with its evidence: P00918', async () => {
    const ca2 = await normalizeOne(row('P00918'));
    expect(ca2.biophysicochemical).toStrictEqual([
      {
        michaelisConstants: [
          {
            constant: 9.3,
            unit: 'mM',
            substrate: 'CO(2)',
            evidence: ['PubMed:4994926', 'PubMed:7761440'],
          },
          { constant: 11, unit: 'mM', substrate: 'CO(2)', evidence: ['PubMed:1909891'] },
          { constant: 8.2, unit: 'mM', substrate: 'CO(2)', evidence: ['PubMed:9398308'] },
          { constant: 82, unit: 'mM', substrate: 'H(2)CO(3)', evidence: ['PubMed:8262987'] },
          {
            constant: 2.9,
            unit: 'mM',
            substrate: '4-nitrophenyl acetate',
            evidence: ['PubMed:10550681'],
          },
        ],
        phDependence: [
          {
            value: 'Optimum pH is 6-8.',
            evidence: [
              'PubMed:15667203',
              'PubMed:17330962',
              'PubMed:18942852',
              'PubMed:8262987',
              'PubMed:9398308',
            ],
          },
        ],
      },
    ]);
    // The comment is its own section: nothing of it is filed under comments.
    expect(ca2).not.toHaveProperty('comments');
  });

  it('keeps a kinetics note, an absorption maximum with its evidence, and the pH and temperature texts: A9WGE2', async () => {
    const ccl = await normalizeOne(row('A9WGE2'));
    expect(ccl.biophysicochemical).toStrictEqual([
      {
        michaelisConstants: [
          {
            constant: 70,
            unit: 'uM',
            substrate: '(R)-citramalyl-CoA',
            evidence: ['PubMed:17259315'],
          },
        ],
        // UniProt sends this note without evidence, so it has none.
        kineticsNote: [
          { value: 'kcat is 1.7 sec(-1) for lyase activity with (R)-citramalyl-CoA as substrate.' },
        ],
        phDependence: [
          { value: 'Optimum pH is 7 (at 55 degrees Celsius).', evidence: ['PubMed:17259315'] },
        ],
        temperatureDependence: [
          { value: 'Optimum temperature is 55 degrees Celsius.', evidence: ['PubMed:17259315'] },
        ],
        // UniProt's approximate: false is omitted.
        absorption: { maxNm: 280, evidence: ['PubMed:17259315'] },
      },
    ]);
  });

  it('keeps a Vmax row with UniProt’s enzyme text, a redox potential, and an approximate absorption with its note', async () => {
    const fatp2 = await normalizeOne(row('O14975'));
    expect(fatp2.biophysicochemical).toStrictEqual([
      {
        michaelisConstants: [
          {
            constant: 12,
            unit: 'uM',
            substrate: 'hexadecanoate (palmitate)',
            evidence: ['PubMed:11980911'],
          },
        ],
        maximumVelocities: [
          {
            velocity: 1.4,
            unit: 'nmol/min/mg',
            enzyme: 'enzyme for hexadecanoyl-CoA (palmitoyl-CoA) synthesis',
            evidence: ['PubMed:11980911'],
          },
        ],
      },
    ]);

    const tmx3 = await normalizeOne(row('Q96JJ7'));
    expect(tmx3.biophysicochemical).toStrictEqual([
      { redoxPotential: [{ value: 'E(0) is -157 mV.', evidence: ['PubMed:15623505'] }] },
    ]);

    // The note, lifted beside the absorption, carries evidence; the absorption itself carries none.
    const lhca2 = await normalizeOne(row('Q9SYW8'));
    expect(lhca2.biophysicochemical).toStrictEqual([
      {
        absorption: { maxNm: 695, approximate: true },
        absorptionNote: [{ value: 'Emission maxima at 702 nm.', evidence: ['PubMed:11553743'] }],
      },
    ]);
  });

  it('returns one object per comment, in UniProt order, with molecule on the object only', async () => {
    const adk = await normalizeOne(row('P55263'));
    const objects = adk.biophysicochemical ?? [];
    expect(objects.map((b) => b.molecule)).toEqual([undefined, 'Isoform 1', 'Isoform 2']);
    expect(objects[0]).not.toHaveProperty('molecule');
    expect(objects[0]?.michaelisConstants).toHaveLength(5);
    expect(objects[0]?.kineticsNote).toEqual([
      {
        value:
          'kcat is 0.19 sec(-1) with adenosine as substrate. kcat is 0.28 sec(-1) with N(6)-methyladenosine (m6A) as substrate. kcat is 0.27 sec(-1) with N(6),N(6)-dimethyladenosine as substrate. kcat is 0.18 sec(-1) with N(6)-isopentenyladenosine (i6A) as substrate.',
      },
    ]);
    expect(objects[0]?.phDependence).toEqual([
      { value: 'Optimum pH is 6.5.', evidence: ['PubMed:6246102'] },
    ]);
    expect(objects[1]).toStrictEqual({
      molecule: 'Isoform 1',
      michaelisConstants: [
        { constant: 41, unit: 'nM', substrate: 'adenosine', evidence: ['PubMed:8577746'] },
        { constant: 0.13, unit: 'uM', substrate: 'ATP', evidence: ['PubMed:9070863'] },
      ],
    });
    expect(objects[2]).toStrictEqual({
      molecule: 'Isoform 2',
      michaelisConstants: [
        { constant: 0.12, unit: 'uM', substrate: 'ATP', evidence: ['PubMed:9070863'] },
      ],
    });

    const pde4b = await normalizeOne(row('Q07343'));
    expect(
      pde4b.biophysicochemical?.map((b) => [b.molecule, b.michaelisConstants?.length]),
    ).toEqual([
      ['Isoform PDE4B2', 2],
      ['Isoform PDE4B1', 1],
      ['Isoform PDE4B3', 1],
      ['Isoform PDE4B5', 1],
    ]);
  });

  it('keeps all 39 KM and 38 Vmax rows of the largest comment, each with its evidence: Q29550', async () => {
    const est1 = await normalizeOne(row('Q29550'));
    const [only] = est1.biophysicochemical ?? [];
    expect(est1.biophysicochemical).toHaveLength(1);
    expect(only?.michaelisConstants).toHaveLength(39);
    expect(only?.maximumVelocities).toHaveLength(38);
    const evidence = ['PubMed:16223870', 'PubMed:9490062', 'PubMed:9799112'];
    expect(only?.michaelisConstants?.at(0)).toEqual({
      constant: 27.5,
      unit: 'uM',
      substrate: 'retinyl palmitate',
      evidence,
    });
    expect(only?.michaelisConstants?.at(-1)).toEqual({
      constant: 8.81,
      unit: 'mM',
      substrate: 'VACV',
      evidence,
    });
    expect(only?.maximumVelocities?.at(0)).toEqual({
      velocity: 530,
      unit: 'nmol/h/mg',
      enzyme: 'enzyme with retinyl palmitate as substrate',
      evidence,
    });
    expect(only?.maximumVelocities?.at(-1)).toEqual({
      velocity: 0.03,
      unit: 'nmol/min/ug',
      enzyme: 'enzyme with CPT-11 as substrate',
      evidence,
    });
  });

  it('keeps both texts of every text part, in UniProt order, each with its own evidence', async () => {
    const entry = await normalizeOne(TWO_TEXT_BIOPHYSICOCHEMICAL_ROW);
    expect(entry.biophysicochemical).toStrictEqual([
      {
        kineticsNote: [
          { value: 'kcat is 1.7 sec(-1) for lyase activity with (R)-citramalyl-CoA as substrate.' },
          { value: 'kcat is 390 sec(-1) for NAD(+).', evidence: ['PubMed:7852410'] },
        ],
        phDependence: [
          { value: 'Optimum pH is 6.5.', evidence: ['PubMed:6246102'] },
          { value: 'Optimum pH is 7 (at 55 degrees Celsius).', evidence: ['PubMed:17259315'] },
        ],
        temperatureDependence: [
          { value: 'Thermostable.', evidence: ['PubMed:37708259'] },
          { value: 'Optimum temperature is 45 degrees Celsius.', evidence: ['PubMed:29326945'] },
        ],
        redoxPotential: [
          { value: 'E(0) is -157 mV.', evidence: ['PubMed:15623505'] },
          { value: 'E is 0 +/- 10 mV for 2Fe-2S at pH 7.5.', evidence: ['PubMed:19580816'] },
        ],
        absorption: { maxNm: 695, approximate: true },
        absorptionNote: [
          { value: 'Emission maxima at 702 nm.', evidence: ['PubMed:11553743'] },
          {
            value: 'Shoulder at 335 nm (at pH 7.5 and 30 degrees Celsius).',
            evidence: ['PubMed:22547782'],
          },
        ],
      },
    ]);
  });

  it('leaves off what UniProt does not send: row evidence, an absent maximum, an empty part, the section', async () => {
    const entry = await normalizeOne({
      ...activeRawEntry('P00000', 'TEST_HUMAN'),
      comments: [
        {
          commentType: 'BIOPHYSICOCHEMICAL PROPERTIES',
          molecule: 'Isoform 2',
          kineticParameters: {
            michaelisConstants: [{ constant: 1.97e-8, unit: 'M', substrate: 'X' }],
            maximumVelocities: [{ velocity: 0, unit: 'umol/min/mg', enzyme: 'enzyme toward X' }],
            note: { texts: [] },
          },
          // UniProt marks only a maximum approximate; with none, the flag has nothing to qualify,
          // and an absorption left with nothing but its note is that note alone.
          absorption: { approximate: true, note: { texts: [{ value: 'Broad band.' }] } },
        },
        {
          commentType: 'BIOPHYSICOCHEMICAL PROPERTIES',
          temperatureDependence: { texts: [{ value: 'Thermostable.' }] },
          absorption: {
            approximate: false,
            evidences: [{ evidenceCode: 'ECO:0000269', source: 'PubMed', id: '3' }],
          },
        },
      ],
    });
    expect(entry.biophysicochemical).toStrictEqual([
      {
        molecule: 'Isoform 2',
        michaelisConstants: [{ constant: 1.97e-8, unit: 'M', substrate: 'X' }],
        maximumVelocities: [{ velocity: 0, unit: 'umol/min/mg', enzyme: 'enzyme toward X' }],
        absorptionNote: [{ value: 'Broad band.' }],
      },
      {
        temperatureDependence: [{ value: 'Thermostable.' }],
        absorption: { evidence: ['PubMed:3'] },
      },
    ]);

    const p53 = await normalizeOne(RAW_ENTRIES.p53);
    expect(p53).not.toHaveProperty('biophysicochemical');
  });
});

describe('UniProtService — return fields the normalizers read (#34)', () => {
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');
  const p04637 = required(p04637Sections.results[0], 'the P04637 fixture row');
  const ecoliRpsD = {
    ...activeRawEntry('P0A7V8', 'RS4_ECOLI', 206),
    genes: sectionRows.P0A7V8.genes,
  };

  /** Normalize raw rows as the batch search returns them. */
  async function normalize(...rows: object[]) {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: rows }));
    return (await service.getEntries(['P00000'], undefined, ctx())).entries;
  }

  /** The `fields` parameter of the request the service sent. */
  function sentFields(): string | null {
    return new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).searchParams.get('fields');
  }

  it('sends the default projection with the types it once left out, and nothing on request', async () => {
    await normalize(p07477);
    const fields = sentFields()?.split(',');
    for (const field of ['ft_disulfid', 'ft_dna_bind', 'ft_coiled', 'xref_alphafolddb', 'cc_ptm'])
      expect(fields).toContain(field);
    for (const field of ['ft_mutagen', 'cc_interaction', 'xref_reactome'])
      expect(fields).not.toContain(field);
  });

  it('sends the identity columns alone for an empty projection, on entries and searches', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [] }, { 'x-total-results': '0' }),
    );
    await service.getEntries(['P07477'], '', ctx());
    await service.search('gene:PRSS1', { fields: '' }, ctx());
    const [entryUrl, searchUrl] = fetchWithTimeoutMock.mock.calls.map(
      ([url]) => new URL(String(url)),
    );
    expect(entryUrl?.searchParams.get('fields')).toBe(
      'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence',
    );
    expect(searchUrl?.searchParams.get('fields')).toBe(
      'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence',
    );
  });

  it('reads the default record’s disulfide bonds as PTMs', async () => {
    const [trypsin] = await normalize(p07477);
    expect(trypsin?.ptms?.filter((p) => p.type === 'Disulfide bond')).toEqual(
      [
        [30, 160],
        [48, 64],
        [139, 206],
        [171, 185],
        [196, 220],
      ].map(([start, end]) => ({ type: 'Disulfide bond', location: { start, end } })),
    );
  });

  it('lists ordered-locus and ORF names after each gene’s name and synonyms, on entries and search hits', async () => {
    const [rpsD, vps35] = await normalize(ecoliRpsD, sectionRows.P34110);
    expect(rpsD?.genes).toEqual(['rpsD', 'ramA', 'b3296', 'JW3258']);
    expect(vps35?.genes).toEqual(['VPS35', 'VPT7', 'YJL154C', 'J0580']);

    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [ecoliRpsD] }, { 'x-total-results': '1' }),
    );
    const page = await service.search('gene:rpsD', {}, ctx());
    expect(page.results[0]?.geneNames).toEqual(['rpsD', 'ramA', 'b3296', 'JW3258']);
  });

  it('reads a DNA-binding region and a coiled coil as domains', async () => {
    // P35579's coiled coil as rest.uniprot.org returned it (release 2026_04, captured 2026-11-17).
    const coiledCoil = {
      type: 'Coiled coil',
      location: {
        start: { value: 837, modifier: 'EXACT' },
        end: { value: 1926, modifier: 'EXACT' },
      },
      description: '',
      evidences: [{ evidenceCode: 'ECO:0000255' }],
    };
    const [p53, myh9] = await normalize(p04637, {
      ...activeRawEntry('P35579', 'MYH9_HUMAN', 1960),
      features: [coiledCoil],
    });
    expect(p53?.domains).toEqual([{ type: 'DNA binding', location: { start: 102, end: 292 } }]);
    expect(myh9?.domains).toEqual([{ type: 'Coiled coil', location: { start: 837, end: 1926 } }]);
  });

  it('keeps every cross-reference database the projection fetched except GO', async () => {
    const [trypsin] = await normalize(p07477);
    expect(Object.keys(trypsin?.xrefs ?? {}).sort()).toEqual([
      'AlphaFoldDB',
      'ChEMBL',
      'Ensembl',
      'GeneID',
      'HGNC',
      'InterPro',
      'MIM',
      'PDB',
      'Pfam',
      'RefSeq',
      'STRING',
    ]);
    expect(trypsin?.xrefs).toMatchObject({
      AlphaFoldDB: ['P07477'],
      HGNC: ['HGNC:9475'],
      MIM: ['167800', '276000'],
      GeneID: ['5644'],
      STRING: ['9606.ENSP00000308720'],
      Pfam: ['PF00089'],
    });
    expect(trypsin?.xrefs?.InterPro).toHaveLength(6);
    expect(trypsin?.goTerms).toHaveLength(6);
  });

  it('keeps a database the caller named beyond the default set', async () => {
    // P07477 under fields xref_reactome, as rest.uniprot.org returned it (release 2026_04, 2026-11-17).
    const reactome = (id: string, PathwayName: string) => ({
      database: 'Reactome',
      id,
      properties: [{ key: 'PathwayName', value: PathwayName }],
    });
    const [trypsin] = await normalize({
      ...activeRawEntry('P07477', 'TRY1_HUMAN', 247),
      uniProtKBCrossReferences: [
        reactome('R-HSA-1592389', 'Activation of Matrix Metalloproteinases'),
        reactome('R-HSA-9758881', 'Uptake of dietary cobalamins into enterocytes'),
        reactome('R-HSA-9925561', 'Developmental Lineage of Pancreatic Acinar Cells'),
      ],
    });
    expect(trypsin?.xrefs).toEqual({
      Reactome: ['R-HSA-1592389', 'R-HSA-9758881', 'R-HSA-9925561'],
    });
  });

  it('keys a database named like an Object prototype member as its own', async () => {
    const [entry] = await normalize({
      ...activeRawEntry('P07477', 'TRY1_HUMAN', 247),
      uniProtKBCrossReferences: [
        { database: 'constructor', id: 'c1' },
        { database: '__proto__', id: 'p1' },
        { database: 'constructor', id: 'c2' },
      ],
    });
    expect(Object.hasOwn(entry?.xrefs ?? {}, '__proto__')).toBe(true);
    expect(JSON.stringify(entry?.xrefs)).toBe('{"constructor":["c1","c2"],"__proto__":["p1"]}');
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
    cpdStatus: 'Unknown',
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

  it('discovers a unique descendant reference proteome only after the exact miss', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [RAW_HUMAN_PROTEOME] }));
    await expect(service.getProteome({ taxonId: 9605 }, ctx())).resolves.toMatchObject({
      upid: 'UP000005640',
    });
    expect(new URL(String(fetchWithTimeoutMock.mock.calls[1]?.[0])).searchParams.get('query')).toBe(
      '(taxonomy_id:9605) AND (reference:true)',
    );
  });

  it('discloses incomplete descendant candidates instead of choosing the first', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { results: [RAW_HUMAN_PROTEOME] },
          { link: '<https://rest.uniprot.org/proteomes/search?cursor=second>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { results: [{ ...RAW_HUMAN_PROTEOME, id: 'UP000000002' }] },
          { link: '<https://rest.uniprot.org/proteomes/search?cursor=third>; rel="next"' },
        ),
      );
    const error = await expectMcpError(service.getProteome({ taxonId: 9605 }, ctx()));
    expect(error.data).toMatchObject({ reason: 'ambiguous_proteome' });
    expect(error.message).toContain('UP000005640');
    expect(error.message).toContain('UP000000002');
    expect(error.message).toContain('cursor=third');
    expect(error.message).toContain('incomplete');
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
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

describe('UniProtService — proteome counts, CPD status, and exclusion reasons (#49)', () => {
  /** The fields #49 adds, as one normalized proteome carries them; an absent field stays absent. */
  const COUNT_KEYS = [
    'geneCount',
    'reviewedProteinCount',
    'unreviewedProteinCount',
    'isoformProteinCount',
    'cpdStatus',
    'exclusionReasons',
  ];
  const countsOf = (proteome: object) =>
    Object.fromEntries(Object.entries(proteome).filter(([key]) => COUNT_KEYS.includes(key)));
  const proteomeOf = (raw: object) => {
    fetchWithTimeoutMock.mockResolvedValue(jsonResponse({ results: [raw] }));
    return service.getProteome({ upid: 'UP000000001' }, ctx());
  };

  it('normalizes the human reference proteome with every count beside its proteinCount', async () => {
    await expect(proteomeOf(RAW_PROTEOMES.human)).resolves.toEqual({
      upid: 'UP000005640',
      proteomeType: 'Reference proteome',
      organism: {
        scientificName: 'Homo sapiens',
        commonName: 'Human',
        taxonId: 9606,
        mnemonic: 'HUMAN',
      },
      proteinCount: 263886,
      geneCount: 20652,
      reviewedProteinCount: 20414,
      unreviewedProteinCount: 243472,
      isoformProteinCount: 22131,
      cpdStatus: 'Outlier (high value)',
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
    });
  });

  it.each([
    [
      'E. coli K-12 reference: its real 0 unreviewed count stays',
      RAW_PROTEOMES.ecoli,
      {
        geneCount: 4403,
        reviewedProteinCount: 4403,
        unreviewedProteinCount: 0,
        isoformProteinCount: 12,
        cpdStatus: 'Close to standard (low value)',
      },
    ],
    [
      "non-reference: UniProt's 0 placeholders are omitted, the CPD status kept",
      RAW_PROTEOMES.nonReference,
      { cpdStatus: 'Close to standard (low value)' },
    ],
    [
      'excluded: placeholders omitted, its exclusion reasons kept',
      RAW_PROTEOMES.excluded,
      { cpdStatus: 'Outlier (low value)', exclusionReasons: ['genome length too small'] },
    ],
    [
      'excluded for three reasons: every reason kept, in UniProt’s order',
      /**
       * UP000003488 as `/proteomes/search?query=proteome_type:EXCLUDED` returned it
       * (UniProt release 2026_04, captured 2026-11-23), cut to the fields the service reads.
       */
      {
        id: 'UP000003488',
        taxonomy: {
          scientificName: 'Shigella flexneri 1235-66',
          taxonId: 766154,
          mnemonic: 'SHIFL',
        },
        proteomeType: 'Excluded',
        proteinCount: 10313,
        geneCount: 0,
        proteomeStatistics: {
          reviewedProteinCount: 0,
          unreviewedProteinCount: 0,
          isoformProteinCount: 0,
        },
        proteomeCompletenessReport: { cpdReport: { status: 'Outlier (high value)' } },
        genomeAssembly: { assemblyId: 'GCA_000268065.1' },
        exclusionReasons: ['mixed culture', 'genome length too large', 'contaminated'],
      },
      {
        cpdStatus: 'Outlier (high value)',
        exclusionReasons: ['mixed culture', 'genome length too large', 'contaminated'],
      },
    ],
    [
      'reviewed 0 beside a non-zero unreviewed count: all three statistics stay',
      {
        ...RAW_PROTEOMES.ecoli,
        proteomeStatistics: {
          reviewedProteinCount: 0,
          unreviewedProteinCount: 4403,
          isoformProteinCount: 0,
        },
      },
      {
        geneCount: 4403,
        reviewedProteinCount: 0,
        unreviewedProteinCount: 4403,
        isoformProteinCount: 0,
        cpdStatus: 'Close to standard (low value)',
      },
    ],
    [
      'a sparse record with no geneCount, proteomeStatistics, or cpdReport: none',
      {
        ...RAW_HUMAN_PROTEOME,
        proteomeCompletenessReport: {
          buscoReport: RAW_HUMAN_PROTEOME.proteomeCompletenessReport.buscoReport,
        },
      },
      {},
    ],
    [
      'no completeness report and an empty exclusionReasons: none',
      {
        id: 'UP000000001',
        proteomeType: 'Excluded',
        proteinCount: 12,
        exclusionReasons: [],
      },
      {},
    ],
  ])('%s', async (_label, raw, expected) => {
    expect(countsOf(await proteomeOf(raw))).toStrictEqual(expected);
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

  it('getTaxonByName resolves an exact scientific name and returns its full record', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ results: [rawHuman] }))
      .mockResolvedValueOnce(jsonResponse(rawHuman));
    await expect(service.getTaxonByName('Homo sapiens', ctx())).resolves.toEqual(human);
  });

  it('prefers a full common name over partial scientific names and a tied mnemonic', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { taxonId: 10359, scientificName: 'Human cytomegalovirus' },
            {
              ...rawHuman,
              taxonId: 741158,
              scientificName: "Homo sapiens subsp. 'Denisova'",
              commonName: undefined,
            },
            rawHuman,
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(rawHuman));
    await expect(service.getTaxonByName('human', ctx())).resolves.toMatchObject({ taxonId: 9606 });
  });

  it('does not guess a partial scientific match', async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [{ taxonId: 3092168, scientificName: 'SARS-CoV-2 pseudovirus' }] }),
    );
    await expect(service.getTaxonByName('SARS-CoV-2', ctx())).rejects.toMatchObject({
      data: { reason: 'no_exact_match' },
    });
  });

  it.each(['Homo sapiens', 'Home sapiens', 'Homo "sapiens', 'Homo \\sapiens'])(
    'matches complete accepted name %j',
    async (name) => {
      fetchWithTimeoutMock
        .mockResolvedValueOnce(jsonResponse({ results: [rawHuman] }))
        .mockResolvedValueOnce(jsonResponse(rawHuman));
      await expect(service.getTaxonByName(name, ctx())).resolves.toMatchObject({ taxonId: 9606 });
    },
  );

  it('preserves meaningful punctuation and refuses equal best matches', async () => {
    const denisova = {
      ...rawHuman,
      taxonId: 741158,
      scientificName: "Homo sapiens subsp. 'Denisova'",
    };
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ results: [rawHuman, denisova] }))
      .mockResolvedValueOnce(jsonResponse(denisova));
    await expect(service.getTaxonByName(denisova.scientificName, ctx())).resolves.toMatchObject({
      taxonId: 741158,
    });
    fetchWithTimeoutMock.mockResolvedValue(
      jsonResponse({ results: [rawHuman, { ...rawHuman, taxonId: 2 }] }),
    );
    await expect(service.getTaxonByName('Homo sapiens', ctx())).rejects.toMatchObject({
      data: { reason: 'ambiguous_name' },
    });
  });

  it('checks subsequent candidate pages before resolving and hydrates the full record', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse(
          { results: [{ taxonId: 10359, scientificName: 'Human cytomegalovirus' }] },
          { link: '<https://rest.uniprot.org/taxonomy/search?cursor=next>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { results: [{ taxonId: 9606, scientificName: 'Homo sapiens' }] },
          { link: '<https://rest.uniprot.org/taxonomy/search?cursor=last>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse(rawHuman));
    await expect(service.getTaxonByName('Homo sapiens', ctx())).resolves.toEqual(human);
    expect(
      new URL(String(fetchWithTimeoutMock.mock.calls[0]?.[0])).searchParams.get('fields'),
    ).toBe('id,scientific_name,common_name,mnemonic,other_names');
    expect(String(fetchWithTimeoutMock.mock.calls[1]?.[0])).toContain('cursor=next');
    expect(String(fetchWithTimeoutMock.mock.calls[2]?.[0])).toContain('cursor=last');
    expect(String(fetchWithTimeoutMock.mock.calls[3]?.[0])).toContain('/taxonomy/9606?format=json');
  });

  it('does not resolve a first-page exact name when a tied taxon appears later', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse(
          { results: [rawHuman] },
          { link: '<https://rest.uniprot.org/taxonomy/search?cursor=next>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [{ ...rawHuman, taxonId: 2 }] }));
    await expect(service.getTaxonByName('Homo sapiens', ctx())).rejects.toMatchObject({
      data: { reason: 'ambiguous_name' },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it('keeps an exact punctuation-bearing name ahead of normalization and refuses normalized ties', async () => {
    const quoted = { ...rawHuman, taxonId: 2, scientificName: 'Homo "sapiens' };
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse({ results: [rawHuman, quoted] }))
      .mockResolvedValueOnce(jsonResponse(quoted));
    await expect(service.getTaxonByName('Homo "sapiens', ctx())).resolves.toMatchObject({
      taxonId: 2,
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ results: [rawHuman, quoted] }));
    await expect(service.getTaxonByName('Homo \\sapiens', ctx())).rejects.toMatchObject({
      data: { reason: 'ambiguous_name' },
    });
  });

  it('passes cancellation into candidate paging and does not hydrate after cancellation', async () => {
    const controller = new AbortController();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        jsonResponse(
          { results: [rawHuman] },
          { link: '<https://rest.uniprot.org/taxonomy/search?cursor=next>; rel="next"' },
        ),
      )
      .mockImplementationOnce((_url, _timeout, _context, options) => {
        expect(options.signal.aborted).toBe(false);
        controller.abort();
        expect(options.signal.aborted).toBe(true);
        expect(options.signal.reason).toBe(controller.signal.reason);
        return Promise.reject(new DOMException('Cancelled', 'AbortError'));
      });
    await expect(
      service.getTaxonByName('Homo sapiens', createMockContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  // Thread-CPU oracle: a wall-clock timeout measures machine load, not this code (timeout 0).
  it('keeps caller-name escaping and normalization linear over a 64-fold input span', async () => {
    const costs: number[] = [];
    for (const length of [1_250, 5_000, 20_000, 80_000]) {
      const name = 'a\\"\n'.repeat(Math.ceil(length / 4)).slice(0, length);
      const samples: number[] = [];
      for (let sample = 0; sample < 4; sample++) {
        fetchWithTimeoutMock.mockImplementation(() =>
          Promise.resolve(jsonResponse({ results: [{ taxonId: 1, scientificName: `${name}!` }] })),
        );
        const start = process.threadCpuUsage();
        for (let iteration = 0; iteration < 8; iteration++) {
          await expect(service.getTaxonByName(name, ctx())).rejects.toMatchObject({
            data: { reason: 'no_exact_match' },
          });
        }
        const elapsed = process.threadCpuUsage(start);
        samples.push(elapsed.user + elapsed.system);
      }
      costs.push(Math.min(...samples));
    }
    expect(costs[3]! / Math.max(costs[0]!, 1)).toBeLessThan(256);
  }, 0);
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
