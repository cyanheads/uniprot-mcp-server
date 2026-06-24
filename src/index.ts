#!/usr/bin/env node
/**
 * @fileoverview uniprot-mcp-server MCP server entry point. Registers the protein-
 *   first UniProt research surface (6 tools, 2 resources, 1 prompt) and wires the
 *   UniProtService in setup().
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { proteinDossier } from './mcp-server/prompts/definitions/uniprot-protein-dossier.prompt.js';
import { entryResource } from './mcp-server/resources/definitions/uniprot-entry.resource.js';
import { taxonomyResource } from './mcp-server/resources/definitions/uniprot-taxonomy.resource.js';
import { getEntry } from './mcp-server/tools/definitions/uniprot-get-entry.tool.js';
import { getProteome } from './mcp-server/tools/definitions/uniprot-get-proteome.tool.js';
import { getSequence } from './mcp-server/tools/definitions/uniprot-get-sequence.tool.js';
import { getTaxonomy } from './mcp-server/tools/definitions/uniprot-get-taxonomy.tool.js';
import { mapIds } from './mcp-server/tools/definitions/uniprot-map-ids.tool.js';
import { searchProteins } from './mcp-server/tools/definitions/uniprot-search-proteins.tool.js';
import { initUniProtService } from './services/uniprot/uniprot-service.js';

await createApp({
  name: 'uniprot-mcp-server',
  title: 'uniprot-mcp-server',
  tools: [searchProteins, getEntry, mapIds, getProteome, getTaxonomy, getSequence],
  resources: [entryResource, taxonomyResource],
  prompts: [proteinDossier],
  instructions:
    'Protein-first research over UniProt (rest.uniprot.org), keyless. Start with uniprot_search_proteins (function/gene/organism queries) or arrive from a sibling identifier through uniprot_map_ids — the bridge that turns a gene, Ensembl, ChEMBL, RefSeq, or PDB id into a UniProtKB accession. Reviewed Swiss-Prot entries are manually curated; unreviewed TrEMBL are computationally predicted and ~30x more numerous, so favor reviewed:true unless you specifically want predictions. Chain accessions into uniprot_get_entry (full curated record; large records return an outline — re-call with sections) and uniprot_get_sequence (FASTA). Cross-references hop outward: PDB ids to protein-mcp-server for structure, ChEMBL ids to chembl for bioactivity, PubMed evidence to pubmed. Data is UniProt, CC BY 4.0 — attribute UniProt in downstream use.',
  setup(core) {
    initUniProtService(core.config, core.storage);
  },
});
