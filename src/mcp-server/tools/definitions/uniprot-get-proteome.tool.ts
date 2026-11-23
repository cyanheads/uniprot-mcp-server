/**
 * @fileoverview uniprot_get_proteome — a proteome by UPID, or an organism's
 *   reference proteome by taxon ID (exactly one). Returns metadata inline (type
 *   and any exclusion reasons, protein and gene counts, reviewed/unreviewed/isoform
 *   counts, CPD status, BUSCO completeness, genome assembly) and, when
 *   include_proteins is set, an opt-in cursor-paginated, capped protein list with
 *   truncation disclosure.
 * @module mcp-server/tools/definitions/uniprot-get-proteome
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { activeServerConfig, getServerConfig } from '@/config/server-config.js';
import { clampPageSize, countInput, PAGE_SIZE_CAP } from '@/mcp-server/tools/input-limits.js';
import { lengthLabel, moleculeLabel } from '@/mcp-server/tools/protein-format.js';
import { proteomeQuery } from '@/services/uniprot/proteome-query.js';
import { queryCursor } from '@/services/uniprot/query-cursor.js';
import type { ProteomeProteinPage } from '@/services/uniprot/types.js';
import { unbalancedParenthesis } from '@/services/uniprot/types.js';
import { getUniProtService, isCursorRejection } from '@/services/uniprot/uniprot-service.js';

const UPID_REGEX = /^UP[0-9]{9}$/;

const ProteinHitSchema = z
  .object({
    accession: z.string().describe('UniProtKB primary accession.'),
    entryName: z.string().describe('UniProtKB mnemonic ID.'),
    proteinName: z.string().optional().describe('Recommended protein name. Omitted when none.'),
    geneNames: z
      .array(z.string().describe('A gene name, synonym, ordered-locus name, or ORF name.'))
      .describe(
        'Every name of each gene in UniProt order: gene name, synonyms, ordered-locus names (e.g. "b3296", "JW3258"), and ORF names (e.g. "J0580").',
      ),
    organism: z
      .object({
        scientificName: z.string().describe('Organism scientific name.'),
        commonName: z.string().optional().describe('Organism common name. Omitted when none.'),
        taxonId: z.number().describe('NCBI taxonomy ID.'),
      })
      .describe('Source organism.'),
    length: z.number().describe('Canonical sequence length in residues.'),
    sequenceFlags: z
      .array(z.string().describe('One flag, as UniProt words it.'))
      .optional()
      .describe(
        'UniProt\'s sequence flags: "Fragment" or "Fragments" (several non-adjacent pieces) when the sequence is incomplete, so length counts only the residues UniProt holds, not the whole protein; "Precursor" when the sequence is processed into a shorter mature form (signal, propeptide, transit peptide, or initiator methionine cleaved). Omitted when UniProt flags none.',
      ),
    reviewed: z.boolean().describe('True for reviewed Swiss-Prot, false for unreviewed TrEMBL.'),
    annotationScore: z.number().describe('Annotation confidence on a 1–5 scale.'),
    proteinExistence: z.string().describe('Protein-existence evidence level.'),
    functionSnippet: z
      .string()
      .optional()
      .describe(
        'Opening of the first FUNCTION annotation, evidence references stripped: whole sentences within 250 characters (at least the first; one over 400 is cut at a word and ends with …). The complete annotation with evidence is uniprot_get_entry function. Omitted when none.',
      ),
    functionSnippetMolecule: z
      .string()
      .optional()
      .describe(
        'The isoform, chain, or peptide the functionSnippet annotation is about, as UniProt names it, e.g. "Glucagon" or "Isoform 2". Omitted when UniProt names none, so the snippet is about the protein the row describes, and whenever functionSnippet is.',
      ),
  })
  .describe('A protein in the proteome.');

export const getProteome = tool('uniprot_get_proteome', {
  title: 'uniprot-mcp-server: get proteome',
  description:
    'Fetch a proteome by UPID (e.g. "UP000005640"), which can name a reference, non-reference, or excluded proteome, or the reference proteome for an organism by NCBI taxon ID (e.g. 9606) — provide exactly one. Returns metadata inline: proteome type (with UniProt\'s reasons when excluded), total protein count, gene count, reviewed, unreviewed, and additional isoform protein counts, Complete Proteome Detector (CPD) status, BUSCO completeness (score, complete/fragmented/missing counts, lineage dataset), and the genome assembly accession. UniProt computes the gene count and the reviewed, unreviewed, and isoform counts for reference proteomes only, so they are omitted elsewhere. The protein set is opt-in via include_proteins (it is large) and returns a capped page with a forward cursor; narrow it with the query filter (UniProtKB Lucene syntax) for a subset. Resolve an organism name to a taxon ID first with uniprot_get_taxonomy.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    upid: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(
            UPID_REGEX,
            'Must be a proteome UPID: "UP" followed by 9 digits, e.g. "UP000005640". Or pass taxon_id instead.',
          )
          .describe('Proteome identifier, e.g. "UP000005640".'),
      ])
      .optional()
      .describe('Proteome UPID. Provide this OR taxon_id, not both.'),
    taxon_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'NCBI taxon ID, e.g. 9606 for human. Prefers an exact reference proteome; otherwise resolves a unique descendant reference, or returns candidate UPIDs and taxon IDs for explicit selection. Provide this OR upid, not both.',
      ),
    include_proteins: z
      .boolean()
      .default(false)
      .describe(
        "When true, also return a capped, cursor-paginated page of the proteome's proteins. Defaults to false — metadata alone is the common case.",
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Optional UniProtKB Lucene filter to narrow the protein list, e.g. "reviewed:true AND keyword:KW-0067". Only applies when include_proteins is true.',
      ),
    size: countInput(PAGE_SIZE_CAP, (clamped) => {
      const fallback = activeServerConfig().defaultPageSize;
      return clamped
        ? `Proteins per page when include_proteins is true. Default ${fallback}; a value above ${PAGE_SIZE_CAP}, UniProt's page maximum, returns ${PAGE_SIZE_CAP} and says so.`
        : `Proteins per page when include_proteins is true, at most ${PAGE_SIZE_CAP}. Default ${fallback}.`;
    }).optional(),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque cursor from this tool for the same resolved UPID and exact query. Identifier aliases resolving to that UPID and size changes are allowed. Older raw cursors are rejected; restart without cursor. Only meaningful with include_proteins.',
      ),
  }),
  output: z.object({
    proteome: z
      .object({
        upid: z.string().describe('Proteome identifier, e.g. "UP000005640".'),
        proteomeType: z
          .string()
          .describe(
            'Proteome type as UniProt words it, e.g. "Reference proteome", "Non Reference proteome", or "Excluded".',
          ),
        exclusionReasons: z
          .array(z.string().describe('One reason, as UniProt words it.'))
          .optional()
          .describe(
            'Why UniProt excluded the proteome, e.g. ["genome length too small"] or ["contaminated"]. Present on excluded proteomes only.',
          ),
        organism: z
          .object({
            scientificName: z.string().describe('Organism scientific name.'),
            commonName: z.string().optional().describe('Organism common name. Omitted when none.'),
            taxonId: z.number().describe('NCBI taxonomy ID.'),
            mnemonic: z
              .string()
              .optional()
              .describe('Organism mnemonic, e.g. "HUMAN". Omitted when none.'),
          })
          .describe('Source organism.'),
        proteinCount: z.number().describe('Total number of proteins in the proteome.'),
        geneCount: z
          .number()
          .optional()
          .describe(
            'Number of genes the proteins come from — at most proteinCount, below it where genes have several protein entries. Omitted where UniProt has not computed it (it reports 0 on non-reference and excluded proteomes).',
          ),
        reviewedProteinCount: z
          .number()
          .optional()
          .describe(
            'Reviewed (Swiss-Prot) proteins; with unreviewedProteinCount it sums to proteinCount. Omitted, with the unreviewed and isoform counts, where UniProt has not computed them (it reports 0 for all three on non-reference and excluded proteomes).',
          ),
        unreviewedProteinCount: z
          .number()
          .optional()
          .describe(
            'Unreviewed (TrEMBL) proteins; 0 when every protein is reviewed. Omitted together with reviewedProteinCount.',
          ),
        isoformProteinCount: z
          .number()
          .optional()
          .describe(
            'Additional isoform sequences, counted outside proteinCount. Omitted together with reviewedProteinCount.',
          ),
        cpdStatus: z
          .string()
          .optional()
          .describe(
            'Complete Proteome Detector (CPD) status — where proteinCount falls among at least 30 closely related proteomes, as UniProt words it: "Standard", "Close to standard (high value)", "Close to standard (low value)", "Outlier (high value)", "Outlier (low value)", or "Unknown" (too few related proteomes to score). Omitted when UniProt sends none.',
          ),
        busco: z
          .object({
            complete: z.number().describe('Complete BUSCO genes.'),
            completeSingle: z.number().describe('Complete and single-copy BUSCOs.'),
            completeDuplicated: z.number().describe('Complete and duplicated BUSCOs.'),
            fragmented: z.number().describe('Fragmented BUSCOs.'),
            missing: z.number().describe('Missing BUSCOs.'),
            total: z.number().describe('Total BUSCO genes searched.'),
            lineageDb: z
              .string()
              .optional()
              .describe('BUSCO lineage dataset, e.g. "primates_odb10". Omitted when none.'),
            score: z
              .number()
              .optional()
              .describe('Completeness percentage (0–100). Omitted when none.'),
          })
          .optional()
          .describe('BUSCO completeness report. Absent for proteomes without one.'),
        genomeAssembly: z
          .string()
          .optional()
          .describe('Genome assembly accession, e.g. "GCA_000001405.29". Omitted when none.'),
      })
      .describe('Proteome metadata.'),
    proteins: z
      .array(ProteinHitSchema)
      .optional()
      .describe(
        "A capped page of the proteome's proteins. Present only when include_proteins is true.",
      ),
  }),
  enrichment: {
    query: z.string().optional().describe('The protein filter as supplied by the caller.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the protein page hit the size cap — more remain via cursor.'),
    shown: z.number().optional().describe('Number of proteins returned in this page.'),
    cap: z.number().optional().describe('The page-size cap that was applied.'),
    totalProteinsMatched: z
      .number()
      .optional()
      .describe('Total proteins matching the (optionally filtered) proteome query.'),
    cursor: z
      .string()
      .optional()
      .describe('Forward cursor for the next protein page. Absent on the last page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance: the requested and applied size when size was above the 500-row page maximum; how to reach the rest when the protein page was capped (walk the cursor or narrow with the query filter); or that no protein matched.',
      ),
  },
  errors: [
    {
      reason: 'ambiguous_proteome',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'Multiple descendant reference proteomes exist or candidate pages remain.',
      recovery:
        'Choose an explicit upid from the candidate names and taxon IDs in the message, or retrieve its next-page link.',
    },
    {
      reason: 'missing_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither upid nor taxon_id was provided.',
      recovery:
        'Provide a proteome UPID or an NCBI taxon ID; resolve a name first with uniprot_get_taxonomy.',
    },
    {
      reason: 'conflicting_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both upid and taxon_id were provided.',
      recovery: 'Provide only one of upid or taxon_id, not both, then retry.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No proteome has the UPID, or the taxon has no reference proteome.',
      recovery:
        'Check the UPID. For a taxon ID with no reference proteome, re-call with a parent taxon ID from its uniprot_get_taxonomy lineage to list the reference proteomes of related organisms.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The query filter has unbalanced parentheses (rejected before any request), or UniProtKB rejected it — the message names the rejected field or syntax.',
      recovery:
        'Fix the field name or syntax named in the message, balancing parentheses and quotes, or omit query to list the whole proteome.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The protein cursor is malformed, from an older version, belongs to another tool, resolved UPID or query, or UniProt could not continue from it (HTTP 500).',
      recovery:
        'Re-call with the same proteome, query, and include_proteins but no cursor to restart from the first page.',
    },
  ],

  async handler(input, ctx) {
    const upid = input.upid?.trim() || undefined;
    if (upid && input.taxon_id) {
      throw ctx.fail('conflicting_identifier');
    }
    // Narrowed union: exactly one identifier survives the guards and reaches the service.
    const target = upid ? { upid } : input.taxon_id ? { taxonId: input.taxon_id } : undefined;
    if (!target) {
      throw ctx.fail('missing_identifier');
    }
    // The filter is sent as "proteome:<upid> AND (<query>)"; a stray ")" would close that
    // group early, so an unbalanced filter is rejected before any request.
    const unbalanced =
      input.include_proteins && input.query ? unbalancedParenthesis(input.query) : undefined;
    if (unbalanced) {
      throw ctx.fail('invalid_query', `Unbalanced parentheses in query: ${unbalanced}.`);
    }

    const service = getUniProtService();
    let proteome: Awaited<ReturnType<typeof service.getProteome>>;
    try {
      proteome = await service.getProteome(target, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message);
      }
      throw err;
    }

    if (!input.include_proteins) {
      return { proteome };
    }

    // ctx.enrich.notice is last-wins, so every notice the call raises is collected here and sent once.
    const notices: string[] = [];
    let cap = getServerConfig().defaultPageSize;
    if (input.size !== undefined) {
      const pageSize = clampPageSize(input.size, 'uniprot_get_proteome', ctx);
      cap = pageSize.applied;
      if (pageSize.notice) notices.push(pageSize.notice);
    }
    const effectiveQuery = proteomeQuery(proteome.upid, input.query);
    const cursor = queryCursor.decode(input.cursor, 'uniprot_get_proteome', effectiveQuery);
    let page: ProteomeProteinPage;
    try {
      page = await service.getProteomeProteins(
        proteome.upid,
        {
          ...(input.query ? { query: input.query } : {}),
          size: cap,
          ...(cursor ? { cursor } : {}),
        },
        ctx,
      );
    } catch (err) {
      // The service types a cursor UniProt refused; any other InvalidParams is UniProt's
      // 400, relayed with UniProt's own message.
      if (isCursorRejection(err)) {
        throw ctx.fail('invalid_cursor', (err as Error).message, undefined, { cause: err });
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
        throw ctx.fail('invalid_query', err.message, undefined, { cause: err });
      }
      throw err;
    }

    ctx.enrich({ totalProteinsMatched: page.totalResults });
    if (input.query) ctx.enrich({ query: input.query });
    if (!page.proteins.length)
      notices.push(
        `No proteins matched${input.query ? ` the filter "${input.query}"` : ' this proteome page'}.`,
      );
    // truncated() writes the notice too (last-wins), so a truncated page carries the others in its guidance.
    if (page.cursor) {
      notices.push(
        `Showing ${page.proteins.length} of ${page.totalResults} proteins. Walk the cursor for more, or narrow with the query filter.`,
      );
      ctx.enrich.truncated({ shown: page.proteins.length, cap, guidance: notices.join(' ') });
      ctx.enrich({
        cursor: queryCursor.encode(page.cursor, 'uniprot_get_proteome', effectiveQuery),
      });
    } else {
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      ctx.enrich({ shown: page.proteins.length });
    }

    ctx.log.info('Proteome fetched', {
      upid: proteome.upid,
      count: proteome.proteinCount,
      listed: page.proteins.length,
    });
    return { proteome, proteins: page.proteins };
  },

  format: (result) => {
    const p = result.proteome;
    const lines = [
      `# ${p.organism.scientificName}${p.organism.commonName ? ` (${p.organism.commonName})` : ''} — ${p.upid}`,
      `**Type:** ${p.proteomeType}${p.exclusionReasons?.length ? ` (${p.exclusionReasons.join('; ')})` : ''} · **Proteins:** ${p.proteinCount} · **Taxon:** ${p.organism.taxonId}${p.organism.mnemonic ? ` (${p.organism.mnemonic})` : ''}`,
    ];
    // Each count renders on its own: a real 0 (E. coli's unreviewed count) shows as 0.
    const counts = [
      p.geneCount != null ? `**Genes:** ${p.geneCount}` : undefined,
      p.reviewedProteinCount != null
        ? `**Reviewed proteins:** ${p.reviewedProteinCount}`
        : undefined,
      p.unreviewedProteinCount != null
        ? `**Unreviewed proteins:** ${p.unreviewedProteinCount}`
        : undefined,
      p.isoformProteinCount != null
        ? `**Additional isoforms:** ${p.isoformProteinCount}`
        : undefined,
    ].filter((part) => part !== undefined);
    if (counts.length) lines.push(counts.join(' · '));
    if (p.genomeAssembly) lines.push(`**Genome assembly:** ${p.genomeAssembly}`);
    if (p.busco) {
      lines.push(
        `**BUSCO:** ${p.busco.score != null ? `${p.busco.score}% complete` : 'completeness'} (${p.busco.lineageDb ?? 'lineage n/a'}) — complete ${p.busco.complete} (single ${p.busco.completeSingle}, duplicated ${p.busco.completeDuplicated}), fragmented ${p.busco.fragmented}, missing ${p.busco.missing} of ${p.busco.total}`,
      );
    }
    if (p.cpdStatus) lines.push(`**CPD status:** ${p.cpdStatus}`);
    if (result.proteins?.length) {
      lines.push('', `## Proteins (${result.proteins.length} shown)`);
      for (const hit of result.proteins) {
        lines.push(
          `- **${hit.accession}** (${hit.entryName}) ${hit.proteinName ?? ''}${hit.geneNames.length ? ` [${hit.geneNames.join(', ')}]` : ''}`,
        );
        lines.push(
          `  ${hit.reviewed ? 'reviewed' : 'unreviewed'} · score ${hit.annotationScore}/5 · ${lengthLabel(hit.length, hit.sequenceFlags)} · ${hit.proteinExistence} · ${hit.organism.scientificName}${hit.organism.commonName ? ` (${hit.organism.commonName})` : ''} [taxon ${hit.organism.taxonId}]`,
        );
        // A molecule comes only with a snippet; it leads the text, as on uniprot_get_entry function rows.
        if (hit.functionSnippet)
          lines.push(`  ${moleculeLabel(hit.functionSnippetMolecule)}${hit.functionSnippet}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
