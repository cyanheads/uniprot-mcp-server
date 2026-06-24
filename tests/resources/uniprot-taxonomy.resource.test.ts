/**
 * @fileoverview Tests for the uniprot://taxonomy/{taxonId} resource — the
 *   not_found regression: a service NotFound must reach the wire as a typed
 *   ctx.fail("not_found") (data.reason === 'not_found' + the taxonId in data),
 *   not a leaked raw throw. Plus the happy path and param validation.
 * @module tests/resources/uniprot-taxonomy.resource.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Taxon } from '@/services/uniprot/types.js';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('taxonomyResource', () => {
  it('rejects a non-numeric taxonId at the param edge', () => {
    expect(() => taxonomyResource.params.parse({ taxonId: 'human' })).toThrow();
  });

  it('returns the taxon record for a valid id (coerced to a number for the service)', async () => {
    getTaxonByIdMock.mockResolvedValue(human);
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    const params = taxonomyResource.params.parse({ taxonId: '9606' });

    const result = await taxonomyResource.handler(params, ctx);
    expect(getTaxonByIdMock).toHaveBeenCalledWith(9606, ctx);
    expect(result.taxonId).toBe(9606);
    expect(result.scientificName).toBe('Homo sapiens');
  });

  it('routes the service NotFound through ctx.fail("not_found") with the taxonId in data', async () => {
    getTaxonByIdMock.mockRejectedValue(
      notFound('No taxonomy record for taxon ID 99999999.', { taxonId: 99999999 }),
    );
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    const params = taxonomyResource.params.parse({ taxonId: '99999999' });

    const err = await taxonomyResource.handler(params, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found', taxonId: '99999999' });
    expect((err.data as { recovery?: unknown }).recovery).toBeDefined();
  });

  it('lets a non-NotFound service error bubble unchanged (not coerced to not_found)', async () => {
    getTaxonByIdMock.mockRejectedValue(serviceUnavailable('UniProt is in maintenance.'));
    const ctx = createMockContext({ errors: taxonomyResource.errors });
    const params = taxonomyResource.params.parse({ taxonId: '9606' });

    const err = await taxonomyResource.handler(params, ctx).catch((e) => e as McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err.data as { reason?: unknown } | undefined)?.reason).toBeUndefined();
  });
});
