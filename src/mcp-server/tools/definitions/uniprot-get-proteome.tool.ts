/**
 * @fileoverview uniprot_get_proteome — the reference proteome for an organism by
 *   UPID or taxon ID (exactly one). Returns metadata inline (protein count, BUSCO
 *   completeness, genome assembly) and, when include_proteins is set, an opt-in
 *   cursor-paginated, capped protein list with truncation disclosure.
 * @module mcp-server/tools/definitions/uniprot-get-proteome
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const UPID_REGEX = /^UP[0-9]{9}$/;

const ProteinHitSchema = z
  .object({
    accession: z.string().describe('UniProtKB primary accession.'),
    entryName: z.string().describe('UniProtKB mnemonic ID.'),
    proteinName: z.string().optional().describe('Recommended protein name. Omitted when none.'),
    geneNames: z
      .array(z.string().describe('A gene name or synonym.'))
      .describe('Gene names and synonyms.'),
    organism: z
      .object({
        scientificName: z.string().describe('Organism scientific name.'),
        commonName: z.string().optional().describe('Organism common name. Omitted when none.'),
        taxonId: z.number().describe('NCBI taxonomy ID.'),
      })
      .describe('Source organism.'),
    length: z.number().describe('Canonical sequence length in residues.'),
    reviewed: z.boolean().describe('True for reviewed Swiss-Prot, false for unreviewed TrEMBL.'),
    annotationScore: z.number().describe('Annotation confidence on a 1–5 scale.'),
    proteinExistence: z.string().describe('Protein-existence evidence level.'),
    functionSnippet: z
      .string()
      .optional()
      .describe('First function sentence(s), evidence stripped. Omitted when none.'),
  })
  .describe('A protein in the proteome.');

export const getProteome = tool('uniprot_get_proteome', {
  title: 'uniprot-mcp-server: get proteome',
  description:
    'Fetch the reference proteome for an organism by UPID (e.g. "UP000005640") or NCBI taxon ID (e.g. 9606) — provide exactly one. Returns metadata inline: proteome type, total protein count, BUSCO completeness (score, complete/fragmented/missing counts, lineage dataset), and the genome assembly accession. The protein set is opt-in via include_proteins (it is large — human is ~147,506) and returns a capped page with a forward cursor; narrow it with the query filter (UniProtKB Lucene syntax) for a subset. Resolve an organism name to a taxon ID first with uniprot_get_taxonomy.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    upid: z
      .union([
        z.literal(''),
        z.string().regex(UPID_REGEX).describe('Proteome identifier, e.g. "UP000005640".'),
      ])
      .optional()
      .describe('Proteome UPID. Provide this OR taxon_id, not both.'),
    taxon_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'NCBI taxon ID, e.g. 9606 for human. Resolves to the reference proteome. Provide this OR upid, not both.',
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
    size: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe(
        'Proteins per page when include_proteins is true (max 500). Omit for the server default.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Forward-pagination cursor from a prior protein page. Only meaningful with include_proteins.',
      ),
  }),
  output: z.object({
    proteome: z
      .object({
        upid: z.string().describe('Proteome identifier, e.g. "UP000005640".'),
        proteomeType: z.string().describe('Proteome type, e.g. "Reference proteome".'),
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
  },
  errors: [
    {
      reason: 'missing_identifier',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither upid nor taxon_id was provided.',
      recovery:
        'Provide a proteome UPID or an NCBI taxon ID; resolve a name first with uniprot_get_taxonomy.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The UPID or taxon has no reference proteome.',
      recovery:
        'Confirm the organism has a reference proteome, or look it up with uniprot_get_taxonomy.',
    },
  ],

  async handler(input, ctx) {
    const upid = input.upid?.trim() || undefined;
    if (!upid && !input.taxon_id) {
      throw ctx.fail('missing_identifier', undefined, { ...ctx.recoveryFor('missing_identifier') });
    }

    const service = getUniProtService();
    let proteome: Awaited<ReturnType<typeof service.getProteome>>;
    try {
      proteome = await service.getProteome(upid ? { upid } : { taxonId: input.taxon_id! }, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message, {
          ...ctx.recoveryFor('not_found'),
        });
      }
      throw err;
    }

    if (!input.include_proteins) {
      return { proteome };
    }

    const cap = input.size ?? getServerConfig().defaultPageSize;
    const page = await service.getProteomeProteins(
      proteome.upid,
      {
        ...(input.query ? { query: input.query } : {}),
        size: cap,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      ctx,
    );

    ctx.enrich({ totalProteinsMatched: page.totalResults });
    if (page.cursor) {
      ctx.enrich.truncated({
        shown: page.proteins.length,
        cap,
        guidance: `Showing ${page.proteins.length} of ${page.totalResults} proteins. Walk the cursor for more, or narrow with the query filter.`,
      });
      ctx.enrich({ cursor: page.cursor });
    } else {
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
      `**Type:** ${p.proteomeType} · **Proteins:** ${p.proteinCount} · **Taxon:** ${p.organism.taxonId}${p.organism.mnemonic ? ` (${p.organism.mnemonic})` : ''}`,
    ];
    if (p.genomeAssembly) lines.push(`**Genome assembly:** ${p.genomeAssembly}`);
    if (p.busco) {
      lines.push(
        `**BUSCO:** ${p.busco.score != null ? `${p.busco.score}% complete` : 'completeness'} (${p.busco.lineageDb ?? 'lineage n/a'}) — complete ${p.busco.complete} (single ${p.busco.completeSingle}, duplicated ${p.busco.completeDuplicated}), fragmented ${p.busco.fragmented}, missing ${p.busco.missing} of ${p.busco.total}`,
      );
    }
    if (result.proteins?.length) {
      lines.push('', `## Proteins (${result.proteins.length} shown)`);
      for (const hit of result.proteins) {
        lines.push(
          `- **${hit.accession}** (${hit.entryName}) ${hit.proteinName ?? ''}${hit.geneNames.length ? ` [${hit.geneNames.join(', ')}]` : ''}`,
        );
        lines.push(
          `  ${hit.reviewed ? 'reviewed' : 'unreviewed'} · score ${hit.annotationScore}/5 · ${hit.length} aa · ${hit.proteinExistence} · ${hit.organism.scientificName}${hit.organism.commonName ? ` (${hit.organism.commonName})` : ''} [taxon ${hit.organism.taxonId}]`,
        );
        if (hit.functionSnippet) lines.push(`  ${hit.functionSnippet}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
