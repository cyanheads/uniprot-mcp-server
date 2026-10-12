/**
 * @fileoverview Tests for the uniprot://taxonomy/{taxonId} resource — the
 *   not_found regression: a service NotFound must reach the wire as a typed
 *   ctx.fail("not_found") (data.reason === 'not_found' + the taxonId in data),
 *   not a leaked raw throw. Plus the happy path and param validation.
 * @module tests/resources/uniprot-taxonomy.resource.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Taxon } from '@/services/uniprot/types.js';
import {
  expectMcpError,
  rejectUnmockedFetch,
  required,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

const getTaxonByIdMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getTaxonById: getTaxonByIdMock }),
}));

const { taxonomyResource } = await import(
  '@/mcp-server/resources/definitions/uniprot-taxonomy.resource.js'
);

const human: Taxon = {
  taxonId: 9606,
  scientificName: 'Homo sapiens',
  commonName: 'Human',
  mnemonic: 'HUMAN',
  rank: 'species',
  lineage: [{ taxonId: 2759, scientificName: 'Eukaryota', rank: 'superkingdom' }],
};

/** The real service, for tests that drive an upstream response through its error mapping. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const paramsSchema = required(taxonomyResource.params, 'taxonomyResource.params');

describe('taxonomyResource', () => {
  it('rejects a non-numeric taxonId at the param edge', () => {
    expect(() => paramsSchema.parse({ taxonId: 'human' })).toThrow();
  });

  it('names the taxon-ID format and where to resolve a name, not the compiled pattern', () => {
    const parsed = paramsSchema.safeParse({ taxonId: 'abc' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([
      'Must be a numeric NCBI taxon ID such as "9606". Resolve a name with uniprot_get_taxonomy.',
    ]);
    expect(parsed.error?.message).not.toContain('must match pattern');
  });

  it('returns the taxon record for a valid id (coerced to a number for the service)', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    const params = paramsSchema.parse({ taxonId: '9606' });

    const result = (await taxonomyResource.handler(params, ctx)) as Taxon;
    expect(getTaxonByIdMock).toHaveBeenCalledWith(9606, ctx);
    expect(result.taxonId).toBe(9606);
    expect(result.scientificName).toBe('Homo sapiens');
  });

  it('routes the service NotFound through ctx.fail("not_found") with the taxonId in data', async () => {
    getTaxonByIdMock.mockRejectedValue(
      notFound('No taxonomy record for taxon ID 99999999.', { taxonId: 99999999 }),
    );
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    const params = paramsSchema.parse({ taxonId: '99999999' });

    const err = await expectMcpError(taxonomyResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    // The declared recovery hint is filled in by the framework's resource
    // handler, not by this throw site.
    expect(err.data).toMatchObject({ reason: 'not_found', taxonId: '99999999' });
  });

  it.each([
    // Past UniProt's own numeric range: it would answer 400 'For input string: "…"'.
    '100000000000000000000',
    // Number() would print this one as 1e+26.
    '99999999999999999999999999',
    // Number() would round this one to 9007199254740992 and look up a different taxon.
    '9007199254740993',
  ])(
    'answers taxon id %s, past the exact-integer range, as not_found naming it as written, with no request',
    async (taxonId) => {
      // The param pattern bounds the digits, not the magnitude. Real service over a stubbed
      // fetch that answers what UniProt would, so a request that went out would show.
      const fetchStub = vi.fn(() =>
        Promise.resolve(
          upstreamResponse(400, UNIPROT_400_BODIES.taxonIdUnparseable, 'Bad Request'),
        ),
      );
      vi.stubGlobal('fetch', fetchStub);
      getTaxonByIdMock.mockImplementation(realService.getTaxonById.bind(realService));
      const ctx = createMockContext({ errors: taxonomyResource.errors });
      const params = paramsSchema.parse({ taxonId });

      const err = await expectMcpError(taxonomyResource.handler(params, ctx));
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toBe(`No taxonomy record for taxon ID ${taxonId}.`);
      expect(err.data).toMatchObject({ reason: 'not_found', taxonId });
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(
        /For input string|rest\.uniprot\.org|statusCode/,
      );
      expect(fetchStub).not.toHaveBeenCalled();
      expect(getTaxonByIdMock).not.toHaveBeenCalled();
    },
  );

  it('passes the largest exact integer id through to UniProt unchanged', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    await taxonomyResource.handler(paramsSchema.parse({ taxonId: '9007199254740991' }), ctx);
    expect(getTaxonByIdMock).toHaveBeenCalledWith(9007199254740991, ctx);
  });

  it('lets a non-NotFound service error bubble unchanged (not coerced to not_found)', async () => {
    getTaxonByIdMock.mockRejectedValue(serviceUnavailable('UniProt is in maintenance.'));
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    const params = paramsSchema.parse({ taxonId: '9606' });

    const err = await expectMcpError(taxonomyResource.handler(params, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err.data as { reason?: unknown } | undefined)?.reason).toBeUndefined();
  });
});
