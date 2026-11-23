# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-11-23

uniprot_get_entry keeps the isoform or chain, evidence, and uncertain positions UniProt attaches to annotations, adds a biophysicochemical section and a residue filter; proteomes report gene counts; uniprot_map_ids pages by size and polls tickets; searches by merged accession keep their stubs under the default filters.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-11-17

uniprot_get_entry measures each record against the 24,000-byte budget on its own and returns site, topology, processing, comment, mutagenesis, and interaction sections; over-the-cap size, section_limit, and accession counts are served up to the cap, and functionSnippet is bounded.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-11-03

Publishes the uniprot-guide skill over MCP, searches species through descendant strains, matches taxonomy names exactly, escapes plain-text search, and adds UniProtKB target identity, job totals, and failure reasons to uniprot_map_ids.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-10-22 · ⚠️ Breaking

Complete entry rendering and query-bound pagination cursors.

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-10-12

Fixes query grouping and reviewed:false in uniprot_search_proteins, reports merged and deleted accessions instead of hollow records, pages taxonomy children and long uniprot_get_entry sections, types UniProt query, field and cursor rejections, and adopts mcp-ts-core 0.13.15.

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-10-08

Adopts mcp-ts-core 0.13.14: error results carry a request ID, uniprot_get_entry rejects an unknown sections name instead of dropping it, numeric strings are accepted for numeric fields, and the Docker image installs dependencies on the build platform.

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-09-20 · ⚠️ Breaking

The server resolves stateless on every launch path, and an out-of-schema argument is now rejected as InvalidParams carrying a machine-readable reason and recovery hint instead of ValidationError with bare text.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-08-30

uniprot_map_ids preserves UniProt failed IDs, separates completed-page continuations from running-job tickets, and avoids transferring results during finished status probes.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-08-21

Eight typed contract errors move from InvalidParams (-32602) to ValidationError (-32007), and the framework bump to mcp-ts-core ^0.12.3 tightens the wire: tool inputs reject undeclared argument keys, the advertised outputSchema declares the error envelope, and schemas emit as JSON Schema 2020-12.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-28

Fixes uniprot_get_proteome's truncation notice so paging guidance survives into content[] for text-only clients, rejects conflicting identifiers on uniprot_get_proteome and uniprot_get_taxonomy, and outlines annotation-heavy uniprot://entry records instead of injecting the full payload.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking

Breaking: uniprot_get_entry output is flattened — kind/succeeded[]/failed[]/sections[] now sit at the top level of structuredContent instead of under a result wrapper. Also fixes uniprot_get_sequence isoforms (wrong FASTA endpoint) and a uniprot_search_proteins crash on custom fields projections.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Initial release — 6 tools, 2 resources, and 1 prompt for protein-first research over UniProtKB: search, curated entries, cross-database ID mapping, reference proteomes, taxonomy, and sequences. Keyless, distributed as @cyanheads/uniprot-mcp-server.
