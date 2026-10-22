# uniprot-mcp-server — Design

The protein-as-primary-entity research workflow over [UniProt](https://rest.uniprot.org) — search UniProtKB by what proteins *do* (function, keyword, GO term, gene, organism, family), retrieve full curated (Swiss-Prot) records, map identifiers across 100+ databases, and pull reference proteomes, taxonomy, and sequences. Keyless, CC BY 4.0.

This doc formalizes `docs/idea.md` into a buildable spec. Tool names are taken verbatim from the idea; the surface is **6 tools, 2 resources, 1 prompt** (see [Design Decisions](#design-decisions) #5 for why a local SQL/DataCanvas layer was cut).

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `uniprot_search_proteins` | Search UniProtKB by free text (`text_search`) or structured Lucene `query`; optional upstream facet counts for breakdowns. Cursor-paginated. The discovery entry point. | `true` | `true` | `text_search` \| `query`, `reviewed`, `fields`, `facets`, `size`, `cursor` | `{ results[], inactive?[], totalResults, facets?, cursor? }` |
| `uniprot_get_entry` | Curated entries by accession (batch ≤ 20), with partial success and aggregate overflow handling. | `true` | `true` | `accessions[]`, `fields`, `sections`, `section_limit?`, `section_offset?` | `{ kind: 'full', succeeded[], failed[], window? } \| { kind: 'outline', sections?, outlinedEntries?, failed?, notice }` |
| `uniprot_map_ids` | Translate IDs across databases via the async ID-mapping service (run → poll within a bounded budget; one completed page per call). `from_db`/`to_db` values from the enum list in the Workflow Analysis section. | `true` | `true` | `from_db`, `to_db`, `ids[]`, `tax_id?` \| `ticket` \| `continuation` | `{ status: 'finished', results[{ from, to, inactive? }], continuation? } \| { status: 'running', ticket }` |
| `uniprot_get_proteome` | Reference proteome for an organism by UPID (`UP000005640`) or taxon ID (`9606`) — exactly one required. Metadata (protein count, BUSCO completeness, genome assembly) plus an optional cursor-paginated, capped protein list. | `true` | `true` | `upid` \| `taxon_id`, `include_proteins?`, `cursor?` | `{ proteome, proteins?, cursor? }` |
| `uniprot_get_taxonomy` | Taxonomy record by NCBI taxon ID (integer, e.g. `9606`) or scientific name (e.g. `"Homo sapiens"`): scientific/common name, rank, full lineage, and an optional cursor-paginated page of immediate children (100 per page) with the total. | `true` | `true` | `taxon_id` \| `name`, `include_children?`, `cursor?` | `{ taxon, lineage[], children?, totalChildren?, cursor? }` |
| `uniprot_get_sequence` | Canonical + isoform sequences (FASTA) for an accession, each with its FASTA header and length. A merged accession returns its target's sequences. | `true` | `true` | `accession`, `include_isoforms?` | `{ accession, mergedFrom?, canonical, isoforms?[] }` |

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
- Resolve canonical + isoform sequences as FASTA, each with its header and length.

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

Batch call (≤ 20 accessions). Full results return `succeeded[]` and `failed[]` in request order. An inactive accession (merged, demerged, deleted) is a `failed[]` row whose `error` names where to go instead. Initial results exceeding 24,000 UTF-8 bytes, measured over the complete serialized `{structuredContent, content}` envelope, return `kind: 'outline'`. A lone resolved record returns the existing `sections:[{name,bytes}]`; a batch or partial success returns `outlinedEntries:[{accession,bytes}]` and all failures, omitting inline successes. Each omitted accession can be re-called individually. Entry and section sizes count UTF-8 serialized bytes; they are navigation hints, while the inline decision includes response structure and complete rendering on both surfaces. Explicit section re-calls bypass overflow and return the selected values in full.

**`fields` vs `sections`** — two orthogonal projection parameters:
- `fields` is the upstream UniProt REST `fields` param (e.g. `accession,gene_names,cc_function,ft_variant`) — controls what raw data is fetched from the API. Accepts individual UniProtKB field names; reduces network payload.
- `sections` selects server-side section keys (e.g. `["disease","variants"]`) from one re-fetched entry. It requires one accession; multiple accessions fail `sections_single_accession` before requests, and batches can be trimmed with `fields`. Keys resolve case-insensitively (`Function` → `function`); `absentSections` and `window.section` use canonical spelling. Unknown keys fail `unknown_section` with valid keys listed. A known section absent from the record or excluded by `fields` is listed in `absentSections`; other requested sections still return.

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
  children?: { taxonId: number; scientificName: string; rank: string }[]; // one page of 100, via search, not inline
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
| `UniProtService` (`src/services/uniprot/uniprot-service.ts`) | The `rest.uniprot.org` REST client. Wraps all four collections; owns base-URL config, retry/backoff, `fields`/`format` handling, cursor pagination (parse `Link: rel="next"` + `x-total-results`), and the async ID-mapping run→poll→results loop. | `search(query, opts, ctx)`, `getEntries(accessions, fields, ctx)`, `mapIds(from, to, ids, taxId, ctx)`, `resumeMapping(ticket, ctx)`, `resumeMappingPage(continuation, ctx)`, `getProteome(idOrTaxon, ctx)`, `getProteomeProteins(upid, opts, ctx)`, `getTaxonById(taxonId, ctx)`, `getTaxonByName(name, ctx)`, `getChildren(taxonId, opts, ctx)`, `getFasta(accession, includeIsoforms, ctx)` |

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
3. **`uniprot_get_entry`** — batch fetch, section normalization, aggregate inline-byte measurement, singleton section or batch accession outlines, and explicit section re-calls/windows.
4. **`uniprot_map_ids`** — async run→poll→results bounded by `UNIPROT_ID_MAPPING_BUDGET_MS`; `from_db`/`to_db` enums; resumable ticket on overflow.
5. **`uniprot_get_proteome`** — by UPID or taxon ID; BUSCO/assembly metadata inline; optional cursor-paginated, capped protein list.
6. **`uniprot_get_taxonomy`** — by taxon ID or name; lineage inline; children via follow-up search, cursor-paginated.
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

Live-verified gotcha that drives the design: `Gene_Name → UniProtKB` for `TP53`+human returns **one canonical Swiss-Prot accession plus dozens of TrEMBL isoform accessions** (`P04637, A0A087WT22, …`). So `to_db` exposes both `UniProtKB-Swiss-Prot` (reviewed accessions only — the usual intent) and `UniProtKB` (which includes TrEMBL), and the description steers agents to the reviewed target unless they want TrEMBL.

**`from_db`/`to_db` enum values** — taken verbatim from the live `/configure/idmapping/fields` endpoint (most-used subset; full list at [UniProt ID mapping docs](https://www.uniprot.org/help/id_mapping)). The exact strings live in `ID_MAPPING_FROM_DBS` / `ID_MAPPING_TO_DBS` in `src/services/uniprot/types.ts`:

| Value | Direction | Notes |
|---|---|---|
| `UniProtKB_AC-ID` | from only | Accession or entry name (Swiss-Prot + TrEMBL); UniProt rejects it as a target for every source |
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
| b | `GET /idmapping/status/{jobId}` → `{ jobStatus }` or `303`; poll until `FINISHED` without following the finished redirect | until `UNIPROT_ID_MAPPING_BUDGET_MS` |
| c | `GET /idmapping/results/{jobId}` → one page of `{ results:[{from,to}], failedIds? }`; return a completed-page continuation for `rel="next"` | on `FINISHED` |
| c′ | `GET /idmapping/uniprotkb/results/{jobId}` (same cursor, `fields=accession`) → the page's target stubs; rows whose target is inactive get an `inactive` marker | only when the page reports `obsoleteCount` > 0 |
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
3. **`reviewed` is a first-class, prominent param, defaulting to favor Swiss-Prot.** The dominant failure mode is an agent drowning in TrEMBL predictions (live-confirmed: a single gene maps to dozens of TrEMBL accessions). Surfacing `reviewed` + `annotationScore` + `proteinExistence` on every row lets the agent weigh manual vs. predicted annotation (the provenance requirement). `reviewed: false` appends no tier clause, so both tiers come back (a `reviewed:false` clause in UniProtKB means TrEMBL only, which would drop the curated entry); a caller wanting TrEMBL only pins it in `query`. Whenever `organism_id` or `reviewed:true` is appended, the caller's clause is parenthesized first: UniProtKB binds `AND` tighter than `OR`, so an unwrapped top-level `OR` took the filters on its last branch only. Wrapping is unconditional rather than detecting a top-level `OR`, because detection would need a query parser. It is neutral on every measured form but one: a backslash-escaped parenthesis in a text field (`protein_name:p53\)` returns 163 reviewed entries unwrapped and 0 wrapped). The wrapper makes parenthesis balance the tool's concern: a stray `)` in the clause closes it early and UniProt accepts the result (a 200 with the filter on one branch), so an unbalanced clause is rejected as `invalid_query` before the request, its position counted in code points. The check counts parentheses outside quoted phrases and escapes only; quote balance stays with UniProt, whose 400 on an unclosed quote still arrives through the wrapper. A clause ending in an unescaped `\` would escape the wrapper's `)` (`(gene:TP53\) AND reviewed:true` is a 400), so `groupClause` sets a space before the `)`: the backslash then escapes that space, which UniProt reads as nothing, and `(gene:TP53\ ) AND reviewed:true` returns the same 34 entries the unwrapped form did. The proteome `query` filter is grouped the same way.
4. **`get_entry` measures the aggregate inline result before outlining.** Several individually small records can exceed the same budget as one large record, and text-only clients need every value. Measure both complete surfaces in UTF-8; return a section outline for a singleton or an accession outline plus failures for a batch. Explicit section selection remains caller-controlled, with offset windows for one list section. Search and proteome result sets use upstream cursor pagination.
5. **No DataCanvas / local SQL layer — search + proteome overflow stays cursor-paginated, entries outline.** UniProt's Lucene queries, server-side facets, field projection, and cursor pagination cover discovery and protein-list retrieval without local SQL. Search and proteome calls return upstream pages; `get_entry` handles aggregate overflow with accession outlines for batches and section outlines for singletons. A local SQL layer would require an analytical workflow that UniProt's upstream query API cannot serve.
6. **`map_ids` separates running-job and completed-page resumption.** Polling stays within a budget and returns a `ticket` while the job is running. Once finished, each call retrieves one upstream results page and returns a distinct `continuation` when another page exists; the service preserves UniProt's `failedIds` instead of inferring failures from normalized result rows. `from_db`/`to_db` are Zod enums (not free strings) so invalid database values fail at validation before any async job is submitted.
7. **No auth, no API key, no scopes.** UniProt REST is keyless public data; adding auth config would be ceremony for an impossible requirement. Read-only over stdio/HTTP.
8. **Two by-ID resources + one dossier prompt.** Resources mirror the cheapest by-ID lookups (entry, taxon) for injectable-context clients; the prompt structures the function→protein→cross-server journey (the `ensembl_gene_dossier` precedent). All optional — the tool surface is self-sufficient for tool-only clients.
9. **Display identity is `uniprot-mcp-server` everywhere** — `createApp()` `name`/`title`, manifest, docs headers. Never a Title-Cased "UniProt MCP Server".
10. **Inactive accessions are reported, never normalized into records.** UniProt answers a merged, demerged, or deleted accession with a stub (`entryType: "Inactive"` + `inactiveReason`) carrying no organism, sequence, or annotation; normalizing it fabricated `taxonId: 0`, `"unknown"`, and `length: 0`. One parse (`parseInactive` in the service) and one wording (`describeInactive` in `types.ts`) serve every surface. `get_entry` reports, never follows: the batch stays keyed by the requested accessions, an inactive one lands in `failed[]` naming its merge target, demerge products, or UniParc ID, and only `MERGED` has a single target anyway. `get_sequence` is a single-accession read, so it follows a merge: the per-accession FASTA endpoint already 303s to the target on the same request, so the result is labelled with the target and `mergedFrom` names the requested accession at no extra request. Only an empty FASTA body (demerged, deleted, or a merge on the isoform search path) pays one stub lookup, best-effort — a failed lookup leaves a disclosed plain `not_found`, while a caller cancellation still propagates. `search_proteins` moves matched stubs into an optional `inactive[]` (emitted only when non-empty, so an all-active page is unchanged); UniProt's `reviewed:` filter never matches a stub, so they arrive only with no tier filter. `map_ids` keeps a row whose target is inactive — the mapping is real — and marks it with the reason and pointer. The `/idmapping/results` page it reads names target accessions only; UniProt flags a job holding any inactive UniProtKB target with a job-wide `obsoleteCount`, and only `/idmapping/uniprotkb/results` carries the stubs, so such a job pays one re-read of each page there (same cursor, `fields=accession`), matched to rows by source ID and target, while a job with none pays nothing extra. A failed re-read, or one whose page lacks a row of the generic page, leaves the rows unmarked and says so in a notice.

---

## Error Contract

Per-tool typed contracts (`errors: [{ reason, code, when, recovery }]`) for the domain failures an agent should plan around. Baseline codes (`ServiceUnavailable`, `Timeout`, `InternalError`) bubble freely and aren't declared.

| Tool | reason | code | when |
|---|---|---|---|
| `uniprot_search_proteins` | `missing_query` | `ValidationError` | Neither `text_search` nor `query` provided. Recovery: provide one. |
| `uniprot_search_proteins` | `conflicting_query` | `ValidationError` | Both `text_search` and `query` provided. Recovery: pass only one. |
| `uniprot_search_proteins` | `invalid_query` | `InvalidParams` | The `query` or `text_search` has unbalanced parentheses — checked before any request, since the clause is wrapped in a group of the tool's own and a stray `)` would close it early (parentheses inside quoted phrases or backslash-escaped don't count; an unclosed quote is left to UniProt) — or UniProtKB answered 400 to the `query`, `text_search`, `fields`, or `facets` value, and the message relays UniProt's own text naming the rejected value. Recovery: fix the field name, facet, or syntax it names. |
| `uniprot_search_proteins` | `invalid_cursor` | `InvalidParams` | Malformed, legacy, cross-tool, or cross-query tokens fail before requests. An upstream cursor rejection (HTTP 500) retains its existing classification; 502/503/429 and timeouts remain upstream errors. Recovery: re-call with the same query and filters but no cursor. |
| `uniprot_get_entry` | `all_not_found` | `NotFound` | No accession in the batch resolved to an active entry — each was unknown or inactive (total failure); the message carries each inactive accession's reason and pointer. Partial failures (some found, some not) surface in `failed[]` in the success result, not as an error. Recovery: retry with a replacement the message names, or verify via `uniprot_search_proteins` or `uniprot_map_ids`. |
| `uniprot_get_entry` | `invalid_fields` | `InvalidParams` | UniProtKB answered 400 to the `fields` value; the message relays UniProt's text naming the rejected field. Recovery: correct or remove it, or omit `fields`. |
| `uniprot_get_entry` | `sections_single_accession` | `ValidationError` | `sections` was passed with more than one accession; rejected before any upstream request. Recovery: trim a batch with `fields`, or re-call one accession at a time with `sections`. |
| `uniprot_get_entry` | `unknown_section` | `InvalidParams` | `sections` named a key the tool never emits; rejected before any upstream request, the message listing every valid key (`data.unmatched`, `data.available`). A valid key the record lacks is not this error — it lands in `absentSections`. Recovery: pass keys from the outline response or the listed valid keys. |
| `uniprot_get_entry` | `invalid_section_window` | `ValidationError` | `section_limit` or `section_offset` was set without `sections` naming exactly one list section — none, several, or a non-list section (`organism`, `xrefs`, a scalar identity key); rejected before any upstream request, the message listing the list sections. Recovery: re-call with one list section (e.g. `["variants"]`), or drop the window inputs. |
| `uniprot_map_ids` | `missing_inputs` | `ValidationError` | Neither a resume `ticket` nor the full `from_db`/`to_db`/`ids` triple was provided. Recovery: supply the triple to start a job, or a ticket alone to resume. |
| `uniprot_map_ids` | `conflicting_inputs` | `ValidationError` | Submission inputs, a running-job ticket, or a completed-page continuation were combined. Recovery: provide exactly one mode. |
| `uniprot_map_ids` | `unsupported_db_pair` | `ValidationError` | `from_db`/`to_db` combination isn't supported by the ID-mapping service (a 400 at submission). Recovery: check the enum; route through `UniProtKB` as an intermediate. |
| `uniprot_map_ids` | `invalid_ticket` | `NotFound` | The resume ticket is not a UniProt job ID (letters, digits, `-`, `_`; checked before any request), or is unknown or expired server-side (UniProt holds jobs only temporarily). Recovery: re-submit the original `from_db`/`to_db`/`ids`. |
| `uniprot_map_ids` | `invalid_continuation` | `NotFound` | The completed-page continuation's `jobId` is invalid (checked before requests), the page is unknown or expired, or its request returned HTTP 400. The 400 receives a fixed safe message; generic 500/502/503/429, timeouts, network failures, and cancellation keep their upstream classification. Recovery: restart the mapping job and consume returned continuations before they expire. |
| `uniprot_get_proteome` | `missing_identifier` | `ValidationError` | Neither `upid` nor `taxon_id` provided. Recovery: supply one; resolve a name first with `uniprot_get_taxonomy`. |
| `uniprot_get_proteome` | `conflicting_identifier` | `ValidationError` | Both `upid` and `taxon_id` provided. Recovery: pass only one. |
| `uniprot_get_proteome` | `not_found` | `NotFound` | UPID/taxon has no reference proteome. Recovery: confirm the organism has one, or look it up via `uniprot_get_taxonomy`. |
| `uniprot_get_proteome` | `invalid_query` | `InvalidParams` | The `query` filter has unbalanced parentheses (checked before any request, by the same rule as `uniprot_search_proteins` — the filter is sent as `proteome:<upid> AND (<query>)`), or UniProtKB answered 400 to it and the message relays UniProt's text. Recovery: fix the field or syntax it names, or omit `query`. |
| `uniprot_get_proteome` | `invalid_cursor` | `InvalidParams` | Malformed, legacy, cross-tool, cross-UPID, or cross-query tokens fail before the protein request; UPID resolution may precede validation. Upstream cursor rejections retain the search service's classification. Recovery: re-call with the same proteome, query, and `include_proteins` but no cursor. |
| `uniprot_get_taxonomy` | `missing_identifier` | `ValidationError` | Neither `taxon_id` nor `name` provided. Recovery: supply one. |
| `uniprot_get_taxonomy` | `conflicting_identifier` | `ValidationError` | Both `taxon_id` and `name` provided. Recovery: pass only one. |
| `uniprot_get_taxonomy` | `not_found` | `NotFound` | Taxon ID/name unresolved. Recovery: check spelling or NCBI taxon ID. |
| `uniprot_get_taxonomy` | `invalid_cursor` | `InvalidParams` | The children `cursor` was issued for another taxon or is malformed (checked before the children request: the emitted cursor is `<taxonId>.<UniProt cursor>`, split at the first `.`, because UniProt answers another taxon's cursor with a page from the middle of this one's list), or UniProt answered HTTP 500 to it. Recovery: re-call with the same taxon and `include_children` but no cursor. |
| `uniprot_get_sequence` | `not_found` | `NotFound` | The accession has no sequence in UniProtKB — unknown, demerged, or deleted; an inactive accession's message names its replacements or UniParc ID. A merged accession is not a failure: its target's sequences return with `mergedFrom`. Recovery: retry with a replacement the message names, or verify via `uniprot_search_proteins` or `uniprot_map_ids`. |

The `uniprot://entry/{accession}` and `uniprot://taxonomy/{taxonId}` resources each carry their own `not_found` (`NotFound`) contract, mirroring the by-ID tool path; an inactive accession's `not_found` on the entry resource carries the same text `uniprot_get_entry` puts in `failed[]`. The taxonomy resource's `taxonId` pattern bounds its digits but not its magnitude. An id past 2^53 cannot be held exactly as a number (it would print as `1e+26` or round onto another taxon), so the resource answers it `not_found`, naming the id as written, without a request. UniProt itself reads ids up to the 64-bit range and answers one past that with a 400 rather than a 404; `getTaxonById` treats both as no record for that id. The tool's integer schema stops at 2^53.

Upstream errors pass through one choke point, `sanitizeUpstreamError()` in `UniProtService`, so the framework's HTTP error `data` (status text, raw body, request URL) never reaches a client. A 400 is UniProt rejecting a caller-supplied value: the service re-throws it as `InvalidParams` with the message `UniProt rejected the request: <messages[] joined by "; ">` (at most 5 messages, each cut to 300 characters and at the framework's head+tail capture splice, a message the splice leaves empty dropped; a non-JSON body, or one with no message left, gets the fixed `UniProt rejected the request as invalid.`) and no `data`. The service attaches no `reason`; each tool translates `InvalidParams` from the call carrying its caller text into its own contract reason, as it does `NotFound`. UniProt answers a cursor it cannot continue from with a 500, so a 500 to a request that carried a cursor (and was not cancelled) is re-thrown as `InvalidParams` with `data.reason: 'invalid_cursor'`; the search, proteome, and taxonomy tools check that (`isCursorRejection`) before mapping the remaining `InvalidParams` to their query reason. Every other status (429, 5xx), timeouts, and network failures keep a generic `<operation> failed upstream (<code>).` message, since restarting from the first page would not fix an outage. The framework's retry still runs first, so a refused cursor costs its retries (about 7 s) before it is reported.

Malformed accession / UPID / taxon ID are caught by Zod `.regex()` at the schema edge before any upstream call (not a contract reason): tools reject them as `InvalidParams` (`-32602`, reason `invalid_arguments`), resources as `ValidationError` (`-32007`). Each pattern carries a custom message naming the format, an example, and where to get a valid ID (the accession one is `ACCESSION_MESSAGE`, beside `ACCESSION_REGEX` in `types.ts`); the advertised JSON Schema still carries `pattern` only. `map_ids`'s "running" status is a **success result variant** (`{status:'running', ticket}`), not a thrown error — the agent treats it as a poll-again signal; only a malformed, unknown, or expired ticket throws (`invalid_ticket`). `get_entry` partial failures (some accessions not found) are also **success result variants** — they surface in `failed[]` alongside the `succeeded[]` entries, not as thrown errors; the `all_not_found` contract reason fires only when the entire batch resolves to nothing.

## Output Design Notes

- **Overflow:** initial entry calls measure the complete inline result against 24,000 UTF-8 bytes. Singletons outline sections; batches outline accessions and retain failures. A selected list section pages with caller-chosen `section_limit` 1–500 and `section_offset`, reporting `totalCount`, `nextOffset`, and truncation guidance. Other result lists use upstream cursor pagination.
- **`format()` completeness:** every returned entry list item, cross-reference database and ID, and taxonomy alternative name reaches the text surface in order. Renderer-only clipping is absent. Explicit windows control the returned data itself; both surfaces carry that same selection.
- **Provenance is data, not decoration:** `annotationScore`, `proteinExistence`, and per-field evidence (PubMed/ECO) ship in both surfaces so the agent can weigh curation quality. Normalization preserves uncertainty — absent upstream fields stay absent, never fabricated.
- **Agent-facing context via `enrichment`:** `totalResults` (from `x-total-results`), the parsed query echo, the data source, and any "more results — paginate with cursor" / "outlined" notice go through `ctx.enrich(...)` so they reach both `structuredContent` and `content[]`.
- **Cursor pagination:** search and proteome wrap the upstream cursor in a versioned opaque token bound by SHA-256 to tool identity and the exact assembled query. Search includes organism/reviewed filters; proteome includes the resolved UPID and optional query, permitting identifier aliases that resolve identically. Projection, facets, and page size do not change membership and may vary. Changed queries/tools, malformed tokens, and legacy raw cursors reject before paging with `invalid_cursor` and restart guidance; no logical Lucene canonicalization is attempted. Taxonomy keeps its taxon-ID prefix, and mapping keeps its completed-job `continuation` distinct from a running-job `ticket`.

---

## Known Limitations

- **ID mapping is asynchronous and occasionally slow.** Small jobs finish in seconds (TP53 mapped in ~3s in testing), but large batches can exceed the inline budget → poll with the returned ticket. Completed results are also paginated at 500 rows per call → follow each returned continuation to the terminal page.
- **Large gene→protein mappings are TrEMBL-heavy.** One gene can map to dozens of unreviewed accessions. The `reviewed` filter and the `UniProtKB-Swiss-Prot` (reviewed only) vs `UniProtKB` `to_db` distinction mitigate, but the agent must still choose curation level.
- **Cursor-only deep pagination.** UniProtKB has no offset paging — only opaque `rel="next"` cursors. Random access to page N is impossible; the agent walks forward or narrows the query.
- **Taxonomy children aren't inline.** The taxon record carries `parent` + `lineage` but not children — `include_children` costs a second search call (`parent:{taxonId}`), one page of 100 per call. Large genera run to many pages (*Streptomyces*, 1883, has over 1,100 children), so the total comes back on every page and the rest are walked with `cursor`.
- **Explicit section calls may exceed the inline budget.** List sections can be windowed with `section_limit`/`section_offset`; non-list sections such as `xrefs` return whole, including every ID on both surfaces. The selected section and window are the caller's chosen size and never outline again.
- **No UniRef / UniParc / proteomics.** idea.md lists the UniRef collection but ships no tool in v1 (see Deferred).
- **Fair-use, not a hard SLA.** No published quota; heavy parallel use can draw 429s. Handled by retry/backoff, but a sustained burst can still degrade.

---

## v1 Scope vs. Deferred

**v1 (ships):**

- 6 tools (`uniprot_search_proteins`, `uniprot_get_entry`, `uniprot_map_ids`, `uniprot_get_proteome`, `uniprot_get_taxonomy`, `uniprot_get_sequence`).
- 2 by-ID resources (`uniprot://entry/{accession}`, `uniprot://taxonomy/{taxonId}`).
- 1 prompt (`uniprot_protein_dossier`).
- `UniProtService` over all four REST collections with retry/backoff, batch fetch, `fields`/`format`, cursor pagination, async ID-mapping loop.
- Overflow: outline-on-overflow plus offset windows inside one list section (entry), cursor pagination + truncation disclosure (search hits, proteome proteins).
- Server `instructions` (CC BY attribution, reviewed-first hint, the cross-server map_ids note).

**Deferred (post-v1, if demand warrants):**

- **UniRef tools** — `/uniref/search`, `/uniref/{id}` (50/90/100% identity clusters). Listed as a collection in idea.md but no tool sketched; a distinct workflow (sequence-similarity grouping) better added once the core surface is proven.
- **UniParc** — archive/sequence-version history.
- **Feature-viewer / proteins-API coordinate mapping** — `protein`'s 3D-structure territory; cross-link rather than duplicate.
- **Bulk stream downloads** — UniProt's `/stream` endpoint for whole-query exports; cursor-paginated search covers the iterate-the-result-set need without a streaming download path.
- **Per-entry PDB/AlphaFold structure fetch** — intentionally *not* here; that's `protein-mcp-server`'s `protein_get_structure`. This server emits the accession + PDB xref and the agent hops servers (the earned-overlap boundary from idea.md).
