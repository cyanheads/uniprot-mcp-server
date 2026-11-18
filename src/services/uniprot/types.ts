/**
 * @fileoverview Domain types for the UniProt service — normalized, agent-facing
 *   shapes derived from the live `rest.uniprot.org` JSON (verified against the
 *   API), plus the ID-mapping database enum and job-id shape, the
 *   query-grouping check tools run before any request
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
  /** How the gene is involved, e.g. "The disease is caused by variants affecting the gene represented in this entry". */
  note?: string;
};

/** A sequence feature (PTM, variant, domain, region). */
export type Feature = {
  type: string;
  description?: string;
  location: { start?: number; end?: number };
  featureId?: string;
};

/** A ligand UniProt names on a binding site; `chebiId` is the bare `CHEBI:n` form. */
export type Ligand = {
  name: string;
  chebiId?: string;
  /** Tells apart copies of one ligand at different sites, e.g. "1". */
  label?: string;
  note?: string;
};

/** An active, binding, or other functional site; a binding site names its ligand. */
export type Site = Feature & {
  ligand?: Ligand;
  /** The part of the ligand the residue binds, e.g. the Fe of heme b. */
  ligandPart?: { name: string; chebiId?: string };
};

/** A free-text annotation (PTM, PATHWAY, SUBUNIT, …), one row per text. */
export type Comment = {
  /** UniProt's commentType, e.g. "PTM" or "TISSUE SPECIFICITY". */
  type: string;
  value: string;
  evidence?: string[];
  /** The isoform or chain the text is about, e.g. "Isoform 2". */
  molecule?: string;
};

/** A binary interaction partner (IntAct). */
export type Interaction = {
  /** The partner's UniProtKB accession, an isoform accession when IntAct names one. */
  partner: string;
  /** The partner's chain feature ID when IntAct names one product of a polyprotein, e.g. "PRO_0000037536". */
  partnerChain?: string;
  gene?: string;
  experiments: number;
  /** True when the partner comes from another organism; omitted otherwise. */
  organismDiffer?: boolean;
  /** This entry's isoform accession when the interaction is recorded for one, e.g. "P04637-7". */
  isoform?: string;
  /** This entry's chain feature ID when the interaction is recorded for one product of a polyprotein. */
  chain?: string;
};

/** A natural variant or a mutagenesis experiment, with the residue change when present. */
export type Variant = {
  description?: string;
  location: { start?: number; end?: number };
  original?: string;
  variation?: string;
  featureId?: string;
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
  /** GO evidence code and its assigning source, e.g. "IDA:UniProtKB" or "IEA:InterPro". */
  evidenceType?: string;
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
  alternativeNames?: string[];
  genes: string[];
  organism: Organism;
  length: number;
  reviewed: boolean;
  annotationScore: number;
  proteinExistence: string;
  ecNumbers?: string[];
  function?: EvidencedText[];
  catalyticActivity?: Reaction[];
  cofactors?: Cofactor[];
  sites?: Site[];
  subcellularLocation?: Location[];
  topology?: Feature[];
  disease?: Disease[];
  ptms?: Feature[];
  processing?: Feature[];
  variants?: Variant[];
  mutagenesis?: Variant[];
  isoforms?: Isoform[];
  domains?: Feature[];
  comments?: Comment[];
  interactions?: Interaction[];
  goTerms?: GoTerm[];
  keywords?: Keyword[];
  xrefs?: Record<string, string[]>;
  /** Distinct Ensembl gene IDs behind the transcript IDs in `xrefs.Ensembl`. */
  ensemblGenes?: string[];
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
  results: {
    from: string;
    to: string;
    inactive?: InactiveReason;
    entryName?: string;
    reviewed?: boolean;
    organism?: { taxonId: number; scientificName?: string };
    gene?: string;
  }[];
  totalMappings?: number;
  identityUnavailable?: boolean;
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
