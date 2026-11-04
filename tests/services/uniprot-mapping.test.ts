/** @fileoverview Mapping HTTP regression coverage. @module tests/services/uniprot-mapping */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { mapIds } from '@/mcp-server/tools/definitions/uniprot-map-ids.tool.js';
import { initUniProtService, UniProtService } from '@/services/uniprot/uniprot-service.js';

afterEach(() => vi.unstubAllGlobals());
const service = () => new UniProtService({} as never, {} as never);

it('preserves completed generic empty pages and job-wide failed IDs (characterization)', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ results: [], failedIds: ['missing'] }))),
  );
  expect(
    await service().resumeMappingPage({ jobId: 'job', cursor: 'end' }, createMockContext()),
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
  await expect(service().resumeMapping('job', createMockContext())).rejects.toMatchObject({
    data: { reason: 'mapping_failed' },
    message: expect.stringContaining('500,000'),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
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
    await service().resumeMappingPage({ jobId: 'job', cursor: 'page2' }, createMockContext()),
  ).toEqual({
    status: 'finished',
    results: [{ from: 'x', to: 'P04637' }],
    totalMappings: 100001,
    failedIds: ['missing'],
    identityUnavailable: true,
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
    await service().resumeMappingPage({ jobId: 'job', cursor: 'end' }, createMockContext()),
  ).toEqual({ status: 'finished', results: [], failedIds: ['missing'], identityUnavailable: true });
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
    service().resumeMappingPage({ jobId: 'job', cursor: 'c' }, createMockContext()),
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
    service().resumeMappingPage({ jobId: 'job', cursor: 'c' }, createMockContext()),
  ).resolves.toMatchObject({
    results: [{ from: 'P53_HUMAN', to: 'P04637' }],
    failedIds: ['missing'],
    totalMappings: 1,
    identityUnavailable: true,
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
    createMockContext({ signal: controller.signal }),
  );
  const assertion = expect(pending).rejects.toMatchObject({ code: -32011 });
  await started.promise;
  controller.abort();
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('degrades an expired optional deadline without cancelling generic results', async () => {
  const deadline = new AbortController();
  const nativeTimeout = AbortSignal.timeout;
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  timeout.mockImplementation((ms) => (ms === 2000 ? deadline.signal : nativeTimeout(ms)));
  const fetch = vi.fn((input: unknown, options: RequestInit) => {
    const url = String(input);
    if (url.includes('/details/')) return Promise.resolve(Response.json({ to: 'UniProtKB' }));
    if (!url.includes('/uniprotkb/'))
      return Promise.resolve(Response.json({ results: [{ from: 'x', to: 'P04637' }] }));
    return new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      });
      deadline.abort();
    });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    expect(
      await service().resumeMappingPage({ jobId: 'job', cursor: 'c' }, createMockContext()),
    ).toMatchObject({ results: [{ from: 'x', to: 'P04637' }], identityUnavailable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    timeout.mockRestore();
  }
});
