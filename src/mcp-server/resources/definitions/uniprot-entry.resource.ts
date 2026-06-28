/**
 * @fileoverview uniprot://entry/{accession} — a curated UniProtKB entry by
 *   accession, the injectable-context mirror of uniprot_get_entry's single
 *   accession path. Tool-only clients lose nothing: the same record is reachable
 *   via uniprot_get_entry. Annotation-heavy entries (P04637 serializes to ~360 KB)
 *   would otherwise inject the whole high-cardinality record; when one exceeds the
 *   outline budget this returns a bounded identity summary plus a section outline
 *   (names + byte sizes) and points to uniprot_get_entry for specific sections —
 *   the resource URI has no sections parameter of its own.
 * @module mcp-server/resources/definitions/uniprot-entry
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { outlineOnOverflow, selectSections } from '@cyanheads/mcp-ts-core/utils';
import { ACCESSION_REGEX } from '@/services/uniprot/types.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

/**
 * Small, always-present identity columns kept in the overflow summary so the
 * outline still names the protein it describes. Mirrors the alwaysKeep set
 * uniprot_get_entry projects on its outline path.
 */
const IDENTITY_FIELDS = [
  'accession',
  'entryName',
  'proteinName',
  'genes',
  'organism',
  'length',
  'reviewed',
  'annotationScore',
  'proteinExistence',
];

export const entryResource = resource('uniprot://entry/{accession}', {
  name: 'UniProtKB entry',
  description:
    'A curated UniProtKB entry by accession — function, catalytic activity, disease, variants, GO terms, and cross-references. The resource mirror of uniprot_get_entry for a single accession. An annotation-heavy entry over the outline budget returns a bounded identity summary plus a section outline (names + byte sizes) instead of the full record — fetch specific sections with the uniprot_get_entry tool (sections:[...]).',
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

    // Cap annotation-heavy entries: outline the record instead of injecting the
    // whole thing. The resource URI takes no sections argument, so the re-call
    // notice routes the agent to the uniprot_get_entry tool's sections path.
    const doc = entry as unknown as Record<string, unknown>;
    const outcome = outlineOnOverflow(doc, {
      notice: (sections) =>
        `Entry ${entry.accession} is too large to inline. Fetch specific sections with the uniprot_get_entry tool (accessions:["${entry.accession}"], sections:[...]) — e.g. ${sections
          .slice(0, 3)
          .map((s) => s.name)
          .join(', ')}.`,
    });
    if (outcome.kind === 'outline') {
      ctx.log.info('Entry resource exceeded budget — returning outline', {
        accession: entry.accession,
        sections: outcome.sections.length,
      });
      return {
        ...selectSections(doc, [], { alwaysKeep: IDENTITY_FIELDS }),
        kind: 'outline' as const,
        sections: outcome.sections,
        notice: outcome.notice,
      };
    }
    return entry;
  },
});
