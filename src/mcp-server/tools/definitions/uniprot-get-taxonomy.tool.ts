/**
 * @fileoverview uniprot_get_taxonomy — a taxonomy record by NCBI taxon ID or
 *   scientific name: scientific/common name, rank, full lineage, and optionally
 *   the immediate children (a follow-up search, not inline on the record).
 *   Resolves organism filters for uniprot_search_proteins and grounds
 *   cross-server taxonomy.
 * @module mcp-server/tools/definitions/uniprot-get-taxonomy
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const LineageEntrySchema = z
  .object({
    taxonId: z.number().describe('NCBI taxonomy ID of the lineage node.'),
    scientificName: z.string().describe('Scientific name of the lineage node.'),
    commonName: z.string().optional().describe('Common name of the node. Omitted when none.'),
    rank: z.string().describe('Taxonomic rank, e.g. "phylum", "clade", "no rank".'),
  })
  .describe('A node in the lineage, ordered root → near.');

export const getTaxonomy = tool('uniprot_get_taxonomy', {
  title: 'uniprot-mcp-server: get taxonomy',
  description:
    'Resolve a taxonomy record by NCBI taxon ID (e.g. 9606) or scientific name (e.g. "Homo sapiens") — provide exactly one. Returns the scientific and common name, mnemonic, rank, parent, and the full lineage. Set include_children to also fetch immediate child taxa (a separate lookup — not inline on the record). Use this to turn an organism name into the taxon ID that uniprot_search_proteins (organism_id) and uniprot_get_proteome (taxon_id) expect.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    taxon_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('NCBI taxonomy ID, e.g. 9606. Provide this OR name, not both.'),
    name: z
      .string()
      .optional()
      .describe(
        'Organism scientific name, e.g. "Homo sapiens". Provide this OR taxon_id, not both. Matched against the scientific name.',
      ),
    include_children: z
      .boolean()
      .default(false)
      .describe(
        'When true, also fetch the immediate child taxa via a follow-up search. Defaults to false.',
      ),
  }),
  output: z.object({
    taxon: z
      .object({
        taxonId: z.number().describe('NCBI taxonomy ID.'),
        scientificName: z.string().describe('Scientific name.'),
        commonName: z.string().optional().describe('Common name. Omitted when none.'),
        mnemonic: z
          .string()
          .optional()
          .describe('UniProt organism mnemonic, e.g. "HUMAN". Omitted when none.'),
        rank: z.string().describe('Taxonomic rank, e.g. "species".'),
        parent: z
          .object({
            taxonId: z.number().describe('Parent taxon ID.'),
            scientificName: z.string().describe('Parent scientific name.'),
          })
          .optional()
          .describe('Immediate parent taxon. Omitted at the root.'),
        otherNames: z
          .array(z.string().describe('An alternative name or synonym.'))
          .optional()
          .describe('Synonyms and alternative spellings. Omitted when none.'),
      })
      .describe('The taxonomy record.'),
    lineage: z
      .array(LineageEntrySchema)
      .describe("Full lineage from root to the taxon's near ancestor."),
    children: z
      .array(
        z
          .object({
            taxonId: z.number().describe('Child taxon ID.'),
            scientificName: z.string().describe('Child scientific name.'),
            rank: z.string().describe('Child rank.'),
          })
          .describe('An immediate child taxon.'),
      )
      .optional()
      .describe('Immediate children. Present only when include_children is true.'),
  }),
  enrichment: {
    childCount: z
      .number()
      .optional()
      .describe('Number of immediate children returned (when include_children is true).'),
  },
  errors: [
    {
      reason: 'missing_identifier',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither taxon_id nor name was provided.',
      recovery: 'Provide an NCBI taxon ID or a scientific name to resolve.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The taxon ID or name did not resolve to a record.',
      recovery: 'Check the spelling or the NCBI taxon ID and try again.',
    },
  ],

  async handler(input, ctx) {
    const name = input.name?.trim();
    if (!input.taxon_id && !name) {
      throw ctx.fail('missing_identifier', undefined, { ...ctx.recoveryFor('missing_identifier') });
    }

    const service = getUniProtService();
    let taxon: Awaited<ReturnType<typeof service.getTaxonById>>;
    try {
      taxon = input.taxon_id
        ? await service.getTaxonById(input.taxon_id, ctx)
        : await service.getTaxonByName(name!, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message, {
          ...ctx.recoveryFor('not_found'),
        });
      }
      throw err;
    }

    let children: Awaited<ReturnType<typeof service.getChildren>> | undefined;
    if (input.include_children) {
      children = await service.getChildren(taxon.taxonId, ctx);
      ctx.enrich({ childCount: children.length });
    }

    ctx.log.info('Taxonomy resolved', {
      taxonId: taxon.taxonId,
      rank: taxon.rank,
      children: children?.length ?? 0,
    });

    const { lineage, ...rest } = taxon;
    return { taxon: rest, lineage, ...(children ? { children } : {}) };
  },

  format: (result) => {
    const t = result.taxon;
    const lines = [
      `# ${t.scientificName}${t.commonName ? ` (${t.commonName})` : ''} — taxon ${t.taxonId}`,
      `**Rank:** ${t.rank}${t.mnemonic ? ` · **Mnemonic:** ${t.mnemonic}` : ''}${t.parent ? ` · **Parent:** ${t.parent.scientificName} [${t.parent.taxonId}]` : ''}`,
    ];
    if (t.otherNames?.length)
      lines.push(`**Other names:** ${t.otherNames.slice(0, 10).join('; ')}`);
    lines.push(
      `**Lineage:** ${result.lineage
        .map(
          (l) =>
            `${l.scientificName}${l.commonName ? ` (${l.commonName})` : ''} [${l.taxonId}, ${l.rank}]`,
        )
        .join(' > ')}`,
    );
    if (result.children?.length) {
      lines.push(`## Children (${result.children.length})`);
      for (const c of result.children.slice(0, 50))
        lines.push(`- ${c.scientificName} [${c.taxonId}] (${c.rank})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
