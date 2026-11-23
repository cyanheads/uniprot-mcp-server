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
  /**
   * No tool here holds per-session state or calls `ctx.requestInput`, so the
   * session store buys nothing. Declaring it here rather than leaving it to
   * `MCP_SESSION_MODE` means stdio, `bunx`, source, and the container all
   * resolve the same posture; the env var still wins when a deployment sets it.
   */
  sessionMode: 'stateless',
  tools: [searchProteins, getEntry, mapIds, getProteome, getTaxonomy, getSequence],
  resources: [entryResource, taxonomyResource],
  prompts: [proteinDossier],
  skills: 'skills',
  instructions:
    'Protein-first research over UniProt (rest.uniprot.org), keyless. Start with uniprot_search_proteins (function/gene/organism queries) or arrive from a sibling identifier through uniprot_map_ids — the bridge that turns a gene, Ensembl, ChEMBL, RefSeq, or PDB id into a UniProtKB accession. Reviewed Swiss-Prot entries are manually curated; unreviewed TrEMBL are computationally predicted and ~30x more numerous, so favor reviewed:true unless you specifically want predictions. Chain accessions into uniprot_get_entry for curated records and uniprot_get_sequence for FASTA. The default entry record carries function, catalytic activity, cofactors, biophysicochemical properties (enzyme kinetics, pH and temperature dependence, redox potential, absorption), active and binding sites, location and membrane topology, disease, PTMs and processing, variants, isoforms, domains, free-text comments, GO terms, keywords, and cross-references; the mutagenesis and interactions sections come back only when sections or fields name them. A name in fields that a tool cannot return is not requested and comes back in ignoredFields. uniprot_get_entry fetches up to 20 distinct accessions per call and returns any more in deferredAccessions, to pass as accessions on the next call. A record over 24,000 bytes on its own is listed in outlinedEntries instead of inlined: re-call it alone, e.g. accessions:["P04637"], for its section outline. A singleton section outline is retrieved with that one accession and sections:["function","disease"]; use section_limit/section_offset for one large list section. To see what is annotated at one residue, pass residue with one accession: each position-bearing section keeps only its rows covering that canonical position, and residueCoverage.excluded counts the rows with no canonical position, to read before concluding nothing is annotated there. Cross-references hop outward: PDB ids to protein-mcp-server for structure, ChEMBL ids to chembl for bioactivity, PubMed evidence to pubmed. Data is UniProt, CC BY 4.0 — attribute UniProt in downstream use.',
  setup(core) {
    initUniProtService(core.config, core.storage);
  },
});
