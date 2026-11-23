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
import { clampPageSize, countInput, PAGE_SIZE_CAP } from '@/mcp-server/tools/input-limits.js';
import type { MappingIdentityGap } from '@/services/uniprot/types.js';
import {
  describeInactiveInFull,
  ID_MAPPING_FROM_DBS,
  ID_MAPPING_TO_DBS,
  JOB_ID_REGEX,
} from '@/services/uniprot/types.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

/** Mappings per results page when the caller sets no size: about 24 KB with identity and organism names. */
const DEFAULT_PAGE_SIZE = 100;

const FAILED_UPSTREAM =
  'failed upstream (unavailable, rate-limited, or an HTML page instead of JSON)';

/** The identity notice's second sentence: why this page carries no UniProtKB target identity. */
const IDENTITY_GAP_CAUSES: Record<MappingIdentityGap, string> = {
  no_target: "UniProt's job details name no target database, so identity was not requested.",
  details_timeout:
    "Reading the job's target database from UniProt's job details timed out, so identity was not requested.",
  details_failed: `Reading the job's target database from UniProt's job details ${FAILED_UPSTREAM}, so identity was not requested.`,
  details_refused:
    "UniProt refused the job-details read that names the job's target database, so identity was not requested.",
  identity_timeout: 'Reading target identity from UniProt timed out.',
  identity_failed: `Reading target identity from UniProt ${FAILED_UPSTREAM}.`,
  identity_refused:
    'UniProt refused the target-identity read (it refuses one for any job above 100,000 mapped IDs).',
};

const MappingContinuationSchema = z
  .object({
    jobId: z.string().min(1).describe('UniProt ID-mapping job identifier for the completed job.'),
    cursor: z.string().min(1).describe('Opaque cursor for the next completed results page.'),
  })
  .describe('Continuation for the next page of an already-completed mapping job.');

export const mapIds = tool('uniprot_map_ids', {
  title: 'uniprot-mcp-server: map IDs',
  description:
    'Translate identifiers across databases via UniProt\'s ID-mapping service — gene names to accessions, accession to PDB / Ensembl / RefSeq / ChEMBL / GeneID, and back. The job runs asynchronously; this tool submits it and polls within a budget. A running job returns status "running" with a ticket; pass that ticket, without submission inputs, to poll the same job for another budget. A completed call returns status "finished" with one results page of up to size mappings (default 100); when continuation is present, pass it, without submission inputs, to fetch the next page without re-submitting or polling the job. A gene name often maps to one reviewed Swiss-Prot accession plus dozens of unreviewed TrEMBL ones, so target UniProtKB-Swiss-Prot (reviewed only) for the usual intent, or UniProtKB to include TrEMBL. Pair a gene-symbol from_db with tax_id to disambiguate species. A row whose UniProtKB target is inactive (merged, demerged, or deleted) carries an inactive marker naming its replacements. Chain the resulting active accessions into uniprot_get_entry.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    from_db: z
      .enum(ID_MAPPING_FROM_DBS)
      .optional()
      .describe(
        'Source database. Gene_Name = gene symbol (e.g. TP53; pair with tax_id); UniProtKB_AC-ID = accession or entry name; Ensembl/Ensembl_Protein = ENSG/ENSP; PDB; RefSeq_Nucleotide/RefSeq_Protein = NM_/NP_; ChEMBL; GeneID = NCBI Gene. Required only when submitting a new mapping job; omitted when resuming with a ticket or continuation.',
      ),
    to_db: z
      .enum(ID_MAPPING_TO_DBS)
      .optional()
      .describe(
        'Target database. UniProtKB-Swiss-Prot = reviewed accessions only (the usual intent); UniProtKB also includes unreviewed TrEMBL. Required only when submitting a new mapping job; omitted when resuming with a ticket or continuation.',
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
        'Exact NCBI taxon node for submission, e.g. 9606 for human. Unlike protein search taxonomy filters, this excludes descendant strains and subspecies. Resolve the strain taxon with uniprot_get_taxonomy when needed; no descendant filtering is applied to mapped results.',
      ),
    ticket: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Running-job ticket from a prior status "running" response. Pass it without continuation or submission inputs to poll that job for another budget; size may accompany it.',
      ),
    continuation: MappingContinuationSchema.optional().describe(
      'Completed-page continuation from a prior status "finished" response. Pass it without a ticket or submission inputs to fetch the next page without polling or re-submitting; size may accompany it.',
    ),
    size: countInput(PAGE_SIZE_CAP, (clamped) =>
      clamped
        ? `Mappings per completed results page. Default ${DEFAULT_PAGE_SIZE}; a value above ${PAGE_SIZE_CAP}, UniProt's page maximum, returns ${PAGE_SIZE_CAP} and says so. Applies to the page this call returns, beside a submission, a ticket, or a continuation; a continuation resumes at the next mapping whatever size the previous page had.`
        : `Mappings per completed results page, at most ${PAGE_SIZE_CAP}. Default ${DEFAULT_PAGE_SIZE}. Applies to the page this call returns, beside a submission, a ticket, or a continuation; a continuation resumes at the next mapping whatever size the previous page had.`,
    ).optional(),
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
            entryName: z.string().optional().describe('UniProtKB entry name when available.'),
            reviewed: z
              .boolean()
              .optional()
              .describe('Whether UniProtKB marks the target reviewed.'),
            organism: z
              .object({
                taxonId: z.number().describe('Target NCBI taxon ID.'),
                scientificName: z
                  .string()
                  .optional()
                  .describe('Target organism name when available.'),
              })
              .optional()
              .describe('UniProtKB target organism when available.'),
            gene: z.string().optional().describe('Primary target gene name when available.'),
            inactive: z
              .object({
                reason: z
                  .string()
                  .optional()
                  .describe(
                    'UniProt inactiveReasonType: MERGED, DEMERGED, or DELETED. Omitted when UniProt names none.',
                  ),
                replacedBy: z
                  .array(z.string().describe('A replacement UniProtKB accession.'))
                  .optional()
                  .describe(
                    'Accessions that replace the target — the merge target (MERGED) or the demerge products (DEMERGED).',
                  ),
                deletedReason: z
                  .string()
                  .optional()
                  .describe(
                    'Why UniProt deleted the target, when it says. Present on DELETED only.',
                  ),
                uniParcId: z
                  .string()
                  .optional()
                  .describe('UniParc ID that still holds the sequence, when UniProt gives one.'),
              })
              .optional()
              .describe(
                'Present only when the target accession is inactive in UniProtKB — it has no entry to fetch; use replacedBy or uniParcId instead. Absent for an active target.',
              ),
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
        'Running-job ticket (present only when status is "running"). Pass it back as ticket, without submission inputs, to poll the same job.',
      ),
    continuation: MappingContinuationSchema.optional().describe(
      'Next completed-page continuation (finished jobs only). Pass it back as continuation, without submission inputs, to fetch the next page; absent on the terminal page.',
    ),
  }),
  enrichment: {
    mappedCount: z
      .number()
      .optional()
      .describe('Number of resolved mappings on this page (finished jobs only).'),
    totalMappings: z
      .number()
      .optional()
      .describe('Job-wide total mappings reported by UniProt; absent when unavailable.'),
    unmappedIds: z
      .array(z.string().describe('A source ID that resolved to nothing.'))
      .optional()
      .describe(
        'Job-wide source IDs UniProt reported as failed, repeated on every completed page. Absent when none failed.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Status guidance — e.g. that the job is still running or its latest status check failed upstream, that size was above the 500-row page maximum, that no IDs mapped, why target identity is unavailable, or that inactive targets could not be marked on this page.',
      ),
  },
  enrichmentTrailer: {
    unmappedIds: { render: (ids: string[]) => `**Unmapped IDs:** ${ids.join(', ')}` },
  },
  errors: [
    {
      reason: 'mapping_failed',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'UniProt reports a terminal ERROR for the mapping job.',
      recovery:
        'Check the submitted identifiers and databases, then submit a fresh job with fewer identifiers if a mapping limit was exceeded.',
    },
    {
      reason: 'missing_inputs',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No complete submission, running-job ticket, or completed-page continuation was provided.',
      recovery:
        'Provide from_db, to_db, and ids; or a ticket; or a continuation. size may accompany any of them.',
    },
    {
      reason: 'conflicting_inputs',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Submission inputs, a running-job ticket, or a completed-page continuation were combined.',
      recovery:
        'Provide exactly one mode: submission fields, a ticket, or a continuation; size is the one input every mode accepts.',
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
      when: 'The resume ticket is not a UniProt job ID, or is unknown or has expired server-side (UniProt holds jobs only temporarily).',
      recovery: 'Re-submit the original from_db/to_db/ids to start a fresh mapping job.',
    },
    {
      reason: 'invalid_continuation',
      code: JsonRpcErrorCode.NotFound,
      when: 'The completed-page continuation has an invalid job ID, is unknown or expired, or UniProt rejected the page with HTTP 400.',
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
      throw ctx.fail('conflicting_inputs');
    }

    // A ticket or continuation job id becomes a segment of the /idmapping request paths,
    // so only UniProt's job-id shape (JOB_ID_REGEX) is sent. The input schema stays
    // pattern-free; the check runs here, before any request.
    const allowedJobId = 'it may hold only letters, digits, "-", and "_".';
    if (input.ticket && !JOB_ID_REGEX.test(input.ticket)) {
      throw ctx.fail('invalid_ticket', `Mapping ticket is not a UniProt job ID: ${allowedJobId}`);
    }
    if (input.continuation && !JOB_ID_REGEX.test(input.continuation.jobId)) {
      throw ctx.fail(
        'invalid_continuation',
        `Continuation jobId is not a UniProt job ID: ${allowedJobId}`,
      );
    }

    const service = getUniProtService();
    // size is the one input every mode shares; UniProt answers a size above its maximum with a 400.
    const pageSize = clampPageSize(input.size ?? DEFAULT_PAGE_SIZE, 'uniprot_map_ids', ctx);
    let result: Awaited<ReturnType<typeof service.mapIds>>;
    let mode: 'start' | 'ticket' | 'continuation';

    if (input.ticket) {
      mode = 'ticket';
      try {
        result = await service.resumeMapping(input.ticket, pageSize.applied, ctx);
      } catch (err) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail(
            'invalid_ticket',
            `Mapping ticket "${input.ticket}" is unknown or expired.`,
          );
        }
        throw err;
      }
    } else if (input.continuation) {
      mode = 'continuation';
      try {
        result = await service.resumeMappingPage(input.continuation, pageSize.applied, ctx);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
          throw ctx.fail(
            'invalid_continuation',
            'UniProt rejected the completed mapping page continuation.',
            undefined,
            { cause: err },
          );
        }
        if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
          throw ctx.fail(
            'invalid_continuation',
            'The completed mapping page is unknown or expired.',
          );
        }
        throw err;
      }
    } else {
      mode = 'start';
      if (!input.from_db || !input.to_db || !input.ids?.length) {
        throw ctx.fail('missing_inputs');
      }
      try {
        result = await service.mapIds(
          input.from_db,
          input.to_db,
          input.ids,
          input.tax_id,
          pageSize.applied,
          ctx,
        );
      } catch (err) {
        if (err instanceof McpError && err.data?.reason === 'unsupported_db_pair') {
          throw ctx.fail(
            'unsupported_db_pair',
            `Mapping ${input.from_db} → ${input.to_db} is not supported.`,
          );
        }
        throw err;
      }
    }

    if (result.status === 'running') {
      ctx.enrich.notice(
        result.statusCheckFailed
          ? `The latest status check of this mapping job failed upstream, so it is reported as running and may have finished since. Re-call with ticket "${result.ticket}" to keep polling it.`
          : `Mapping job still running after the inline budget. Re-call with ticket "${result.ticket}" to keep polling it.`,
      );
      ctx.log.info('ID mapping exceeded inline budget', {
        ticket: result.ticket,
        mode,
        ...(result.statusCheckFailed ? { statusCheckFailed: true } : {}),
        ...(input.from_db ? { from: input.from_db } : {}),
        ...(input.to_db ? { to: input.to_db } : {}),
      });
      return { status: 'running' as const, ticket: result.ticket };
    }

    ctx.enrich({
      mappedCount: result.results.length,
      ...(result.totalMappings !== undefined ? { totalMappings: result.totalMappings } : {}),
      ...(result.failedIds.length ? { unmappedIds: result.failedIds } : {}),
    });
    // ctx.enrich.notice is last-wins, so every notice that applies to the page goes out as one.
    const notices: string[] = [];
    if (pageSize.notice) notices.push(pageSize.notice);
    if (result.results.length === 0) {
      notices.push(
        'Completed result page contains no mappings in the target database. Mapping tax_id matches an exact taxon node; use uniprot_get_taxonomy to resolve the strain taxon, or omit tax_id for a deliberately global job. Protein search taxonomy filters include descendants.',
      );
    }
    if (result.identityUnavailable)
      notices.push(
        `UniProtKB target identity is unavailable for this page; generic source-to-target mappings remain usable. ${IDENTITY_GAP_CAUSES[result.identityUnavailable]}`,
      );
    if (result.inactiveUnchecked) {
      notices.push(
        `UniProt reports ${result.inactiveUnchecked} inactive (merged, demerged, or deleted) target accession(s) in this job, but they could not be identified on this page. Retry the call to mark them, or check a target with uniprot_get_entry.`,
      );
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));
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
      } else if (
        results.some(
          (r) =>
            r.entryName !== undefined ||
            r.reviewed !== undefined ||
            r.organism !== undefined ||
            r.gene !== undefined,
        )
      ) {
        // A page carrying UniProtKB identity gets one row per mapping, blank where a value is absent.
        lines.push(
          '',
          '| From | To | Entry | Reviewed | Organism | Gene |',
          '| --- | --- | --- | --- | --- | --- |',
        );
        for (const r of results) {
          const organism = r.organism
            ? `${r.organism.scientificName ? `${r.organism.scientificName} ` : ''}[taxon ${r.organism.taxonId}]`
            : '';
          lines.push(
            `| ${r.from} | ${r.to} | ${r.entryName ?? ''} | ${r.reviewed ?? ''} | ${organism} | ${r.gene ?? ''} |`,
          );
        }
      } else {
        lines.push('', '| From | To |', '| --- | --- |');
        for (const r of results) lines.push(`| ${r.from} | ${r.to} |`);
      }
      const inactiveRows = results.filter((r) => r.inactive);
      if (inactiveRows.length) {
        lines.push('', '**Inactive targets** (no entry to fetch):');
        for (const r of inactiveRows) {
          lines.push(`- ${r.from} → ${describeInactiveInFull({ accession: r.to, ...r.inactive })}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
