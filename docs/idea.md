# uniprot-mcp-server — Idea & Design

The protein-as-primary-entity research workflow over [UniProt](https://rest.uniprot.org) — the canonical hub for protein function, sequence, and annotation. Search UniProtKB by function, keyword, GO term, gene, or organism; retrieve full curated (Swiss-Prot) entries — function, catalytic activity, subcellular location, disease involvement, PTMs, isoforms, sequence, and cross-references; map identifiers across 100+ databases; pull reference proteomes and taxonomy. Keyless, CC BY.

**Audience:** Molecular/structural biologists, bioinformaticians, drug-discovery researchers, anyone resolving "what does this protein do" or "which proteins have property X."

## Relationship to protein-mcp-server (earned overlap)

`protein-mcp-server` already calls UniProt — but only as an **annotation layer for a structure**: `protein_get_annotations` pulls UniProt features/variants for a protein you reached *via its 3D structure* (PDB/AlphaFold). That's structure-first. This server is **protein-first** and stands alone: the entry point is a function/keyword/organism query across all of UniProtKB, and the unit of work is the curated knowledge record, not the coordinate file. The two intersect at "given an accession, show its features," and that overlap is **earned** — each server serves a different journey (structure → annotation vs. function → protein → optional structure), and an agent shouldn't have to load a structure server to ask "find all human kinases involved in apoptosis." Cross-link: a UniProt accession here chains into `protein_get_structure` for the model, and a protein structure there chains here for the full functional record.

## User Goals

- Find proteins by function, keyword, GO term, pathway, or family ("reviewed human kinases involved in apoptosis")
- Retrieve a full curated UniProtKB entry — function, catalytic activity, subcellular location, disease, PTMs, isoforms, sequence, cross-references
- Map identifiers across databases (gene name ↔ accession, accession ↔ PDB / Ensembl / RefSeq / ChEMBL)
- Get the reference proteome for an organism
- Resolve a protein's sequence and isoforms (FASTA)
- Look up taxonomy lineage for an organism
- Trace disease associations and natural variants for a protein

## API Surface

One provider, several REST collections at `rest.uniprot.org`. UniProtKB query syntax is Lucene-style and field-aware (`gene:BRCA1 AND organism_id:9606 AND reviewed:true`, `keyword:KW-0053`, `go:0006915`). Entries are keyed by **accession** (e.g. `P04637` for p53); proteomes by **UPID** (`UP000005640`); taxa by **NCBI taxon ID** (`9606`). Full entries are large — use `fields` selection and `format` (json/fasta/tsv) to trim.

| Collection | Endpoint | Purpose |
|:-----------|:---------|:--------|
| UniProtKB | `/uniprotkb/search`, `/uniprotkb/{accession}` | Protein search (with facets) + full entry |
| ID Mapping | `/idmapping/run` → `/status/{job}` → `/results/{job}` | Cross-database ID translation (async job) |
| Proteomes | `/proteomes/search`, `/proteomes/{upid}` | Organism reference proteomes |
| Taxonomy | `/taxonomy/{id}`, `/taxonomy/search` | Lineage + children |
| UniRef | `/uniref/search`, `/uniref/{id}` | Sequence-identity clusters (50/90/100%) |

## Tool Surface (sketch)

```
uniprot_search_proteins  — search UniProtKB by free text or structured query (gene,
                          organism, keyword, GO term, family, reviewed status, length,
                          existence level). Returns accession, protein/gene name,
                          organism, length, reviewed flag, and a function snippet.
                          Optional facets (organism, keyword, reviewed) for breakdowns.
                          The discovery entry point — chain hits into get_entry.
                          Convenience `text_search` shortcut over the full `query` syntax.

uniprot_get_entry        — full curated entry(ies) by accession (batch). Function,
                          catalytic activity, cofactors, subcellular location, disease
                          involvement, PTMs, isoforms, domains/features, GO/keyword
                          annotations, and cross-references. `fields` selection trims the
                          payload; large multi-section records use outline-on-overflow so
                          the agent can re-fetch only the sections it needs.

uniprot_map_ids          — translate IDs across databases via the UniProt ID-mapping
                          service (async run→poll→results wrapped within a budget). e.g.
                          gene names → accessions, accession → PDB / Ensembl / RefSeq /
                          ChEMBL / GeneID. from_db / to_db enums. The glue that lets an
                          agent arrive from any sibling server's identifier.

uniprot_get_proteome     — reference proteome for an organism by UPID or taxon ID:
                          protein count, completeness (BUSCO), and the protein set
                          (paginated / DataCanvas for large proteomes). "Give me the
                          human reference proteome."

uniprot_get_taxonomy     — taxonomy record by NCBI taxon ID or name: scientific/common
                          name, rank, full lineage, and immediate children. Resolves
                          organism filters for search and grounds cross-server taxonomy.

uniprot_get_sequence     — canonical + isoform sequences (FASTA) for an accession, with
                          length and feature-mapped sequence ranges. Splittable from
                          get_entry so sequence-only calls stay cheap. (Optional — fold
                          into get_entry if the surface is tighter without it.)
```

## Design Notes

- **Lucene query is the power surface; a `text_search` shortcut covers the 80% case.** Document the common fields (`gene`, `organism_id`, `keyword`, `go`, `reviewed`, `protein_name`, `family`) in the param description; point to the full query syntax for advanced use. Validate that one of `text_search` / `query` is provided.
- **ID mapping is async** (submit job → poll status → fetch results). Wrap it like protein's Foldseek pattern: poll within a bounded budget, return a resumable ticket on overflow rather than blocking. This is the single most-reused tool — every sibling server's identifier (gene from `ensembl`, target from `chembl`, structure from `protein`) enters UniProt through it.
- **Entries are big and section-heavy.** Default to `fields` selection; for full entries, use `outlineOnOverflow()` so a 50-section record returns an outline and the agent pulls only `function`, `disease`, or `xrefs` as needed.
- **Reviewed (Swiss-Prot) vs. unreviewed (TrEMBL)** is a critical filter — expose `reviewed` prominently and default search to favor reviewed entries; an agent drowning in TrEMBL predictions is a common failure mode.
- **Large proteomes / search result sets are analytical** (group by organism, keyword, GO) → DataCanvas + `uniprot_dataframe_query` is a fit for the proteome and faceted-search paths.
- **Provenance:** every entry carries an evidence/annotation-score; surface it so the agent can weigh manually-curated vs. computationally-predicted annotation.
- **Composes with** `protein` (accession → 3D structure), `ensembl` (gene ↔ protein, build context), `chembl` (target → bioactivity / known drugs), `pubmed` (citations behind annotations), `pubchem` (cofactors/ligands).
- README one-liner: "Protein function and annotation research over UniProtKB — search by what proteins do, fetch curated records, and map IDs across the bioinformatics ecosystem."
