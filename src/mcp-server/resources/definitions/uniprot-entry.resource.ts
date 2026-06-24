/**
 * @fileoverview uniprot://entry/{accession} — a curated UniProtKB entry by
 *   accession, the injectable-context mirror of uniprot_get_entry's single
 *   accession path. Tool-only clients lose nothing: the same record is reachable
 *   via uniprot_get_entry.
 * @module mcp-server/resources/definitions/uniprot-entry
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const ACCESSION_REGEX =
  /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

export const entryResource = resource('uniprot://entry/{accession}', {
  name: 'UniProtKB entry',
  description:
    'A curated UniProtKB entry by accession — function, catalytic activity, disease, variants, GO terms, and cross-references. The resource mirror of uniprot_get_entry for a single accession.',
  mimeType: 'application/json',
  params: z.object({
    accession: z
      .string()
      .regex(ACCESSION_REGEX)
      .describe(
        'UniProtKB primary accession, e.g. "P04637". Canonical form only — strip any "-N" isoform suffix.',
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The accession was not found in UniProtKB.',
      recovery: 'Verify the accession with uniprot_search_proteins or uniprot_map_ids first.',
    },
  ],

  async handler(params, ctx) {
    const entries = await getUniProtService().getEntries([params.accession], undefined, ctx);
    const entry = entries.find((e) => e.accession === params.accession);
    if (!entry) {
      throw ctx.fail('not_found', `Accession ${params.accession} not found in UniProtKB.`, {
        accession: params.accession,
        ...ctx.recoveryFor('not_found'),
      });
    }
    return entry;
  },
});
