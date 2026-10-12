/**
 * @fileoverview Domain types for the UniProt service — normalized, agent-facing
 *   shapes derived from the live `rest.uniprot.org` JSON (verified against the
 *   API), plus the ID-mapping database enum and job-id shape, the canonical
 *   default field set, the query-grouping check tools run before any request
 *   (`unbalancedParenthesis`) and the wrapper they group a clause with
 *   (`groupClause`), and the one caller-facing wording for an inactive
 *   accession (`describeInactive`, `describeInactiveInFull`).
 *   Raw upstream sparsity is preserved: most curated sections are optional and
 *   absent on TrEMBL entries, so absence stays absence rather than a fabricated
 *   value.
 * @module services/uniprot/types
 */

/**
 * ID-mapping database identifiers (`from`/`to` values), taken verbatim from the
 * live `/configure/idmapping/fields` endpoint. These are the exact strings the
 * `/idmapping/run` form accepts — `UniProtKB-Swiss-Prot` (not `UniProtKB`) is the
 * reviewed-only target, `UniProtKB` the target that also includes TrEMBL, and
 * `UniProtKB_AC-ID` is a source only (accession or entry name) — UniProt answers
 * 400 to it as a target for every source, so it is not in `ID_MAPPING_TO_DBS`.
 */
export const ID_MAPPING_FROM_DBS = [
  'UniProtKB_AC-ID',
  'Gene_Name',
  'GeneID',
  'Ensembl',
  'Ensembl_Protein',
  'PDB',
  'RefSeq_Nucleotide',
  'RefSeq_Protein',
  'ChEMBL',
  'PomBase',
  'WormBase_Protein',
] as const;

export const ID_MAPPING_TO_DBS = [
  'UniProtKB',
  'UniProtKB-Swiss-Prot',
  'Gene_Name',
  'GeneID',
  'Ensembl',
  'Ensembl_Protein',
  'PDB',
  'RefSeq_Nucleotide',
  'RefSeq_Protein',
  'ChEMBL',
  'PomBase',
  'WormBase_Protein',
] as const;

export type IdMappingFromDb = (typeof ID_MAPPING_FROM_DBS)[number];
export type IdMappingToDb = (typeof ID_MAPPING_TO_DBS)[number];

/**
 * Default UniProtKB `fields` projection for search results — keeps payloads
 * small while carrying the provenance signal (reviewed flag, annotation score,
 * protein-existence level) the agent needs to weigh curation quality.
 */
export const DEFAULT_SEARCH_FIELDS =
  'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence,cc_function';

/**
 * Default UniProtKB `fields` projection for full entries. Covers the curated
 * sections the entry tool normalizes (function, catalytic activity, cofactors,
 * location, disease, PTMs, variants, isoforms, domains, GO, keywords, xrefs).
 */
export const DEFAULT_ENTRY_FIELDS =
  'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence,cc_function,cc_catalytic_activity,cc_cofactor,cc_subcellular_location,cc_disease,ft_mod_res,ft_carbohyd,ft_variant,cc_alternative_products,ft_domain,ft_region,go,keyword,xref_pdb,xref_ensembl,xref_refseq,xref_chembl';

/**
 * UniProtKB fields that back the required (non-optional) columns of the entry
 * output schema. UniProt only returns `id`, `length`, `annotation_score`,
 * `protein_existence`, and the organism fields when they are explicitly
 * requested, so a caller-supplied `fields` that omits them would otherwise drop
 * `entryName` (a hard schema-validation crash) or silently fabricate
 * provenance (`0` score, `unknown` existence). These are always merged into the
 * upstream request so a custom `fields` trims sections without dropping identity.
 */
export const MANDATORY_ENTRY_FIELDS = [
  'accession',
  'id',
  'protein_name',
  'gene_names',
  'organism_name',
  'organism_id',
  'length',
  'reviewed',
  'annotation_score',
  'protein_existence',
] as const;

/**
 * UniProtKB fields that back the required (non-optional) columns of the search
 * output schema (`ProteinHit`). Mirrors `MANDATORY_ENTRY_FIELDS` minus
 * `protein_name` (optional on a hit). UniProt omits `id`, `length`, organism,
 * `annotation_score`, `protein_existence`, and `reviewed` unless explicitly
 * requested, so a caller-supplied `fields` (e.g. `accession,gene_names`) that
 * drops them would crash on the missing `entryName` or fabricate provenance.
 * Always merged into the upstream search request so a custom `fields` trims the
 * projection without dropping the identity/provenance columns.
 */
export const MANDATORY_SEARCH_FIELDS = [
  'accession',
  'id',
  'gene_names',
  'organism_name',
  'organism_id',
  'length',
  'reviewed',
  'annotation_score',
  'protein_existence',
] as const;

/**
 * UniProtKB primary accession pattern. Covers both the 6-character format
 * (OPQ-prefix) and the 10-character format (1 or 2 alpha–digit–alpha3–digit
 * groups), used by tools and resources to validate input before calling the
 * service.
 */
export const ACCESSION_REGEX =
  /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

/**
 * The rejection message every accession input pairs with `ACCESSION_REGEX`
 * (`.regex(ACCESSION_REGEX, ACCESSION_MESSAGE)`), in place of Zod's default,
 * which prints the compiled pattern. Names the format, an example, the isoform
 * suffix callers most often send by mistake, and where to get a valid one. The
 * advertised JSON Schema is unaffected — it still carries `pattern` only.
 */
export const ACCESSION_MESSAGE =
  'Must be a UniProtKB primary accession such as "P04637", canonical form with no "-N" isoform suffix. Find one with uniprot_search_proteins or uniprot_map_ids.';

/**
 * Describe the first unbalanced parenthesis in a caller-supplied UniProtKB query
 * clause, or `undefined` when its grouping is balanced. Tools embed the caller's
 * clause inside a group of their own (`(<clause>) AND reviewed:true`,
 * `proteome:X AND (<clause>)`), and a stray `)` would close that group early and
 * move the tool's filter onto part of the clause only — a query UniProt accepts.
 * Parentheses inside a quoted phrase and backslash-escaped characters do not
 * count. An unclosed quote is left alone: UniProt rejects it with its own 400.
 * Positions are 1-based code points, so an emoji counts as one character.
 */
export function unbalancedParenthesis(clause: string): string | undefined {
  const chars = Array.from(clause);
  const open: number[] = [];
  let quoted = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\') i++;
    else if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '(') open.push(i);
    else if (ch === ')' && open.pop() === undefined) {
      return `the ")" at character ${i + 1} closes a group that was never opened`;
    }
  }
  const unclosed = open[0];
  return unclosed === undefined
    ? undefined
    : `the "(" at character ${unclosed + 1} is never closed`;
}

/**
 * Wrap a caller-supplied query clause in a group of the tool's own, `(<clause>)`.
 * A clause ending in an unescaped `\` would escape that closing `)` — UniProt
 * answers `(gene:TP53\) AND reviewed:true` with a 400 — so a space is set before
 * the `)`. The dangling backslash then escapes the space, which UniProt reads as
 * nothing: `(gene:TP53\ )` matches what `gene:TP53` does. An even run of trailing
 * backslashes is a literal backslash and is left as written.
 */
export function groupClause(clause: string): string {
  const trailingBackslashes = clause.length - clause.replace(/\\+$/, '').length;
  return trailingBackslashes % 2 === 1 ? `(${clause} )` : `(${clause})`;
}

/**
 * UniProt ID-mapping job identifier: letters, digits, `-`, and `_` only (UniProt
 * issues short alphanumeric ids such as "3OVYSqg8Mm"). The id becomes a segment of
 * the `/idmapping/.../{jobId}` request paths, so a caller-supplied ticket or
 * continuation job id must match this before any request is made.
 */
export const JOB_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/** Organism block shared across hits, entries, and proteomes. */
export type Organism = {
  scientificName: string;
  commonName?: string;
  taxonId: number;
  mnemonic?: string;
};

/** A single curated text with its source PubMed/ECO evidence codes preserved. */
export type EvidencedText = {
  value: string;
  evidence?: string[];
};

/** A search-result row — trimmed to what an agent scans before drilling in. */
export type ProteinHit = {
  accession: string;
  entryName: string;
  proteinName?: string;
  geneNames: string[];
  organism: Organism;
  length: number;
  reviewed: boolean;
  annotationScore: number;
  proteinExistence: string;
  functionSnippet?: string;
};

/** A normalized catalytic-activity reaction (Rhea/ChEBI cross-references). */
export type Reaction = {
  name: string;
  ecNumber?: string;
  rheaId?: string;
};

/** A cofactor entry (ChEBI). */
export type Cofactor = {
  name: string;
  chebiId?: string;
};

/** A subcellular-location entry. */
export type Location = {
  location: string;
  topology?: string;
};

/** A disease association (OMIM xref, UniProt DI-accession). */
export type Disease = {
  diseaseId?: string;
  name: string;
  acronym?: string;
  description?: string;
  omimId?: string;
};

/** A sequence feature (PTM, variant, domain, region). */
export type Feature = {
  type: string;
  description?: string;
  location: { start?: number; end?: number };
  featureId?: string;
};

/** A natural variant (dbSNP/ClinVar), with the residue change when present. */
export type Variant = {
  description?: string;
  location: { start?: number; end?: number };
  original?: string;
  variation?: string;
  featureId?: string;
  xrefs?: string[];
};

/** An isoform produced by alternative splicing. */
export type Isoform = {
  isoformId: string;
  name?: string;
  sequenceStatus?: string;
};

/** A Gene Ontology annotation (aspect P/F/C). */
export type GoTerm = {
  id: string;
  term: string;
  aspect: string;
};

/** A UniProt keyword (KW-accession). */
export type Keyword = {
  id: string;
  name: string;
  category?: string;
};

/**
 * Why an accession is no longer an active UniProtKB entry, parsed from the
 * stub UniProt returns in its place (`entryType: "Inactive"`). The stub carries
 * no organism, sequence, or annotation, so an inactive accession is reported
 * through this shape and never normalized into a protein record.
 */
export type InactiveReason = {
  /** UniProt's `inactiveReasonType` — `MERGED`, `DEMERGED`, `DELETED`, or a newer value. Omitted when the stub names none. */
  reason?: string;
  /** The accessions that replace it (`mergeDemergeTo`): one merge target, or the demerge products. */
  replacedBy?: string[];
  /** UniProt's stated reason for a deletion. */
  deletedReason?: string;
  /** The UniParc entry that still holds the sequence. */
  uniParcId?: string;
};

/** An inactive accession and the reason it is inactive. */
export type InactiveEntry = InactiveReason & { accession: string };

/**
 * The caller-facing sentence for an inactive accession, naming where to go
 * instead: the merge target to retry with, the demerge products to choose
 * among, or the UniParc entry that keeps a deleted sequence. Every surface that
 * reports an inactive accession uses this text.
 */
export function describeInactive(
  // Also takes the output-schema shape, whose optional fields admit an explicit undefined.
  entry: { [K in keyof InactiveReason]?: InactiveReason[K] | undefined } & { accession: string },
): string {
  const { accession, reason, replacedBy = [], deletedReason, uniParcId } = entry;
  const uniParc = uniParcId ? ` Its sequence survives in UniParc as ${uniParcId}.` : '';
  if (reason === 'MERGED' && replacedBy.length === 1) {
    return `${accession} is inactive in UniProtKB: merged into ${replacedBy[0]}. Retry with ${replacedBy[0]}.`;
  }
  if (reason === 'DEMERGED' && replacedBy.length) {
    return `${accession} is inactive in UniProtKB: demerged into ${replacedBy.join(', ')}. Pick the one matching your gene and organism, then retry.`;
  }
  if (reason === 'DELETED') {
    return `${accession} was deleted from UniProtKB${deletedReason ? ` (${deletedReason})` : ''}.${uniParc}`;
  }
  // Any other shape (an unrecognized type, a pointer missing): name whatever UniProt gave.
  const detail = [reason, deletedReason].filter(Boolean).join(': ');
  const pointer = replacedBy.length ? `: replaced by ${replacedBy.join(', ')}` : '';
  return `${accession} is inactive in UniProtKB${detail ? ` (${detail})` : ''}${pointer}.${uniParc}`;
}

/**
 * `describeInactive` plus the UniParc ID when the sentence leaves it out. It names
 * the UniParc ID only where it is the pointer (DELETED), but a merged or demerged
 * stub carries one too, and `content[]` must show every field `structuredContent`
 * does.
 */
export function describeInactiveInFull(entry: Parameters<typeof describeInactive>[0]): string {
  const text = describeInactive(entry);
  return entry.uniParcId && !text.includes(entry.uniParcId)
    ? `${text} UniParc: ${entry.uniParcId}.`
    : text;
}

/** The full curated entry, normalized into stable named sections. */
export type Entry = {
  accession: string;
  entryName: string;
  proteinName?: string;
  genes: string[];
  organism: Organism;
  length: number;
  reviewed: boolean;
  annotationScore: number;
  proteinExistence: string;
  function?: EvidencedText[];
  catalyticActivity?: Reaction[];
  cofactors?: Cofactor[];
  subcellularLocation?: Location[];
  disease?: Disease[];
  ptms?: Feature[];
  variants?: Variant[];
  isoforms?: Isoform[];
  domains?: Feature[];
  goTerms?: GoTerm[];
  keywords?: Keyword[];
  xrefs?: Record<string, string[]>;
};

/** BUSCO completeness sub-report. */
export type Busco = {
  complete: number;
  completeSingle: number;
  completeDuplicated: number;
  fragmented: number;
  missing: number;
  total: number;
  lineageDb?: string;
  score?: number;
};

/** A reference / other proteome record. */
export type Proteome = {
  upid: string;
  proteomeType: string;
  organism: Organism;
  proteinCount: number;
  busco?: Busco;
  genomeAssembly?: string;
};

/** An immediate child taxon (from a follow-up search). */
export type TaxonChild = {
  taxonId: number;
  scientificName: string;
  rank: string;
};

/** Immediate children fetched per page — UniProt allows up to 500; 100 keeps a page readable. */
export const TAXON_CHILDREN_PAGE_SIZE = 100;

/** One cursor-paginated page of a taxon's immediate children. */
export type TaxonChildrenPage = {
  children: TaxonChild[];
  /** Every immediate child of the taxon, across all pages (`x-total-results`). */
  totalChildren: number;
  /** Forward cursor to the next page; absent on the last one. */
  cursor?: string;
};

/** A taxonomy record with its full lineage. */
export type Taxon = {
  taxonId: number;
  scientificName: string;
  commonName?: string;
  mnemonic?: string;
  rank: string;
  parent?: { taxonId: number; scientificName: string };
  lineage: { taxonId: number; scientificName: string; commonName?: string; rank: string }[];
  otherNames?: string[];
};

/** A FASTA sequence record (canonical or isoform). */
export type SequenceRecord = {
  isoformId?: string;
  header: string;
  sequence: string;
  length: number;
};

/**
 * The sequence records served for a requested accession. `accession` names the
 * entry the records belong to — the merge target when the requested accession
 * was merged, which `mergedFrom` then names.
 */
export type SequenceResult = {
  accession: string;
  mergedFrom?: string;
  records: [SequenceRecord, ...SequenceRecord[]];
};

/** A search result page: hits + pagination metadata. */
export type SearchPage = {
  results: ProteinHit[];
  /** Matching accessions that are inactive (merged, demerged, deleted) — never hits. */
  inactive: InactiveEntry[];
  totalResults: number;
  cursor?: string;
  facets?: SearchFacet[];
};

/** A single upstream facet (server-side count breakdown). */
export type SearchFacet = {
  name: string;
  label: string;
  values: { value: string; label: string; count: number }[];
};

/** A paginated proteome protein page. */
export type ProteomeProteinPage = {
  proteins: ProteinHit[];
  cursor?: string;
  totalResults: number;
};

/** Cursor state for the next completed ID-mapping results page. */
export type IdMappingContinuation = {
  jobId: string;
  cursor: string;
};

/** One completed ID-mapping results page, including upstream failure metadata. */
export type IdMappingPage = {
  /** `inactive` is present only on a row whose UniProtKB target is inactive. */
  results: { from: string; to: string; inactive?: InactiveReason }[];
  /**
   * UniProt's job-wide count of inactive targets, set only when this page's
   * inactive rows could not be identified (the lookup failed, or returned a page with
   * other rows) — so they are unmarked.
   */
  inactiveUnchecked?: number;
  failedIds: string[];
  continuation?: IdMappingContinuation;
};

/** Result of an ID-mapping call: one finished page, or a running-job ticket. */
export type IdMappingResult =
  | ({ status: 'finished' } & IdMappingPage)
  | { status: 'running'; ticket: string };
