/**
 * @fileoverview uniprot_map_ids — translate identifiers across databases via
 *   UniProt's async ID-mapping service (run → poll → results within a bounded
 *   budget). On overflow it returns a resumable ticket (the job is held
 *   server-side) so the agent re-calls with the ticket rather than re-submitting.
 *   The bridge tool: every sibling server's identifier (a gene from ensembl, a
 *   target from chembl, a structure from protein) enters UniProt through here.
 * @module mcp-server/tools/definitions/uniprot-map-ids
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { ID_MAPPING_FROM_DBS, ID_MAPPING_TO_DBS } from '@/services/uniprot/types.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const MappingContinuationSchema = z
  .object({
    jobId: z.string().min(1).describe('UniProt ID-mapping job identifier for the completed job.'),
    cursor: z.string().min(1).describe('Opaque cursor for the next completed results page.'),
  })
  .describe('Continuation for the next page of an already-completed mapping job.');

export const mapIds = tool('uniprot_map_ids', {
  title: 'uniprot-mcp-server: map IDs',
  description:
    'Translate identifiers across databases via UniProt\'s ID-mapping service — gene names to accessions, accession to PDB / Ensembl / RefSeq / ChEMBL / GeneID, and back. The job runs asynchronously; this tool submits it and polls within a budget. A running job returns status "running" with a ticket; pass that ticket alone to poll the same job. A completed call returns status "finished" with one results page; when continuation is present, pass it alone to fetch the next completed page without re-submitting or polling the job. A gene name often maps to one reviewed Swiss-Prot accession plus dozens of unreviewed TrEMBL ones, so target UniProtKB-Swiss-Prot (reviewed only) for the usual intent, or UniProtKB / UniProtKB_AC-ID to include TrEMBL. Pair a gene-symbol from_db with tax_id to disambiguate species. Chain the resulting accessions into uniprot_get_entry.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    from_db: z
      .enum(ID_MAPPING_FROM_DBS)
      .optional()
      .describe(
        'Source database. Gene_Name = HGNC symbol (pair with tax_id); UniProtKB_AC-ID = accession or entry name; Ensembl/Ensembl_Protein = ENSG/ENSP; PDB; RefSeq_Nucleotide/RefSeq_Protein = NM_/NP_; ChEMBL; GeneID = NCBI Gene. Required only when submitting a new mapping job; omitted when resuming with a ticket or continuation.',
      ),
    to_db: z
      .enum(ID_MAPPING_TO_DBS)
      .optional()
      .describe(
        'Target database. UniProtKB-Swiss-Prot = reviewed accessions only (the usual intent); UniProtKB / UniProtKB_AC-ID also include unreviewed TrEMBL. Required only when submitting a new mapping job; omitted when resuming with a ticket or continuation.',
      ),
    ids: z
      .array(
        z
          .string()
          .describe('A source identifier in the from_db namespace, e.g. "TP53" for Gene_Name.'),
      )
      .max(100_000)
      .optional()
      .describe(
        'Identifiers to translate. Required only when submitting a new mapping job; omitted when resuming with a ticket or continuation.',
      ),
    tax_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'NCBI taxon ID to disambiguate ambiguous source IDs (e.g. a gene symbol across species). Recommended with Gene_Name; e.g. 9606 for human.',
      ),
    ticket: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Running-job ticket from a prior status "running" response. Pass it alone to poll that job; do not combine it with continuation or submission inputs.',
      ),
    continuation: MappingContinuationSchema.optional().describe(
      'Completed-page continuation from a prior status "finished" response. Pass it alone to fetch the next page without polling or re-submitting.',
    ),
  }),
  output: z.object({
    status: z
      .enum(['finished', 'running'])
      .describe(
        'Job state: "finished" (one completed results page included) or "running" (poll with ticket).',
      ),
    results: z
      .array(
        z
          .object({
            from: z.string().describe('The source identifier that was mapped.'),
            to: z.string().describe('The resolved target identifier (e.g. a UniProtKB accession).'),
          })
          .describe('A single from→to mapping.'),
      )
      .optional()
      .describe(
        'Resolved mappings on this completed page (present only when status is "finished"). Failed source IDs are reported in unmappedIds.',
      ),
    ticket: z
      .string()
      .optional()
      .describe(
        'Running-job ticket (present only when status is "running"). Pass it alone to poll the same job.',
      ),
    continuation: MappingContinuationSchema.optional().describe(
      'Next completed-page continuation (finished jobs only). Pass it alone to fetch the next page; absent on the terminal page.',
    ),
  }),
  enrichment: {
    mappedCount: z
      .number()
      .optional()
      .describe('Number of resolved mappings (finished jobs only).'),
    unmappedIds: z
      .array(z.string().describe('A source ID that resolved to nothing.'))
      .optional()
      .describe(
        'Source IDs UniProt reported as failed on this completed page. Absent when none failed.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Status guidance — e.g. that the job is still running, or that no IDs mapped.'),
  },
  enrichmentTrailer: {
    unmappedIds: { render: (ids: string[]) => `**Unmapped IDs:** ${ids.join(', ')}` },
  },
  errors: [
    {
      reason: 'missing_inputs',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No complete submission, running-job ticket, or completed-page continuation was provided.',
      recovery: 'Provide from_db, to_db, and ids; a ticket alone; or a continuation alone.',
    },
    {
      reason: 'conflicting_inputs',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Submission inputs, a running-job ticket, or a completed-page continuation were combined.',
      recovery: 'Provide exactly one mode: submission fields, ticket alone, or continuation alone.',
    },
    {
      reason: 'unsupported_db_pair',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The from_db/to_db combination is not supported by the ID-mapping service.',
      recovery: 'Check the enum values, or route through UniProtKB as an intermediate database.',
    },
    {
      reason: 'invalid_ticket',
      code: JsonRpcErrorCode.NotFound,
      when: 'The resume ticket is unknown or has expired server-side (UniProt holds jobs only temporarily).',
      recovery: 'Re-submit the original from_db/to_db/ids to start a fresh mapping job.',
    },
    {
      reason: 'invalid_continuation',
      code: JsonRpcErrorCode.NotFound,
      when: 'The completed-page continuation refers to a result page that is unknown or expired.',
      recovery: 'Restart the mapping job and use each returned continuation before it expires.',
    },
  ],

  async handler(input, ctx) {
    const hasSubmissionInputs =
      input.from_db !== undefined ||
      input.to_db !== undefined ||
      input.ids !== undefined ||
      input.tax_id !== undefined;
    if (
      (input.ticket && (input.continuation || hasSubmissionInputs)) ||
      (input.continuation && hasSubmissionInputs)
    ) {
      throw ctx.fail('conflicting_inputs', undefined, {
        ...ctx.recoveryFor('conflicting_inputs'),
      });
    }

    const service = getUniProtService();
    let result: Awaited<ReturnType<typeof service.mapIds>>;
    let mode: 'start' | 'ticket' | 'continuation';

    if (input.ticket) {
      mode = 'ticket';
      try {
        result = await service.resumeMapping(input.ticket, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail(
            'invalid_ticket',
            `Mapping ticket "${input.ticket}" is unknown or expired.`,
            {
              ...ctx.recoveryFor('invalid_ticket'),
            },
          );
        }
        throw err;
      }
    } else if (input.continuation) {
      mode = 'continuation';
      try {
        result = await service.resumeMappingPage(input.continuation, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail(
            'invalid_continuation',
            'The completed mapping page is unknown or expired.',
            { ...ctx.recoveryFor('invalid_continuation') },
          );
        }
        throw err;
      }
    } else {
      mode = 'start';
      if (!input.from_db || !input.to_db || !input.ids?.length) {
        throw ctx.fail('missing_inputs', undefined, { ...ctx.recoveryFor('missing_inputs') });
      }
      try {
        result = await service.mapIds(input.from_db, input.to_db, input.ids, input.tax_id, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
          throw ctx.fail(
            'unsupported_db_pair',
            `Mapping ${input.from_db} → ${input.to_db} is not supported.`,
            { ...ctx.recoveryFor('unsupported_db_pair') },
          );
        }
        throw err;
      }
    }

    if (result.status === 'running') {
      const notice =
        mode === 'ticket'
          ? 'Mapping job is still running. Re-call with the same ticket shortly.'
          : `Mapping job still running after the inline budget. Re-call with ticket "${result.ticket}" to poll it.`;
      ctx.enrich.notice(notice);
      ctx.log.info('ID mapping exceeded inline budget', {
        ticket: result.ticket,
        mode,
        ...(input.from_db ? { from: input.from_db } : {}),
        ...(input.to_db ? { to: input.to_db } : {}),
      });
      return { status: 'running' as const, ticket: result.ticket };
    }

    ctx.enrich({
      mappedCount: result.results.length,
      ...(result.failedIds.length ? { unmappedIds: result.failedIds } : {}),
    });
    if (result.results.length === 0) {
      ctx.enrich.notice('Completed result page contains no mappings in the target database.');
    }
    ctx.log.info('ID mapping finished', {
      mode,
      ...(input.from_db ? { from: input.from_db } : {}),
      ...(input.to_db ? { to: input.to_db } : {}),
      mapped: result.results.length,
      unmapped: result.failedIds.length,
      hasContinuation: result.continuation !== undefined,
    });

    return {
      status: 'finished' as const,
      results: result.results,
      ...(result.continuation ? { continuation: result.continuation } : {}),
    };
  },

  format: (result) => {
    const lines = [`**Status:** ${result.status}`];
    if (result.ticket)
      lines.push(`**Ticket:** ${result.ticket} (re-call with this to poll the running job)`);
    if (result.status === 'finished') {
      if (result.continuation) {
        lines.push(
          `**Next page:** re-call with continuation {"jobId":"${result.continuation.jobId}","cursor":"${result.continuation.cursor}"}`,
        );
      }
      const results = result.results ?? [];
      if (results.length === 0) {
        lines.push('No mappings resolved.');
      } else {
        lines.push('', '| From | To |', '| --- | --- |');
        for (const r of results) lines.push(`| ${r.from} | ${r.to} |`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
