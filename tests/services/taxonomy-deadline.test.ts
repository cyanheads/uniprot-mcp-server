/**
 * @fileoverview Taxonomy name resolution shares one deadline across candidate pages.
 * @module tests/services/taxonomy-deadline.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { getTaxonomy } from '@/mcp-server/tools/definitions/uniprot-get-taxonomy.tool.js';
import { initUniProtService, UniProtService } from '@/services/uniprot/uniprot-service.js';
import { contentText, errorEnvelope } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['service', 'tool'])(
  'returns incomplete candidates through %s after its deadline',
  async (surface) => {
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
      ms === 45_000 ? deadline.signal : originalTimeout(ms),
    );
    const next = 'https://rest.uniprot.org/taxonomy/search?cursor=remaining';
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ taxonId: 9606, scientificName: 'Homo sapiens' }] }),
          { headers: { link: `<${next}>; rel="next"` } },
        ),
      )
      .mockImplementationOnce((_url: unknown, options: RequestInit) => {
        deadline.abort(new DOMException('Lookup deadline reached', 'TimeoutError'));
        if (options.signal?.aborted) return Promise.reject(options.signal.reason);
        return Promise.resolve(
          new Response(
            JSON.stringify({ results: [{ taxonId: 999, scientificName: 'Homo sapiens' }] }),
          ),
        );
      });
    vi.stubGlobal('fetch', fetchStub);
    if (surface === 'service') {
      const service = new UniProtService({} as never, {} as never);
      await expect(
        service.getTaxonByName('Homo sapiens', createMockContext()),
      ).rejects.toMatchObject({
        data: { reason: 'incomplete_candidates' },
        message: expect.stringContaining(next),
      });
    } else {
      initUniProtService({} as never, {} as never);
      const result = await runToolContract(getTaxonomy, { name: 'Homo sapiens' });
      expect(errorEnvelope(result).data).toMatchObject({ reason: 'incomplete_candidates' });
      const text = contentText(result);
      expect(text).toContain(next);
      expect(text).toContain('9606: Homo sapiens');
      expect(text).toContain('Recovery:');
    }
    expect(fetchStub).toHaveBeenCalledTimes(2);
  },
);
