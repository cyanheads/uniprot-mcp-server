/**
 * @fileoverview uniprot_get_taxonomy — a taxonomy record by NCBI taxon ID or
 *   scientific name: scientific/common name, rank, full lineage, and optionally
 *   one cursor-paginated page of immediate children (a follow-up search, not
 *   inline on the record) with the total and truncation disclosure.
 *   Resolves organism filters for uniprot_search_proteins and grounds
 *   cross-server taxonomy.
 * @module mcp-server/tools/definitions/uniprot-get-taxonomy
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import type { TaxonChild, TaxonChildrenPage } from '@/services/uniprot/types.js';
import { TAXON_CHILDREN_PAGE_SIZE } from '@/services/uniprot/types.js';
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
    'Resolve a taxonomy record by NCBI taxon ID (e.g. 9606) or scientific name (e.g. "Homo sapiens") — provide exactly one. Returns the scientific and common name, mnemonic, rank, parent, and the full lineage. Set include_children to also fetch immediate child taxa (a separate lookup — not inline on the record) in pages of 100 with the total child count; when more remain, pass the returned cursor to fetch the next page. Use this to turn an organism name into the taxon ID that uniprot_search_proteins (organism_id) and uniprot_get_proteome (taxon_id) expect.',
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
        'When true, also fetch a page of up to 100 immediate child taxa via a follow-up search. Defaults to false.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Forward-pagination cursor from a prior children page, for the next page of the same taxon; a cursor issued for another taxon is rejected. Only meaningful with include_children.',
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
      .describe(
        'One page of immediate children (up to 100). Present only when include_children is true.',
      ),
  }),
  enrichment: {
    childCount: z
      .number()
      .optional()
      .describe('Number of immediate children on this page (when include_children is true).'),
    totalChildren: z
      .number()
      .optional()
      .describe(
        'Total immediate children of the taxon across all pages (when include_children is true).',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more children remain past this page — fetch them with cursor.'),
    shown: z.number().optional().describe('Number of children on this page, when more remain.'),
    cap: z.number().optional().describe('The page size that was applied, when more remain.'),
    cursor: z
      .string()
      .optional()
      .describe('Forward cursor for the next children page. Absent on the last page.'),
    notice: z
      .string()
      .optional()
      .describe('Paging guidance when more children remain — the total and how to continue.'),
  },
  errors: [
    {
      reason: 'missing_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither taxon_id nor name was provided.',
      recovery: 'Provide an NCBI taxon ID or a scientific name to resolve.',
    },
    {
      reason: 'conflicting_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both taxon_id and name were provided.',
      recovery: 'Provide only one of taxon_id or name, not both, then retry.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The taxon ID or name did not resolve to a record.',
      recovery: 'Check the spelling or the NCBI taxon ID and try again.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The cursor was issued for another taxon, is malformed, or UniProt could not continue from it.',
      recovery:
        'Re-call with the same taxon and include_children but no cursor to restart from the first page.',
    },
  ],

  async handler(input, ctx) {
    const name = input.name?.trim();
    if (input.taxon_id && name) {
      throw ctx.fail('conflicting_identifier');
    }
    // Narrowed union: exactly one identifier survives the guards and reaches the service.
    const target = input.taxon_id ? { taxonId: input.taxon_id } : name ? { name } : undefined;
    if (!target) {
      throw ctx.fail('missing_identifier');
    }

    const service = getUniProtService();
    let taxon: Awaited<ReturnType<typeof service.getTaxonById>>;
    try {
      taxon =
        'taxonId' in target
          ? await service.getTaxonById(target.taxonId, ctx)
          : await service.getTaxonByName(target.name, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail('not_found', err.message);
      }
      throw err;
    }

    let children: TaxonChild[] | undefined;
    if (input.include_children) {
      // UniProt answers another taxon's cursor with a page from the middle of this taxon's
      // list, so the emitted cursor is "<taxonId>.<upstream cursor>" and checked here. The
      // split is at the first "." because UniProt's own part could hold one.
      let upstreamCursor: string | undefined;
      if (input.cursor) {
        const dot = input.cursor.indexOf('.');
        upstreamCursor = input.cursor.slice(dot + 1);
        if (dot === -1 || input.cursor.slice(0, dot) !== String(taxon.taxonId) || !upstreamCursor) {
          throw ctx.fail(
            'invalid_cursor',
            `The cursor was not issued for the children of taxon ${taxon.taxonId}.`,
          );
        }
      }
      // A cursor UniProt cannot continue from arrives from the service already carrying
      // reason invalid_cursor; the framework fills its recovery hint from this contract.
      const page: TaxonChildrenPage = await service.getChildren(
        taxon.taxonId,
        upstreamCursor ? { cursor: upstreamCursor } : {},
        ctx,
      );
      children = page.children;
      ctx.enrich({ childCount: children.length, totalChildren: page.totalChildren });
      if (page.cursor) {
        ctx.enrich.truncated({
          shown: children.length,
          cap: TAXON_CHILDREN_PAGE_SIZE,
          guidance: `This page lists ${children.length} of ${page.totalChildren} immediate children. Pass cursor to fetch the next page.`,
        });
        ctx.enrich({ cursor: `${taxon.taxonId}.${page.cursor}` });
      }
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
      lines.push(
        `**Other names:** ${t.otherNames.map((name) => markdown().inlineCode(name).build()).join('; ')}`,
      );
    lines.push(
      `**Lineage:** ${result.lineage
        .map(
          (l) =>
            `${l.scientificName}${l.commonName ? ` (${l.commonName})` : ''} [${l.taxonId}, ${l.rank}]`,
        )
        .join(' > ')}`,
    );
    if (result.children) {
      lines.push(`## Children (${result.children.length})`);
      if (!result.children.length) lines.push('No immediate child taxa.');
      for (const c of result.children)
        lines.push(`- ${c.scientificName} [${c.taxonId}] (${c.rank})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
