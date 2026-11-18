/**
 * @fileoverview uniprot_search_proteins — the discovery entry point. Searches
 *   UniProtKB by free text (`text_search`) or a structured Lucene `query`,
 *   foregrounds the reviewed (Swiss-Prot) filter, optionally returns upstream
 *   facet counts, and walks results with an opaque forward cursor. Inactive
 *   accessions the query matches are split into inactive[], never built into
 *   hits. Chain the result accessions into uniprot_get_entry.
 * @module mcp-server/tools/definitions/uniprot-search-proteins
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { activeServerConfig } from '@/config/server-config.js';
import { clampPageSize, countInput, PAGE_SIZE_CAP } from '@/mcp-server/tools/input-limits.js';
import { queryCursor } from '@/services/uniprot/query-cursor.js';
import { ignoredFieldsNotice, searchFieldRequest } from '@/services/uniprot/return-fields.js';
import type { SearchPage } from '@/services/uniprot/types.js';
import {
  describeInactiveInFull,
  groupClause,
  unbalancedParenthesis,
} from '@/services/uniprot/types.js';
import { getUniProtService, isCursorRejection } from '@/services/uniprot/uniprot-service.js';

const LUCENE_PUNCTUATION = /[+\-!(){}[\]^"~*?:\\/&|]/g;
const LUCENE_BOOLEAN_WORD = /(?<![\p{L}\p{N}_])(?:AND|OR|NOT)(?![\p{L}\p{N}_])/gu;

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
      .array(z.string().describe('A gene name, synonym, ordered-locus name, or ORF name.'))
      .describe(
        'Every name of each gene for the protein in UniProt order: gene name, synonyms, ordered-locus names (e.g. "b3296", "JW3258"), and ORF names (e.g. "J0580").',
      ),
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
        'Opening of the first FUNCTION annotation, evidence references stripped: whole sentences within 250 characters (at least the first; one over 400 is cut at a word and ends with …). The complete annotation with evidence is uniprot_get_entry function. Omitted when no function is annotated.',
      ),
  })
  .describe('A UniProtKB search hit.');

const InactiveHitSchema = z
  .object({
    accession: z.string().describe('The inactive UniProtKB accession the query matched.'),
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
        'Accessions that replace it — the merge target (MERGED) or the demerge products (DEMERGED). Look these up instead.',
      ),
    deletedReason: z
      .string()
      .optional()
      .describe('Why UniProt deleted the entry, when it says. Present on DELETED only.'),
    uniParcId: z
      .string()
      .optional()
      .describe('UniParc ID that still holds the sequence, when UniProt gives one.'),
  })
  .describe('An inactive accession the query matched, with where to go instead.');

export const searchProteins = tool('uniprot_search_proteins', {
  title: 'uniprot-mcp-server: search proteins',
  description:
    'Search UniProtKB and return curated protein records. Pass text_search for a plain-language query (the 80% case) or query for the full Lucene field syntax (gene:TP53 AND organism_id:9606 AND reviewed:true) — exactly one is required. Reviewed (Swiss-Prot) entries are manually curated; unreviewed (TrEMBL) are computationally predicted and ~30x more numerous, so reviewed defaults to true to avoid drowning in predictions — set it false to search both tiers together (for TrEMBL only, put reviewed:false in query). The organism_id and reviewed filters apply to the whole query. Request facets (e.g. reviewed, model_organism) for server-side count breakdowns. Results page forward with an opaque cursor; UniProtKB has no offset paging. An inactive accession the query matches (merged, demerged, or deleted) comes back in inactive[] with the accessions that replace it, never as a result. This is the discovery entry point — chain results[].accession into uniprot_get_entry for full records, or uniprot_get_sequence for FASTA.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    text_search: z
      .string()
      .optional()
      .describe(
        'Plain-language search across protein names, gene names, and function, e.g. "kinase apoptosis". Punctuation and uppercase AND/OR/NOT are searched as text, with UniProt tokenization; use query for operators and field syntax. Provide this OR query, not both.',
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
        'Restrict to reviewed Swiss-Prot entries. Defaults to true (curated only). false applies no tier filter, returning reviewed and unreviewed TrEMBL entries together; for TrEMBL only, put reviewed:false in query. Ignored when query already contains a reviewed: clause; plain text never overrides this filter.',
      ),
    organism_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to an NCBI taxon and its descendants, including strains and subspecies, e.g. 9606 for human or 562 for E. coli. Applies taxonomy_id to the whole query; use an explicit organism_id: clause in query for an exact taxon. Resolve names with uniprot_get_taxonomy.',
      ),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated UniProtKB return-field names that trim each hit, e.g. "accession,gene_names" to drop the function snippet. Omit for the default hit: name, gene, organism, length, reviewed, score, and a function snippet. The identity fields always come back. Hits carry only these fields: accession, id, protein_name, gene_names, gene_primary, gene_synonym, gene_oln, gene_orf, organism_name, organism_id, length, reviewed, annotation_score, protein_existence, cc_function. Any other field (e.g. ec, ft_act_site, xref_pdb) is not requested and comes back in ignoredFields with a notice — fetch it with uniprot_get_entry. Text that is not a field name fails invalid_query with UniProt\'s message.',
      ),
    facets: z
      .string()
      .optional()
      .describe(
        'Comma-separated upstream facet names for count breakdowns, e.g. "reviewed,model_organism,proteins_with". Returns a facets array alongside the hits.',
      ),
    size: countInput(PAGE_SIZE_CAP, (clamped) => {
      const fallback = activeServerConfig().defaultPageSize;
      return clamped
        ? `Number of hits per page. Default ${fallback}; a value above ${PAGE_SIZE_CAP}, UniProt's page maximum, returns ${PAGE_SIZE_CAP} and says so.`
        : `Number of hits per page, at most ${PAGE_SIZE_CAP}. Default ${fallback}.`;
    }).optional(),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque forward cursor from this tool for the same exact effective query and filters. Size, fields, and facets may change. Older raw cursors are rejected; restart without cursor. Random access to page N is not supported.',
      ),
  }),
  output: z.object({
    results: z
      .array(ProteinHitSchema)
      .describe('Matching active protein hits for this page. Inactive accessions are in inactive.'),
    inactive: z
      .array(InactiveHitSchema)
      .optional()
      .describe(
        'Matching accessions that are inactive in UniProtKB (merged, demerged, or deleted) — not proteins to read, but pointers to the accessions that replace them. Present only when the page held any.',
      ),
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
      .describe(
        'Total matches for the query before pagination (from the upstream result count), inactive accessions included.',
      ),
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
      .describe(
        'Guidance: the requested and applied size when size was above the 500-row page maximum; when fields named fields hits do not carry, those fields, where to get them, and the fields hits carry; and, when nothing matched, how to broaden — distinguishing plain text from a structured query.',
      ),
    ignoredFields: z
      .array(z.string().describe('A requested field name, lowercased, that hits do not carry.'))
      .optional()
      .describe(
        'Names in fields that hits do not carry, in request order — left out of the UniProt request, so the search answered without them. Absent when every name was returned.',
      ),
  },
  enrichmentTrailer: {
    // Ignored names are field-shaped (return-fields FIELD_NAME), so they render without escaping.
    ignoredFields: { render: (names: string[]) => `**Ignored fields:** ${names.join(', ')}` },
  },
  errors: [
    {
      reason: 'missing_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither text_search nor query was provided.',
      recovery: 'Provide either text_search for plain language or query for Lucene field syntax.',
    },
    {
      reason: 'conflicting_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both text_search and query were provided.',
      recovery: 'Provide only one of text_search or query, not both, then retry.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The query has unbalanced parentheses (rejected before any request), or UniProtKB rejected the query, text_search, fields, or facets value — the message names the rejected value.',
      recovery:
        'Fix the field name, facet, or syntax named in the message — balance parentheses and quotes, use UniProtKB query and return field names — then retry.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor is malformed, from an older version, belongs to another tool or effective query, or UniProt could not continue from it (HTTP 500).',
      recovery:
        'Re-call with the same query and filters but no cursor to restart from the first page.',
    },
  ],

  async handler(input, ctx) {
    const textSearch = input.text_search?.trim() ?? '';
    const luceneQuery = input.query?.trim() ?? '';
    if (!textSearch && !luceneQuery) {
      throw ctx.fail('missing_query');
    }
    if (textSearch && luceneQuery) {
      throw ctx.fail('conflicting_query');
    }

    const clause =
      luceneQuery ||
      textSearch.replace(LUCENE_PUNCTUATION, '\\$&').replace(LUCENE_BOOLEAN_WORD, '"$&"');
    const unbalanced = luceneQuery && unbalancedParenthesis(luceneQuery);
    if (unbalanced) {
      throw ctx.fail('invalid_query', `Unbalanced parentheses in query: ${unbalanced}.`);
    }
    // reviewed: true restricts to Swiss-Prot; false adds no tier clause, so both tiers
    // return. A reviewed: clause in the structured query wins over either.
    const callerPinsTier = /\breviewed:/i.test(luceneQuery);
    const filters: string[] = [];
    if (input.organism_id) filters.push(`taxonomy_id:${input.organism_id}`);
    if (input.reviewed && !callerPinsTier) filters.push('reviewed:true');
    // UniProtKB binds AND tighter than OR, so the caller's clause is parenthesized before
    // any filter is ANDed on — unwrapped, a top-level OR takes the filters on its last
    // branch only. The balance check above keeps a stray ")" from closing this group early.
    // Escaped text always has paired backslashes; only raw Lucene needs the trailing-escape guard.
    const effectiveQuery = filters.length
      ? [luceneQuery ? groupClause(clause) : `(${clause})`, ...filters].join(' AND ')
      : clause;
    const cursor = queryCursor.decode(input.cursor, 'uniprot_search_proteins', effectiveQuery);
    // ctx.enrich.notice is last-wins, so every notice the call raises is collected here and sent once.
    const notices: string[] = [];
    const pageSize =
      input.size === undefined
        ? undefined
        : clampPageSize(input.size, 'uniprot_search_proteins', ctx);
    if (pageSize?.notice) notices.push(pageSize.notice);
    // A requested field a hit cannot carry is not fetched; the search answers without it and says so.
    const { fields, ignored } = searchFieldRequest(input.fields);
    if (ignored.length > 0) {
      ctx.enrich({ ignoredFields: ignored });
      notices.push(ignoredFieldsNotice(ignored, 'search'));
    }

    let page: SearchPage;
    try {
      page = await getUniProtService().search(
        effectiveQuery,
        {
          ...(fields !== undefined ? { fields } : {}),
          ...(input.facets ? { facets: input.facets } : {}),
          ...(pageSize ? { size: pageSize.applied } : {}),
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

    ctx.enrich.echo(effectiveQuery);
    ctx.enrich({ totalResults: page.totalResults });
    if (page.cursor)
      ctx.enrich({
        cursor: queryCursor.encode(page.cursor, 'uniprot_search_proteins', effectiveQuery),
      });
    const tier = callerPinsTier ? 'from query' : input.reviewed ? 'reviewed' : 'both';
    if (page.results.length === 0 && page.inactive.length === 0) {
      const guidance =
        tier === 'reviewed'
          ? 'Broaden the terms or set reviewed: false to search both Swiss-Prot and unreviewed TrEMBL.'
          : 'Broaden the terms.';
      notices.push(
        `No proteins matched the ${luceneQuery ? 'query' : 'plain-text search'}. ${guidance}${luceneQuery ? ' Check field syntax in query.' : ''}`,
      );
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('UniProtKB search completed', {
      total: page.totalResults,
      shown: page.results.length,
      inactive: page.inactive.length,
      tier,
    });

    return {
      results: page.results,
      ...(page.inactive.length ? { inactive: page.inactive } : {}),
      ...(page.facets ? { facets: page.facets } : {}),
    };
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
    if (result.inactive?.length) {
      lines.push('### Inactive accessions');
      for (const entry of result.inactive) {
        lines.push(`- **${entry.accession}** — ${describeInactiveInFull(entry)}`);
      }
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
