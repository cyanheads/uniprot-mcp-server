<div align="center">
  <h1>@cyanheads/uniprot-mcp-server</h1>
  <p><b>Search UniProtKB by protein function, fetch curated records, map IDs across databases, and pull reference proteomes, taxonomy, and sequences via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/uniprot-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/uniprot-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/uniprot-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/uniprot-mcp-server/releases/latest/download/uniprot-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=uniprot-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdW5pcHJvdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22uniprot-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Funiprot-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Six tools for protein-first research over UniProt — discovery search is the entry point, `uniprot_map_ids` is the bridge that turns any sibling identifier into a UniProtKB accession, and the rest fetch curated records, proteomes, taxonomy, and sequences:

| Tool | Description |
|:---|:---|
| `uniprot_search_proteins` | Search UniProtKB by plain text or a Lucene field query, with the reviewed (Swiss-Prot) filter foregrounded and optional server-side facet counts. Cursor-paginated. The discovery entry point. |
| `uniprot_get_entry` | Fetch full curated entries by accession in one batch (up to 20) — function, catalytic activity, disease, variants, isoforms, GO terms, cross-references. Partial-success output; an oversized record returns a section outline. |
| `uniprot_map_ids` | Translate identifiers across databases via UniProt's async ID-mapping service — gene names, Ensembl, RefSeq, ChEMBL, PDB, GeneID ↔ UniProtKB accessions. Polls within a budget; returns a resumable ticket on overflow. |
| `uniprot_get_proteome` | Fetch a reference proteome by UPID or NCBI taxon ID — protein count, BUSCO completeness, genome assembly inline, plus an opt-in capped page of the proteins. |
| `uniprot_get_taxonomy` | Resolve a taxonomy record by NCBI taxon ID or scientific name — name, rank, parent, full lineage, and optionally the immediate children. |
| `uniprot_get_sequence` | Fetch the canonical amino-acid sequence (FASTA) for an accession, with length and parsed header — and optionally the isoform sequences. The cheap sequence-only path. |

### `uniprot_search_proteins`

Search UniProtKB and return curated protein records — the discovery entry point.

- `text_search` for plain language (the 80% case) **or** `query` for full Lucene field syntax (`gene`, `organism_id`, `keyword`, `go`, `reviewed`, `protein_name`, `family`, `length`, `existence`, `accession`) — exactly one
- `reviewed` defaults to `true` (Swiss-Prot only) so the agent isn't drowned in TrEMBL predictions; set `false` to include them
- `organism_id` convenience filter ANDed onto the query
- Optional `facets` for server-side count breakdowns (e.g. `reviewed`, `model_organism`)
- Forward cursor pagination (UniProtKB has no offset paging); `totalResults` and the effective query echoed back
- Every hit carries `reviewed`, `annotationScore`, and `proteinExistence` so curation quality is weighable

---

### `uniprot_get_entry`

Fetch full curated UniProtKB entries by accession in batch — this tool does not search.

- Batch up to 20 accessions in one round trip
- Sectioned record: function, catalytic activity, cofactors, subcellular location, disease, PTMs, natural variants, isoforms, domains, GO terms, keywords, cross-references
- Partial-success output — resolved entries in `succeeded[]`, unknown/withdrawn ones in `failed[]`; the whole batch never aborts on one bad accession
- `fields` trims the upstream projection; identity and provenance fields are always retained
- A single oversized record returns `kind: "outline"` (a section listing) instead of overflowing context — re-call the same accession with `sections: [...]` to pull only what's needed
- Accessions come from `uniprot_search_proteins` or `uniprot_map_ids`; strip any `-N` isoform suffix first

---

### `uniprot_map_ids`

Translate identifiers across databases via UniProt's ID-mapping service — the bridge from any sibling server's identifier into a UniProtKB accession.

- `from_db` / `to_db` are validated enums (e.g. `Gene_Name`, `Ensembl`, `RefSeq_Protein`, `ChEMBL`, `PDB`, `GeneID`, `UniProtKB_AC-ID`) so an unsupported pair fails before the upstream call
- Target `UniProtKB-Swiss-Prot` for reviewed accessions only (the usual intent), or `UniProtKB` / `UniProtKB_AC-ID` to include unreviewed TrEMBL
- The job runs asynchronously; the tool submits it and polls within a budget. Finishes in time → `status: "finished"` with the mappings; runs long → `status: "running"` with a resumable ticket — re-call with the ticket alone (the job is held server-side)
- Pair a gene-symbol `from_db` with `tax_id` to disambiguate species
- Reports unmapped input IDs alongside the resolved mappings

---

### `uniprot_get_proteome`

Fetch the reference proteome for an organism by UPID or NCBI taxon ID — provide exactly one.

- Metadata inline: proteome type, total protein count, BUSCO completeness (score, complete/fragmented/missing counts, lineage dataset), genome assembly accession
- The protein set is opt-in via `include_proteins` (it is large — human is ~147,506) and returns a capped page with a forward cursor and truncation disclosure
- Narrow the protein list with the `query` filter (UniProtKB Lucene syntax) for a subset
- Resolve an organism name to a taxon ID first with `uniprot_get_taxonomy`

---

### `uniprot_get_taxonomy`

Resolve a taxonomy record by NCBI taxon ID or scientific name — provide exactly one.

- Returns scientific and common name, mnemonic, rank, parent, and the full lineage (root → near ancestor)
- `include_children` fetches the immediate child taxa via a follow-up search (not inline on the record)
- Turns an organism name into the taxon ID that `uniprot_search_proteins` (`organism_id`) and `uniprot_get_proteome` (`taxon_id`) expect

---

### `uniprot_get_sequence`

Fetch the canonical amino-acid sequence (FASTA) for an accession — the cheap, sequence-only path (for the full functional record use `uniprot_get_entry`).

- Returns the canonical sequence with its length and parsed FASTA header
- `include_isoforms` also returns the alternatively-spliced isoform sequences
- Accessions come from `uniprot_search_proteins` or `uniprot_map_ids`; strip any `-N` isoform suffix first

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `uniprot://entry/{accession}` | A curated UniProtKB entry by accession — the resource mirror of `uniprot_get_entry` for a single accession. |
| Resource | `uniprot://taxonomy/{taxonId}` | A taxonomy record by NCBI taxon ID — name, rank, parent, full lineage. The mirror of `uniprot_get_taxonomy` by ID. |
| Prompt | `uniprot_protein_dossier` | Guided protein-research workflow — resolve an identifier, fetch the curated entry, pull disease and variants, and surface cross-references for structure, citations, and bioactivity. |

All resource data is also reachable via tools — tool-only clients lose nothing. UniProtKB is far too large to enumerate, so there is no resource `list()`; discovery is `uniprot_search_proteins`'s job.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

UniProt-specific:

- Keyless — UniProt REST requires no API key; works against any `rest.uniprot.org`-compatible base (override `UNIPROT_BASE_URL` for a private mirror)
- One thin `fetch` client over all four REST collections (UniProtKB, ID Mapping, Proteomes, Taxonomy) with retry/backoff and HTML-error-page detection
- Batch entry fetch — N accessions in one round trip, cross-referenced against the request to flag any missing
- Async ID-mapping run → poll → results bounded by a wall-clock budget, with a resumable server-side ticket on overflow

Agent-friendly output:

- Provenance is data, not decoration — `reviewed`, `annotationScore`, `proteinExistence`, and per-field PubMed/ECO evidence ship on every record so the agent can weigh manual vs. predicted annotation
- Graceful partial failure — `uniprot_get_entry` returns per-accession `succeeded[]` / `failed[]` rows instead of aborting the batch
- Discriminated output contracts — `uniprot_get_entry` returns `kind: "full" | "outline"`, `uniprot_map_ids` returns `status: "finished" | "running"`; callers branch on data, not string parsing
- Sparsity preserved — absent upstream fields stay absent, never fabricated (most curated sections are legitimately missing on TrEMBL entries)

## Getting started

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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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
| `UNIPROT_ID_MAPPING_BUDGET_MS` | Wall-clock budget for the inline ID-mapping poll loop before returning a resumable ticket. Must be less than `UNIPROT_TIMEOUT_MS`. | `8000` |
| `UNIPROT_DEFAULT_PAGE_SIZE` | Default page size for search and proteome protein listing when the caller leaves it unset. | `25` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
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
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
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
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) (and the byte-identical [`AGENTS.md`](./AGENTS.md)) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap the UniProt API: validate raw → normalize to domain type → return the output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
