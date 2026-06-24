/**
 * @fileoverview uniprot_get_entry — fetch full curated UniProtKB entries by
 *   accession in batch (≤ 20). Returns partial-success output (succeeded[] +
 *   failed[]) so the agent knows which accessions resolved. When a single
 *   record exceeds the context budget, the response switches to a section
 *   outline (kind: 'outline'); the agent re-calls with sections:[...] to pull
 *   only the sections it needs. Entries do not search — accessions come from
 *   uniprot_search_proteins or uniprot_map_ids.
 * @module mcp-server/tools/definitions/uniprot-get-entry
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  formatOutline,
  OUTLINE_VARIANT,
  outlineOnOverflow,
  selectSections,
} from '@cyanheads/mcp-ts-core/utils';
import type { Entry } from '@/services/uniprot/types.js';
import { ACCESSION_REGEX } from '@/services/uniprot/types.js';
import { getUniProtService } from '@/services/uniprot/uniprot-service.js';

const EvidencedTextSchema = z
  .object({
    value: z.string().describe('The annotated text.'),
    evidence: z
      .array(z.string().describe('A PubMed/source evidence reference, e.g. "PubMed:11025664".'))
      .optional()
      .describe('Source evidence codes. Omitted when none are attached.'),
  })
  .describe('An annotation with its source evidence preserved.');

const FeatureSchema = z
  .object({
    type: z.string().describe('Feature type, e.g. "Modified residue" or "Domain".'),
    description: z
      .string()
      .optional()
      .describe('Free-text description of the feature. Omitted when absent.'),
    location: z
      .object({
        start: z.number().optional().describe('Start residue position. Omitted when not exact.'),
        end: z.number().optional().describe('End residue position. Omitted when not exact.'),
      })
      .describe('Residue range of the feature.'),
    featureId: z
      .string()
      .optional()
      .describe('Stable feature identifier, e.g. "VAR_066493". Omitted when none.'),
  })
  .describe('A sequence feature.');

const EntrySchema = z
  .object({
    accession: z.string().describe('UniProtKB primary accession.'),
    entryName: z.string().describe('UniProtKB mnemonic ID, e.g. "P53_HUMAN".'),
    proteinName: z
      .string()
      .optional()
      .describe('Recommended full protein name. Omitted when none.'),
    genes: z
      .array(z.string().describe('A gene name or synonym.'))
      .describe('Gene names and synonyms.'),
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
    length: z.number().describe('Canonical sequence length in residues.'),
    reviewed: z.boolean().describe('True for reviewed Swiss-Prot, false for unreviewed TrEMBL.'),
    annotationScore: z.number().describe('Annotation confidence on a 1–5 scale.'),
    proteinExistence: z.string().describe('Protein-existence evidence level.'),
    function: z
      .array(EvidencedTextSchema)
      .optional()
      .describe('FUNCTION annotations. Absent on most TrEMBL entries.'),
    catalyticActivity: z
      .array(
        z
          .object({
            name: z.string().describe('Reaction equation, e.g. "ATP + L-tyrosyl-[protein] = ...".'),
            ecNumber: z
              .string()
              .optional()
              .describe('Enzyme Commission number. Omitted when none.'),
            rheaId: z
              .string()
              .optional()
              .describe('Rhea reaction ID, e.g. "RHEA:10596". Omitted when none.'),
          })
          .describe('A catalyzed reaction.'),
      )
      .optional()
      .describe('Catalytic-activity reactions (Rhea-cross-referenced). Absent when not an enzyme.'),
    cofactors: z
      .array(
        z
          .object({
            name: z.string().describe('Cofactor name, e.g. "Zn(2+)".'),
            chebiId: z.string().optional().describe('ChEBI identifier. Omitted when none.'),
          })
          .describe('A required cofactor.'),
      )
      .optional()
      .describe('Cofactors. Absent when none are annotated.'),
    subcellularLocation: z
      .array(
        z
          .object({
            location: z.string().describe('Subcellular location, e.g. "Nucleus".'),
            topology: z
              .string()
              .optional()
              .describe('Membrane topology. Omitted when not applicable.'),
          })
          .describe('A subcellular location.'),
      )
      .optional()
      .describe('Subcellular locations. Absent when none are annotated.'),
    disease: z
      .array(
        z
          .object({
            name: z.string().describe('Disease name.'),
            diseaseId: z
              .string()
              .optional()
              .describe('UniProt disease accession, e.g. "DI-01537". Omitted when none.'),
            acronym: z.string().optional().describe('Disease acronym. Omitted when none.'),
            description: z.string().optional().describe('Disease description. Omitted when none.'),
            omimId: z.string().optional().describe('OMIM identifier. Omitted when none.'),
          })
          .describe('A disease association.'),
      )
      .optional()
      .describe('Disease involvements (DISEASE comments). Absent when none.'),
    ptms: z
      .array(FeatureSchema)
      .optional()
      .describe(
        'Post-translational modification features (modified residues, glycosylation, etc.). Absent when none.',
      ),
    variants: z
      .array(
        z
          .object({
            description: z.string().optional().describe('Variant description. Omitted when none.'),
            location: z
              .object({
                start: z
                  .number()
                  .optional()
                  .describe('Start residue position. Omitted when not exact.'),
                end: z
                  .number()
                  .optional()
                  .describe('End residue position. Omitted when not exact.'),
              })
              .describe('Residue range of the variant.'),
            original: z
              .string()
              .optional()
              .describe('Original residue(s). Omitted when not a substitution.'),
            variation: z
              .string()
              .optional()
              .describe('Variant residue(s). Omitted when not a substitution.'),
            featureId: z
              .string()
              .optional()
              .describe('Variant identifier, e.g. "VAR_066493". Omitted when none.'),
          })
          .describe('A natural variant.'),
      )
      .optional()
      .describe('Natural variants (dbSNP/ClinVar-linked). Absent when none.'),
    isoforms: z
      .array(
        z
          .object({
            isoformId: z.string().describe('Isoform accession, e.g. "P04637-2".'),
            name: z.string().optional().describe('Isoform name. Omitted when none.'),
            sequenceStatus: z
              .string()
              .optional()
              .describe('Sequence status, e.g. "Displayed" or "Described". Omitted when none.'),
          })
          .describe('An alternatively-spliced isoform.'),
      )
      .optional()
      .describe('Isoforms (ALTERNATIVE PRODUCTS). Absent when only one product.'),
    domains: z
      .array(FeatureSchema)
      .optional()
      .describe('Domain and region features. Absent when none.'),
    goTerms: z
      .array(
        z
          .object({
            id: z.string().describe('GO identifier, e.g. "GO:0006915".'),
            term: z.string().describe('GO term label, e.g. "apoptotic process".'),
            aspect: z.string().describe('GO aspect: P (process), F (function), or C (component).'),
          })
          .describe('A Gene Ontology annotation.'),
      )
      .optional()
      .describe('GO annotations. Absent when none.'),
    keywords: z
      .array(
        z
          .object({
            id: z.string().describe('Keyword identifier, e.g. "KW-0053".'),
            name: z.string().describe('Keyword name, e.g. "Apoptosis".'),
            category: z.string().optional().describe('Keyword category. Omitted when none.'),
          })
          .describe('A UniProt keyword.'),
      )
      .optional()
      .describe('UniProt keywords. Absent when none.'),
    xrefs: z
      .record(
        z.string(),
        z.array(z.string().describe('A cross-reference identifier in that database.')),
      )
      .optional()
      .describe(
        'Cross-references grouped by database (PDB, Ensembl, RefSeq, ChEMBL, AlphaFoldDB). Chain a PDB id into protein-mcp-server, a ChEMBL id into chembl. Absent when none.',
      ),
  })
  .describe('A full curated UniProtKB entry.');

export const getEntry = tool('uniprot_get_entry', {
  title: 'uniprot-mcp-server: get entry',
  description:
    'Fetch full curated UniProtKB entries by accession in one batch (up to 20). Each entry carries function, catalytic activity, cofactors, subcellular location, disease involvement, PTMs, natural variants, isoforms, domains, GO terms, keywords, and cross-references. Partial failures do not abort the batch — resolved entries land in succeeded[] and unknown/withdrawn accessions in failed[]. Pass fields to trim the upstream projection. A single oversized record returns kind: "outline" (a section listing with byte sizes) instead of overflowing context — re-call the same accession with sections:[...] (e.g. ["disease","variants"]) to pull only those. This tool does not search: accessions come from uniprot_search_proteins.results[].accession or uniprot_map_ids. Strip any isoform suffix (P04637-2 to P04637) before calling.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    accessions: z
      .array(
        z
          .string()
          .regex(ACCESSION_REGEX)
          .describe(
            'A UniProtKB primary accession, e.g. "P04637". Canonical form only — strip any "-N" isoform suffix.',
          ),
      )
      .min(1)
      .max(20)
      .describe('Accessions to fetch (1–20). From uniprot_search_proteins or uniprot_map_ids.'),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated UniProtKB field names to project, e.g. "accession,gene_names,cc_function,ft_variant". Omit for the full curated default set. Use this on the initial call to trim payload.',
      ),
    sections: z
      .array(
        z
          .string()
          .describe(
            'A section key from a prior outline response, e.g. "disease", "variants", "function", "xrefs".',
          ),
      )
      .optional()
      .describe(
        'Only used to re-call after a kind: "outline" response — pass a subset of the outlined section keys to fetch just those sections. Do not pass on the initial call.',
      ),
  }),
  output: z.object({
    result: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z
              .literal('full')
              .describe('Discriminator: a full (or section-projected) batch result.'),
            succeeded: z.array(EntrySchema).describe('Entries that resolved successfully.'),
            failed: z
              .array(
                z
                  .object({
                    accession: z.string().describe('The requested accession that did not resolve.'),
                    error: z.string().describe('Why it failed and how to recover.'),
                  })
                  .describe('A per-accession failure.'),
              )
              .describe('Accessions that were well-formed but not found in UniProtKB.'),
          })
          .describe('Full batch result with per-accession success/failure split.'),
        OUTLINE_VARIANT.describe(
          'Section outline returned when a single record exceeds the context budget. Re-call with sections:[...] to retrieve specific sections.',
        ),
      ])
      .describe(
        'Either the full batch result (kind: "full") or a section outline (kind: "outline") for an oversized single record.',
      ),
  }),
  errors: [
    {
      reason: 'all_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every accession in the batch was well-formed but unknown to UniProtKB.',
      recovery: 'Verify the accessions via uniprot_search_proteins or uniprot_map_ids, then retry.',
    },
  ],

  async handler(input, ctx) {
    const service = getUniProtService();
    const entries = await service.getEntries(input.accessions, input.fields, ctx);

    const byAccession = new Map(entries.map((e) => [e.accession, e]));
    const succeeded: Entry[] = [];
    const failed: { accession: string; error: string }[] = [];
    for (const acc of input.accessions) {
      const entry = byAccession.get(acc);
      if (entry) succeeded.push(entry);
      else
        failed.push({
          accession: acc,
          error: `Accession ${acc} not found in UniProtKB. Verify via uniprot_search_proteins or uniprot_map_ids.`,
        });
    }

    if (succeeded.length === 0) {
      throw ctx.fail(
        'all_not_found',
        `None of the ${input.accessions.length} accession(s) resolved in UniProtKB.`,
        {
          accessions: input.accessions,
          ...ctx.recoveryFor('all_not_found'),
        },
      );
    }

    // Single-record overflow path: outline a fat record so the agent re-calls with sections:[...].
    if (succeeded.length === 1 && failed.length === 0) {
      const entry = succeeded[0]!;
      if (input.sections?.length) {
        const projected = selectSections(
          entry as unknown as Record<string, unknown>,
          input.sections,
          {
            alwaysKeep: [
              'accession',
              'entryName',
              'proteinName',
              'genes',
              'organism',
              'length',
              'reviewed',
              'annotationScore',
              'proteinExistence',
            ],
          },
        );
        return {
          result: { kind: 'full' as const, succeeded: [projected as unknown as Entry], failed },
        };
      }
      const outcome = outlineOnOverflow(entry as unknown as Record<string, unknown>);
      if (outcome.kind === 'outline') {
        ctx.log.info('Entry exceeded budget — returning outline', {
          accession: entry.accession,
          sections: outcome.sections.length,
        });
        return { result: outcome };
      }
    }

    if (failed.length > 0) {
      ctx.log.info('Batch entry fetch had partial failures', {
        succeeded: succeeded.length,
        failed: failed.length,
      });
    }
    return { result: { kind: 'full' as const, succeeded, failed } };
  },

  format: ({ result }) => {
    if (result.kind === 'outline') {
      return [
        {
          type: 'text',
          text: `_Result: ${result.kind} — record too large; re-call with sections:[...]._`,
        },
        ...formatOutline(result),
      ];
    }

    const lines = [`_Result: ${result.kind}_`];
    for (const e of result.succeeded) {
      lines.push(`# ${e.proteinName ?? e.entryName} (${e.accession})`);
      lines.push(`**Entry:** ${e.entryName}`);
      lines.push(
        [
          e.reviewed ? 'Reviewed (Swiss-Prot)' : 'Unreviewed (TrEMBL)',
          `Score ${e.annotationScore}/5`,
          `${e.length} aa`,
          e.proteinExistence,
        ].join(' · '),
      );
      lines.push(
        `**Organism:** ${e.organism.scientificName}${e.organism.commonName ? ` (${e.organism.commonName})` : ''}${e.organism.mnemonic ? ` "${e.organism.mnemonic}"` : ''} [taxon ${e.organism.taxonId}]`,
      );
      if (e.genes.length) lines.push(`**Genes:** ${e.genes.join(', ')}`);
      if (e.function?.length)
        lines.push(
          `**Function:** ${e.function
            .map((f) => `${f.value}${f.evidence?.length ? ` (${f.evidence.join(', ')})` : ''}`)
            .join(' ')}`,
        );
      if (e.catalyticActivity?.length) {
        lines.push('**Catalytic activity:**');
        for (const r of e.catalyticActivity)
          lines.push(
            `- ${r.name}${r.rheaId ? ` (${r.rheaId})` : ''}${r.ecNumber ? ` [EC ${r.ecNumber}]` : ''}`,
          );
      }
      if (e.cofactors?.length)
        lines.push(
          `**Cofactors:** ${e.cofactors.map((c) => `${c.name}${c.chebiId ? ` (${c.chebiId})` : ''}`).join(', ')}`,
        );
      if (e.subcellularLocation?.length)
        lines.push(
          `**Subcellular location:** ${e.subcellularLocation.map((l) => l.location + (l.topology ? ` (${l.topology})` : '')).join('; ')}`,
        );
      if (e.disease?.length) {
        lines.push('**Disease:**');
        for (const d of e.disease)
          lines.push(
            `- ${d.name}${d.acronym ? ` (${d.acronym})` : ''}${d.omimId ? ` [OMIM:${d.omimId}]` : ''}${d.diseaseId ? ` [${d.diseaseId}]` : ''}${d.description ? `: ${d.description}` : ''}`,
          );
      }
      if (e.variants?.length) {
        lines.push(`**Variants:** ${e.variants.length} natural variant(s)`);
        for (const v of e.variants.slice(0, 25)) {
          const pos =
            v.location.start === v.location.end || v.location.end == null
              ? `${v.location.start ?? '?'}`
              : `${v.location.start ?? '?'}-${v.location.end}`;
          lines.push(
            `- ${pos}${v.original && v.variation ? ` ${v.original}→${v.variation}` : ''}${v.featureId ? ` [${v.featureId}]` : ''}${v.description ? `: ${v.description}` : ''}`,
          );
        }
      }
      if (e.ptms?.length) {
        lines.push(`**PTMs:** ${e.ptms.length}`);
        for (const p of e.ptms.slice(0, 25)) {
          const range =
            p.location.start != null
              ? ` @${p.location.start}${p.location.end != null && p.location.end !== p.location.start ? `-${p.location.end}` : ''}`
              : '';
          lines.push(
            `- ${p.type}${range}${p.featureId ? ` [${p.featureId}]` : ''}${p.description ? `: ${p.description}` : ''}`,
          );
        }
      }
      if (e.domains?.length) {
        lines.push('**Domains/regions:**');
        for (const d of e.domains.slice(0, 25))
          lines.push(
            `- ${d.type}${d.location.start != null ? ` ${d.location.start}-${d.location.end ?? '?'}` : ''}${d.featureId ? ` [${d.featureId}]` : ''}${d.description ? `: ${d.description}` : ''}`,
          );
      }
      if (e.isoforms?.length)
        lines.push(
          `**Isoforms:** ${e.isoforms.map((i) => `${i.isoformId}${i.name ? ` (${i.name})` : ''}${i.sequenceStatus ? ` [${i.sequenceStatus}]` : ''}`).join(', ')}`,
        );
      if (e.goTerms?.length)
        lines.push(`**GO:** ${e.goTerms.map((g) => `${g.id} [${g.aspect}] ${g.term}`).join('; ')}`);
      if (e.keywords?.length)
        lines.push(
          `**Keywords:** ${e.keywords.map((k) => `${k.name} (${k.id})${k.category ? ` — ${k.category}` : ''}`).join(', ')}`,
        );
      if (e.xrefs && Object.keys(e.xrefs).length) {
        lines.push('**Cross-references:**');
        for (const [db, ids] of Object.entries(e.xrefs))
          lines.push(`- ${db}: ${ids.slice(0, 30).join(', ')}`);
      }
      lines.push('');
    }
    if (result.failed.length) {
      lines.push('### Not found');
      for (const f of result.failed) lines.push(`- **${f.accession}** — ${f.error}`);
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
