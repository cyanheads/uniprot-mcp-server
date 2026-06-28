# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-28

Fixes uniprot_get_proteome's truncation notice so paging guidance survives into content[] for text-only clients, rejects conflicting identifiers on uniprot_get_proteome and uniprot_get_taxonomy, and outlines annotation-heavy uniprot://entry records instead of injecting the full payload.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking

Breaking: uniprot_get_entry output is flattened — kind/succeeded[]/failed[]/sections[] now sit at the top level of structuredContent instead of under a result wrapper. Also fixes uniprot_get_sequence isoforms (wrong FASTA endpoint) and a uniprot_search_proteins crash on custom fields projections.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Initial release — 6 tools, 2 resources, and 1 prompt for protein-first research over UniProtKB: search, curated entries, cross-database ID mapping, reference proteomes, taxonomy, and sequences. Keyless, distributed as @cyanheads/uniprot-mcp-server.
