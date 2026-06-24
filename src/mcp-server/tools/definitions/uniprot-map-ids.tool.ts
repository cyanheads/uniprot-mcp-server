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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ID_MAPPING_FROM_DBS, ID_MAPPING_TO_DBS } from '@/services/uniprot/types.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

export const mapIds = tool('uniprot_map_ids', {
  title: 'uniprot-mcp-server: map IDs',
  description:
    'Translate identifiers across databases via UniProt\'s ID-mapping service — gene names to accessions, accession to PDB / Ensembl / RefSeq / ChEMBL / GeneID, and back. The job runs asynchronously; this tool submits it and polls within a budget. If it finishes in time you get status "finished" with the mappings; if it runs long you get status "running" with a ticket — re-call with that ticket (and no other inputs) to fetch the result without re-submitting. A gene name often maps to one reviewed Swiss-Prot accession plus dozens of unreviewed TrEMBL ones, so target UniProtKB-Swiss-Prot (reviewed only) for the usual intent, or UniProtKB / UniProtKB_AC-ID to include TrEMBL. Pair a gene-symbol from_db with tax_id to disambiguate species. Chain the resulting accessions into uniprot_get_entry.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    from_db: z
      .enum(ID_MAPPING_FROM_DBS)
      .optional()
      .describe(
        'Source database. Gene_Name = HGNC symbol (pair with tax_id); UniProtKB_AC-ID = accession or entry name; Ensembl/Ensembl_Protein = ENSG/ENSP; PDB; RefSeq_Nucleotide/RefSeq_Protein = NM_/NP_; ChEMBL; GeneID = NCBI Gene. Required unless resuming with a ticket.',
      ),
    to_db: z
      .enum(ID_MAPPING_TO_DBS)
      .optional()
      .describe(
        'Target database. UniProtKB-Swiss-Prot = reviewed accessions only (the usual intent); UniProtKB / UniProtKB_AC-ID also include unreviewed TrEMBL. Required unless resuming with a ticket.',
      ),
    ids: z
      .array(
        z
          .string()
          .describe('A source identifier in the from_db namespace, e.g. "TP53" for Gene_Name.'),
      )
      .max(100_000)
      .optional()
      .describe('Identifiers to translate. Required unless resuming with a ticket.'),
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
      .optional()
      .describe(
        'A ticket from a prior status "running" response. Pass this alone (no from_db/to_db/ids) to fetch the completed result.',
      ),
  }),
  output: z.object({
    status: z
      .enum(['finished', 'running'])
      .describe('Job state: "finished" (results included) or "running" (re-call with the ticket).'),
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
        'Resolved mappings (present when status is "finished"). A source ID with no mapping is simply absent.',
      ),
    ticket: z
      .string()
      .optional()
      .describe(
        'Resumable job ticket (present when status is "running"). Re-call this tool with ticket set, and nothing else, to fetch the result.',
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
        'Input IDs with no mapping in the target database (finished jobs only). Absent when resuming or all mapped.',
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
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither a ticket nor the full from_db/to_db/ids triple was provided.',
      recovery: 'Provide from_db, to_db, and ids to start a job, or a ticket alone to resume one.',
    },
    {
      reason: 'unsupported_db_pair',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The from_db/to_db combination is not supported by the ID-mapping service.',
      recovery: 'Check the enum values, or route through UniProtKB as an intermediate database.',
    },
  ],

  async handler(input, ctx) {
    // Resume path — ticket alone.
    if (input.ticket) {
      const result = await getUniProtService().resumeMapping(input.ticket, ctx);
      if (result.status === 'running') {
        ctx.enrich.notice('Mapping job is still running. Re-call with the same ticket shortly.');
        return { status: 'running' as const, ticket: result.ticket };
      }
      ctx.enrich({ mappedCount: result.results.length });
      if (result.results.length === 0)
        ctx.enrich.notice('Job finished with no mappings in the target database.');
      return { status: 'finished' as const, results: result.results };
    }

    // Start path — requires the full from/to/ids triple. Validate before touching the service.
    if (!input.from_db || !input.to_db || !input.ids?.length) {
      throw ctx.fail('missing_inputs', undefined, { ...ctx.recoveryFor('missing_inputs') });
    }
    const service = getUniProtService();

    let result: Awaited<ReturnType<typeof service.mapIds>>;
    try {
      result = await service.mapIds(input.from_db, input.to_db, input.ids, input.tax_id, ctx);
    } catch (err) {
      // UniProt rejects unsupported pairs at submission with a 400 + message.
      if (
        err instanceof Error &&
        /not supported|invalid.*(from|to)|status code 400/i.test(err.message)
      ) {
        throw ctx.fail(
          'unsupported_db_pair',
          `Mapping ${input.from_db} → ${input.to_db} is not supported.`,
          {
            ...ctx.recoveryFor('unsupported_db_pair'),
          },
        );
      }
      throw err;
    }

    if (result.status === 'running') {
      ctx.enrich.notice(
        `Mapping job still running after the inline budget. Re-call with ticket "${result.ticket}" to fetch results.`,
      );
      ctx.log.info('ID mapping exceeded inline budget', {
        ticket: result.ticket,
        from: input.from_db,
        to: input.to_db,
      });
      return { status: 'running' as const, ticket: result.ticket };
    }

    const mappedFrom = new Set(result.results.map((r) => r.from));
    const unmapped = input.ids.filter((id) => !mappedFrom.has(id));
    ctx.enrich({
      mappedCount: result.results.length,
      ...(unmapped.length ? { unmappedIds: unmapped } : {}),
    });
    if (result.results.length === 0) {
      ctx.enrich.notice(
        `No ${input.from_db} IDs mapped to ${input.to_db}. Check the IDs and database pair, or add tax_id.`,
      );
    }
    ctx.log.info('ID mapping finished', {
      from: input.from_db,
      to: input.to_db,
      mapped: result.results.length,
      unmapped: unmapped.length,
    });

    return { status: 'finished' as const, results: result.results };
  },

  format: (result) => {
    const lines = [`**Status:** ${result.status}`];
    if (result.ticket)
      lines.push(`**Ticket:** ${result.ticket} (re-call with this to fetch results)`);
    const results = result.results ?? [];
    if (result.status === 'finished') {
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
