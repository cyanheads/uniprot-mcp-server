/**
 * @fileoverview Domain types for the UniProt service — normalized, agent-facing
 *   shapes derived from the live `rest.uniprot.org` JSON (verified against the
 *   API), plus the ID-mapping database enum and job-id shape, the
 *   query-grouping check tools run before any request
 *   (`unbalancedParenthesis`), the wrapper they group a clause with
 *   (`groupClause`), the accession-token test and OR-condition count a search
 *   clause is weighed by (`ACCESSION_TOKEN_REGEX`, `orConditionCount`), and the
 *   one caller-facing wording for an inactive
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
 * An accession-shaped token anywhere in a query clause: `ACCESSION_REGEX` without its
 * anchors, bounded by non-word characters, in any letter case — UniProt matches
 * `accession:q15086` as it does `accession:Q15086`.
 */
export const ACCESSION_TOKEN_REGEX = new RegExp(
  `\\b${ACCESSION_REGEX.source.slice(1, -1)}\\b`,
  'i',
);

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

/** UniProt answers a query holding more OR conditions than this with HTTP 400. */
export const MAX_OR_CONDITIONS = 100;

/** What Lucene's classic query parser reads as whitespace, the ideographic space included. */
const QUERY_WHITESPACE = new Set([' ', '\t', '\n', '\r', String.fromCodePoint(0x3000)]);
/** What ends a bare term, besides whitespace. */
const TERM_END = new Set(['(', ')', '"', '!']);

/** One parenthesized group of a query clause, its clauses added as Lucene's classic parser adds them. */
type QueryGroup = {
  clauses: number;
  /** Clauses left optional (Lucene's SHOULD): the ones UniProt counts. */
  optional: number;
  lastOptional: boolean;
  /** An `AND` waiting for the next clause, which it makes required along with the one before it. */
  andPending: boolean;
  /** A `+`, `-`, `NOT`, or `!` waiting for the next clause, which it makes required or prohibited. */
  markPending: boolean;
};

const openGroup = (): QueryGroup => ({
  clauses: 0,
  optional: 0,
  lastOptional: false,
  andPending: false,
  markPending: false,
});

function addClause(group: QueryGroup): void {
  if (group.andPending && group.lastOptional) group.optional--;
  group.lastOptional = !group.andPending && !group.markPending;
  if (group.lastOptional) group.optional++;
  group.clauses++;
  group.andPending = false;
  group.markPending = false;
}

/**
 * Count the OR conditions a query clause spends of UniProt's `MAX_OR_CONDITIONS`.
 * UniProt parses a query with Lucene's classic parser, whose default operator is
 * OR, and counts the optional clauses of every group: each operand of `OR` or
 * `||` and each term set beside another, unless `AND` or `&&` joins it on either
 * side or `+`, `-`, `NOT`, or `!` marks it. A group of one clause counts none.
 * Quoted phrases and backslash escapes read as the parser reads them, as in
 * `unbalancedParenthesis`. A range bound, boost, or slop counts as a term of its
 * own, so the count can run above UniProt's.
 */
export function orConditionCount(clause: string): number {
  const parents: QueryGroup[] = [];
  let group = openGroup();
  let conditions = 0;
  let i = 0;
  while (i < clause.length) {
    const ch = clause.charAt(i);
    if (QUERY_WHITESPACE.has(ch)) {
      i++;
    } else if (ch === '(') {
      parents.push(group);
      group = openGroup();
      i++;
    } else if (ch === ')') {
      i++;
      const parent = parents.pop();
      if (!parent) continue;
      if (group.clauses > 1) conditions += group.optional;
      group = parent;
      addClause(group);
    } else if (ch === '"') {
      for (i++; i < clause.length && clause.charAt(i) !== '"'; ) {
        i += clause.charAt(i) === '\\' ? 2 : 1;
      }
      i++;
      addClause(group);
    } else if (ch === '+' || ch === '-' || ch === '!') {
      i++;
      // Followed by whitespace it is a term of its own; otherwise it marks the next clause.
      if (i >= clause.length || QUERY_WHITESPACE.has(clause.charAt(i))) addClause(group);
      else group.markPending = true;
    } else {
      const start = i;
      let escaped = false;
      while (i < clause.length) {
        const next = clause.charAt(i);
        if (QUERY_WHITESPACE.has(next) || TERM_END.has(next)) break;
        escaped = next === '\\';
        i += escaped ? 2 : 1;
      }
      const term = clause.slice(start, i);
      if (term === 'AND' || term === '&&') group.andPending = true;
      else if (term === 'NOT') group.markPending = true;
      // OR is the default operator; a `field:` prefix belongs to the clause after it.
      else if (term !== 'OR' && term !== '||' && !(term.endsWith(':') && !escaped)) {
        addClause(group);
      }
    }
  }
  for (const open of [...parents, group]) if (open.clauses > 1) conditions += open.optional;
  return conditions;
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

/** One FUNCTION text, with the isoform or chain its comment is about. */
export type FunctionText = EvidencedText & {
  /** The isoform, chain, or peptide the comment is about (UniProt's `molecule`), e.g. "Isoform 2" or "Spinorphin"; absent when it is about the entry's protein. */
  molecule?: string;
};

/** A search-result row — trimmed to what an agent scans before drilling in. */
export type ProteinHit = {
  accession: string;
  entryName: string;
  proteinName?: string;
  geneNames: string[];
  organism: Organism;
  length: number;
  /** UniProt's sequence flags, e.g. ["Fragment"] or ["Fragment", "Precursor"]: a fragment's `length` is the fragment's. */
  sequenceFlags?: string[];
  reviewed: boolean;
  annotationScore: number;
  proteinExistence: string;
  functionSnippet?: string;
  /** The isoform, chain, or peptide the snippet's FUNCTION comment is about, as on `FunctionText`. */
  functionSnippetMolecule?: string;
};

/** A normalized catalytic-activity reaction (Rhea/ChEBI cross-references). */
export type Reaction = {
  name: string;
  ecNumber?: string;
  rheaId?: string;
  /** The reaction's own evidence. */
  evidence?: string[];
  /** The isoform or chain its comment is about, as on `FunctionText`. */
  molecule?: string;
};

/**
 * A cofactor entry (ChEBI). Its comment's note ("Binds 1 zinc ion per subunit.")
 * is a `Comment` of type `COFACTOR`, carrying the same `molecule`.
 */
export type Cofactor = {
  name: string;
  chebiId?: string;
  /** The cofactor's own evidence. */
  evidence?: string[];
  /** The isoform or chain its comment is about, as on `FunctionText`. */
  molecule?: string;
};

/**
 * One BIOPHYSICOCHEMICAL PROPERTIES comment. UniProt writes one such comment per
 * molecule, so `molecule` qualifies the whole object. Every KM and Vmax row, text,
 * and the absorption carries its own evidence; the comment itself carries none.
 */
export type Biophysicochemical = {
  /** The isoform or chain the comment is about, as on `FunctionText`. */
  molecule?: string;
  /** Michaelis constants: `constant` in `unit` (mM, uM, nM, …) for `substrate`. */
  michaelisConstants?: { constant: number; unit: string; substrate: string; evidence?: string[] }[];
  /** Maximum velocities; `enzyme` is UniProt's text after the unit, e.g. "enzyme with malonyl-CoA as substrate". */
  maximumVelocities?: { velocity: number; unit: string; enzyme: string; evidence?: string[] }[];
  /** The kinetic parameters' note (UniProt's `kineticParameters.note`), often kcat values. */
  kineticsNote?: EvidencedText[];
  phDependence?: EvidencedText[];
  temperatureDependence?: EvidencedText[];
  redoxPotential?: EvidencedText[];
  /** `maxNm` is UniProt's "Abs(max)"; `approximate` is set only when that maximum is approximate ("~695 nm"). */
  absorption?: { maxNm?: number; approximate?: true; evidence?: string[] };
  /** The absorption's note (UniProt's `absorption.note`), e.g. "Emission maxima at 702 nm.". */
  absorptionNote?: EvidencedText[];
};

/**
 * A subcellular-location entry. Its comment's note is a `Comment` of type
 * `SUBCELLULAR LOCATION`, carrying the same `molecule`.
 */
export type Location = {
  location: string;
  topology?: string;
  /** Which side of the membrane, e.g. "Cytoplasmic side". */
  orientation?: string;
  /** The location's own evidence; the topology's and orientation's are not kept. */
  evidence?: string[];
  /** The isoform or chain its comment is about, as on `FunctionText`. */
  molecule?: string;
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

/**
 * Where a feature sits on the sequence, as UniProt records it. An exact position
 * on the canonical sequence carries `start` and `end` only.
 */
export type FeatureLocation = {
  /** 1-based start residue, on the canonical sequence or on `isoform` when set; absent only when `startModifier` is `UNKNOWN`. */
  start?: number;
  /** 1-based end residue, numbered as `start` is; absent only when `endModifier` is `UNKNOWN`. */
  end?: number;
  /**
   * UniProt's modifier on the start bound, present only when it is not `EXACT`:
   * `OUTSIDE` (the feature begins before the sequence shown, at a fragment end
   * or mid-sequence on a multi-fragment entry), `UNSURE` (approximate), or
   * `UNKNOWN` (no position; `start` is absent). Kept as UniProt's string, so a
   * value it adds later passes through.
   */
  startModifier?: string;
  /** UniProt's modifier on the end bound, as `startModifier`; `OUTSIDE` means the feature runs past the sequence shown. */
  endModifier?: string;
  /** The isoform accession the positions are numbered on (UniProt's `location.sequence`), e.g. "O00139-4"; absent on the canonical numbering. */
  isoform?: string;
};

/** A sequence feature (PTM, variant, domain, region). */
export type Feature = {
  type: string;
  description?: string;
  location: FeatureLocation;
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

/**
 * A free-text annotation (PTM, PATHWAY, SUBUNIT, …), one row per text. The note
 * of a SUBCELLULAR LOCATION, COFACTOR, or ALTERNATIVE PRODUCTS comment, and of a
 * DISEASE comment that names no disease, is filed here under that comment's type,
 * one row per note text.
 */
export type Comment = {
  /** UniProt's commentType, e.g. "PTM", "TISSUE SPECIFICITY", or "COFACTOR" for a cofactor note. */
  type: string;
  value: string;
  evidence?: string[];
  /** The isoform or chain the text is about, as on `FunctionText`. */
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
  location: FeatureLocation;
  original?: string;
  variation?: string;
  featureId?: string;
};

/**
 * An isoform produced by alternative splicing. The ALTERNATIVE PRODUCTS comment's
 * note ("Additional isoforms seem to exist.") is a `Comment` of that type.
 */
export type Isoform = {
  isoformId: string;
  name?: string;
  /** Other names of the isoform, e.g. "p53alpha"; a `molecule` can name an isoform by one. */
  synonyms?: string[];
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
  /** As on `ProteinHit`. */
  sequenceFlags?: string[];
  reviewed: boolean;
  annotationScore: number;
  proteinExistence: string;
  ecNumbers?: string[];
  function?: FunctionText[];
  catalyticActivity?: Reaction[];
  cofactors?: Cofactor[];
  /** One object per BIOPHYSICOCHEMICAL PROPERTIES comment, in UniProt's order. */
  biophysicochemical?: Biophysicochemical[];
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

/**
 * The small identity keys an entry projection or outline always keeps, so the slice
 * still names its protein: uniprot_get_entry's `sections` and the entry resource's overflow summary.
 */
export const ENTRY_IDENTITY_KEYS: (keyof Entry)[] = [
  'accession',
  'entryName',
  'proteinName',
  'genes',
  'organism',
  'length',
  // Qualifies length: without it a fragment's length reads as the whole protein's.
  'sequenceFlags',
  'reviewed',
  'annotationScore',
  'proteinExistence',
];

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

/**
 * A proteome record: reference, non-reference, or excluded. UniProt computes the
 * gene count and the reviewed/unreviewed/isoform statistics for reference
 * proteomes only and reports 0 for each elsewhere, so a 0 gene count is omitted,
 * and the three statistics are omitted together when reviewed and unreviewed are
 * both 0.
 */
export type Proteome = {
  upid: string;
  proteomeType: string;
  /** Why UniProt excluded the proteome, e.g. "genome length too small"; excluded proteomes only. */
  exclusionReasons?: string[];
  organism: Organism;
  proteinCount: number;
  /** Genes the proteins come from; at most `proteinCount`. */
  geneCount?: number;
  /** Reviewed (Swiss-Prot) proteins; with `unreviewedProteinCount` it sums to `proteinCount`. */
  reviewedProteinCount?: number;
  unreviewedProteinCount?: number;
  /** Isoform sequences counted outside `proteinCount`. */
  isoformProteinCount?: number;
  /** Complete Proteome Detector status, e.g. "Standard" or "Outlier (high value)". */
  cpdStatus?: string;
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

/** How an upstream mapping read was unavailable: it timed out, failed upstream, or was refused (a 4xx). */
export type MappingReadFailure = 'timeout' | 'failed' | 'refused';

/**
 * Why a completed ID-mapping page carries no UniProtKB target identity. `no_target`:
 * the job details name no target database. `details_*`: the job-details read that
 * names it timed out, failed upstream (unavailable, rate-limited, an HTML page), or
 * was refused (a 4xx). `identity_*`: the same three for the identity-enriched results
 * read; UniProt refuses that read for any job above 100,000 mapped IDs.
 */
export type MappingIdentityGap = 'no_target' | `${'details' | 'identity'}_${MappingReadFailure}`;

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
  identityUnavailable?: MappingIdentityGap;
  /**
   * UniProt's job-wide count of inactive targets, set only when this page's
   * inactive rows could not be identified (the lookup failed, or returned a page with
   * other rows) — so they are unmarked.
   */
  inactiveUnchecked?: number;
  failedIds: string[];
  continuation?: IdMappingContinuation;
};

/**
 * Result of an ID-mapping call: one finished page, or a running-job ticket.
 * `statusCheckFailed` marks a poll that ended on a status check failing upstream
 * after the job was known to exist, so the job may have finished since.
 */
export type IdMappingResult =
  | ({ status: 'finished' } & IdMappingPage)
  | { status: 'running'; ticket: string; statusCheckFailed?: boolean };
