# uniprot-mcp-server — Design

The protein-as-primary-entity research workflow over [UniProt](https://rest.uniprot.org) — search UniProtKB by what proteins *do* (function, keyword, GO term, gene, organism, family), retrieve full curated (Swiss-Prot) records, map identifiers across 100+ databases, and pull reference proteomes, taxonomy, and sequences. Keyless, CC BY 4.0.

This doc formalizes `docs/idea.md` into a buildable spec. Tool names are taken verbatim from the idea; the surface is **6 tools, 2 resources, 1 prompt** (see [Design Decisions](#design-decisions) #5 for why a local SQL/DataCanvas layer was cut).

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `uniprot_search_proteins` | Search UniProtKB by free text (`text_search`) or structured Lucene `query`; optional upstream facet counts for breakdowns. Cursor-paginated. The discovery entry point. | `true` | `true` | `text_search` \| `query`, `reviewed`, `fields`, `facets`, `size`, `cursor` | `{ results[], totalResults, facets?, cursor? }` |
| `uniprot_get_entry` | Full curated entry(ies) by accession (batch ≤ 20). Function, catalytic activity, cofactors, location, disease, PTMs, isoforms, features, GO/keywords, xrefs. Partial-success output: `succeeded[]` + `failed[]`. | `true` | `true` | `accessions[]`, `fields`, `sections` | `{ kind: 'full', succeeded[], failed[] } \| { kind: 'outline', sections, notice }` |
| `uniprot_map_ids` | Translate IDs across databases via the async ID-mapping service (run → poll → results within a bounded budget; resumable ticket on overflow). `from_db`/`to_db` values from the enum list in the Workflow Analysis section. | `true` | `true` | `from_db`, `to_db`, `ids[]`, `tax_id?` | `{ status: 'finished', results[] } \| { status: 'running', ticket }` |
| `uniprot_get_proteome` | Reference proteome for an organism by UPID (`UP000005640`) or taxon ID (`9606`) — exactly one required. Metadata (protein count, BUSCO completeness, genome assembly) plus an optional cursor-paginated, capped protein list. | `true` | `true` | `upid` \| `taxon_id`, `include_proteins?`, `cursor?` | `{ proteome, proteins?, cursor? }` |
| `uniprot_get_taxonomy` | Taxonomy record by NCBI taxon ID (integer, e.g. `9606`) or scientific name (e.g. `"Homo sapiens"`): scientific/common name, rank, full lineage, immediate children. | `true` | `true` | `taxon_id` \| `name`, `include_children?` | `{ taxon, lineage[], children? }` |
| `uniprot_get_sequence` | Canonical + isoform sequences (FASTA) for an accession, with length and feature-mapped ranges. | `true` | `true` | `accession`, `include_isoforms?` | `{ accession, canonical, isoforms?[] }` |

### Resources

| URI Template | Returns | Notes |
|---|---|---|
| `uniprot://entry/{accession}` | Curated UniProtKB entry, default `fields` set (same projection as `uniprot_get_entry` single-accession path) | Convenience mirror; tool path is authoritative for tool-only clients |
| `uniprot://taxonomy/{taxonId}` | Taxonomy record (name, rank, lineage) | Mirrors `uniprot_get_taxonomy` by-ID |

Both are read-only by-ID lookups — the kind that earns a resource (stable URI, injectable context). No `list()`: UniProtKB is far too large to enumerate, and discovery is the search tool's job. Every datum here is reachable via tools, so tool-only clients lose nothing.

### Prompts

| Name | Description | Args |
|---|---|---|
| `uniprot_protein_dossier` | Guided protein-research workflow: resolve identifier → fetch curated entry → pull disease/variants → surface cross-references for structure (`protein`), citations (`pubmed`), and bioactivity (`chembl`). | `identifier` (gene name, accession, or protein name), `organism?` |

One prompt, mirroring the `ensembl_gene_dossier` pattern in the sibling `ensembl-mcp-server`. It structures the most common multi-tool journey (function → protein → optional cross-server hops) without the agent rediscovering the chain. Skip-able for clients that don't surface prompts; the tools stand alone.

---

## Overview

UniProt is the canonical hub for protein function, sequence, and annotation. `uniprot-mcp-server` exposes its REST collections (`rest.uniprot.org`) as a **protein-first** research surface: the entry point is a function/keyword/organism query across all of UniProtKB, and the unit of work is the curated knowledge record — not a coordinate file. An agent asks "find all reviewed human kinases involved in apoptosis," gets accessions, and pulls full curated records (function, catalytic activity, subcellular location, disease involvement, PTMs, isoforms, GO/keyword annotations, cross-references) for the hits.

The core value is twofold. First, **curation-aware discovery**: UniProtKB splits into reviewed Swiss-Prot (manually curated) and unreviewed TrEMBL (computationally predicted, ~30× larger). An agent drowning in TrEMBL predictions is the common failure mode, so the surface foregrounds the `reviewed` filter and every record carries its annotation score and protein-existence evidence level. Second, **the identifier bridge**: `uniprot_map_ids` wraps UniProt's async ID-mapping service, the single most-reused tool in the fleet — every sibling server's identifier (a gene from `ensembl`, a target from `chembl`, a structure from `protein`) enters UniProt through it.

Upstream is one provider, several REST collections: UniProtKB (search + entry), ID Mapping (async job), Proteomes, Taxonomy. Entries are keyed by **accession** (e.g. `P04637` for p53); proteomes by **UPID** (`UP000005640`); taxa by **NCBI taxon ID** (`9606`). Full entries are large and section-heavy, so the surface leans on `fields` selection, FASTA/JSON `format` switching, cursor pagination for long result sets, and outline-on-overflow for fat single records.

Primary agent workflows: (1) function/keyword search → curated record; (2) arrive from a sibling server's ID → map to UniProt accession → record; (3) "give me the human reference proteome"; (4) trace a protein's disease associations and natural variants. The server composes with `protein` (accession → 3D structure), `ensembl` (gene ↔ protein), `chembl` (target → bioactivity), `pubmed` (citations behind annotations), and `pubchem` (cofactors/ligands).

---

## Requirements

**Functional**

- Search UniProtKB by free text or structured Lucene query (`gene`, `organism_id`, `keyword`, `go`, `reviewed`, `protein_name`, `family`, `length`, `existence`, `accession`), with optional upstream facet counts (`reviewed`, `proteins_with`, `model_organism`, etc.) for breakdowns, cursor-paginated.
- Fetch full curated entries by accession in batch, with `fields` projection and section-outline overflow.
- Map identifiers across databases via the async ID-mapping service (run → poll → results), bounded by a time budget with a resumable ticket on overflow.
- Retrieve a reference proteome (BUSCO completeness, protein count, genome assembly) by UPID or taxon ID, with an optional cursor-paginated, capped protein list.
- Resolve taxonomy records (lineage + immediate children) by taxon ID or name.
- Resolve canonical + isoform sequences as FASTA, with length and feature-mapped ranges.

**Non-functional / constraints**

- **No auth.** UniProt REST is keyless. No API key config, no JWT/OAuth, no auth scopes (read-only public data over stdio/HTTP).
- **Licensing:** UniProt data is CC BY 4.0 — attribution surfaced in server `instructions` and the README. No PII concerns (public scientific reference data).
- **Rate / fair use:** no published hard quota, but the service expects polite use. Service layer retries transient 5xx/429 with backoff; ID-mapping polling is bounded (see Workflow Analysis).
- **Payload size:** full entries reach ~tens of KB each (the p53 record's FUNCTION comment alone carries 18 PubMed evidence refs); large proteomes are 100K+ proteins (human = 147,506). Overflow handling is mandatory, not optional.
- **Freshness:** UniProt releases ~every 8 weeks; the server reads live, so freshness tracks upstream with no local lag.

**Out of scope (v1)** — UniRef sequence-identity clusters (idea.md lists the collection but no tool); UniParc; proteomics/Peptide-level data; any write/submission path (UniProt is read-only upstream); BLAST/alignment (that's `protein`'s Foldseek territory and a different service).

---

## Data Model

Entities as surfaced by the tools. Field names follow the live UniProt JSON (verified against `rest.uniprot.org`), normalized into flatter agent-facing shapes where the raw nesting adds no signal.

### Identifiers — how an agent obtains each

| Identifier | Format | Pattern | How obtained |
|---|---|---|---|
| **Accession** | UniProtKB primary accession | `[OPQ][0-9][A-Z0-9]{3}[0-9]` or `[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2}` | `uniprot_search_proteins` results; `uniprot_map_ids` `to` field; cross-server (sibling `protein`/`ensembl`/`chembl` xrefs) |
| **UPID** | Proteome identifier | `UP[0-9]{9}` | `uniprot_get_proteome` (by taxon ID resolves the UPID); proteome search |
| **Taxon ID** | NCBI taxonomy integer | `[0-9]+` | `uniprot_get_taxonomy`; `organism.taxonId` on any entry; well-known (9606 = human) |
| **Entry name** | UniProtKB ID (mnemonic) | `[A-Z0-9]+_[A-Z0-9]+` (e.g. `P53_HUMAN`) | entry/search output; **not** an input key — accession is |

> Accession regex is enforced as a Zod `.regex()` (→ JSON-Schema `pattern`), not prose. A malformed accession is a client-input error caught before the upstream call. Isoform-suffixed accessions (`P04637-2`) may appear in cross-references — strip the `-N` suffix before passing to `uniprot_get_entry` or `uniprot_get_sequence`; the canonical accession (`P04637`) is the lookup key.

### Protein (search result row — trimmed)

```ts
type ProteinHit = {
  accession: string;           // primaryAccession, e.g. "P04637"
  entryName: string;           // uniProtkbId, e.g. "P53_HUMAN"
  proteinName: string | null;  // proteinDescription.recommendedName.fullName.value
  geneNames: string[];         // genes[].geneName.value (+ synonyms)
  organism: { scientificName: string; commonName: string | null; taxonId: number };
  length: number;              // sequence.length
  reviewed: boolean;           // entryType === "UniProtKB reviewed (Swiss-Prot)"
  annotationScore: number;     // 1–5; manual-curation confidence — surfaced for provenance
  proteinExistence: string;    // "1: Evidence at protein level" … "5: Uncertain"
  functionSnippet: string | null; // first FUNCTION comment text, evidence stripped for the snippet
};
```

### Entry (full curated record — `uniprot_get_entry`)

Batch call (≤ 20 accessions). Uses partial-success output pattern: always returns both `succeeded[]` and `failed[]` so an agent knows which accessions resolved and which didn't, without re-calling the whole batch. The `outline` variant replaces `succeeded[]` with a section outline when the payload exceeds context budget.

**`fields` vs `sections`** — two orthogonal projection parameters:
- `fields` is the upstream UniProt REST `fields` param (e.g. `accession,gene_names,cc_function,ft_variant`) — controls what raw data is fetched from the API. Accepts individual UniProtKB field names; reduces network payload.
- `sections` is a server-side input used only on re-calls after an `outline` response: the agent passes a subset of outlined section keys (e.g. `["disease","variants"]`) and the server fetches + returns only those sections from the full record. Not passed on initial calls — initial `fields` selection handles the trimming.

Sectioned. Raw upstream returns `comments[]` discriminated by `commentType` (`FUNCTION`, `CATALYTIC_ACTIVITY`, `COFACTOR`, `SUBCELLULAR_LOCATION`, `DISEASE`, `PTM`, `ALTERNATIVE_PRODUCTS`, …) and `features[]` by feature `type` (`Modified residue`, `Natural variant`, `Domain`, …). Normalized into named sections so `fields` selection and outline-on-overflow operate on stable keys:

```ts
type Entry = {
  accession: string; entryName: string; proteinName: string | null;
  genes: string[]; organism: Organism; length: number;
  reviewed: boolean; annotationScore: number; proteinExistence: string;
  function?: EvidencedText[];          // cc_function
  catalyticActivity?: Reaction[];      // cc_catalytic_activity (Rhea xrefs)
  cofactors?: Cofactor[];              // cc_cofactor (ChEBI)
  subcellularLocation?: Location[];    // cc_subcellular_location
  disease?: Disease[];                 // cc_disease (OMIM xref, diseaseAccession DI-xxxxx)
  ptms?: Feature[];                    // ft_mod_res, ft_carbohyd, ...
  variants?: Variant[];                // ft_variant (dbSNP, ClinVar)
  isoforms?: Isoform[];                // cc_alternative_products + ft_var_seq
  domains?: Feature[];                 // ft_domain, ft_region
  goTerms?: GoTerm[];                  // go (id + aspect: P/F/C)
  keywords?: Keyword[];                // keyword (KW-xxxx)
  xrefs?: Record<string, string[]>;    // grouped by database: PDB, Ensembl, RefSeq, ChEMBL, ...
  evidence?: string;                   // provenance summary
};
```

Each evidenced field preserves its source PubMed/ECO codes — `format()` and normalization **must not** fabricate facts from missing upstream data (sparse-payload rule). A required-vs-optional split errs toward optional: most sections are absent on TrEMBL entries.

### Proteome

```ts
type Proteome = {
  upid: string;                        // id, e.g. "UP000005640"
  proteomeType: string;                // "Reference proteome" | "Other proteome" | "Redundant proteome"
  organism: { scientificName: string; commonName: string | null; taxonId: number; mnemonic: string };
  proteinCount: number;                // 147506 for human
  busco?: {                            // proteomeCompletenessReport.buscoReport
    complete: number; completeSingle: number; completeDuplicated: number;
    fragmented: number; missing: number; total: number;
    lineageDb: string;                 // e.g. "primates_odb10"
    score: number;                     // 0–100 completeness %
  };
  genomeAssembly?: string;             // genomeAssembly.assemblyId, e.g. "GCA_000001405.29"
};
```

### Taxon

```ts
type Taxon = {
  taxonId: number; scientificName: string; commonName: string | null;
  mnemonic: string | null;             // "HUMAN"
  rank: string;                        // "species", "genus", ...
  parent?: { taxonId: number; scientificName: string };
  lineage: { taxonId: number; scientificName: string; commonName?: string; rank: string }[];
  children?: { taxonId: number; scientificName: string; rank: string }[]; // via search, not inline
  otherNames?: string[];
};
```

### Sequence (FASTA)

```ts
type SequenceResult = {
  accession: string;
  canonical: { header: string; sequence: string; length: number };  // sp|P04637|P53_HUMAN ... PE=1 SV=4
  isoforms?: { isoformId: string; header: string; sequence: string; length: number }[]; // includeIsoform=true
};
```

---

## Services

One upstream provider → one service.

| Service | Responsibility | Key methods |
|---|---|---|
| `UniProtService` (`src/services/uniprot/uniprot-service.ts`) | The `rest.uniprot.org` REST client. Wraps all four collections; owns base-URL config, retry/backoff, `fields`/`format` handling, cursor pagination (parse `Link: rel="next"` + `x-total-results`), and the async ID-mapping run→poll→results loop. | `search(query, opts)`, `getEntries(accessions, fields)`, `mapIds(from, to, ids, taxId, budgetMs)`, `pollMapping(jobId)`, `getProteome(idOrTaxon)`, `getTaxon(idOrName)`, `getChildren(taxonId)`, `getFasta(accession, includeIsoforms)` |

**Resilience** (`UniProtService`): retry boundary wraps the full fetch+parse pipeline via `withRetry` from `/utils`; backoff 1–2s base (the service is occasionally rate-limited under load); `fetchWithTimeout` classifies non-OK → `ServiceUnavailable`; the response handler detects UniProt's HTML error/maintenance pages and throws transient (not `SerializationError`). No SDK exists for UniProt REST — a thin `fetch` client is the right call (no wrapper earns its keep beyond this service).

**API efficiency**: `getEntries` uses UniProtKB's batch search (`query=accession:(P04637 OR P38398 OR …)`) so N accessions are one round trip, cross-referenced against the requested set to flag any missing; every method passes `fields` to trim payloads (a full record is ~tens of KB; a 5-field projection is a fraction).

---

## Config

`src/config/server-config.ts` — lazy `parseEnvConfig`, separate from framework config. No secrets (keyless API).

| Env Var | Required | Default | Purpose |
|---|---|---|---|
| `UNIPROT_BASE_URL` | optional | `https://rest.uniprot.org` | Override the REST base (private mirror / testing). |
| `UNIPROT_TIMEOUT_MS` | optional | `30000` | Per-request HTTP timeout in ms. ID-mapping poll calls use a shorter internal slice so the budget calculation stays accurate. |
| `UNIPROT_ID_MAPPING_BUDGET_MS` | optional | `8000` | Wall-clock budget for the inline ID-mapping poll loop before returning a resumable ticket. Must be < `UNIPROT_TIMEOUT_MS`. |
| `UNIPROT_DEFAULT_PAGE_SIZE` | optional | `25` | Default `size` for search / proteome protein listing when unset by the caller. |

No API key row: UniProt requires none, and adding a fake one would mislead. (Contrast: sibling servers like `smithsonian`/`census` need keys; this one genuinely does not.)

---

## Implementation Order

Each step independently buildable + testable.

1. **Config + service skeleton** — `server-config.ts` (Zod schema above), `UniProtService` with `search` + `getEntries` + the `fetchWithTimeout`/`withRetry` resilience layer. Delete the echo definitions; wire an empty `createApp()`.
2. **`uniprot_search_proteins`** — the discovery entry point. `text_search`/`query` shortcut split, `reviewed` filter, `fields` projection, cursor pagination, upstream facet pass-through.
3. **`uniprot_get_entry`** — batch fetch + section normalization + `outlineOnOverflow()` discriminated-union output (`full | outline`) with `sections` re-call. Includes the sparse-payload test case.
4. **`uniprot_map_ids`** — async run→poll→results bounded by `UNIPROT_ID_MAPPING_BUDGET_MS`; `from_db`/`to_db` enums; resumable ticket on overflow.
5. **`uniprot_get_proteome`** — by UPID or taxon ID; BUSCO/assembly metadata inline; optional cursor-paginated, capped protein list.
6. **`uniprot_get_taxonomy`** — by taxon ID or name; lineage inline; children via follow-up search.
7. **`uniprot_get_sequence`** — FASTA canonical + isoforms (`includeIsoform=true`); parse headers into `length` + metadata.
8. **Resources** — `uniprot://entry/{accession}`, `uniprot://taxonomy/{taxonId}` (thin wrappers over the service methods built above).
9. **Prompt** — `uniprot_protein_dossier`.
10. **Polish** — `instructions` (attribution, reviewed-first hint, the map_ids cross-server note), README, `server.json` env vars, tests, `devcheck`, `security-pass`.

---

## Workflow Analysis

### 1. Function-first discovery → curated record (the spine)

| # | Tool | Why | Hop |
|---|---|---|---|
| 1 | `uniprot_search_proteins` | `text_search: "kinase apoptosis"` + `reviewed: true` + `organism_id:9606` → ranked accessions | — |
| 2 | `uniprot_get_entry` | batch the top accessions from step 1's `results[].accession` | **input = step 1 output** |
| 3 | `uniprot_get_sequence` *(opt)* | FASTA for a hit if the agent needs sequence | accession from step 1/2 |

The cross-tool hop: `get_entry.accessions[]` comes **only** from `search_proteins.results[].accession` (or a sibling server's xref). The entry tool does not search — its description says so and points to the search tool.

### 2. Arrive from a sibling server's identifier (the bridge — most-reused path)

| # | Tool | Why | Hop |
|---|---|---|---|
| 1 | `uniprot_map_ids` | `from_db: "Gene_Name"` / `"Ensembl"` / `"ChEMBL"`, `to_db: "UniProtKB"`, `ids: ["TP53"]`, `tax_id: 9606` | enters from any sibling ID |
| 2 | `uniprot_get_entry` | the `results[].to` accessions from step 1 | **input = step 1 output** |

Live-verified gotcha that drives the design: `Gene_Name → UniProtKB` for `TP53`+human returns **one canonical Swiss-Prot accession plus dozens of TrEMBL isoform accessions** (`P04637, A0A087WT22, …`). So `to_db` exposes both `UniProtKB-Swiss-Prot` (reviewed accessions only — the usual intent) and `UniProtKB` / `UniProtKB_AC-ID` (which include TrEMBL), and the description steers agents to the reviewed target unless they want TrEMBL.

**`from_db`/`to_db` enum values** — taken verbatim from the live `/configure/idmapping/fields` endpoint (most-used subset; full list at [UniProt ID mapping docs](https://www.uniprot.org/help/id_mapping)). The exact strings live in `ID_MAPPING_FROM_DBS` / `ID_MAPPING_TO_DBS` in `src/services/uniprot/types.ts`:

| Value | Direction | Notes |
|---|---|---|
| `UniProtKB_AC-ID` | from/to | Accession or entry name (Swiss-Prot + TrEMBL) |
| `UniProtKB` | to only | Swiss-Prot + TrEMBL accessions |
| `UniProtKB-Swiss-Prot` | to only | Reviewed (Swiss-Prot) accessions only — use this to filter to curated entries |
| `Gene_Name` | from | HGNC gene symbol (e.g. `TP53`); pair with `taxon_id` to disambiguate species |
| `GeneID` | from/to | NCBI Gene ID (integer) |
| `Ensembl` | from/to | Ensembl gene stable ID (`ENSG…`) |
| `Ensembl_Protein` | from/to | Ensembl protein stable ID (`ENSP…`) |
| `PDB` | from/to | PDB structure ID (4-char, e.g. `2OCJ`) |
| `RefSeq_Nucleotide` | from/to | RefSeq mRNA accession (`NM_…`) |
| `RefSeq_Protein` | from/to | RefSeq protein accession (`NP_…`) |
| `ChEMBL` | from/to | ChEMBL target ID (`CHEMBL…`) |
| `PomBase` | from/to | PomBase gene systematic ID |
| `WormBase_Protein` | from/to | WormBase protein ID |

The Zod schema exposes this as `z.enum([...])` so invalid `from_db`/`to_db` values are caught at the edge before the upstream call. The async loop:

| Sub-step | Call | Bound |
|---|---|---|
| a | `POST /idmapping/run` (form: `from`, `to`, `ids`, optional `taxId`) → `{ jobId }` | always |
| b | `GET /idmapping/status/{jobId}` → `{ jobStatus }`, poll until `FINISHED` | until `UNIPROT_ID_MAPPING_BUDGET_MS` |
| c | `GET /idmapping/results/{jobId}` (follow redirect; cursor-paginated) → `{ results:[{from,to}] }` | on `FINISHED` |
| — | budget exceeded → return `{ status: 'running', ticket: jobId }` so the agent re-calls to fetch without re-submitting | on overflow |

(Mirrors `protein`'s Foldseek poll-within-budget pattern; the `ticket` is the bare `jobId`, resumable because UniProt holds the job server-side.)

### 3. Organism reference proteome

| # | Tool | Why | Hop |
|---|---|---|---|
| 1 | `uniprot_get_taxonomy` *(opt)* | resolve "human" → taxon ID 9606 if the agent has a name, not an ID | name → taxonId |
| 2 | `uniprot_get_proteome` | `taxon_id: 9606` → UPID `UP000005640`, BUSCO 99/`primates_odb10`, 147,506 proteins; metadata inline, protein list opt-in | taxonId from step 1 |
| 3 | `uniprot_get_proteome` *(opt)* | `include_proteins: true` + walk `cursor` for the protein set (capped page; narrow upstream with the `query` filter for a subset) | `cursor` from step 2 |

### 4. Disease + variant trace

| # | Tool | Why | Hop |
|---|---|---|---|
| 1 | `uniprot_get_entry` | `accessions: ["P04637"]`, `fields/sections: ["disease","variants"]` → typed `DISEASE` comments (OMIM, `DI-01537`) + `ft_variant` (dbSNP/ClinVar) | accession from search/map |
| 2 | cross-server | OMIM/dbSNP xrefs chain out; PubMed evidence IDs → `pubmed`; PDB xref → `protein` | xref IDs from step 1 |

---

## Design Decisions

1. **6 tools, names verbatim from idea.md.** `uniprot_get_sequence` is kept as its own tool (idea.md flags it "optional — fold into get_entry"): sequence-only calls stay cheap (FASTA, not the full JSON record), and FASTA is a different `format`/parser path than the entry JSON. Folding it in would force every sequence fetch through the heavy entry shape.
2. **`text_search` shortcut + full `query` escape hatch** (the convenience-shortcut pattern). The Lucene query is the power surface; `text_search` covers the 80% case. Handler validates exactly one of the two is provided (a typed `missing_query` contract error). Common fields documented in the `query` `.describe()`; pointer to UniProt query syntax for advanced use.
3. **`reviewed` is a first-class, prominent param, defaulting to favor Swiss-Prot.** The dominant failure mode is an agent drowning in TrEMBL predictions (live-confirmed: a single gene maps to dozens of TrEMBL accessions). Surfacing `reviewed` + `annotationScore` + `proteinExistence` on every row lets the agent weigh manual vs. predicted annotation (the provenance requirement).
4. **`get_entry` uses outline-on-overflow, not truncation** (`outlineOnOverflow()` → `full | outline` discriminated union). A full multi-section record can exceed context; the agent gets a section outline and re-calls with `sections: [...]`. This is the *one-fat-document* overflow shape — distinct from the *many-rows* shape (search hits, proteome proteins), which is handled by cursor pagination + truncation disclosure. `format()`-parity is enforced per union branch.
5. **No DataCanvas / local SQL layer — search + proteome overflow stays cursor-paginated, entries outline.** An earlier draft spilled faceted search and large proteome protein lists to a DuckDB DataCanvas (with paired `uniprot_dataframe_query` + `uniprot_dataframe_describe` consumers). Cut against the `api-canvas` earns-its-keep gate. `uniprot_search_proteins` is a **discovery/search surface** — find proteins, then drill into `uniprot_get_entry` — which the skill explicitly disqualifies *regardless of row count* (a 5,000-row search result is still discovery, not a `SELECT … GROUP BY` analytical surface). `uniprot_get_proteome` is borderline-discovery: the protein set is commonly used for the count + completeness summary (carried inline as metadata), not group-by analytics. Neither is an analytical surface an agent would write SQL over, and UniProt's own upstream query power makes a local SQL layer redundant — Lucene field queries (`gene`, `organism_id`, `go`, `keyword`, `reviewed`, `length`, …), server-side facet counts, `fields` projection, and cursor pagination already express the filter/breakdown/slice operations a canvas would. So both tools return cursor-paginated hits (with optional upstream facets for search) and a capped protein list (proteome), and the surface keeps only outline-on-overflow for the one-fat-document case (`get_entry`). Re-adding canvas requires re-clearing the gate: a genuinely analytical, SQL-shaped surface that UniProt's upstream query API can't already serve.
6. **`map_ids` polls within a budget and returns a resumable ticket on overflow**, rather than blocking indefinitely or failing. The ID-mapping job is server-side and durable, so the `jobId` *is* the resume ticket — no local state needed. `from_db`/`to_db` are Zod enums (not free strings) so invalid database-pair values fail at validation before any async job is submitted.
7. **No auth, no API key, no scopes.** UniProt REST is keyless public data; adding auth config would be ceremony for an impossible requirement. Read-only over stdio/HTTP.
8. **Two by-ID resources + one dossier prompt.** Resources mirror the cheapest by-ID lookups (entry, taxon) for injectable-context clients; the prompt structures the function→protein→cross-server journey (the `ensembl_gene_dossier` precedent). All optional — the tool surface is self-sufficient for tool-only clients.
9. **Display identity is `uniprot-mcp-server` everywhere** — `createApp()` `name`/`title`, manifest, docs headers. Never a Title-Cased "UniProt MCP Server".

---

## Error Contract

Per-tool typed contracts (`errors: [{ reason, code, when, recovery }]`) for the domain failures an agent should plan around. Baseline codes (`ServiceUnavailable`, `Timeout`, `InternalError`) bubble freely and aren't declared.

| Tool | reason | code | when |
|---|---|---|---|
| `uniprot_search_proteins` | `missing_query` | `ValidationError` | Neither `text_search` nor `query` provided. Recovery: provide one. |
| `uniprot_search_proteins` | `conflicting_query` | `ValidationError` | Both `text_search` and `query` provided. Recovery: pass only one. |
| `uniprot_get_entry` | `all_not_found` | `NotFound` | Every accession in the batch is well-formed but unknown to UniProtKB (total failure). Partial failures (some found, some not) surface in `failed[]` in the success result, not as an error. Recovery: verify via `uniprot_search_proteins` or `uniprot_map_ids`. |
| `uniprot_map_ids` | `missing_inputs` | `ValidationError` | Neither a resume `ticket` nor the full `from_db`/`to_db`/`ids` triple was provided. Recovery: supply the triple to start a job, or a ticket alone to resume. |
| `uniprot_map_ids` | `unsupported_db_pair` | `ValidationError` | `from_db`/`to_db` combination isn't supported by the ID-mapping service (a 400 at submission). Recovery: check the enum; route through `UniProtKB` as an intermediate. |
| `uniprot_map_ids` | `invalid_ticket` | `NotFound` | The resume ticket is unknown or expired server-side (UniProt holds jobs only temporarily). Recovery: re-submit the original `from_db`/`to_db`/`ids`. |
| `uniprot_get_proteome` | `missing_identifier` | `ValidationError` | Neither `upid` nor `taxon_id` provided. Recovery: supply one; resolve a name first with `uniprot_get_taxonomy`. |
| `uniprot_get_proteome` | `conflicting_identifier` | `ValidationError` | Both `upid` and `taxon_id` provided. Recovery: pass only one. |
| `uniprot_get_proteome` | `not_found` | `NotFound` | UPID/taxon has no reference proteome. Recovery: confirm the organism has one, or look it up via `uniprot_get_taxonomy`. |
| `uniprot_get_taxonomy` | `missing_identifier` | `ValidationError` | Neither `taxon_id` nor `name` provided. Recovery: supply one. |
| `uniprot_get_taxonomy` | `conflicting_identifier` | `ValidationError` | Both `taxon_id` and `name` provided. Recovery: pass only one. |
| `uniprot_get_taxonomy` | `not_found` | `NotFound` | Taxon ID/name unresolved. Recovery: check spelling or NCBI taxon ID. |
| `uniprot_get_sequence` | `not_found` | `NotFound` | The accession has no sequence in UniProtKB. Recovery: verify via `uniprot_search_proteins` or `uniprot_map_ids`. |

The `uniprot://entry/{accession}` and `uniprot://taxonomy/{taxonId}` resources each carry their own `not_found` (`NotFound`) contract, mirroring the by-ID tool path.

Malformed accession / UPID / taxon ID are caught by Zod `.regex()` at the schema edge → `ValidationError` before any upstream call (not a contract reason). `map_ids`'s "running" status is a **success result variant** (`{status:'running', ticket}`), not a thrown error — the agent treats it as a poll-again signal; only an unknown/expired ticket throws (`invalid_ticket`). `get_entry` partial failures (some accessions not found) are also **success result variants** — they surface in `failed[]` alongside the `succeeded[]` entries, not as thrown errors; the `all_not_found` contract reason fires only when the entire batch resolves to nothing.

## Output Design Notes

- **Overflow, two shapes, two handlers:** one fat record (`get_entry`) → `outlineOnOverflow()`; any capped or paginated list (search hits, proteome proteins) → `ctx.enrich.truncated({ shown, cap })` disclosure + a forward `cursor` (never a silent cap). The `capped-list-no-truncation` lint rule enforces the second.
- **`format()` content-completeness:** every `output` field renders in `format()` markdown (enforced by `format-parity`). For `get_entry`'s discriminated union, both `full` and `outline` arms render (`formatOutline` for the outline arm).
- **Provenance is data, not decoration:** `annotationScore`, `proteinExistence`, and per-field evidence (PubMed/ECO) ship in both surfaces so the agent can weigh curation quality. Normalization preserves uncertainty — absent upstream fields stay absent, never fabricated.
- **Agent-facing context via `enrichment`:** `totalResults` (from `x-total-results`), the parsed query echo, the data source, and any "more results — paginate with cursor" / "outlined" notice go through `ctx.enrich(...)` so they reach both `structuredContent` and `content[]`.
- **Cursor pagination:** opaque cursor extracted from the upstream `Link: rel="next"` header (live-confirmed), surfaced as an optional `cursor` output + input. `x-total-results` becomes `totalResults`.

---

## Known Limitations

- **ID mapping is asynchronous and occasionally slow.** Small jobs finish in seconds (TP53 mapped in ~3s in testing), but large batches can exceed the inline budget → the agent must poll with the returned ticket. No way to make it synchronous; it's a server-side job by design.
- **Large gene→protein mappings are TrEMBL-heavy.** One gene can map to dozens of unreviewed accessions. The `reviewed` filter and the `UniProtKB-Swiss-Prot` (reviewed only) vs `UniProtKB` / `UniProtKB_AC-ID` `to_db` distinction mitigate, but the agent must still choose curation level.
- **Cursor-only deep pagination.** UniProtKB has no offset paging — only opaque `rel="next"` cursors. Random access to page N is impossible; the agent walks forward or narrows the query.
- **Taxonomy children aren't inline.** The taxon record carries `parent` + `lineage` but not children — `include_children` costs a second search call (`parent:{taxonId}`).
- **A single oversized section can still overflow.** `outlineOnOverflow` outlines *between* sections; one section that alone exceeds budget (a giant FUNCTION comment) returns whole. Sub-section outlining is out of scope.
- **No UniRef / UniParc / proteomics.** idea.md lists the UniRef collection but ships no tool in v1 (see Deferred).
- **Fair-use, not a hard SLA.** No published quota; heavy parallel use can draw 429s. Handled by retry/backoff, but a sustained burst can still degrade.

---

## v1 Scope vs. Deferred

**v1 (ships):**

- 6 tools (`uniprot_search_proteins`, `uniprot_get_entry`, `uniprot_map_ids`, `uniprot_get_proteome`, `uniprot_get_taxonomy`, `uniprot_get_sequence`).
- 2 by-ID resources (`uniprot://entry/{accession}`, `uniprot://taxonomy/{taxonId}`).
- 1 prompt (`uniprot_protein_dossier`).
- `UniProtService` over all four REST collections with retry/backoff, batch fetch, `fields`/`format`, cursor pagination, async ID-mapping loop.
- Overflow: outline-on-overflow (entry), cursor pagination + truncation disclosure (search hits, proteome proteins).
- Server `instructions` (CC BY attribution, reviewed-first hint, the cross-server map_ids note).

**Deferred (post-v1, if demand warrants):**

- **UniRef tools** — `/uniref/search`, `/uniref/{id}` (50/90/100% identity clusters). Listed as a collection in idea.md but no tool sketched; a distinct workflow (sequence-similarity grouping) better added once the core surface is proven.
- **UniParc** — archive/sequence-version history.
- **Feature-viewer / proteins-API coordinate mapping** — `protein`'s 3D-structure territory; cross-link rather than duplicate.
- **Bulk stream downloads** — UniProt's `/stream` endpoint for whole-query exports; cursor-paginated search covers the iterate-the-result-set need without a streaming download path.
- **Per-entry PDB/AlphaFold structure fetch** — intentionally *not* here; that's `protein-mcp-server`'s `protein_get_structure`. This server emits the accession + PDB xref and the agent hops servers (the earned-overlap boundary from idea.md).
