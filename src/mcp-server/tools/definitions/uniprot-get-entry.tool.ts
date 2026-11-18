/**
 * @fileoverview uniprot_get_entry — fetch full curated UniProtKB entries by
 *   accession in batch: up to 500 accepted, repeats collapsed, the first 20
 *   distinct fetched and the rest returned in deferredAccessions. Returns
 *   partial-success output (succeeded[] + failed[]) so the agent knows which
 *   accessions resolved. Each record is measured on its own, as a one-accession
 *   call would measure it: one within 24,000 UTF-8 bytes inlines, a larger one is
 *   listed in outlinedEntries (a lone accession returns its section outline). The
 *   agent re-calls one accession with sections:[...] to pull only the sections it
 *   needs, paging a list section still too large on its own with
 *   section_limit/section_offset. Entries do not search — accessions come from
 *   uniprot_search_proteins or uniprot_map_ids.
 * @module mcp-server/tools/definitions/uniprot-get-entry
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { markdown, selectSections } from '@cyanheads/mcp-ts-core/utils';
import { clamping, countInput, recordDeferral } from '@/mcp-server/tools/input-limits.js';
import { entryFieldRequest, ignoredFieldsNotice } from '@/services/uniprot/return-fields.js';
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

const SiteSchema = FeatureSchema.extend({
  ligand: z
    .object({
      name: z.string().describe('Ligand name, e.g. "Ca(2+)" or "heme b".'),
      chebiId: z
        .string()
        .optional()
        .describe(
          'ChEBI identifier, e.g. "CHEBI:29108". Omitted when ChEBI does not cover the ligand.',
        ),
      label: z
        .string()
        .optional()
        .describe(
          'Tells apart copies of one ligand bound at different sites, e.g. "1". Omitted when none.',
        ),
      note: z
        .string()
        .optional()
        .describe('Curator note on the ligand, e.g. "catalytic". Omitted when none.'),
    })
    .optional()
    .describe('The ligand a binding site binds. Omitted on active sites and other sites.'),
  ligandPart: z
    .object({
      name: z.string().describe('Name of the ligand part, e.g. "Fe".'),
      chebiId: z.string().optional().describe('ChEBI identifier of the part. Omitted when none.'),
    })
    .optional()
    .describe(
      'The part of the ligand the residue binds, e.g. the Fe of heme b. Omitted when none.',
    ),
}).describe('An active site, a binding site with its ligand, or another functional site.');

/** A residue change — the shape of a natural variant and of a mutagenesis experiment. */
const VariantSchema = z.object({
  description: z.string().optional().describe('Variant description. Omitted when none.'),
  location: z
    .object({
      start: z.number().optional().describe('Start residue position. Omitted when not exact.'),
      end: z.number().optional().describe('End residue position. Omitted when not exact.'),
    })
    .describe('Residue range of the variant.'),
  original: z.string().optional().describe('Original residue(s). Omitted when not a substitution.'),
  variation: z
    .string()
    .optional()
    .describe(
      'Variant residue(s); several substitutions tested at one position are comma-separated, e.g. "A,P". Omitted when not a substitution.',
    ),
  featureId: z
    .string()
    .optional()
    .describe('Variant identifier, e.g. "VAR_066493". Omitted when none.'),
});

const CommentSchema = z
  .object({
    type: z
      .string()
      .describe(
        'UniProt comment type, e.g. "PTM", "PATHWAY", "SUBUNIT", or "DISEASE" for a disease note that names no disease.',
      ),
    value: z.string().describe('The comment text.'),
    evidence: z
      .array(z.string().describe('A PubMed/source evidence reference, e.g. "PubMed:11057674".'))
      .optional()
      .describe('Source evidence codes. Omitted when none are attached.'),
    molecule: z
      .string()
      .optional()
      .describe('The isoform or chain the text is about, e.g. "Isoform 2". Omitted when none.'),
  })
  .describe('A free-text annotation.');

const InteractionSchema = z
  .object({
    partner: z
      .string()
      .describe('Partner UniProtKB accession — an isoform accession when IntAct names one.'),
    partnerChain: z
      .string()
      .optional()
      .describe(
        'The partner chain when IntAct names one product of a polyprotein, e.g. "PRO_0000037536". Omitted otherwise.',
      ),
    gene: z.string().optional().describe('Partner gene name. Omitted when none.'),
    experiments: z.number().describe('Number of IntAct experiments supporting the interaction.'),
    organismDiffer: z
      .boolean()
      .optional()
      .describe('True when the partner comes from another organism. Omitted otherwise.'),
    isoform: z
      .string()
      .optional()
      .describe(
        'This entry\'s isoform accession when the interaction is recorded for one, e.g. "P04637-7". Omitted otherwise.',
      ),
    chain: z
      .string()
      .optional()
      .describe(
        'This entry\'s chain when the interaction is recorded for one product of a polyprotein, e.g. "PRO_0000037540". Omitted otherwise.',
      ),
  })
  .describe('A binary interaction partner (IntAct).');

const EntrySchema = z
  .object({
    accession: z.string().describe('UniProtKB primary accession.'),
    entryName: z.string().describe('UniProtKB mnemonic ID, e.g. "P53_HUMAN".'),
    proteinName: z
      .string()
      .optional()
      .describe('Recommended full protein name. Omitted when none.'),
    alternativeNames: z
      .array(z.string().describe('An alternative full protein name.'))
      .optional()
      .describe('Alternative full protein names. Absent when none.'),
    genes: z
      .array(z.string().describe('A gene name, synonym, ordered-locus name, or ORF name.'))
      .describe(
        'Every name of each gene in UniProt order: gene name, synonyms, ordered-locus names (e.g. "b3296", "JW3258"), and ORF names (e.g. "J0580").',
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
    length: z.number().describe('Canonical sequence length in residues.'),
    reviewed: z.boolean().describe('True for reviewed Swiss-Prot, false for unreviewed TrEMBL.'),
    annotationScore: z.number().describe('Annotation confidence on a 1–5 scale.'),
    proteinExistence: z.string().describe('Protein-existence evidence level.'),
    ecNumbers: z
      .array(z.string().describe('An Enzyme Commission number, e.g. "3.4.21.4".'))
      .optional()
      .describe('EC numbers of the recommended name. Absent when none.'),
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
    sites: z
      .array(SiteSchema)
      .optional()
      .describe(
        'Active sites, binding sites with the ligand they bind, and other functional sites. Absent when none.',
      ),
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
    topology: z
      .array(FeatureSchema)
      .optional()
      .describe(
        'Membrane topology: topological domains, transmembrane and intramembrane segments. Absent when none.',
      ),
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
            note: z
              .string()
              .optional()
              .describe(
                'How the gene is involved, e.g. "The disease is caused by variants affecting the gene represented in this entry". Omitted when none.',
              ),
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
    processing: z
      .array(FeatureSchema)
      .optional()
      .describe(
        'Molecule processing: signal peptide, transit peptide, propeptides, chains, peptides, and initiator methionine. Absent when none.',
      ),
    variants: z
      .array(VariantSchema.describe('A natural variant.'))
      .optional()
      .describe('Natural variants (dbSNP/ClinVar-linked). Absent when none.'),
    mutagenesis: z
      .array(VariantSchema.describe('A mutagenesis experiment: the residue change and its effect.'))
      .optional()
      .describe(
        'Site-directed mutagenesis: each residue change with its observed effect as the description. Absent when none.',
      ),
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
    comments: z
      .array(CommentSchema)
      .optional()
      .describe(
        'Free-text annotations by type (PTM, PATHWAY, SUBUNIT, TISSUE SPECIFICITY, and the other free-text types), plus any DISEASE note that names no disease. Absent when none.',
      ),
    interactions: z
      .array(InteractionSchema)
      .optional()
      .describe('Binary interaction partners (IntAct). Absent when none.'),
    goTerms: z
      .array(
        z
          .object({
            id: z.string().describe('GO identifier, e.g. "GO:0006915".'),
            term: z.string().describe('GO term label, e.g. "apoptotic process".'),
            aspect: z.string().describe('GO aspect: P (process), F (function), or C (component).'),
            evidenceType: z
              .string()
              .optional()
              .describe(
                'GO evidence code and its assigning source, e.g. "IDA:UniProtKB" or "IEA:InterPro". Omitted when none.',
              ),
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
        'Cross-reference IDs keyed by database name as UniProt spells it. The default record carries PDB, Ensembl, RefSeq, ChEMBL, AlphaFoldDB, InterPro, Pfam, HGNC, MIM, GeneID, and STRING; fields with an xref_ name (e.g. xref_reactome) adds that database. GO terms are in goTerms, never here. Chain a PDB id into protein-mcp-server, a ChEMBL id into chembl. Absent when none.',
      ),
    ensemblGenes: z
      .array(z.string().describe('An Ensembl gene ID, e.g. "ENSG00000141510.20".'))
      .optional()
      .describe(
        'Distinct Ensembl gene IDs behind the transcript IDs in xrefs.Ensembl. Absent when none.',
      ),
  })
  .describe('A full curated UniProtKB entry.');

/** Every section key the tool emits — the keys `sections` may name. */
const SECTION_KEYS = Object.keys(EntrySchema.shape);

/**
 * Canonical section key by lowercased key. The keys are distinct ignoring case, so
 * `Function` or `GOTERMS` maps to exactly one key (`function`, `goTerms`).
 */
const SECTION_KEY_BY_LOWERCASE = new Map(SECTION_KEYS.map((k) => [k.toLowerCase(), k]));

/** List-valued sections — the ones section_limit/section_offset can window. */
const LIST_SECTION_KEYS = Object.entries(EntrySchema.shape)
  .filter(
    ([, field]) => (field instanceof z.ZodOptional ? field.unwrap() : field) instanceof z.ZodArray,
  )
  .map(([key]) => key);

/** Maximum UTF-8 bytes of one record's one-accession result, including both client surfaces. */
const INLINE_BUDGET_BYTES = 24_000;

/** The most distinct accessions one call fetches; the rest return in deferredAccessions. */
const FETCH_CAP = 20;

/** The most accessions one call accepts: the largest page the search, proteome, and mapping tools return. */
const ACCESSION_CEILING = 500;

/** The accessions maximum in force: the ceiling while clamping, else the fetch cap. */
const accessionMaximum = () => (clamping() ? ACCESSION_CEILING : FETCH_CAP);

/**
 * UTF-8 bytes of a record's one-accession result across both surfaces, after the
 * output-schema parse the framework applies, rendered through format(). The one
 * measure the inline budget compares, for a lone accession and for each record
 * of a batch alike.
 */
function recordBytes(record: Entry): number {
  const result = { kind: 'full' as const, succeeded: [EntrySchema.parse(record)], failed: [] };
  return Buffer.byteLength(
    JSON.stringify({ structuredContent: result, content: formatEntryResult(result) }),
    'utf8',
  );
}

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
    'Fetch full curated UniProtKB entries by accession in one batch of up to 20 distinct accessions; repeats collapse, and any further accessions return in deferredAccessions to pass as accessions on the next call. Each entry carries alternative names, function, EC numbers and catalytic activity, cofactors, active and binding sites with their ligands, subcellular location and membrane topology, disease involvement, PTMs, molecule processing (signal, propeptides, chains), natural variants, isoforms, domains, free-text comments (PTM, pathway, subunit, tissue specificity), GO terms with their evidence, keywords, cross-references, and Ensembl gene IDs; mutagenesis and IntAct interaction partners come back when sections or fields name them. Partial failures do not abort the batch — resolved entries land in succeeded[] and unknown or inactive (merged, demerged, deleted) accessions in failed[], where an inactive accession names its replacement or UniParc ID. Pass fields to trim the upstream projection; a field this tool cannot return (e.g. sequence) is not requested and is listed in ignoredFields with a notice. Each record is measured on its own across both output surfaces: one within 24,000 UTF-8 bytes returns in succeeded[]; a larger one is listed in outlinedEntries with its size instead. Re-call an outlined accession alone, e.g. accessions:["P04637"], for its section outline (kind: "outline", sections with byte sizes), then add sections:["disease","variants"] to select sections. sections takes exactly one accession; trim a batch with fields instead. All returned list items and cross-reference IDs render in full. A large list section pages with section_limit/section_offset on a re-call naming that one section. This tool does not search: accessions come from uniprot_search_proteins.results[].accession or uniprot_map_ids. Strip any isoform suffix (P04637-2 to P04637) before calling.',
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
      .check((payload) => {
        const maximum = accessionMaximum();
        if (payload.value.length > maximum) {
          payload.issues.push({
            code: 'too_big',
            origin: 'array',
            maximum,
            inclusive: true,
            input: payload.value,
          });
        }
      })
      .meta({
        get maxItems() {
          return accessionMaximum();
        },
        get description() {
          return clamping()
            ? `Accessions to fetch (1–${ACCESSION_CEILING}). Repeats collapse to their first occurrence; the first ${FETCH_CAP} distinct are fetched and the rest return in deferredAccessions, in order, for the next call. From uniprot_search_proteins or uniprot_map_ids.`
            : `Accessions to fetch (1–${FETCH_CAP}). From uniprot_search_proteins or uniprot_map_ids.`;
        },
      }),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated UniProtKB return-field names to fetch in place of the default record, e.g. "accession,cc_function,ft_variant,xref_pdb" — trims a batch. Omit for the default record. The identity fields always come back. Names are case-insensitive; keywordid is sent as keyword and rhea as cc_catalytic_activity. Any xref_ field (e.g. xref_reactome) fills xrefs. A field this tool does not return (e.g. sequence, which uniprot_get_sequence returns, or ft_helix) is not requested from UniProt and comes back in ignoredFields with a notice listing the supported fields. An xref_ database UniProt does not know, or text that is not a field name, fails invalid_fields with UniProt\'s message.',
      ),
    sections: z
      .array(
        z
          .string()
          .describe(
            'A section key of the entry record, e.g. "disease", "variants", "mutagenesis", "interactions". Case-insensitive.',
          ),
      )
      .optional()
      .describe(
        'Section keys to return for one accession, e.g. ["disease","variants"]: the record is cut to these plus its identity fields. Re-call an accession with it after a kind: "outline" response, or name the on-request sections mutagenesis and interactions, which the default record leaves out — without fields, naming one fetches it; with fields, include ft_mutagen or cc_interaction there. Requires exactly one accession: a batch with sections is rejected, so trim a batch with fields. A requested section the record lacks is named in absentSections, not an error.',
      ),
    section_limit: countInput(
      500,
      (clamped) =>
        `Window size for one list section on a sections re-call: return at most this many items of it (${clamped ? 'at least 1; a value past the remaining items returns them all' : '1–500'}). Requires sections naming exactly one list section, e.g. ["variants"] (or ptms, domains, goTerms). Omit together with section_offset to return the whole section.`,
    ).optional(),
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
        'Result kind. "full": read succeeded[], failed[], and any outlinedEntries and deferredAccessions — every call with more than one distinct accession or any failure. "outline": a lone accession whose record alone exceeded 24,000 UTF-8 bytes; read sections and re-call it with sections:[...].',
      ),
    succeeded: z
      .array(EntrySchema)
      .optional()
      .describe(
        'Entries that resolved and fit the 24,000-byte per-record budget, in request order. Present when kind is "full"; empty when none did.',
      ),
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
        'Accessions that did not resolve to an active entry — unknown to UniProtKB, or inactive (merged, demerged, or deleted) — in request order.',
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
        'Section outline for a lone accession whose record alone exceeds the 24,000-byte budget. A batch lists such records in outlinedEntries instead.',
      ),
    outlinedEntries: z
      .array(
        z
          .object({
            accession: z
              .string()
              .describe('Accession to re-call alone with accessions:[accession].'),
            bytes: z
              .number()
              .describe(
                'UTF-8 bytes of this record returned alone, across both output surfaces — the measure the 24,000-byte budget compares.',
              ),
          })
          .describe('A resolved entry too large to inline, and its size.'),
      )
      .optional()
      .describe(
        'Resolved entries whose one-accession result alone exceeds 24,000 UTF-8 bytes, in request order — not inlined. Re-call each alone for its section outline. Absent when every resolved record fits.',
      ),
    deferredAccessions: z
      .array(z.string().describe('A submitted accession this call did not fetch.'))
      .optional()
      .describe(
        `Distinct accessions past the first ${FETCH_CAP}, in submission order — not fetched. Pass them as accessions on the next call, which fetches their first ${FETCH_CAP} and defers the rest again. Absent when nothing was deferred.`,
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
        'Re-call guidance. On a single-record outline: re-call that accession with sections:[...] to pull specific sections. When outlinedEntries is present: re-call each listed accession alone. When deferredAccessions is present: pass them as accessions on the next call. On a section window: the section_offset that pages the rest, or why the window came back empty. When ignoredFields is present: the ignored fields, where to get them, and the fields this tool returns.',
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
    ignoredFields: z
      .array(
        z.string().describe('A requested field name, lowercased, that this tool does not return.'),
      )
      .optional()
      .describe(
        'Names in fields this tool does not return, in request order — left out of the UniProt request, so the call answered without them. Absent when every name was returned.',
      ),
  },
  enrichmentTrailer: {
    nextOffset: { label: 'Next section_offset' },
    absentSections: {
      render: (keys: string[]) =>
        `**Absent sections:** ${keys.join(', ')} — not in this response: UniProt holds no data of that kind for this record, or fields left ${keys.length === 1 ? 'it' : 'them'} out.`,
    },
    // Ignored names are field-shaped (return-fields FIELD_NAME), so they render without escaping.
    ignoredFields: { render: (names: string[]) => `**Ignored fields:** ${names.join(', ')}` },
  },
  errors: [
    {
      reason: 'sections_single_accession',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sections was passed with more than one submitted accession (a repeat counts) — rejected before any request. sections re-calls a single outlined record.',
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
      when: 'None of the fetched accessions resolved to an active entry — each was unknown to UniProtKB or inactive (merged, demerged, or deleted) — and none was deferred. The message names each inactive accession and its replacement.',
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
    // ctx.enrich.notice is last-wins, so every notice the call raises is collected here and sent once.
    const notices: string[] = [];
    const sendNotices = () => {
      if (notices.length) ctx.enrich.notice(notices.join(' '));
    };
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

    // Repeats collapse to their first occurrence (ACCESSION_REGEX is uppercase-only, so the string is
    // canonical). The first FETCH_CAP distinct are fetched; the rest are handed back in order.
    const distinct = [...new Set(input.accessions)];
    const fetchAccessions = distinct.slice(0, FETCH_CAP);
    const deferredAccessions = distinct.slice(FETCH_CAP);
    if (deferredAccessions.length > 0) {
      recordDeferral(
        {
          distinct: distinct.length,
          fetched: fetchAccessions.length,
          deferred: deferredAccessions.length,
        },
        ctx,
      );
      notices.push(
        `${deferredAccessions.length} accession(s) past the first ${FETCH_CAP} distinct were not fetched — re-call with deferredAccessions as accessions (keeping any fields) for the next batch.`,
      );
    }
    // A requested field the record cannot carry is not fetched; the call answers without it and says so.
    const { fields: upstreamFields, ignored } = entryFieldRequest(input.fields, sections);
    if (ignored.length > 0) {
      ctx.enrich({ ignoredFields: ignored });
      notices.push(ignoredFieldsNotice(ignored, 'entry'));
    }
    const service = getUniProtService();
    let batch: { entries: Entry[]; inactive: InactiveEntry[] };
    try {
      batch = await service.getEntries(fetchAccessions, upstreamFields, ctx);
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
    for (const acc of fetchAccessions) {
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

    // With accessions deferred, a throw would drop the re-call the caller still needs.
    if (succeeded.length === 0 && deferredAccessions.length === 0) {
      throw ctx.fail(
        'all_not_found',
        [
          `None of the ${fetchAccessions.length} accession(s) resolved in UniProtKB.`,
          ...inactiveReasons,
        ].join(' '),
        { accessions: fetchAccessions },
      );
    }

    // A lone accession with no failure: a sections re-call, or the record whole — or, when it alone
    // exceeds the budget, its section outline so the agent re-calls with sections:[...].
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
          sendNotices();
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
          notices.push(
            `section_offset ${offset} is past the end of ${section}, which holds ${items.length} item(s) — page with section_offset below ${items.length}.`,
          );
        }
        sendNotices();
        return {
          kind: 'full' as const,
          succeeded: [projected as unknown as Entry],
          failed,
          window: { section, offset },
        };
      }

      const sizeBytes = recordBytes(entry);
      if (sizeBytes > INLINE_BUDGET_BYTES) {
        ctx.log.info('Entry exceeded the inline budget — returning its section outline', {
          sizeBytes,
        });
        const outlinedSections = Object.entries(entry)
          .map(([name, value]) => ({
            name,
            bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          }))
          .sort((a, b) => b.bytes - a.bytes);
        notices.push(
          `Re-call with accessions:["${entry.accession}"] and sections:[...] to retrieve selected sections; use section_limit and section_offset for one list section.`,
        );
        sendNotices();
        return { kind: 'outline' as const, sections: outlinedSections };
      }
      sendNotices();
      return { kind: 'full' as const, succeeded, failed };
    }

    // Every other call is a full result: a record inlines when its one-accession result fits the
    // budget, else it is listed — the same measure, so a listed accession outlines when called alone.
    const inline: Entry[] = [];
    const outlinedEntries: { accession: string; bytes: number }[] = [];
    for (const record of succeeded) {
      const bytes = recordBytes(record);
      if (bytes > INLINE_BUDGET_BYTES) outlinedEntries.push({ accession: record.accession, bytes });
      else inline.push(record);
    }
    ctx.log.info('Entry batch returned', {
      inlined: inline.length,
      outlined: outlinedEntries.length,
      failed: failed.length,
      deferred: deferredAccessions.length,
    });
    if (outlinedEntries.length > 0) {
      notices.push(
        `${outlinedEntries.length} record(s) exceed ${INLINE_BUDGET_BYTES.toLocaleString('en-US')} bytes alone and are listed in outlinedEntries, not inlined — re-call each alone for its section outline: ${outlinedEntries.map((e) => `accessions:["${e.accession}"]`).join(', ')}.`,
      );
    }
    sendNotices();
    return {
      kind: 'full' as const,
      succeeded: inline,
      failed,
      ...(outlinedEntries.length > 0 ? { outlinedEntries } : {}),
      ...(deferredAccessions.length > 0 ? { deferredAccessions } : {}),
    };
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
  deferredAccessions?: string[];
  window?: { section: string; offset: number };
}): { type: 'text'; text: string }[] {
  const lines = [`**Result kind:** ${result.kind}`];

  if (result.sections?.length) {
    // Outline arm: a single oversized record returned as a section listing.
    lines.push('Record too large — re-call with sections:[...] to pull only what you need.');
    for (const s of result.sections) lines.push(`- **${s.name}** — ${s.bytes} bytes`);
  }
  if (result.outlinedEntries?.length)
    lines.push(
      `**Outlined entries** — over ${INLINE_BUDGET_BYTES.toLocaleString('en-US')} bytes alone, not inlined:`,
    );
  for (const e of result.outlinedEntries ?? [])
    lines.push(
      `- **${e.accession}** — ${e.bytes} bytes; re-call with accessions:["${e.accession}"].`,
    );
  // Accessions are ACCESSION_REGEX-checked (uppercase letters and digits), so the list needs no escaping.
  if (result.deferredAccessions?.length)
    lines.push(
      `**Deferred accessions** — ${result.deferredAccessions.length} not fetched, past the first ${FETCH_CAP} distinct; re-call with accessions:${JSON.stringify(result.deferredAccessions)}`,
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
    if (e.alternativeNames?.length)
      lines.push(`**Alternative names:** ${e.alternativeNames.join('; ')}`);
    if (e.function?.length)
      lines.push(
        `**Function:** ${e.function
          .map((f) => `${f.value}${f.evidence?.length ? ` (${f.evidence.join(', ')})` : ''}`)
          .join(' ')}`,
      );
    if (e.ecNumbers?.length) lines.push(`**EC numbers:** ${e.ecNumbers.join(', ')}`);
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
    if (e.sites?.length) {
      lines.push(
        `**Sites:** ${e.sites.length}${windowSection === 'sites' ? ' in this window' : ''}`,
      );
      for (const s of e.sites) {
        const ligand = s.ligand
          ? ` — ${s.ligand.name}${s.ligand.chebiId ? ` (${s.ligand.chebiId})` : ''}${s.ligand.label ? ` label ${s.ligand.label}` : ''}${s.ligand.note ? `, ${s.ligand.note}` : ''}`
          : '';
        const part = s.ligandPart
          ? `; part ${s.ligandPart.name}${s.ligandPart.chebiId ? ` (${s.ligandPart.chebiId})` : ''}`
          : '';
        lines.push(`${featureLine(s)}${ligand}${part}`);
      }
    }
    if (e.subcellularLocation?.length)
      lines.push(
        `**Subcellular location:** ${e.subcellularLocation.map((l) => l.location + (l.topology ? ` (${l.topology})` : '')).join('; ')}`,
      );
    if (e.topology?.length) {
      lines.push('**Topology:**');
      for (const f of e.topology) lines.push(featureLine(f));
    }
    if (e.disease?.length) {
      lines.push('**Disease:**');
      for (const d of e.disease)
        lines.push(
          `- ${d.name}${d.acronym ? ` (${d.acronym})` : ''}${d.omimId ? ` [OMIM:${d.omimId}]` : ''}${d.diseaseId ? ` [${d.diseaseId}]` : ''}${d.description ? `: ${d.description}` : ''}${d.note ? ` — ${d.note}` : ''}`,
        );
    }
    if (e.variants?.length) {
      lines.push(
        `**Variants:** ${e.variants.length} natural variant(s)${windowSection === 'variants' ? ' in this window' : ''}`,
      );
      for (const v of e.variants) lines.push(residueChangeLine(v));
    }
    if (e.mutagenesis?.length) {
      lines.push(
        `**Mutagenesis:** ${e.mutagenesis.length}${windowSection === 'mutagenesis' ? ' in this window' : ''}`,
      );
      for (const m of e.mutagenesis) lines.push(residueChangeLine(m));
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
    if (e.processing?.length) {
      lines.push('**Processing:**');
      for (const f of e.processing) lines.push(featureLine(f));
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
    if (e.comments?.length) {
      lines.push('**Comments:**');
      for (const c of e.comments)
        lines.push(
          `- ${c.type}${c.molecule ? ` (${c.molecule})` : ''}: ${c.value}${c.evidence?.length ? ` (${c.evidence.join(', ')})` : ''}`,
        );
    }
    if (e.interactions?.length) {
      lines.push(
        `**Interactions:** ${e.interactions.length} partner(s)${windowSection === 'interactions' ? ' in this window' : ''}`,
      );
      for (const i of e.interactions)
        lines.push(
          `- ${i.partner}${i.partnerChain ? ` [${i.partnerChain}]` : ''}${i.gene ? ` (${i.gene})` : ''}: ${i.experiments} experiment(s)${i.organismDiffer ? '; partner from another organism' : ''}${i.isoform ? `; for this entry's isoform ${i.isoform}` : ''}${i.chain ? `; for this entry's chain ${i.chain}` : ''}`,
        );
    }
    if (e.goTerms?.length)
      lines.push(
        `**GO:** ${e.goTerms.map((g) => `${g.id} [${g.aspect}] ${g.term}${g.evidenceType ? ` (${g.evidenceType})` : ''}`).join('; ')}`,
      );
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
    if (e.ensemblGenes?.length)
      lines.push(
        `**Ensembl genes:** ${e.ensemblGenes.map((id) => markdown().inlineCode(id).build()).join(', ')}`,
      );
    lines.push('');
  }
  if (result.failed?.length) {
    lines.push('### Not found');
    for (const f of result.failed) lines.push(`- **${f.accession}** — ${f.error}`);
  }
  return [{ type: 'text', text: lines.join('\n').trim() }];
}

/** A feature with its residue span — one residue as "- Site 194", a range as "- Transmembrane 646-668". */
function featureLine(f: z.infer<typeof FeatureSchema>): string {
  const { start, end } = f.location;
  const span = start === end ? `${start ?? '?'}` : `${start ?? '?'}-${end ?? '?'}`;
  return `- ${f.type} ${span}${f.featureId ? ` [${f.featureId}]` : ''}${f.description ? `: ${f.description}` : ''}`;
}

/** A residue change — a natural variant or a mutagenesis row — with its cross-references. */
function residueChangeLine(v: z.infer<typeof VariantSchema>): string {
  const pos =
    v.location.start === v.location.end || v.location.end == null
      ? `${v.location.start ?? '?'}`
      : `${v.location.start ?? '?'}-${v.location.end}`;
  return `- ${pos}${v.original && v.variation ? ` ${v.original}→${v.variation}` : ''}${v.featureId ? ` [${v.featureId}]` : ''}${v.description ? `: ${v.description}` : ''}`;
}
