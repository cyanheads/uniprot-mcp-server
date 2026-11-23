/**
 * @fileoverview UniProtKB return fields (`fields=`) for the entry and search
 *   tools: the default and mandatory projections, the field names each tool
 *   renders, the aliases the entry tool rewrites, and the split of a caller's
 *   `fields` into the value sent upstream and the names left out because the
 *   tool cannot render them (reported back as `ignoredFields`, with a notice).
 *   Field names were checked against `rest.uniprot.org/configure/uniprotkb/result-fields`.
 * @module services/uniprot/return-fields
 */

/**
 * UniProtKB fields that back the identity and provenance columns of an entry
 * and a search hit. UniProt only returns `id`, `length`, `annotation_score`,
 * `protein_existence`, and the organism fields when they are explicitly
 * requested, so a caller-supplied `fields` that omits them would otherwise drop
 * `entryName` (a hard schema-validation crash) or silently fabricate
 * provenance (`0` score, `unknown` existence). `protein_name` carries the
 * sequence flags (Fragment, Precursor) that qualify `length`. These are always
 * merged into the upstream request so a custom `fields` trims sections without
 * dropping identity.
 */
const MANDATORY_FIELDS = [
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
 * Default UniProtKB `fields` projection for search results — keeps payloads
 * small while carrying the provenance signal (reviewed flag, annotation score,
 * protein-existence level) the agent needs to weigh curation quality.
 */
const DEFAULT_SEARCH_FIELDS =
  'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence,cc_function';

/**
 * Default UniProtKB `fields` projection for full entries: every kind of
 * annotation the entry output schema describes, except the on-request sections
 * (`ON_REQUEST_SECTION_FIELDS`), whose lists run to hundreds of rows on
 * well-studied proteins. Of the cross-reference databases it carries the ones
 * the tool description names as hops (PDB, Ensembl, RefSeq, ChEMBL, AlphaFoldDB)
 * and the family, gene, and network identifiers (InterPro, Pfam, HGNC, MIM,
 * GeneID, STRING); any other database is one `xref_<database>` field away.
 */
const DEFAULT_ENTRY_FIELDS = [
  ...MANDATORY_FIELDS,
  'cc_function',
  'cc_catalytic_activity',
  'cc_cofactor',
  'kinetics',
  'ph_dependence',
  'temp_dependence',
  'redox_potential',
  'absorption',
  'cc_subcellular_location',
  'cc_disease',
  'ft_mod_res',
  'ft_carbohyd',
  'ft_lipid',
  'ft_crosslnk',
  'ft_disulfid',
  'ft_variant',
  'cc_alternative_products',
  'ft_domain',
  'ft_region',
  'ft_repeat',
  'ft_motif',
  'ft_zn_fing',
  'ft_dna_bind',
  'ft_coiled',
  'ft_act_site',
  'ft_binding',
  'ft_site',
  'ft_signal',
  'ft_transit',
  'ft_propep',
  'ft_chain',
  'ft_peptide',
  'ft_init_met',
  'ft_topo_dom',
  'ft_transmem',
  'ft_intramem',
  'cc_ptm',
  'cc_pathway',
  'cc_subunit',
  'cc_tissue_specificity',
  'go',
  'keyword',
  'xref_pdb',
  'xref_ensembl',
  'xref_refseq',
  'xref_chembl',
  'xref_alphafolddb',
  'xref_interpro',
  'xref_pfam',
  'xref_hgnc',
  'xref_mim',
  'xref_geneid',
  'xref_string',
].join(',');

/**
 * Entry sections left out of the default projection, each with the field that
 * fetches it. A `sections` call naming one (with no `fields`) adds its field.
 */
const ON_REQUEST_SECTION_FIELDS: ReadonlyMap<string, string> = new Map([
  ['mutagenesis', 'ft_mutagen'],
  ['interactions', 'cc_interaction'],
]);

/**
 * Return fields the entry normalizer reads, grouped by the output section they
 * fill. Any `xref_<database>` field renders too: under `xrefs`, or `goTerms` for GO.
 */
const ENTRY_RETURN_FIELDS: readonly string[] = [
  // accession, entryName, proteinName/alternativeNames/ecNumbers, genes, organism, length, provenance
  'accession',
  'id',
  'protein_name',
  'ec',
  'gene_names',
  'gene_primary',
  'gene_synonym',
  'gene_oln',
  'gene_orf',
  'organism_name',
  'organism_id',
  'length',
  'reviewed',
  'annotation_score',
  'protein_existence',
  // function, catalyticActivity, cofactors, subcellularLocation, disease, isoforms, interactions
  'cc_function',
  'cc_catalytic_activity',
  'cc_cofactor',
  'cc_subcellular_location',
  'cc_disease',
  'cc_alternative_products',
  'cc_interaction',
  // biophysicochemical: any one of these returns the whole BIOPHYSICOCHEMICAL PROPERTIES comment
  'kinetics',
  'ph_dependence',
  'temp_dependence',
  'redox_potential',
  'absorption',
  // comments: the free-text annotations (protein_families is the SIMILARITY text)
  'cc_activity_regulation',
  'cc_allergen',
  'cc_biotechnology',
  'cc_caution',
  'cc_developmental_stage',
  'cc_disruption_phenotype',
  'cc_domain',
  'cc_induction',
  'cc_miscellaneous',
  'cc_pathway',
  'cc_pharmaceutical',
  'cc_polymorphism',
  'cc_ptm',
  'cc_similarity',
  'cc_subunit',
  'cc_tissue_specificity',
  'cc_toxic_dose',
  'protein_families',
  // sites
  'ft_act_site',
  'ft_binding',
  'ft_site',
  // topology
  'ft_topo_dom',
  'ft_transmem',
  'ft_intramem',
  // ptms
  'ft_mod_res',
  'ft_carbohyd',
  'ft_lipid',
  'ft_crosslnk',
  'ft_disulfid',
  // processing
  'ft_signal',
  'ft_transit',
  'ft_propep',
  'ft_chain',
  'ft_peptide',
  'ft_init_met',
  // variants, mutagenesis
  'ft_variant',
  'ft_mutagen',
  // domains
  'ft_domain',
  'ft_region',
  'ft_repeat',
  'ft_motif',
  'ft_zn_fing',
  'ft_dna_bind',
  'ft_coiled',
  // goTerms, keywords
  'go',
  'go_p',
  'go_f',
  'go_c',
  'go_id',
  'keyword',
];

/**
 * Entry fields sent as another name. `keywordid` returns keyword ids without
 * names, which the required keyword name cannot carry; `cc_catalytic_activity`
 * returns the whole reaction behind a Rhea id.
 */
const ENTRY_FIELD_ALIASES: ReadonlyMap<string, string> = new Map([
  ['keywordid', 'keyword'],
  ['rhea', 'cc_catalytic_activity'],
]);

/** Return fields a search hit renders. */
const SEARCH_RETURN_FIELDS: readonly string[] = [
  'accession',
  'id',
  'protein_name',
  'gene_names',
  'gene_primary',
  'gene_synonym',
  'gene_oln',
  'gene_orf',
  'organism_name',
  'organism_id',
  'length',
  'reviewed',
  'annotation_score',
  'protein_existence',
  'cc_function',
];

const ENTRY_FIELD_SET: ReadonlySet<string> = new Set(ENTRY_RETURN_FIELDS);
const SEARCH_FIELD_SET: ReadonlySet<string> = new Set(SEARCH_RETURN_FIELDS);

/**
 * The shape of a UniProt return-field name, lowercased: words of letters and
 * digits joined by `_`, and after `xref_` also by `-` (`xref_mane-select`).
 * Only a name of this shape is judged against a tool's vocabulary; anything else
 * goes upstream as sent, for UniProt to accept or reject by name. Every ignored
 * name therefore has this shape, which no Markdown construct reads into.
 */
const FIELD_NAME = /^(?:xref_[a-z0-9]+(?:[_-][a-z0-9]+)*|[a-z0-9]+(?:_[a-z0-9]+)*)$/;

/** Which tool's vocabulary a request is split against. */
type FieldTool = 'entry' | 'search';

/** A caller's `fields` split for one tool. */
type FieldRequest = {
  /** The `fields` value to send — undefined for the service's default projection. */
  fields: string | undefined;
  /** Requested names the tool cannot render, lowercased, in request order: left out of `fields`. */
  ignored: string[];
};

/** The upstream name an entry renders `name` under, or undefined when it renders none. */
function entryField(name: string): string | undefined {
  const field = ENTRY_FIELD_ALIASES.get(name) ?? name;
  return ENTRY_FIELD_SET.has(field) || field.startsWith('xref_') ? field : undefined;
}

function searchField(name: string): string | undefined {
  return SEARCH_FIELD_SET.has(name) ? name : undefined;
}

/** The trimmed, non-empty tokens of a comma-separated `fields` value. */
function fieldTokens(fields: string | undefined): string[] {
  return (fields ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Split a caller's comma-separated `fields` into the names sent upstream and the
 * names the tool cannot render. Tokens are trimmed; a field-shaped token is
 * lowercased (UniProt matches field names case-insensitively) and kept, aliased,
 * or ignored. `fields` with no token returns `undefined` for the default.
 */
function splitFields(
  fields: string | undefined,
  render: (name: string) => string | undefined,
): { sent: string[]; ignored: string[] } | undefined {
  const tokens = fieldTokens(fields);
  if (tokens.length === 0) return;
  const sent: string[] = [];
  const ignored = new Set<string>();
  for (const token of tokens) {
    const name = token.toLowerCase();
    if (!FIELD_NAME.test(name)) {
      sent.push(token);
      continue;
    }
    const field = render(name);
    if (field) sent.push(field);
    else ignored.add(name);
  }
  return { sent, ignored: [...ignored] };
}

/**
 * The upstream `fields` for a uniprot_get_entry call. With no `fields`, the
 * default projection — plus the field of each on-request section `sections`
 * names. With `fields`, the names an entry renders (aliases rewritten, any
 * `xref_<database>` kept); the service adds the identity columns, so a request
 * whose every name is ignored still returns the identity record.
 */
export function entryFieldRequest(
  fields: string | undefined,
  sections: readonly string[] = [],
): FieldRequest {
  const split = splitFields(fields, entryField);
  if (split) return { fields: split.sent.join(','), ignored: split.ignored };
  const onRequest = [...new Set(sections.flatMap((s) => ON_REQUEST_SECTION_FIELDS.get(s) ?? []))];
  return {
    fields: onRequest.length ? [DEFAULT_ENTRY_FIELDS, ...onRequest].join(',') : undefined,
    ignored: [],
  };
}

/** The upstream `fields` for a uniprot_search_proteins call: only the names a hit renders. */
export function searchFieldRequest(fields: string | undefined): FieldRequest {
  const split = splitFields(fields, searchField);
  return split
    ? { fields: split.sent.join(','), ignored: split.ignored }
    : { fields: undefined, ignored: [] };
}

/**
 * The `fields` parameter a request carries: the default projection when
 * `fields` is undefined, else its names behind the mandatory columns. An empty
 * `fields` — every name split off as ignored — sends the mandatory columns alone.
 */
function fieldsParam(fields: string | undefined, defaults: string): string {
  if (fields === undefined) return defaults;
  return [...new Set([...MANDATORY_FIELDS, ...fieldTokens(fields)])].join(',');
}

/** The `fields` parameter of an entry fetch (`fieldsParam`). */
export function entryFieldsParam(fields: string | undefined): string {
  return fieldsParam(fields, DEFAULT_ENTRY_FIELDS);
}

/** The `fields` parameter of a UniProtKB search (`fieldsParam`). */
export function searchFieldsParam(fields: string | undefined): string {
  return fieldsParam(fields, DEFAULT_SEARCH_FIELDS);
}

/**
 * The one notice for a call that ignored fields: the names, why they were not
 * fetched, where each can be had, and the fields the tool supports. Names are
 * field-shaped (`FIELD_NAME`), so the text needs no Markdown escaping.
 */
export function ignoredFieldsNotice(ignored: readonly string[], tool: FieldTool): string {
  const parts = [
    `Ignored fields: ${ignored.join(', ')} — ${tool === 'entry' ? 'uniprot_get_entry does not return them' : 'search hits do not carry them'}, so they were not requested from UniProt.`,
  ];
  const viaEntry =
    tool === 'search' ? ignored.filter((n) => n !== 'sequence' && entryField(n)) : [];
  if (viaEntry.length) {
    parts.push(
      `uniprot_get_entry returns ${viaEntry.join(', ')}: pass these results' accessions with fields:"${viaEntry.join(',')}".`,
    );
  }
  if (ignored.includes('sequence')) {
    parts.push('uniprot_get_sequence returns the sequence (FASTA) of an accession.');
  }
  parts.push(
    tool === 'entry'
      ? `Supported fields: ${[...ENTRY_RETURN_FIELDS, ...ENTRY_FIELD_ALIASES.keys()].join(', ')}, and any \`xref_<database>\` field, e.g. xref_interpro.`
      : `Supported fields: ${SEARCH_RETURN_FIELDS.join(', ')}.`,
  );
  return parts.join(' ');
}
