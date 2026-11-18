<div align="center">
  <h1>@cyanheads/uniprot-mcp-server</h1>
  <p><b>Search UniProtKB by protein function, fetch curated records, map IDs across databases, and pull reference proteomes, taxonomy, and sequences via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 2 Data Resources • 1 Prompt • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/uniprot-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/uniprot-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/uniprot-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/uniprot-mcp-server/releases/latest/download/uniprot-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=uniprot-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW5pcHJvdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22uniprot-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Funiprot-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://uniprot.caseyjhand.com/mcp](https://uniprot.caseyjhand.com/mcp)

</div>

---

## Overview

Protein research over UniProtKB. Search by function or gene, fetch curated records, map identifiers from Ensembl, ChEMBL, RefSeq, PDB, and more, and pull reference proteomes, taxonomy, and sequences.

### Tools

| Tool | Description |
|:---|:---|
| `uniprot_search_proteins` | Search UniProtKB by plain text or a Lucene field query, with the reviewed (Swiss-Prot) filter foregrounded and optional server-side facet counts. Cursor-paginated. The discovery entry point. |
| `uniprot_get_entry` | Fetch full curated entries by accession in one batch (up to 20 distinct per call, the rest deferred) — names, function, catalytic activity, sites, topology, disease, PTMs and processing, variants, isoforms, comments, GO terms, cross-references. Partial-success output; each record too large to inline is listed in `outlinedEntries` and returns a section outline when re-called alone. |
| `uniprot_map_ids` | Translate identifiers across databases via UniProt's async ID-mapping service — gene names, Ensembl, RefSeq, ChEMBL, PDB, GeneID ↔ UniProtKB accessions. Polls within a budget; running jobs return a ticket and completed pages return a continuation. |
| `uniprot_get_proteome` | Fetch a reference proteome by UPID or NCBI taxon ID — protein count, BUSCO completeness, genome assembly inline, plus an opt-in page of the proteins (up to 500). |
| `uniprot_get_taxonomy` | Resolve a taxonomy record by NCBI taxon ID or organism name — exact name matching, rank, parent, full lineage, and optionally the immediate children, cursor-paginated. |
| `uniprot_get_sequence` | Fetch the canonical amino-acid sequence (FASTA) for an accession, with length and parsed header — and optionally the isoform sequences. The cheap sequence-only path. |

### Resources

| Resource | Description |
|:---|:---|
| `uniprot://entry/{accession}` | A curated UniProtKB entry by accession — the resource mirror of `uniprot_get_entry` for a single accession. |
| `uniprot://taxonomy/{taxonId}` | A taxonomy record by NCBI taxon ID — name, rank, parent, full lineage. The mirror of `uniprot_get_taxonomy` by ID. |

All resource data is also reachable via tools — tool-only clients lose nothing. UniProtKB is far too large to enumerate, so there is no resource `list()`; discovery is `uniprot_search_proteins`'s job.

### Prompts

| Prompt | Description |
|:---|:---|
| `uniprot_protein_dossier` | Guided protein-research workflow — resolve an identifier, fetch the curated entry, pull disease and variants, and surface cross-references for structure, citations, and bioactivity. |

### Agent skill

The [UniProt guide](skills/uniprot-guide/SKILL.md) covers protein identity, species versus strain scope, mapping completeness, and evidence-backed interpretation. It ships with plugin, npm, MCPB, and Docker installations and is available over MCP at `skill://uniprot-guide/SKILL.md`.

## Capability reference

### `uniprot_search_proteins` <sub>tool</sub>

- `text_search` for plain language **or** `query` for Lucene field syntax (`gene`, `organism_id`, `taxonomy_id`, `keyword`, `go`, `reviewed`, `protein_name`, `family`, `length`, `existence`, `accession`) — exactly one. Plain-text punctuation and uppercase Boolean words are escaped. Structured queries reject unbalanced parentheses. Optional `facets` return count breakdowns (e.g. `reviewed`, `model_organism`)
- The `organism_id` input restricts the whole query to that taxon and its descendants. For exact-node scope, use `organism_id:<id>` inside `query` instead
- `reviewed` defaults to `true` (Swiss-Prot only); `false` searches both tiers (put `reviewed:false` in `query` for TrEMBL only). Every hit carries `reviewed`, `annotationScore`, and `proteinExistence`
- `size` is served up to 500, UniProt's page maximum: a larger value returns 500 rows with a notice (`UNIPROT_CLAMP_LIMITS=false` rejects it at the schema instead)
- Each hit's `functionSnippet` is whole sentences within 250 characters (at least the first; one over 400 is cut at a word and ends with `…`), evidence tags stripped; the full annotation is `uniprot_get_entry` `function`. `geneNames` carries every name of each gene, including ordered-locus (`b3296`) and ORF (`JW3258`) names
- `fields` trims each hit to the fields hits carry (the default set, plus `gene_primary`, `gene_synonym`, `gene_oln`, `gene_orf`); the identity fields always come back. Names are case-insensitive. A field a hit cannot carry (e.g. `ec`, `xref_pdb`) is not requested, is listed in `ignoredFields`, and is named in a notice pointing to `uniprot_get_entry`. Text that is not a field name fails `invalid_query` with UniProt's message
- Forward-only cursor pagination; returns `totalResults` and the effective query. Cursors bind to this tool and the exact assembled query, including organism/reviewed filters. Changing `size`, `fields`, or `facets` keeps continuation valid; a changed query, malformed token, or legacy raw cursor fails `invalid_cursor`: restart without it
- Inactive accessions (merged, demerged, or deleted) go in `inactive[]` with the reason and replacements, not in `results[]`

---

### `uniprot_get_entry` <sub>tool</sub>

- Accepts up to 500 accessions per call, from `uniprot_search_proteins` or `uniprot_map_ids` (strip any `-N` isoform suffix). Repeats collapse, the first 20 distinct are fetched, and the rest come back in `deferredAccessions` to pass as `accessions` on the next call (`UNIPROT_CLAMP_LIMITS=false` restores the strict 20-accession schema maximum)
- Sectioned record: names (`alternativeNames`, `ecNumbers`), function, catalytic activity, cofactors, `sites` (active, binding, and other sites, with ligand and ChEBI ids), subcellular location, `topology` (transmembrane, intramembrane, and topological domains), disease (with `note`), PTMs, `processing` (signal, transit, propeptide, chain, peptide, initiator Met), natural variants, isoforms, domains, `comments` (PTM, pathway, subunit, tissue specificity, and any free-text comment type named in `fields`), GO terms (with `evidenceType`), keywords, cross-references, and `ensemblGenes`. `organism.mnemonic` is populated from the entry name (e.g. `HUMAN`)
- `mutagenesis` and `interactions` (IntAct partners, with `partnerChain` and `chain`) are left out of the default record because they run to hundreds of rows on well-studied proteins; they come back only when `sections` names them (or `fields` includes `ft_mutagen` / `cc_interaction`)
- `fields` replaces the default projection with UniProtKB return-field names (case-insensitive; `keywordid` is sent as `keyword`, `rhea` as `cc_catalytic_activity`; any `xref_<database>` fills `xrefs`; GO terms are `goTerms`, from `go`). Identity and provenance fields are always kept. A field the tool cannot return (e.g. `sequence`, which is `uniprot_get_sequence`) is not requested, is listed in `ignoredFields`, and is named in a notice. A malformed `xref_` name or text that is not a field name fails `invalid_fields` with UniProt's message
- Resolved entries come back in `succeeded[]`, unknown or inactive ones in `failed[]`, so one bad accession doesn't abort the batch. An inactive accession's error names the merge target, the demerge products, or the UniParc ID
- Each record is measured on its own, as a one-accession call would measure it: one within 24,000 UTF-8 bytes across `content[]` and `structuredContent` inlines in `succeeded[]`, and a larger one is listed in `outlinedEntries` (with its `bytes`) in request order. A batch returns `kind: "full"`; `kind: "outline"` is only the section outline of a single accession. Re-call each outlined accession alone, then use `sections: [...]` for the parts you need. Explicit sections render every returned item, including all cross-reference IDs; every list section pages with `section_limit` and `section_offset` (`section_limit` has no maximum, `UNIPROT_CLAMP_LIMITS=false` caps it at 500), reporting `totalCount` and `nextOffset`

---

### `uniprot_map_ids` <sub>tool</sub>

- `from_db` / `to_db` are validated enums (e.g. `Gene_Name`, `Ensembl`, `RefSeq_Protein`, `ChEMBL`, `PDB`, `GeneID`, and `UniProtKB_AC-ID` as a source); an unknown database fails before any request. Target `UniProtKB-Swiss-Prot` for reviewed accessions only, or `UniProtKB` to include TrEMBL. Mapping `tax_id` restricts submission to an exact node, excluding descendants; use the intended strain's taxon ID when needed
- Submits the job and polls within a time budget. A job still running returns `status: "running"` with a ticket; pass that ticket alone to poll it. A finished call returns `status: "finished"` with one page, and `continuation` (pass it alone) fetches the next; no `continuation` means the last page
- `mappedCount` counts the current page; `totalMappings` is UniProt's job-wide total when available. `unmappedIds` is UniProt's job-wide failed-ID metadata, repeated on completed pages rather than inferred from the displayed rows
- UniProtKB targets include available entry name, reviewed status, organism, and primary gene. Inactive targets carry their reason and replacements. Metadata or enrichment outages fall back to generic identifier rows with a notice; jobs above UniProt's 100,000-mapping enrichment limit remain pageable
- Terminal job failures use `mapping_failed` with UniProt's safe error message and recovery guidance. Only an explicitly unsupported database combination at submission uses `unsupported_db_pair`
- A rejected completed-page continuation (HTTP 400), unknown page, or expired job fails `invalid_continuation` with restart guidance. Upstream outages retain their upstream error classification

---

### `uniprot_get_proteome` <sub>tool</sub>

- Provide exactly one of `upid` (e.g. `UP000005640`) or `taxon_id`; both or neither fails validation. Resolve an organism name to a taxon ID first with `uniprot_get_taxonomy`. Taxon lookup prefers an exact reference proteome, then a unique descendant reference. Multiple descendants return candidate UPIDs and organism identities for explicit selection, with a next-page link when suggestions are incomplete
- Returns proteome type, total protein count, BUSCO completeness (score, complete/fragmented/missing counts, lineage dataset), and genome assembly accession
- Proteins are opt-in via `include_proteins` (human has ~147,506) and come back as a page with a forward cursor; `size` above 500, UniProt's page maximum, returns 500 with a notice (`UNIPROT_CLAMP_LIMITS=false` rejects it at the schema). Each row's `functionSnippet` is whole sentences within 250 characters, evidence tags stripped. Narrow with `query` (UniProtKB Lucene syntax). Cursors bind to the resolved UPID, exact query, and tool; a taxon ID and UPID resolving to the same proteome may share a cursor, and `size` may change. Changed membership or a legacy raw cursor fails `invalid_cursor`: restart without it

---

### `uniprot_get_taxonomy` <sub>tool</sub>

- Provide exactly one of `taxon_id` (NCBI numeric ID) or `name` (organism name); both or neither fails validation. Gives the taxon ID that `uniprot_search_proteins` (`organism_id`) and `uniprot_get_proteome` (`taxon_id`) expect
- Name matching prefers exact case-insensitive scientific names, then common names, mnemonics, and aliases. Quote/backslash-tolerant matching follows exact matching. Ties or partial matches return candidate taxon IDs instead of selecting the first hit
- Name resolution shares a 45-second budget across candidate pages and the selected record lookup. If candidate scanning cannot finish, `incomplete_candidates` supplies partial suggestions and a candidate-search URL; use an explicit taxon ID or narrow the name
- Returns scientific and common name, mnemonic, rank, parent, and the full lineage (root → near ancestor)
- `include_children` adds the immediate child taxa, 100 per page with the total count and a `cursor` for the next page. A cursor sent with a different taxon fails `invalid_cursor`

---

### `uniprot_get_sequence` <sub>tool</sub>

- Returns the canonical sequence with its length and parsed FASTA header; `include_isoforms` adds the isoform sequences. Accessions come from `uniprot_search_proteins` or `uniprot_map_ids` (strip any `-N` isoform suffix)
- A merged accession returns its merge target's sequences, with the requested accession in `mergedFrom`; a demerged or deleted one fails `not_found` naming its replacements or UniParc ID

---

### `uniprot://entry/{accession}` <sub>resource</sub>

- Same record as `uniprot_get_entry` for a single accession, addressed by URI. An inactive accession (merged, demerged, or deleted) fails `not_found`
- The default record, without the on-request `mutagenesis` and `interactions` sections. A very large entry (P04637 is about 420 KB across both output surfaces) returns an identity summary (accession, entry name, protein name, genes, organism, length, reviewed status, annotation score, protein existence) plus a section outline; fetch specific sections with `uniprot_get_entry` (`sections: [...]`), since the URI takes no sections parameter

---

### `uniprot://taxonomy/{taxonId}` <sub>resource</sub>

- Addressed by NCBI taxon ID, e.g. `uniprot://taxonomy/9606` for human
- Returns scientific and common name, mnemonic, rank, parent, and full lineage — same shape as `uniprot_get_taxonomy` without `include_children`
- Tool-only clients reach the same data via `uniprot_get_taxonomy`

---

### `uniprot_protein_dossier` <sub>prompt</sub>

- Arguments: `identifier` required (gene name, accession, or protein name); `organism` optional to disambiguate
- Five-step workflow embedded in the generated message: resolve identifier → fetch entry → summarize function/localization/provenance → pull disease & variants → surface cross-references for structure (PDB), bioactivity (ChEMBL), and citations (PubMed)
- Returns a single user-role message carrying the full instructions — no separate assistant framing message

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

UniProt-specific:

- Keyless — UniProt REST requires no API key; works against any `rest.uniprot.org`-compatible base (override `UNIPROT_BASE_URL` for a private mirror)
- Batch entry fetch — up to 20 distinct accessions per round trip, any beyond that handed back to pass on the next call, and any missing ones flagged
- Async ID mapping with a bounded poll, a resumable ticket for running jobs, and paginated results

Agent-friendly output:

- Provenance is data, not decoration — `reviewed`, `annotationScore`, `proteinExistence`, and per-field PubMed/ECO evidence ship on every record so the agent can weigh manual vs. predicted annotation
- Graceful partial failure — `uniprot_get_entry` returns per-accession `succeeded[]` / `failed[]` rows instead of aborting the batch
- Explicit output shapes — `uniprot_get_entry` returns `kind: "full" | "outline"` (an outline only for one oversized accession; oversized batch members land in `outlinedEntries`), and `uniprot_map_ids` returns either a `ticket` or a `continuation`
- Sparsity preserved — absent upstream fields stay absent, never fabricated (most curated sections are legitimately missing on TrEMBL entries)

## Getting started

### Public Hosted Instance

A public instance is available at `https://uniprot.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "uniprot-mcp-server": {
      "type": "streamable-http",
      "url": "https://uniprot.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. UniProt REST is keyless — no API key required.

```json
{
  "mcpServers": {
    "uniprot-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/uniprot-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "uniprot-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/uniprot-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "uniprot-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/uniprot-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).
- No API key — UniProt REST is keyless and open. Data is [UniProt](https://www.uniprot.org), CC BY 4.0.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/uniprot-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd uniprot-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. UniProt REST is keyless, so every server-specific variable below is an optional override.

| Variable | Description | Default |
|:---|:---|:---|
| `UNIPROT_BASE_URL` | UniProt REST base URL. Override for a private mirror or testing. | `https://rest.uniprot.org` |
| `UNIPROT_TIMEOUT_MS` | Per-request HTTP timeout in ms. | `30000` |
| `UNIPROT_ID_MAPPING_BUDGET_MS` | Time budget for the ID-mapping poll before returning a ticket. Must be less than `UNIPROT_TIMEOUT_MS`. | `8000` |
| `UNIPROT_DEFAULT_PAGE_SIZE` | Default page size for search and proteome protein listing when the caller leaves it unset. | `25` |
| `UNIPROT_CLAMP_LIMITS` | Serve an over-the-cap `size` (search, proteome) at 500 with a notice, accept any `section_limit`, and accept up to 500 `accessions` on `uniprot_get_entry` (first 20 distinct fetched, the rest deferred). `false` restores the strict schema maximums (500, 500, 20) and rejects anything above them. | `true` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. The server is stateless by default. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck        # Lint, format, typecheck, security
  bun run test            # Vitest test suite
  bun run test:coverage   # Test suite with coverage, enforcing the framework thresholds
  bun run lint:mcp        # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t uniprot-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio ghcr.io/cyanheads/uniprot-mcp-server:latest
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/uniprot-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits the UniProt service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools over UniProtKB, ID mapping, proteomes, taxonomy, and sequences. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Entry and taxonomy by-ID mirrors. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). The protein-dossier workflow prompt. |
| `src/services/uniprot` | The `rest.uniprot.org` REST client — search, batch entries, ID mapping, proteomes, taxonomy, FASTA — plus normalized domain types. |
| `skills/` | Published UniProt guide and query reference for agents calling the tools. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) (and the byte-identical [`AGENTS.md`](./AGENTS.md)) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap the UniProt API: validate raw → normalize to domain type → return the output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
