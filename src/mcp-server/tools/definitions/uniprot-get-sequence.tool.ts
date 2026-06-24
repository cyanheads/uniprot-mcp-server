/**
 * @fileoverview uniprot_get_sequence — canonical (and optional isoform)
 *   sequences as FASTA for an accession, parsed into header, sequence, and
 *   length. Kept separate from uniprot_get_entry so sequence-only fetches stay
 *   cheap (FASTA, not the full JSON record).
 * @module mcp-server/tools/definitions/uniprot-get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { SequenceRecord } from '@/services/uniprot/types.js';
import { ACCESSION_REGEX } from '@/services/uniprot/types.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const SequenceRecordSchema = z
  .object({
    header: z
      .string()
      .describe(
        'The FASTA header line (without the leading ">"), e.g. "sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4".',
      ),
    sequence: z.string().describe('The amino-acid sequence as a single string (newlines removed).'),
    length: z.number().describe('Sequence length in residues.'),
  })
  .describe('A FASTA sequence record.');

export const getSequence = tool('uniprot_get_sequence', {
  title: 'uniprot-mcp-server: get sequence',
  description:
    'Fetch the canonical amino-acid sequence (FASTA) for a UniProtKB accession, with length and the parsed header. Set include_isoforms to also return the alternatively-spliced isoform sequences. This is the cheap sequence-only path — for the full functional record use uniprot_get_entry. Accessions come from uniprot_search_proteins or uniprot_map_ids; strip any "-N" isoform suffix (P04637-2 to P04637) before calling.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    accession: z
      .string()
      .regex(ACCESSION_REGEX)
      .describe(
        'UniProtKB primary accession, e.g. "P04637". Canonical form only — strip any "-N" isoform suffix.',
      ),
    include_isoforms: z
      .boolean()
      .default(false)
      .describe(
        'When true, also return the isoform sequences. Defaults to false (canonical only).',
      ),
  }),
  output: z.object({
    accession: z.string().describe('The accession that was fetched.'),
    canonical: SequenceRecordSchema.describe('The canonical sequence record.'),
    isoforms: z
      .array(
        SequenceRecordSchema.extend({
          isoformId: z.string().describe('Isoform accession, e.g. "P04637-2".'),
        }).describe('An isoform sequence record.'),
      )
      .optional()
      .describe(
        'Isoform sequence records. Present only when include_isoforms is true and isoforms exist.',
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The accession has no sequence in UniProtKB.',
      recovery: 'Verify the accession with uniprot_search_proteins or uniprot_map_ids, then retry.',
    },
  ],

  async handler(input, ctx) {
    let records: SequenceRecord[];
    try {
      records = await getUniProtService().getFasta(input.accession, input.include_isoforms, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message, {
          ...ctx.recoveryFor('not_found'),
        });
      }
      throw err;
    }

    // The first record without an isoform-suffixed id (or simply the first) is canonical.
    const canonicalIdx = records.findIndex((r) => !r.isoformId);
    const canonical = records[canonicalIdx >= 0 ? canonicalIdx : 0]!;
    const isoforms = records.flatMap((r) =>
      r !== canonical && r.isoformId
        ? [{ isoformId: r.isoformId, header: r.header, sequence: r.sequence, length: r.length }]
        : [],
    );

    ctx.log.info('Sequence fetched', {
      accession: input.accession,
      length: canonical.length,
      isoforms: isoforms.length,
    });

    return {
      accession: input.accession,
      canonical: {
        header: canonical.header,
        sequence: canonical.sequence,
        length: canonical.length,
      },
      ...(input.include_isoforms && isoforms.length ? { isoforms } : {}),
    };
  },

  format: (result) => {
    const lines = [
      `# ${result.accession} — ${result.canonical.length} aa`,
      '```fasta',
      `>${result.canonical.header}`,
      result.canonical.sequence,
      '```',
    ];
    if (result.isoforms?.length) {
      lines.push(`## Isoforms (${result.isoforms.length})`);
      for (const iso of result.isoforms) {
        lines.push(
          `### ${iso.isoformId} — ${iso.length} aa`,
          '```fasta',
          `>${iso.header}`,
          iso.sequence,
          '```',
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
