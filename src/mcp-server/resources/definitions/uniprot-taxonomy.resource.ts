/**
 * @fileoverview uniprot://taxonomy/{taxonId} — a taxonomy record by NCBI taxon
 *   ID (name, rank, lineage), the injectable-context mirror of
 *   uniprot_get_taxonomy by-ID. Tool-only clients reach the same data via
 *   uniprot_get_taxonomy.
 * @module mcp-server/resources/definitions/uniprot-taxonomy
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

export const taxonomyResource = resource('uniprot://taxonomy/{taxonId}', {
  name: 'UniProt taxonomy record',
  description:
    'A taxonomy record by NCBI taxon ID — scientific/common name, rank, parent, and full lineage. The resource mirror of uniprot_get_taxonomy by ID.',
  mimeType: 'application/json',
  params: z.object({
    taxonId: z
      .string()
      .regex(
        /^[0-9]+$/,
        'Must be a numeric NCBI taxon ID such as "9606". Resolve a name with uniprot_get_taxonomy.',
      )
      .describe('NCBI taxonomy ID as a string, e.g. "9606" for human.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The taxon ID did not resolve to a record.',
      recovery: 'Check the NCBI taxon ID, or resolve a name with uniprot_get_taxonomy.',
    },
  ],

  async handler(params, ctx) {
    // The pattern bounds the digits, not the magnitude. Past 2^53 a number can't hold the
    // id exactly — it would print as 1e+26 or round onto another taxon — and no NCBI taxon
    // ID comes near that range, so such an id is answered here without a request.
    const taxonId = Number(params.taxonId);
    if (!Number.isSafeInteger(taxonId)) {
      throw ctx.fail('not_found', `No taxonomy record for taxon ID ${params.taxonId}.`, {
        taxonId: params.taxonId,
      });
    }
    try {
      return await getUniProtService().getTaxonById(taxonId, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message, { taxonId: params.taxonId });
      }
      throw err;
    }
  },
});
