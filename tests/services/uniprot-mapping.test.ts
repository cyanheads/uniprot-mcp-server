/**
 * @fileoverview Mapping HTTP regression coverage: the real service over a stubbed
 *   `fetch`, with the framework's real `fetchWithTimeout` and `withRetry`, so status
 *   mapping, retries, and the call and best-effort deadlines run as in production.
 * @module tests/services/uniprot-mapping
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { mapIds } from '@/mcp-server/tools/definitions/uniprot-map-ids.tool.js';
import { initUniProtService, UniProtService } from '@/services/uniprot/uniprot-service.js';
import {
  contentText,
  errorEnvelope,
  requestedUrls,
  routeUpstream,
  upstreamResponse,
} from '../helpers.js';

afterEach(() => vi.unstubAllGlobals());
const service = () => new UniProtService({} as never, {} as never);

/**
 * Fake timers, with `AbortSignal.timeout` routed through the fake clock as well: it
 * runs on real time otherwise, so a read bounded by it would never expire in a test.
 */
function useFakeClock(): void {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
}

function useRealClock(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
}

/** A `fetch` answer that settles only when the request's signal aborts, rejecting with its reason. */
function hangUntilAborted(options: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) =>
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
      once: true,
    }),
  );
}

/** A `fetch` answer that resolves after `ms` of (fake) time unless the request aborts first. */
function answerAfter(ms: number, response: Response, options: RequestInit | undefined) {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(response), ms);
    options?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(options.signal?.reason);
      },
      { once: true },
    );
  });
}

/** One UniProtKB results row as `/idmapping/uniprotkb/results` returns it. */
const P04637_ROW = {
  from: 'TP53',
  to: {
    primaryAccession: 'P04637',
    uniProtkbId: 'P53_HUMAN',
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
    genes: [{ geneName: { value: 'TP53' } }],
  },
};

it('preserves completed generic empty pages and job-wide failed IDs (characterization)', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ results: [], failedIds: ['missing'] }))),
  );
  expect(
    await service().resumeMappingPage({ jobId: 'job', cursor: 'end' }, 100, createMockContext()),
  ).toMatchObject({ status: 'finished', results: [], failedIds: ['missing'] });
});

it.each([400, 500])('classifies explicit terminal HTTP %i before retrying', async (status) => {
  const fetch = vi.fn(() =>
    Promise.resolve(
      Response.json(
        {
          jobStatus: 'ERROR',
          errors: [{ code: 40, message: 'The number of mapped IDs is more than 500,000' }],
        },
        { status },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(service().resumeMapping('job', 100, createMockContext())).rejects.toMatchObject({
    data: { reason: 'mapping_failed' },
    message: expect.stringContaining('500,000'),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

describe('mapping failures that relay an HTML error page', () => {
  /**
   * The status body UniProt returned for job 9OW6QfIxPk (captured 2026-11-23), its
   * message cut after the stylesheet's start: a proxy's 503 page passed through as
   * the failure message. Past the framework's 500-byte error-body capture, as the
   * full page is, so the relayed message is the capture's head.
   */
  const SQUID_FAILURE = {
    jobStatus: 'ERROR',
    errors: [
      {
        code: 50,
        message:
          '503 Service Unavailable: "<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><EOL><html><head><EOL><meta type="copyright" content="Copyright (C) 1996-2016 The Squid Software Foundation and contributors"><EOL><meta http-equiv="Content-Type" CONTENT="text/html; charset=utf-8"><EOL><title>ERROR: The requested URL could not be retrieved</title><EOL><style type="text/css"><!-- <EOL> /*<EOL> * Copyright (C) 1996-2016 The Squid Software Foundation and contributors<EOL> *<EOL> * Squid software is distributed under GPLv2+ license and includes<EOL> * contributions from numerous individuals and organizations.<EOL> */<EOL></style></head><body></body></html>"',
      },
    ],
  };
  const FIXED_RECOVERY =
    'Check the submitted identifiers and databases, then submit a fresh mapping job; retry later if the failure persists.';

  it('fails mapping_failed with a fixed sentence naming the job and code on both surfaces, after one status request', async () => {
    initUniProtService({} as never, {} as never);
    const fetch = vi.fn(() => Promise.resolve(upstreamResponse(400, SQUID_FAILURE, 'Bad Request')));
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(mapIds, { ticket: '9OW6QfIxPk' });
    expect(errorEnvelope(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        'UniProt mapping failed: the ID-mapping service failed internally on job 9OW6QfIxPk (error code 50)',
      data: { reason: 'mapping_failed', recovery: { hint: FIXED_RECOVERY } },
    });
    expect(contentText(result)).toContain(
      'the ID-mapping service failed internally on job 9OW6QfIxPk (error code 50)',
    );
    expect(JSON.stringify(result)).not.toMatch(/doctype|<html|<meta|<title|squid/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('relays plain messages beside one fixed sentence for repeated HTML entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            jobStatus: 'ERROR',
            errors: [
              { code: 50, message: '<html><body>Bad gateway</body></html>' },
              { code: 50, message: '<HTML><BODY>Bad gateway</BODY></HTML>' },
              { code: 40, message: 'The number of mapped IDs is more than 500,000' },
            ],
          }),
        ),
      ),
    );
    await expect(service().resumeMapping('jobX', 100, createMockContext())).rejects.toMatchObject({
      message:
        'UniProt mapping failed: the ID-mapping service failed internally on job jobX (error code 50); The number of mapped IDs is more than 500,000',
      data: { reason: 'mapping_failed', recovery: { hint: expect.stringContaining('fewer IDs') } },
    });
  });

  it('relays a message whose angle brackets are not markup unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ jobStatus: 'ERROR', errors: [{ message: 'Invalid id <TP53-x>' }] }),
        ),
      ),
    );
    await expect(service().resumeMapping('jobY', 100, createMockContext())).rejects.toMatchObject({
      message: 'UniProt mapping failed: Invalid id <TP53-x>',
    });
  });
});

it('preserves many-to-one sources while adding identity and real totals', async () => {
  const fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/run')) return Promise.resolve(Response.json({ jobId: 'job' }));
    if (url.pathname.includes('/status/'))
      return Promise.resolve(Response.json({ jobStatus: 'FINISHED' }));
    return Promise.resolve(
      Response.json(
        {
          results: ['P04637', 'P53_HUMAN'].map((from) => ({
            from,
            to: {
              primaryAccession: 'P04637',
              uniProtkbId: 'P53_HUMAN',
              entryType: 'UniProtKB reviewed (Swiss-Prot)',
              organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
              genes: [{ geneName: { value: 'TP53' } }],
            },
          })),
          failedIds: ['missing'],
        },
        { headers: { 'x-total-results': '18' } },
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const result = await service().mapIds(
    'UniProtKB_AC-ID',
    'UniProtKB',
    ['P04637', 'P53_HUMAN'],
    undefined,
    100,
    createMockContext(),
  );
  expect(result).toMatchObject({
    totalMappings: 18,
    results: [
      {
        from: 'P04637',
        entryName: 'P53_HUMAN',
        reviewed: true,
        gene: 'TP53',
        organism: { taxonId: 9606 },
      },
      { from: 'P53_HUMAN', to: 'P04637' },
    ],
  });
  expect(new URL(String(fetch.mock.calls[2]?.[0])).pathname).toBe(
    '/idmapping/uniprotkb/results/job',
  );
  expect(new URL(String(fetch.mock.calls[2]?.[0])).searchParams.has('query')).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['ticket', 'submission'])(
  'renders terminal %s failures and recovery on both client surfaces',
  async (mode) => {
    initUniProtService({} as never, {} as never);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        Promise.resolve(
          String(input).endsWith('/run')
            ? Response.json({ jobId: 'job' })
            : Response.json(
                {
                  jobStatus: 'ERROR',
                  errors: [{ message: 'The number of mapped IDs is more than 500,000' }],
                  url: 'private-url',
                },
                { status: 400 },
              ),
        ),
      ),
    );
    const result = await runToolContract(
      mapIds,
      mode === 'ticket'
        ? { ticket: 'job' }
        : { from_db: 'Gene_Name', to_db: 'UniProtKB', ids: ['TP53'] },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          data: {
            reason: 'mapping_failed',
            recovery: { hint: expect.stringContaining('fewer IDs') },
          },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('500,000');
    expect(JSON.stringify(result.content)).toContain('fewer IDs');
    expect(JSON.stringify(result)).not.toContain('private-url');
  },
);

it('keeps unrelated submission validation separate from unsupported pairs', async () => {
  initUniProtService({} as never, {} as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ messages: ['Invalid taxId'] }, { status: 400 }))),
  );
  const result = await runToolContract(mapIds, {
    from_db: 'Gene_Name',
    to_db: 'UniProtKB',
    ids: ['TP53'],
  });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { message: 'UniProt rejected the request: Invalid taxId' } },
  });
  expect(JSON.stringify(result)).not.toContain('unsupported_db_pair');
});

it('resolves a legacy continuation, preserves sparse identity and renders page totals', async () => {
  initUniProtService({} as never, {} as never);
  const fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/details/'))
      return Promise.resolve(Response.json({ to: 'UniProtKB' }));
    expect(url.pathname).toBe('/idmapping/uniprotkb/results/job');
    expect(url.searchParams.get('cursor')).toBe('page2');
    return Promise.resolve(
      Response.json(
        {
          results: [
            {
              from: 'x',
              to: {
                primaryAccession: 'P04637',
                uniProtkbId: 'P53_HUMAN',
                entryType: 'UniProtKB unreviewed (TrEMBL)',
                organism: { taxonId: 9606 },
                genes: [{ geneName: { value: 'TP53' } }],
              },
            },
            { from: 'y', to: { primaryAccession: 'Q00001' } },
          ],
          failedIds: ['missing'],
        },
        { headers: { 'x-total-results': '100000' } },
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(mapIds, { continuation: { jobId: 'job', cursor: 'page2' } });
  expect(result).toMatchObject({
    structuredContent: {
      totalMappings: 100000,
      mappedCount: 2,
      unmappedIds: ['missing'],
      results: [
        { entryName: 'P53_HUMAN', reviewed: false, organism: { taxonId: 9606 }, gene: 'TP53' },
        { from: 'y', to: 'Q00001' },
      ],
    },
  });
  const text = JSON.stringify(result.content);
  for (const value of ['P53_HUMAN', 'false', '9606', 'TP53', '100000', 'missing'])
    expect(text).toContain(value);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('falls back to generic pagination above the enrichment limit without synthesizing identity', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/details/'))
        return Promise.resolve(Response.json({ to: 'UniProtKB' }));
      if (url.pathname.includes('/uniprotkb/'))
        return Promise.resolve(
          Response.json({ messages: ['Too many mapped IDs to enrich'] }, { status: 400 }),
        );
      return Promise.resolve(
        Response.json(
          { results: [{ from: 'x', to: 'P04637' }], failedIds: ['missing'] },
          {
            headers: {
              'x-total-results': '100001',
              link: '<https://rest.uniprot.org/idmapping/results/job?cursor=page3>; rel="next"',
            },
          },
        ),
      );
    }),
  );
  expect(
    await service().resumeMappingPage({ jobId: 'job', cursor: 'page2' }, 100, createMockContext()),
  ).toEqual({
    status: 'finished',
    results: [{ from: 'x', to: 'P04637' }],
    totalMappings: 100001,
    failedIds: ['missing'],
    identityUnavailable: 'identity_refused',
    continuation: { jobId: 'job', cursor: 'page3' },
  });
});

it('keeps generic results when metadata is unavailable and omits unavailable totals', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) =>
      Promise.resolve(
        String(input).includes('/details/')
          ? Response.json({}, { status: 404 })
          : Response.json({ results: [], failedIds: ['missing'] }),
      ),
    ),
  );
  expect(
    await service().resumeMappingPage({ jobId: 'job', cursor: 'end' }, 100, createMockContext()),
  ).toEqual({
    status: 'finished',
    results: [],
    failedIds: ['missing'],
    identityUnavailable: 'details_refused',
  });
});

it('propagates malformed enrichment instead of hiding a schema failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) =>
      Promise.resolve(
        String(input).includes('/details/')
          ? Response.json({ to: 'UniProtKB' })
          : new Response('{broken'),
      ),
    ),
  );
  await expect(
    service().resumeMappingPage({ jobId: 'job', cursor: 'c' }, 100, createMockContext()),
  ).rejects.toBeInstanceOf(SyntaxError);
});

it.each([
  ['details', 401],
  ['details', 403],
  ['details', 422],
  ['uniprotkb', 401],
  ['uniprotkb', 403],
  ['uniprotkb', 422],
] as const)('preserves generic results when optional %s answers HTTP %i', async (path, status) => {
  const fetch = vi.fn((input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.includes(`/${path}/`)) return Promise.resolve(Response.json({}, { status }));
    if (url.pathname.includes('/details/'))
      return Promise.resolve(Response.json({ to: 'UniProtKB' }));
    expect(url.pathname).toBe('/idmapping/results/job');
    return Promise.resolve(
      Response.json(
        { results: [{ from: 'P53_HUMAN', to: 'P04637' }], failedIds: ['missing'] },
        { headers: { 'x-total-results': '1' } },
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    service().resumeMappingPage({ jobId: 'job', cursor: 'c' }, 100, createMockContext()),
  ).resolves.toMatchObject({
    results: [{ from: 'P53_HUMAN', to: 'P04637' }],
    failedIds: ['missing'],
    totalMappings: 1,
    identityUnavailable: path === 'details' ? 'details_refused' : 'identity_refused',
  });
});

it('propagates caller cancellation during enriched retrieval without a generic retry', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const fetch = vi.fn((input: unknown, options: RequestInit) => {
    if (String(input).includes('/details/'))
      return Promise.resolve(Response.json({ to: 'UniProtKB' }));
    started.resolve();
    return new Promise<Response>((_resolve, reject) =>
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const pending = service().resumeMappingPage(
    { jobId: 'job', cursor: 'c' },
    100,
    createMockContext({ signal: controller.signal }),
  );
  const assertion = expect(pending).rejects.toMatchObject({ code: -32011 });
  await started.promise;
  controller.abort();
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(2);
});

describe('mapping read deadlines', () => {
  beforeEach(useFakeClock);
  afterEach(useRealClock);

  it('degrades a job-details read that outlasts UNIPROT_TIMEOUT_MS without cancelling generic results', async () => {
    const fetch = vi.fn((input: unknown, options?: RequestInit) =>
      String(input).includes('/details/')
        ? hangUntilAborted(options)
        : Promise.resolve(Response.json({ results: [{ from: 'x', to: 'P04637' }] })),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMappingPage(
      { jobId: 'job', cursor: 'c' },
      100,
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(getServerConfig().timeoutMs - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      status: 'finished',
      results: [{ from: 'x', to: 'P04637' }],
      failedIds: [],
      identityUnavailable: 'details_timeout',
    });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/idmapping/details/job',
      '/idmapping/results/job',
    ]);
  });

  it.each([
    ['ticket', () => service().resumeMapping('job', 100, createMockContext())],
    [
      'continuation',
      () => service().resumeMappingPage({ jobId: 'job', cursor: 'c' }, 100, createMockContext()),
    ],
  ])(
    'keeps identity rows on a %s call whose job-details read answers after 3 seconds',
    async (_mode, call) => {
      const fetch = vi.fn((input: unknown, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === '/idmapping/status/job')
          return Promise.resolve(Response.json({ jobStatus: 'FINISHED' }));
        if (path === '/idmapping/details/job')
          return answerAfter(3_000, Response.json({ to: 'UniProtKB' }), options);
        if (path === '/idmapping/uniprotkb/results/job')
          return Promise.resolve(Response.json({ results: [P04637_ROW], failedIds: [] }));
        // The generic page a cut details read would fall back to: rows without identity.
        if (path === '/idmapping/results/job')
          return Promise.resolve(Response.json({ results: [{ from: 'TP53', to: 'P04637' }] }));
        return Promise.reject(new Error(`Unrouted: ${String(input)}`));
      });
      vi.stubGlobal('fetch', fetch);
      const pending = call();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({
        status: 'finished',
        results: [
          {
            from: 'TP53',
            to: 'P04637',
            entryName: 'P53_HUMAN',
            reviewed: true,
            organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
            gene: 'TP53',
          },
        ],
        failedIds: [],
      });
    },
  );

  it('keeps identity rows from an enriched read slower than 2 seconds', async () => {
    const fetch = vi.fn((input: unknown, options?: RequestInit) =>
      String(input).includes('/details/')
        ? Promise.resolve(Response.json({ to: 'UniProtKB' }))
        : answerAfter(2_500, Response.json({ results: [P04637_ROW], failedIds: [] }), options),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMappingPage(
      { jobId: 'job', cursor: 'c' },
      100,
      createMockContext(),
    );
    // Past the slow read and any generic fallback a 2-second bound would have triggered.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({
      status: 'finished',
      results: [
        {
          from: 'TP53',
          to: 'P04637',
          entryName: 'P53_HUMAN',
          reviewed: true,
          organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
          gene: 'TP53',
        },
      ],
      failedIds: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('why a page carries no UniProtKB target identity', () => {
  beforeEach(useFakeClock);
  afterEach(useRealClock);

  type Answer = (options: RequestInit | undefined) => Promise<Response>;
  const answer =
    (response: () => Response): Answer =>
    () =>
      Promise.resolve(response());
  const hang: Answer = (options) => hangUntilAborted(options);
  const unavailable = answer(() => upstreamResponse(503, { messages: ['down'] }, 'Unavailable'));
  const rateLimited = answer(() => upstreamResponse(429, { messages: ['slow'] }, 'Too Many'));
  const htmlPage = answer(() => new Response('<!DOCTYPE html><html><body>Down</body></html>'));
  const refused = answer(() => upstreamResponse(400, { messages: ['Too many to enrich'] }));
  const uniprotTarget = answer(() => Response.json({ to: 'UniProtKB' }));

  it.each([
    [
      'the job details name no target database',
      answer(() => Response.json({})),
      undefined,
      'no_target',
    ],
    ['the job-details read times out', hang, undefined, 'details_timeout'],
    ['the job-details read answers HTTP 503', unavailable, undefined, 'details_failed'],
    ['the job-details read answers HTTP 429', rateLimited, undefined, 'details_failed'],
    ['the job-details read answers an HTML page', htmlPage, undefined, 'details_failed'],
    ['the job-details read is refused', refused, undefined, 'details_refused'],
    ['the identity read times out', uniprotTarget, hang, 'identity_timeout'],
    ['the identity read answers HTTP 503', uniprotTarget, unavailable, 'identity_failed'],
    ['the identity read answers HTTP 429', uniprotTarget, rateLimited, 'identity_failed'],
    ['the identity read answers an HTML page', uniprotTarget, htmlPage, 'identity_failed'],
    ['the identity read is refused (HTTP 400)', uniprotTarget, refused, 'identity_refused'],
  ] as const)('names the cause when %s', async (_case, details, identity, cause) => {
    const fetch = vi.fn((input: unknown, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/idmapping/details/job') return details(options);
      if (path === '/idmapping/uniprotkb/results/job' && identity) return identity(options);
      if (path === '/idmapping/results/job')
        return Promise.resolve(Response.json({ results: [{ from: 'x', to: 'P04637' }] }));
      return Promise.reject(new Error(`Unrouted: ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMappingPage(
      { jobId: 'job', cursor: 'c' },
      100,
      createMockContext(),
    );
    await vi.advanceTimersByTimeAsync(getServerConfig().timeoutMs);
    expect(await pending).toEqual({
      status: 'finished',
      results: [{ from: 'x', to: 'P04637' }],
      failedIds: [],
      identityUnavailable: cause,
    });
    // One attempt per optional read, then the generic page: unavailability is never retried.
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/idmapping/details/job',
      ...(identity ? ['/idmapping/uniprotkb/results/job'] : []),
      '/idmapping/results/job',
    ]);
  });
});

describe('the ID-mapping call budget', () => {
  const BUDGET_MESSAGE =
    "UniProt ID mapping did not finish within this call's 50-second budget. Retry the call.";
  const HELD_MESSAGE =
    "UniProt ID-mapping job job is held server-side, but this call's 50-second budget ran out reading its results.";
  const TICKET_RECOVERY =
    'Re-call with {"ticket":"job"} to read its results without re-submitting the job.';

  beforeEach(useFakeClock);
  afterEach(useRealClock);

  /** Submission answers job `job`, already FINISHED; every other read hangs until the budget cuts it. */
  function finishedJobWithHungReads() {
    return vi.fn((input: unknown, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/idmapping/run') return Promise.resolve(Response.json({ jobId: 'job' }));
      if (path === '/idmapping/status/job')
        return Promise.resolve(Response.json({ jobStatus: 'FINISHED' }));
      return hangUntilAborted(options);
    });
  }

  it('settles a submission whose results reads hang as a Timeout at 50 seconds naming its ticket, retries included', async () => {
    const fetch = finishedJobWithHungReads();
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const pending = service()
      .mapIds('Gene_Name', 'UniProtKB', ['TP53'], undefined, 100, createMockContext())
      .finally(() => {
        settled = true;
      });
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: HELD_MESSAGE,
      data: { ticket: 'job', recovery: { hint: TICKET_RECOVERY } },
    });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    // The enriched read ran to UNIPROT_TIMEOUT_MS, then the generic fallback until the budget cut it.
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/idmapping/run',
      '/idmapping/status/job',
      '/idmapping/uniprotkb/results/job',
      '/idmapping/results/job',
    ]);
  });

  it('returns the ticket when a hung status check outlasts the budget', async () => {
    const fetch = vi.fn((_input: unknown, options?: RequestInit) => hangUntilAborted(options));
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const pending = service()
      .resumeMapping('job', 100, createMockContext())
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'running', ticket: 'job' });
    // A status check is retried after its per-request timeout; nothing past the status endpoint.
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [url] of fetch.mock.calls)
      expect(new URL(String(url)).pathname).toBe('/idmapping/status/job');
  });

  it('returns the ticket when a fresh submission’s hung status check outlasts the budget', async () => {
    const fetch = vi.fn((input: unknown, options?: RequestInit) =>
      new URL(String(input)).pathname === '/idmapping/run'
        ? Promise.resolve(Response.json({ jobId: 'job' }))
        : hangUntilAborted(options),
    );
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const pending = service()
      .mapIds('Gene_Name', 'UniProtKB', ['TP53'], undefined, 100, createMockContext())
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ status: 'running', ticket: 'job' });
    // One submission, then status checks only, each retried after its per-request timeout.
    const [submission, ...checks] = fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(submission).toBe('/idmapping/run');
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const path of checks) expect(path).toBe('/idmapping/status/job');
  });

  it('names the ticket when the budget ends reading the results of a finished ticket job', async () => {
    vi.stubGlobal('fetch', finishedJobWithHungReads());
    const pending = service().resumeMapping('job', 100, createMockContext());
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: HELD_MESSAGE,
      data: { ticket: 'job', recovery: { hint: TICKET_RECOVERY } },
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await assertion;
  });

  it('names the same continuation when the budget ends reading a continuation page', async () => {
    vi.stubGlobal('fetch', finishedJobWithHungReads());
    const continuation = { jobId: 'job', cursor: 'c2' };
    const pending = service().resumeMappingPage(continuation, 100, createMockContext());
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: HELD_MESSAGE,
      data: {
        continuation,
        recovery: {
          hint: 'Re-call with {"continuation":{"jobId":"job","cursor":"c2"}} to read this page again.',
        },
      },
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await assertion;
  });

  it('keeps "Retry the call." with no job data when the budget ends before submission answers', async () => {
    const fetch = vi.fn((_input: unknown, options?: RequestInit) => hangUntilAborted(options));
    vi.stubGlobal('fetch', fetch);
    const pending = service().mapIds(
      'Gene_Name',
      'UniProtKB',
      ['TP53'],
      undefined,
      100,
      createMockContext(),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: BUDGET_MESSAGE,
      data: undefined,
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await assertion;
    expect(fetch).toHaveBeenCalled();
    for (const [url] of fetch.mock.calls)
      expect(new URL(String(url)).pathname).toBe('/idmapping/run');
  });

  it('renders the held job and its re-call on both surfaces, the arguments as a code span', async () => {
    initUniProtService({} as never, {} as never);
    vi.stubGlobal('fetch', finishedJobWithHungReads());
    const pending = runToolContract(mapIds, { ticket: 'job' });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;
    expect(errorEnvelope(result)).toEqual({
      code: JsonRpcErrorCode.Timeout,
      message: HELD_MESSAGE,
      data: { ticket: 'job', recovery: { hint: TICKET_RECOVERY } },
    });
    expect(contentText(result)).toContain(
      'Recovery: Re-call with `{"ticket":"job"}` to read its results without re-submitting the job.',
    );
  });

  it('keeps the page when the budget cuts its inactive-target re-read', async () => {
    const config = getServerConfig();
    const timeoutMs = config.timeoutMs;
    // A per-request timeout past the budget lets the generic read itself run to 49 s.
    config.timeoutMs = 60_000;
    const fetch = vi.fn((input: unknown, options?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/idmapping/details/job')
        return Promise.resolve(Response.json({ to: 'UniProtKB-Swiss-Prot' }));
      if (url.pathname === '/idmapping/results/job')
        return answerAfter(
          49_000,
          Response.json({ results: [{ from: 'Q9ZZZ9', to: 'Q9ZZZ9' }], obsoleteCount: 1 }),
          options,
        );
      // The inactive-target re-read asks for accessions alone; the enriched read is refused.
      return url.searchParams.get('fields') === 'accession'
        ? hangUntilAborted(options)
        : Promise.resolve(Response.json({ messages: ['too many to enrich'] }, { status: 400 }));
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const pending = service().resumeMappingPage(
        { jobId: 'job', cursor: 'c' },
        100,
        createMockContext(),
      );
      await vi.advanceTimersByTimeAsync(50_000);
      expect(await pending).toEqual({
        status: 'finished',
        results: [{ from: 'Q9ZZZ9', to: 'Q9ZZZ9' }],
        failedIds: [],
        identityUnavailable: 'identity_refused',
        inactiveUnchecked: 1,
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      config.timeoutMs = timeoutMs;
    }
  });

  it.each([
    ['plain abort', undefined, JsonRpcErrorCode.RequestCancelled],
    [
      'abort with a TimeoutError reason',
      new DOMException('The client deadline passed.', 'TimeoutError'),
      JsonRpcErrorCode.Timeout,
    ],
  ])(
    'propagates the caller’s %s during the inactive-target re-read, keeping no page',
    async (_case, reason, code) => {
      const controller = new AbortController();
      const fetch = vi.fn((input: unknown, options?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/idmapping/details/job')
          return Promise.resolve(Response.json({ to: 'UniProtKB-Swiss-Prot' }));
        if (url.pathname === '/idmapping/results/job')
          return Promise.resolve(
            Response.json({ results: [{ from: 'Q9ZZZ9', to: 'Q9ZZZ9' }], obsoleteCount: 1 }),
          );
        // The inactive-target re-read asks for accessions alone; the enriched read is refused.
        return url.searchParams.get('fields') === 'accession'
          ? hangUntilAborted(options)
          : Promise.resolve(Response.json({ messages: ['too many to enrich'] }, { status: 400 }));
      });
      vi.stubGlobal('fetch', fetch);
      const pending = service().resumeMappingPage(
        { jobId: 'job', cursor: 'c' },
        100,
        createMockContext({ signal: controller.signal }),
      );
      const assertion = expect(pending).rejects.toMatchObject({ code });
      // Inside the re-read's 2 s bound.
      await vi.advanceTimersByTimeAsync(100);
      expect(fetch).toHaveBeenCalledTimes(4);
      const reRead = new URL(String(fetch.mock.calls[3]?.[0]));
      expect(reRead.searchParams.get('fields')).toBe('accession');
      controller.abort(reason);
      await assertion;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    ['the call budget cuts it', undefined],
    [
      'the caller aborts with a TimeoutError reason',
      new DOMException('The client deadline passed.', 'TimeoutError'),
    ],
  ])(
    'ends at the enriched read when %s, with no generic read after the cut',
    async (_case, reason) => {
      const config = getServerConfig();
      const timeoutMs = config.timeoutMs;
      // A per-request timeout past the budget, so the budget is what ends the hung read.
      config.timeoutMs = 60_000;
      const controller = new AbortController();
      const fetch = vi.fn((input: unknown, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === '/idmapping/run') return Promise.resolve(Response.json({ jobId: 'job' }));
        if (path === '/idmapping/status/job')
          return Promise.resolve(Response.json({ jobStatus: 'FINISHED' }));
        // A real fetch refuses an already-aborted signal at once.
        return options?.signal?.aborted
          ? Promise.reject(options.signal.reason)
          : hangUntilAborted(options);
      });
      vi.stubGlobal('fetch', fetch);
      try {
        const pending = service().mapIds(
          'Gene_Name',
          'UniProtKB',
          ['TP53'],
          undefined,
          100,
          createMockContext({ signal: controller.signal }),
        );
        const assertion = expect(pending).rejects.toMatchObject(
          reason
            ? { code: JsonRpcErrorCode.Timeout }
            : {
                code: JsonRpcErrorCode.Timeout,
                message: HELD_MESSAGE,
                data: { ticket: 'job', recovery: { hint: TICKET_RECOVERY } },
              },
        );
        if (reason) {
          await vi.advanceTimersByTimeAsync(100);
          controller.abort(reason);
        } else {
          await vi.advanceTimersByTimeAsync(50_000);
        }
        await assertion;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
          '/idmapping/run',
          '/idmapping/status/job',
          '/idmapping/uniprotkb/results/job',
        ]);
      } finally {
        config.timeoutMs = timeoutMs;
      }
    },
  );

  it('propagates caller cancellation during the poll pause with no further status request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => Promise.resolve(Response.json({ jobStatus: 'RUNNING' })));
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMapping(
      'job',
      100,
      createMockContext({ signal: controller.signal }),
    );
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('a status check failing upstream once the job is known to exist', () => {
  /**
   * Each failing status answer, as a fresh `Response` per request. The framework
   * retries all four (unavailable, rate-limited, an HTML page, a per-request timeout)
   * before the poll sees the failure.
   */
  const STATUS_FAILURES = [
    ['HTTP 503', () => upstreamResponse(503, { messages: ['down'] }, 'Service Unavailable')],
    ['HTTP 429', () => upstreamResponse(429, { messages: ['slow down'] }, 'Too Many Requests')],
    [
      'a 200 HTML maintenance page',
      () => new Response('<!DOCTYPE html><html><body>Maintenance</body></html>'),
    ],
    ['a request timeout', 'hang'],
  ] as const;
  type StatusAnswer = (typeof STATUS_FAILURES)[number][1] | (() => Response);

  /** Submission answers job `job`; status checks take `answers` in turn, the last repeating. */
  function statusSequence(...answers: StatusAnswer[]) {
    let check = 0;
    return vi.fn((input: unknown, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/idmapping/run') return Promise.resolve(Response.json({ jobId: 'job' }));
      if (path !== '/idmapping/status/job') return rejectUnrouted(input);
      const answer = answers[Math.min(check++, answers.length - 1)];
      return answer === 'hang'
        ? hangUntilAborted(options)
        : Promise.resolve(answer?.() as Response);
    });
  }
  const running = () => Response.json({ jobStatus: 'RUNNING' });
  const rejectUnrouted = (input: unknown) =>
    Promise.reject(new Error(`Unrouted: ${String(input)}`));
  const paths = (fetch: ReturnType<typeof statusSequence>) =>
    fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);

  let timeoutMs: number;
  beforeEach(() => {
    useFakeClock();
    // A per-request timeout short enough that its four attempts end inside the call budget.
    timeoutMs = getServerConfig().timeoutMs;
    getServerConfig().timeoutMs = 1_000;
  });
  afterEach(() => {
    getServerConfig().timeoutMs = timeoutMs;
    useRealClock();
  });

  it.each(STATUS_FAILURES)(
    'answers running with the ticket when a ticket check after RUNNING meets %s',
    async (_case, failure) => {
      const fetch = statusSequence(running, failure);
      vi.stubGlobal('fetch', fetch);
      const pending = service().resumeMapping('job', 100, createMockContext());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toEqual({ status: 'running', ticket: 'job', statusCheckFailed: true });
      // One RUNNING answer, then the failing check's four attempts; nothing past the status endpoint.
      expect(paths(fetch)).toEqual(Array(5).fill('/idmapping/status/job'));
    },
  );

  it.each(STATUS_FAILURES)(
    "keeps a submission's job id as the ticket when its first status check meets %s",
    async (_case, failure) => {
      const fetch = statusSequence(failure);
      vi.stubGlobal('fetch', fetch);
      const pending = service().mapIds(
        'Gene_Name',
        'UniProtKB',
        ['TP53'],
        undefined,
        100,
        createMockContext(),
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toEqual({ status: 'running', ticket: 'job', statusCheckFailed: true });
      expect(paths(fetch)).toEqual(['/idmapping/run', ...Array(4).fill('/idmapping/status/job')]);
    },
  );

  it("propagates a failing first status check of a caller's ticket (characterization)", async () => {
    const fetch = statusSequence(STATUS_FAILURES[0][1]);
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMapping('job', 100, createMockContext());
    const assertion = expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'an unknown job (HTTP 404)',
      () => upstreamResponse(404, { messages: ['not found'] }, 'Not Found'),
      { code: JsonRpcErrorCode.NotFound },
    ],
    [
      'a job that reports an error',
      () => Response.json({ jobStatus: 'ERROR', errors: [{ message: 'Invalid ids' }] }),
      { data: { reason: 'mapping_failed' } },
    ],
  ])('still propagates %s on a later status check', async (_case, failure, expected) => {
    const fetch = statusSequence(running, failure);
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMapping('job', 100, createMockContext());
    const assertion = expect(pending).rejects.toMatchObject(expected);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates caller cancellation during a failing check with no further request', async () => {
    const controller = new AbortController();
    const fetch = statusSequence(running, STATUS_FAILURES[0][1]);
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMapping(
      'job',
      100,
      createMockContext({ signal: controller.signal }),
    );
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // Past the RUNNING check, the pause, and the failing check's first attempt, into its backoff.
    await vi.advanceTimersByTimeAsync(600);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates a caller abort whose reason is a TimeoutError during a check in flight, with no further request', async () => {
    const controller = new AbortController();
    const fetch = statusSequence(running, 'hang');
    vi.stubGlobal('fetch', fetch);
    const pending = service().resumeMapping(
      'job',
      100,
      createMockContext({ signal: controller.signal }),
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    // Past the RUNNING check and the pause, into the second check, inside its 1 s per-request timeout.
    await vi.advanceTimersByTimeAsync(600);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.abort(new DOMException('The client deadline passed.', 'TimeoutError'));
    await assertion;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns running with the ticket and the failed check on both surfaces of a ticket call', async () => {
    initUniProtService({} as never, {} as never);
    vi.stubGlobal('fetch', statusSequence(running, STATUS_FAILURES[0][1]));
    const pending = runToolContract(mapIds, { ticket: 'job' });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    const notice =
      'The latest status check of this mapping job failed upstream, so it is reported as running and may have finished since. Re-call with ticket "job" to keep polling it.';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: 'running', ticket: 'job', notice });
    expect(contentText(result)).toContain('**Ticket:** job');
    expect(contentText(result)).toContain(notice);
  });
});

describe('uniprot_map_ids page size and organism names (#50)', () => {
  /**
   * A finished UniProtKB-target job of `total` mappings, served the way
   * rest.uniprot.org serves one: pages of the requested `size` (a size above 500 is
   * a 400), a positional cursor in the next link, `x-total-results`, and organism
   * names only when `fields` asks for organism_name.
   */
  function finishedJob(total: number) {
    const organisms = [
      { taxonId: 9606, scientificName: 'Homo sapiens' },
      { taxonId: 10090, scientificName: 'Mus musculus' },
    ] as const;
    const rows = Array.from({ length: total }, (_, index) => ({
      from: index % 2 ? 'INS' : 'TP53',
      accession: index === 0 ? 'P04637' : `Q${String(index).padStart(5, '0')}`,
      organism: organisms[index % 2] ?? organisms[0],
    }));
    return routeUpstream((url) => {
      if (url.pathname === '/idmapping/run') return upstreamResponse(200, { jobId: 'job50' });
      if (url.pathname === '/idmapping/status/job50')
        return upstreamResponse(200, { jobStatus: 'FINISHED' });
      if (url.pathname === '/idmapping/details/job50')
        return upstreamResponse(200, { to: 'UniProtKB' });
      if (url.pathname !== '/idmapping/uniprotkb/results/job50') return;
      const size = Number(url.searchParams.get('size'));
      if (size > 500)
        return upstreamResponse(400, { messages: ["'size' must be less than or equal to 500"] });
      const start = Number(url.searchParams.get('cursor')?.slice(1) ?? 0);
      const named = url.searchParams.get('fields')?.split(',').includes('organism_name');
      const results = rows.slice(start, start + size).map((row) => ({
        from: row.from,
        to: {
          primaryAccession: row.accession,
          entryType: 'UniProtKB reviewed (Swiss-Prot)',
          organism: named ? row.organism : { taxonId: row.organism.taxonId },
          genes: [{ geneName: { value: row.from } }],
        },
      }));
      const end = start + results.length;
      return new Response(JSON.stringify({ results, failedIds: [] }), {
        headers: {
          'x-total-results': String(total),
          ...(end < total
            ? {
                link: `<https://rest.uniprot.org/idmapping/uniprotkb/results/job50?cursor=o${end}&size=${size}>; rel="next"`,
              }
            : {}),
        },
      });
    });
  }

  type MappingPageOut = {
    results: { from: string; to: string; organism?: { scientificName?: string } }[];
    continuation?: { jobId: string; cursor: string };
    mappedCount: number;
    totalMappings: number;
  };

  beforeEach(() => {
    initUniProtService({} as never, {} as never);
  });

  it('serves a first page of 100 with a continuation, the job total, and organism names on both surfaces', async () => {
    const fetch = finishedJob(1162);
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(mapIds, {
      from_db: 'Gene_Name',
      to_db: 'UniProtKB',
      ids: ['TP53', 'INS'],
    });
    const out = result.structuredContent as MappingPageOut;
    expect(out.results).toHaveLength(100);
    expect(out).toMatchObject({
      mappedCount: 100,
      totalMappings: 1162,
      continuation: { jobId: 'job50', cursor: 'o100' },
    });
    expect(out.results[0]).toEqual({
      from: 'TP53',
      to: 'P04637',
      reviewed: true,
      organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
      gene: 'TP53',
    });
    expect(contentText(result)).toContain(
      '| TP53 | P04637 |  | true | Homo sapiens [taxon 9606] | TP53 |\n',
    );
    expect(contentText(result)).toContain(
      '| INS | Q00001 |  | true | Mus musculus [taxon 10090] | INS |\n',
    );
    const sent = requestedUrls(fetch).at(-1);
    expect(sent?.searchParams.get('size')).toBe('100');
    expect(sent?.searchParams.get('fields')).toBe(
      'accession,id,reviewed,organism_id,organism_name,gene_primary',
    );
  });

  it('continues at the next mapping whatever size each page asks for, with no repeat or gap', async () => {
    const fetch = finishedJob(400);
    vi.stubGlobal('fetch', fetch);
    const received: string[] = [];
    let continuation: MappingPageOut['continuation'];
    for (const size of [undefined, 250, 37]) {
      const result = await runToolContract(mapIds, {
        ...(continuation
          ? { continuation }
          : { from_db: 'Gene_Name' as const, to_db: 'UniProtKB' as const, ids: ['TP53', 'INS'] }),
        ...(size ? { size } : {}),
      });
      const out = result.structuredContent as MappingPageOut;
      received.push(...out.results.map((row) => row.to));
      continuation = out.continuation;
    }
    const expected = [
      'P04637',
      ...Array.from({ length: 386 }, (_, i) => `Q${String(i + 1).padStart(5, '0')}`),
    ];
    expect(received).toEqual(expected);
    expect(continuation).toEqual({ jobId: 'job50', cursor: 'o387' });
    expect(
      requestedUrls(fetch)
        .filter((url) => url.pathname.includes('/results/'))
        .map((url) => [url.searchParams.get('size'), url.searchParams.get('cursor')]),
    ).toEqual([
      ['100', null],
      ['250', 'o100'],
      ['37', 'o350'],
    ]);
  });

  it('serves size 501 at 500 with a notice, and the job total stays the whole job', async () => {
    const fetch = finishedJob(1162);
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(mapIds, {
      from_db: 'Gene_Name',
      to_db: 'UniProtKB',
      ids: ['TP53', 'INS'],
      size: 501,
    });
    const out = result.structuredContent as MappingPageOut & { notice?: string };
    expect(out.results).toHaveLength(500);
    expect(out.totalMappings).toBe(1162);
    const notice =
      "size 501 is above UniProt's page maximum of 500, so this page was requested at size 500.";
    expect(out.notice).toBe(notice);
    expect(contentText(result)).toContain(notice);
    expect(requestedUrls(fetch).at(-1)?.searchParams.get('size')).toBe('500');
  });
});
