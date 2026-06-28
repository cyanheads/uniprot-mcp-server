/**
 * @fileoverview Domain types for the UniProt service — normalized, agent-facing
 *   shapes derived from the live `rest.uniprot.org` JSON (verified against the
 *   API), plus the ID-mapping database enum and the canonical default field set.
 *   Raw upstream sparsity is preserved: most curated sections are optional and
 *   absent on TrEMBL entries, so absence stays absence rather than a fabricated
 *   value.
 * @module services/uniprot/types
 */

/**
 * ID-mapping database identifiers (`from`/`to` values), taken verbatim from the
 * live `/configure/idmapping/fields` endpoint. These are the exact strings the
 * `/idmapping/run` form accepts — `UniProtKB-Swiss-Prot` (not `UniProtKB`) is the
 * reviewed-only target, and `UniProtKB_AC-ID` is the from-direction accession/ID.
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

/** A search result page: hits + pagination metadata. */
export type SearchPage = {
  results: ProteinHit[];
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

/** Result of an ID-mapping job: finished mappings, or a resumable ticket. */
export type IdMappingResult =
  | { status: 'finished'; results: { from: string; to: string }[] }
  | { status: 'running'; ticket: string };
