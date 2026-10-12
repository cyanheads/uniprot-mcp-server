/**
 * @fileoverview uniprot_get_sequence — canonical (and optional isoform)
 *   sequences as FASTA for an accession, parsed into header, sequence, and
 *   length. Kept separate from uniprot_get_entry so sequence-only fetches stay
 *   cheap (FASTA, not the full JSON record). A merged accession is served as its
 *   merge target, labelled with the target and `mergedFrom`.
 * @module mcp-server/tools/definitions/uniprot-get-sequence
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { SequenceResult } from '@/services/uniprot/types.js';
import { ACCESSION_MESSAGE, ACCESSION_REGEX } from '@/services/uniprot/types.js';
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
    'Fetch the canonical amino-acid sequence (FASTA) for a UniProtKB accession, with length and the parsed header. Set include_isoforms to also return the alternatively-spliced isoform sequences. This is the cheap sequence-only path — for the full functional record use uniprot_get_entry. A merged accession returns the sequences of its merge target, labelled with the target accession and the requested one in mergedFrom; a demerged or deleted accession fails not_found naming its replacements or UniParc ID. Accessions come from uniprot_search_proteins or uniprot_map_ids; strip any "-N" isoform suffix (P04637-2 to P04637) before calling.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    accession: z
      .string()
      .regex(ACCESSION_REGEX, ACCESSION_MESSAGE)
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
    accession: z
      .string()
      .describe(
        'The accession whose sequences are returned — the requested one, or its merge target when mergedFrom is present.',
      ),
    mergedFrom: z
      .string()
      .optional()
      .describe(
        'The requested accession, present only when UniProt merged it into accession; every record here is the merge target. Omitted for an active accession.',
      ),
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
      when: 'The accession has no sequence in UniProtKB — unknown, or demerged or deleted; for an inactive accession the message names its replacements or UniParc ID.',
      recovery:
        'Retry with a replacement accession the message names, or verify the accession with uniprot_search_proteins or uniprot_map_ids.',
    },
  ],

  async handler(input, ctx) {
    let served: SequenceResult;
    try {
      served = await getUniProtService().getFasta(input.accession, input.include_isoforms, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message);
      }
      throw err;
    }

    // The first record without an isoform-suffixed id (or simply the first) is canonical.
    // getFasta's return type guarantees at least one record, so records[0] is total.
    const { records } = served;
    const canonical = records.find((r) => !r.isoformId) ?? records[0];
    const isoforms = records.flatMap((r) =>
      r !== canonical && r.isoformId
        ? [{ isoformId: r.isoformId, header: r.header, sequence: r.sequence, length: r.length }]
        : [],
    );

    ctx.log.info('Sequence fetched', {
      accession: served.accession,
      ...(served.mergedFrom ? { mergedFrom: served.mergedFrom } : {}),
      length: canonical.length,
      isoforms: isoforms.length,
    });

    return {
      accession: served.accession,
      ...(served.mergedFrom ? { mergedFrom: served.mergedFrom } : {}),
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
      ...(result.mergedFrom
        ? [
            `**Merged from:** ${result.mergedFrom} was merged into ${result.accession}; these are ${result.accession}'s sequences.`,
          ]
        : []),
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
