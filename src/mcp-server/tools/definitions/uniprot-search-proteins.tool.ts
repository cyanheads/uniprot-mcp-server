/**
 * @fileoverview uniprot_search_proteins — the discovery entry point. Searches
 *   UniProtKB by free text (`text_search`) or a structured Lucene `query`,
 *   foregrounds the reviewed (Swiss-Prot) filter, optionally returns upstream
 *   facet counts, and walks results with an opaque forward cursor. Chain the
 *   result accessions into uniprot_get_entry.
 * @module mcp-server/tools/definitions/uniprot-search-proteins
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const ProteinHitSchema = z
  .object({
    accession: z
      .string()
      .describe(
        'UniProtKB primary accession, e.g. "P04637". The lookup key for uniprot_get_entry and uniprot_get_sequence.',
      ),
    entryName: z
      .string()
      .describe('UniProtKB mnemonic ID, e.g. "P53_HUMAN". Not an input key — use accession.'),
    proteinName: z
      .string()
      .optional()
      .describe('Recommended full protein name. Omitted when the entry has none.'),
    geneNames: z
      .array(z.string().describe('A gene name or synonym.'))
      .describe('Gene names and synonyms for the protein.'),
    organism: z
      .object({
        scientificName: z.string().describe('Organism scientific name, e.g. "Homo sapiens".'),
        commonName: z
          .string()
          .optional()
          .describe('Organism common name, e.g. "Human". Omitted when none.'),
        taxonId: z.number().describe('NCBI taxonomy ID, e.g. 9606.'),
      })
      .describe('Source organism.'),
    length: z.number().describe('Canonical sequence length in residues.'),
    reviewed: z
      .boolean()
      .describe(
        'True for reviewed Swiss-Prot (manually curated), false for unreviewed TrEMBL (computationally predicted).',
      ),
    annotationScore: z
      .number()
      .describe('Annotation confidence on a 1–5 scale; higher means more curation evidence.'),
    proteinExistence: z
      .string()
      .describe(
        'Evidence level for the protein\'s existence, e.g. "1: Evidence at protein level".',
      ),
    functionSnippet: z
      .string()
      .optional()
      .describe(
        'First sentence(s) of the FUNCTION annotation, evidence references stripped. Omitted when no function is annotated.',
      ),
  })
  .describe('A UniProtKB search hit.');

export const searchProteins = tool('uniprot_search_proteins', {
  title: 'uniprot-mcp-server: search proteins',
  description:
    'Search UniProtKB and return curated protein records. Pass text_search for a plain-language query (the 80% case) or query for the full Lucene field syntax (gene:TP53 AND organism_id:9606 AND reviewed:true) — exactly one is required. Reviewed (Swiss-Prot) entries are manually curated; unreviewed (TrEMBL) are computationally predicted and ~30x more numerous, so reviewed defaults to true to avoid drowning in predictions — set it false to include TrEMBL. Request facets (e.g. reviewed, model_organism) for server-side count breakdowns. Results page forward with an opaque cursor; UniProtKB has no offset paging. This is the discovery entry point — chain results[].accession into uniprot_get_entry for full records, or uniprot_get_sequence for FASTA.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    text_search: z
      .string()
      .optional()
      .describe(
        'Plain-language search across protein names, gene names, and function, e.g. "kinase apoptosis". Provide this OR query, not both.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'UniProtKB Lucene query with field prefixes — gene, organism_id, keyword (KW-xxxx), go (GO id), reviewed, protein_name, family, length, existence, accession. Example: "gene:BRCA1 AND organism_id:9606 AND reviewed:true". Provide this OR text_search, not both.',
      ),
    reviewed: z
      .boolean()
      .default(true)
      .describe(
        'Restrict to reviewed Swiss-Prot entries. Defaults to true (curated only); set false to include unreviewed TrEMBL. Ignored when query already pins a reviewed: clause.',
      ),
    organism_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to an NCBI taxon ID, e.g. 9606 for human. A convenience filter ANDed onto the query; resolve names with uniprot_get_taxonomy.',
      ),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated UniProtKB field names to project, e.g. "accession,gene_names,cc_function". Omit for a sensible default set covering name, gene, organism, length, reviewed, score, and a function snippet.',
      ),
    facets: z
      .string()
      .optional()
      .describe(
        'Comma-separated upstream facet names for count breakdowns, e.g. "reviewed,model_organism,proteins_with". Returns a facets array alongside the hits.',
      ),
    size: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Number of hits per page (max 500). Omit for the server default.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque forward-pagination cursor from a prior response. Walk pages with this; random access to page N is not supported.',
      ),
  }),
  output: z.object({
    results: z.array(ProteinHitSchema).describe('Matching protein hits for this page.'),
    facets: z
      .array(
        z
          .object({
            name: z.string().describe('Facet identifier, e.g. "reviewed".'),
            label: z.string().describe('Human-readable facet label, e.g. "Status".'),
            values: z
              .array(
                z
                  .object({
                    value: z.string().describe('Facet value, e.g. "true".'),
                    label: z
                      .string()
                      .describe('Human-readable value label, e.g. "Reviewed (Swiss-Prot)".'),
                    count: z.number().describe('Number of matches in this bucket.'),
                  })
                  .describe('A single facet bucket.'),
              )
              .describe('Count buckets for this facet.'),
          })
          .describe('A server-side facet breakdown.'),
      )
      .optional()
      .describe('Upstream facet count breakdowns. Present only when facets were requested.'),
  }),
  enrichment: {
    totalResults: z
      .number()
      .describe('Total matches for the query before pagination (from the upstream result count).'),
    effectiveQuery: z
      .string()
      .describe('The query as the server assembled and sent it to UniProtKB.'),
    cursor: z
      .string()
      .optional()
      .describe('Forward cursor for the next page. Absent on the last page.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched — echoes the query and suggests how to broaden.'),
  },
  errors: [
    {
      reason: 'missing_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither text_search nor query was provided.',
      recovery: 'Provide either text_search for plain language or query for Lucene field syntax.',
    },
    {
      reason: 'conflicting_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both text_search and query were provided.',
      recovery: 'Provide only one of text_search or query, not both, then retry.',
    },
  ],

  async handler(input, ctx) {
    const hasText = !!input.text_search?.trim();
    const hasQuery = !!input.query?.trim();
    if (!hasText && !hasQuery) {
      throw ctx.fail('missing_query', undefined, { ...ctx.recoveryFor('missing_query') });
    }
    if (hasText && hasQuery) {
      throw ctx.fail('conflicting_query', undefined, { ...ctx.recoveryFor('conflicting_query') });
    }

    const clauses: string[] = [];
    if (hasQuery) {
      clauses.push(input.query!.trim());
    } else {
      clauses.push(input.text_search!.trim());
    }
    if (input.organism_id) clauses.push(`organism_id:${input.organism_id}`);
    // Honor reviewed unless the caller already pinned a reviewed: clause in their query.
    if (!/\breviewed:/i.test(clauses.join(' '))) {
      clauses.push(`reviewed:${input.reviewed}`);
    }
    const effectiveQuery = clauses.join(' AND ');

    const page = await getUniProtService().search(
      effectiveQuery,
      {
        ...(input.fields ? { fields: input.fields } : {}),
        ...(input.facets ? { facets: input.facets } : {}),
        ...(input.size ? { size: input.size } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      ctx,
    );

    ctx.enrich.echo(effectiveQuery);
    ctx.enrich({ totalResults: page.totalResults });
    if (page.cursor) ctx.enrich({ cursor: page.cursor });
    if (page.results.length === 0) {
      ctx.enrich.notice(
        `No proteins matched "${effectiveQuery}". Broaden the terms, set reviewed: false to include TrEMBL, or check field syntax.`,
      );
    }

    ctx.log.info('UniProtKB search completed', {
      total: page.totalResults,
      shown: page.results.length,
      reviewedOnly: input.reviewed,
    });

    return { results: page.results, ...(page.facets ? { facets: page.facets } : {}) };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const hit of result.results) {
      lines.push(`## ${hit.proteinName ?? hit.entryName} (${hit.accession})`);
      lines.push(`**Entry:** ${hit.entryName}`);
      const meta = [
        hit.reviewed ? 'Reviewed (Swiss-Prot)' : 'Unreviewed (TrEMBL)',
        `Score ${hit.annotationScore}/5`,
        `${hit.length} aa`,
        hit.proteinExistence,
      ].join(' · ');
      lines.push(meta);
      lines.push(
        `**Organism:** ${hit.organism.scientificName}${hit.organism.commonName ? ` (${hit.organism.commonName})` : ''} [taxon ${hit.organism.taxonId}]`,
      );
      if (hit.geneNames.length) lines.push(`**Genes:** ${hit.geneNames.join(', ')}`);
      if (hit.functionSnippet) lines.push(`**Function:** ${hit.functionSnippet}`);
      lines.push('');
    }
    if (result.facets?.length) {
      lines.push('### Facets');
      for (const facet of result.facets) {
        lines.push(`**${facet.label}** (${facet.name})`);
        for (const v of facet.values) lines.push(`- ${v.label} (${v.value}): ${v.count}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n').trim() || 'No matching proteins.' }];
  },
});
