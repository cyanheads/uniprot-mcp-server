/**
 * @fileoverview uniprot_get_entry — fetch full curated UniProtKB entries by
 *   accession in batch (≤ 20). Returns partial-success output (succeeded[] +
 *   failed[]) so the agent knows which accessions resolved. When the complete
 *   inline result exceeds 24,000 UTF-8 bytes, return an accession outline for a
 *   batch or section outline for a single record; the agent re-calls one accession with
 *   sections:[...] to pull only the sections it needs, paging a list section
 *   still too large on its own with section_limit/section_offset. Entries do not search — accessions come from
 *   uniprot_search_proteins or uniprot_map_ids.
 * @module mcp-server/tools/definitions/uniprot-get-entry
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { markdown, selectSections } from '@cyanheads/mcp-ts-core/utils';
import type { Entry, InactiveEntry } from '@/services/uniprot/types.js';
import { ACCESSION_MESSAGE, ACCESSION_REGEX, describeInactive } from '@/services/uniprot/types.js';
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

/** Every section key the tool emits — the keys `sections` may name. */
const SECTION_KEYS = Object.keys(EntrySchema.shape);

/**
 * Canonical section key by lowercased key. The 21 keys are distinct ignoring case,
 * so `Function` or `GOTERMS` maps to exactly one key (`function`, `goTerms`).
 */
const SECTION_KEY_BY_LOWERCASE = new Map(SECTION_KEYS.map((k) => [k.toLowerCase(), k]));

/** List-valued sections — the ones section_limit/section_offset can window. */
const LIST_SECTION_KEYS = Object.entries(EntrySchema.shape)
  .filter(
    ([, field]) => (field instanceof z.ZodOptional ? field.unwrap() : field) instanceof z.ZodArray,
  )
  .map(([key]) => key);

/** Maximum UTF-8 bytes of the complete inline result, including both client surfaces. */
const INLINE_BUDGET_BYTES = 24_000;

/** Identity keys a `sections` projection always keeps, so the slice still names its protein. */
const IDENTITY_KEYS = [
  'accession',
  'entryName',
  'proteinName',
  'genes',
  'organism',
  'length',
  'reviewed',
  'annotationScore',
  'proteinExistence',
];

export const getEntry = tool('uniprot_get_entry', {
  title: 'uniprot-mcp-server: get entry',
  description:
    'Fetch full curated UniProtKB entries by accession in one batch (up to 20). Each entry carries function, catalytic activity, cofactors, subcellular location, disease involvement, PTMs, natural variants, isoforms, domains, GO terms, keywords, and cross-references. Partial failures do not abort the batch — resolved entries land in succeeded[] and unknown or inactive (merged, demerged, deleted) accessions in failed[], where an inactive accession names its replacement or UniParc ID. Pass fields to trim the upstream projection. Initial responses exceeding 24,000 UTF-8 bytes across both output surfaces return kind: "outline": a single resolved record lists sections with byte sizes; a batch lists outlinedEntries in request order and retains failed[]. Re-call each outlined accession individually, e.g. accessions:["P04637"], for its full record or section outline, then add sections:["disease","variants"] to select sections. sections takes exactly one accession; trim a batch with fields instead. All returned list items and cross-reference IDs render in full. A large list section pages with section_limit/section_offset on a re-call naming that one section. This tool does not search: accessions come from uniprot_search_proteins.results[].accession or uniprot_map_ids. Strip any isoform suffix (P04637-2 to P04637) before calling.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    accessions: z
      .array(
        z
          .string()
          .regex(ACCESSION_REGEX, ACCESSION_MESSAGE)
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
        'Only used to re-call one accession after a kind: "outline" response — pass a subset of the outlined section keys to fetch just those sections. Requires exactly one accession: a batch with sections is rejected, so trim a batch with fields. A requested section the record lacks is named in absentSections, not an error. Do not pass on the initial call.',
      ),
    section_limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Window size for one list section on a sections re-call: return at most this many items of it (1–500). Requires sections naming exactly one list section, e.g. ["variants"] (or ptms, domains, goTerms). Omit together with section_offset to return the whole section.',
      ),
    section_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Zero-based index of the first item in the windowed section. Defaults to 0. Pass the previous response's nextOffset to page forward. Same requirements as section_limit; set without section_limit, returns every item from this index on.",
      ),
  }),
  output: z.object({
    kind: z
      .enum(['full', 'outline'])
      .describe(
        'Result kind. "full": read succeeded[] and failed[]. "outline": the complete inline result exceeded 24,000 UTF-8 bytes; read outlinedEntries for a batch or sections for a single record, and re-call one accession individually.',
      ),
    succeeded: z
      .array(EntrySchema)
      .optional()
      .describe('Entries that resolved successfully. Present when kind is "full".'),
    failed: z
      .array(
        z
          .object({
            accession: z.string().describe('The requested accession that did not resolve.'),
            error: z
              .string()
              .describe(
                'Why it failed and how to recover. For an inactive accession: the merge target to retry with, the demerge products to choose among, or the UniParc ID that keeps a deleted sequence.',
              ),
          })
          .describe('A per-accession failure.'),
      )
      .optional()
      .describe(
        'Accessions that did not resolve to an active entry — unknown to UniProtKB, or inactive (merged, demerged, or deleted). Retained on batch outlines as well as full results.',
      ),
    sections: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe('Section identifier — pass a subset in sections:[...] to retrieve it.'),
            bytes: z.number().describe('Serialized byte size of the section.'),
          })
          .describe('An outlined section with its serialized size.'),
      )
      .optional()
      .describe(
        'Section outline for a single fully resolved accession whose inline result exceeds the budget. Absent on batch outlines, which return outlinedEntries instead.',
      ),
    outlinedEntries: z
      .array(
        z
          .object({
            accession: z
              .string()
              .describe('Accession to re-call individually with accessions:[accession].'),
            bytes: z.number().describe('UTF-8 serialized bytes of this entry before outlining.'),
          })
          .describe('An omitted successful entry and its size.'),
      )
      .optional()
      .describe(
        'Successful entries omitted when the aggregate inline result exceeds 24,000 UTF-8 bytes, in request order. Re-call each accession individually for its full record or section outline.',
      ),
    window: z
      .object({
        section: z.string().describe('The section key section_limit/section_offset windowed.'),
        offset: z.number().describe('Index of the first returned item within the full section.'),
      })
      .optional()
      .describe(
        "The window applied to succeeded[0]'s one requested section. Present only when section_limit or section_offset was set; totalCount and nextOffset place it in the full section.",
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Re-call guidance. On a single-record outline: re-call that accession with sections:[...] to pull specific sections. On a batch outline: re-call each outlined accession individually with accessions:[accession]. On a section window: the section_offset that pages the rest, or why the window came back empty.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Items in the windowed section before section_limit/section_offset applied. Present on every windowed call; 0 when the record lacks the section.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when items remain past the returned window. Absent on the final window.'),
    shown: z.number().optional().describe('Items in the returned window. Present when truncated.'),
    cap: z.number().optional().describe('The section_limit applied. Present when truncated.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'section_offset for the next window (same section_limit). Present while items remain.',
      ),
    absentSections: z
      .array(z.string().describe('A requested section key the record does not carry.'))
      .optional()
      .describe(
        'Requested section keys this record does not carry — UniProt holds no annotation of that kind for it, or fields excluded it. Not an error: the other requested sections are returned. Present only on a sections re-call that named one.',
      ),
  },
  enrichmentTrailer: {
    nextOffset: { label: 'Next section_offset' },
    absentSections: {
      render: (keys: string[]) =>
        `**Absent sections:** ${keys.join(', ')} — this record carries no data for ${keys.length === 1 ? 'that section' : 'those sections'}.`,
    },
  },
  errors: [
    {
      reason: 'sections_single_accession',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sections was passed with more than one accession — rejected before any request. sections re-calls a single outlined record.',
      recovery:
        'Trim a batch with fields instead, or re-call one accession at a time with sections.',
    },
    {
      reason: 'unknown_section',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'sections named a key this tool never emits — rejected before any request. The message lists every valid key.',
      recovery:
        'Pass section keys from the outline response, or pick from the valid keys the message lists.',
    },
    {
      reason: 'invalid_section_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'section_limit or section_offset was set without sections naming exactly one list section — no sections, several, or a non-list section such as organism or xrefs. Rejected before any request.',
      recovery:
        'Re-call with sections naming one list section (e.g. ["variants"]), or drop section_limit and section_offset.',
    },
    {
      reason: 'all_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No accession in the batch resolved to an active entry — each was unknown to UniProtKB or inactive (merged, demerged, or deleted). The message names each inactive accession and its replacement.',
      recovery:
        'Retry with a replacement accession the message names, or verify the accessions via uniprot_search_proteins or uniprot_map_ids.',
    },
    {
      reason: 'invalid_fields',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'UniProtKB rejected the fields value — the message relays UniProt naming the rejected field.',
      recovery:
        'Correct or remove the field named in the message, or omit fields for the default curated set.',
    },
  ],

  async handler(input, ctx) {
    // Keys resolve case-insensitively to their canonical spelling; an unknown key stays as sent.
    const sections = input.sections?.map((s) => SECTION_KEY_BY_LOWERCASE.get(s.toLowerCase()) ?? s);
    if (sections?.length) {
      if (input.accessions.length > 1) {
        throw ctx.fail(
          'sections_single_accession',
          `sections re-calls one outlined record, but ${input.accessions.length} accessions were passed. Trim a batch with fields (e.g. "accession,cc_function,cc_disease"), or re-call one accession at a time with sections.`,
          { accessions: input.accessions.length },
        );
      }
      const unmatched = [...new Set(sections.filter((s) => !SECTION_KEYS.includes(s)))];
      if (unmatched.length > 0) {
        throw ctx.fail(
          'unknown_section',
          `Unknown section${unmatched.length === 1 ? '' : 's'}: ${unmatched.join(', ')}. Available sections: ${SECTION_KEYS.join(', ')}.`,
          { unmatched, available: SECTION_KEYS },
        );
      }
    }

    const windowed = input.section_limit !== undefined || input.section_offset !== undefined;
    if (windowed) {
      const named = [...new Set(sections ?? [])];
      const listHint = `List sections: ${LIST_SECTION_KEYS.join(', ')}.`;
      if (named.length !== 1) {
        throw ctx.fail(
          'invalid_section_window',
          `section_limit and section_offset window exactly one section, but sections ${sections === undefined ? 'was not passed' : `names ${named.length}`}. Re-call with sections naming one list section, e.g. sections:["variants"]. ${listHint}`,
        );
      }
      if (!LIST_SECTION_KEYS.includes(named[0] as string)) {
        throw ctx.fail(
          'invalid_section_window',
          `${named[0]} is not a list section, so section_limit and section_offset cannot window it — drop them to fetch it whole. ${listHint}`,
        );
      }
    }

    const service = getUniProtService();
    let batch: { entries: Entry[]; inactive: InactiveEntry[] };
    try {
      batch = await service.getEntries(input.accessions, input.fields, ctx);
    } catch (err) {
      // The service relays UniProt's 400 as InvalidParams carrying UniProt's own message;
      // the only caller text this request carries is fields (accessions are regex-checked).
      if (err instanceof McpError && err.code === JsonRpcErrorCode.InvalidParams) {
        throw ctx.fail('invalid_fields', err.message, undefined, { cause: err });
      }
      throw err;
    }

    const byAccession = new Map(batch.entries.map((e) => [e.accession, e]));
    const inactiveByAccession = new Map(batch.inactive.map((i) => [i.accession, i]));
    const succeeded: Entry[] = [];
    const failed: { accession: string; error: string }[] = [];
    const inactiveReasons: string[] = [];
    for (const acc of input.accessions) {
      const entry = byAccession.get(acc);
      const inactive = inactiveByAccession.get(acc);
      if (entry) {
        succeeded.push(entry);
      } else if (inactive) {
        const error = describeInactive(inactive);
        failed.push({ accession: acc, error });
        inactiveReasons.push(error);
      } else {
        failed.push({
          accession: acc,
          error: `Accession ${acc} not found in UniProtKB. Verify via uniprot_search_proteins or uniprot_map_ids.`,
        });
      }
    }

    if (succeeded.length === 0) {
      throw ctx.fail(
        'all_not_found',
        [
          `None of the ${input.accessions.length} accession(s) resolved in UniProtKB.`,
          ...inactiveReasons,
        ].join(' '),
        { accessions: input.accessions },
      );
    }

    // Single-record overflow path: outline a fat record so the agent re-calls with sections:[...].
    const entry = failed.length === 0 && succeeded.length === 1 ? succeeded[0] : undefined;
    if (entry) {
      if (sections?.length) {
        // Keys were checked against SECTION_KEYS above; one missing here is a section this record lacks.
        const record = entry as unknown as Record<string, unknown>;
        const absent = [...new Set(sections.filter((s) => !(s in record)))];
        const projected = selectSections(
          record,
          sections.filter((s) => s in record),
          { alwaysKeep: IDENTITY_KEYS },
        );
        if (absent.length > 0) ctx.enrich({ absentSections: absent });
        if (!windowed) {
          return { kind: 'full' as const, succeeded: [projected as unknown as Entry], failed };
        }

        // Validated above: sections names exactly one list section.
        const section = sections[0] as string;
        const offset = input.section_offset ?? 0;
        const items = (projected[section] as unknown[] | undefined) ?? [];
        const end =
          input.section_limit === undefined
            ? items.length
            : Math.min(offset + input.section_limit, items.length);
        if (section in projected) projected[section] = items.slice(offset, end);
        ctx.enrich.total(items.length);
        if (input.section_limit !== undefined && end < items.length) {
          ctx.enrich.truncated({
            shown: end - offset,
            cap: input.section_limit,
            guidance: `${items.length - end} of ${items.length} items in ${section} remain. Re-call with section_offset:${end} (same section_limit) for the next window.`,
          });
          ctx.enrich({ nextOffset: end });
        } else if (items.length > 0 && offset >= items.length) {
          ctx.enrich.notice(
            `section_offset ${offset} is past the end of ${section}, which holds ${items.length} item(s) — page with section_offset below ${items.length}.`,
          );
        }
        return {
          kind: 'full' as const,
          succeeded: [projected as unknown as Entry],
          failed,
          window: { section, offset },
        };
      }
    }

    const inline = { kind: 'full' as const, succeeded, failed };
    /** Initial full calls attach no enrichment. Measure both surfaces after the schema parse the framework applies. */
    const parsed = { ...inline, succeeded: succeeded.map((value) => EntrySchema.parse(value)) };
    const sizeBytes = Buffer.byteLength(
      JSON.stringify({ structuredContent: parsed, content: formatEntryResult(parsed) }),
      'utf8',
    );
    if (sizeBytes > INLINE_BUDGET_BYTES) {
      ctx.log.info('Entry result exceeded the inline budget — returning outline', {
        sizeBytes,
        succeeded: succeeded.length,
        failed: failed.length,
      });
      if (entry) {
        const outlinedSections = Object.entries(entry)
          .map(([name, value]) => ({
            name,
            bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          }))
          .sort((a, b) => b.bytes - a.bytes);
        ctx.enrich.notice(
          `Re-call with accessions:["${entry.accession}"] and sections:[...] to retrieve selected sections; use section_limit and section_offset for one list section.`,
        );
        return { kind: 'outline' as const, sections: outlinedSections };
      }
      ctx.enrich.notice(
        'Re-call each outlined accession individually with accessions:[accession] for its full record or section outline.',
      );
      return {
        kind: 'outline' as const,
        outlinedEntries: succeeded.map((value) => ({
          accession: value.accession,
          bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
        })),
        failed,
      };
    }

    if (failed.length > 0) {
      ctx.log.info('Batch entry fetch had partial failures', {
        succeeded: succeeded.length,
        failed: failed.length,
      });
    }
    return inline;
  },

  format: formatEntryResult,
});

/** Render every value returned by an entry call, including caller-selected section windows. */
function formatEntryResult(result: {
  kind: 'full' | 'outline';
  succeeded?: z.infer<typeof EntrySchema>[];
  failed?: { accession: string; error: string }[];
  sections?: { name: string; bytes: number }[];
  outlinedEntries?: { accession: string; bytes: number }[];
  window?: { section: string; offset: number };
}): { type: 'text'; text: string }[] {
  const lines = [`**Result kind:** ${result.kind}`];

  if (result.sections?.length) {
    // Outline arm: a single oversized record returned as a section listing.
    lines.push('Record too large — re-call with sections:[...] to pull only what you need.');
    for (const s of result.sections) lines.push(`- **${s.name}** — ${s.bytes} bytes`);
  }
  for (const e of result.outlinedEntries ?? [])
    lines.push(
      `- **${e.accession}** — ${e.bytes} bytes; re-call with accessions:["${e.accession}"].`,
    );
  const windowSection = result.window?.section;
  for (const e of result.succeeded ?? []) {
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
    if (result.window) {
      const { section, offset } = result.window;
      const count = (e[section as keyof Entry] as unknown[] | undefined)?.length ?? 0;
      lines.push(
        count > 0
          ? `**Window:** \`${section}\` items ${offset + 1}–${offset + count} (section_offset ${offset})`
          : `**Window:** \`${section}\` — no items at section_offset ${offset}`,
      );
    }
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
      lines.push(
        `**Variants:** ${e.variants.length} natural variant(s)${windowSection === 'variants' ? ' in this window' : ''}`,
      );
      for (const v of e.variants) {
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
      lines.push(`**PTMs:** ${e.ptms.length}${windowSection === 'ptms' ? ' in this window' : ''}`);
      for (const p of e.ptms) {
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
      for (const d of e.domains)
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
        lines.push(
          `- ${markdown().inlineCode(db).build()}: ${ids.map((id) => markdown().inlineCode(id).build()).join(', ')}`,
        );
    }
    lines.push('');
  }
  if (result.failed?.length) {
    lines.push('### Not found');
    for (const f of result.failed) lines.push(`- **${f.accession}** — ${f.error}`);
  }
  return [{ type: 'text', text: lines.join('\n').trim() }];
}
