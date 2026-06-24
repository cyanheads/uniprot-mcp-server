/**
 * @fileoverview uniprot_protein_dossier — a guided protein-research workflow:
 *   resolve an identifier → fetch the curated entry → pull disease and variants →
 *   surface cross-references for structure, citations, and bioactivity. Structures
 *   the most common multi-tool journey so the agent does not rediscover the chain.
 * @module mcp-server/prompts/definitions/uniprot-protein-dossier
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const proteinDossier = prompt('uniprot_protein_dossier', {
  description:
    'Guided protein-research workflow over UniProt — resolve an identifier to a UniProtKB accession, fetch the curated entry, pull disease and variant detail, and surface cross-references for structure, citations, and bioactivity.',
  title: 'uniprot-mcp-server: protein dossier',
  args: z.object({
    identifier: z
      .string()
      .describe(
        'A gene name (e.g. "TP53"), UniProtKB accession (e.g. "P04637"), or protein name to research.',
      ),
    organism: z
      .string()
      .optional()
      .describe(
        'Optional organism scientific name or NCBI taxon ID to disambiguate (e.g. "Homo sapiens" or "9606").',
      ),
  }),
  generate: (args) => {
    const organismClause = args.organism
      ? ` Restrict to organism "${args.organism}" (resolve a name to its taxon ID with uniprot_get_taxonomy if needed).`
      : '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Build a protein dossier for "${args.identifier}".${organismClause}

Follow this workflow with the uniprot-mcp-server tools:

1. Resolve the identifier to a UniProtKB accession. If it looks like a gene name, use uniprot_map_ids (from_db: Gene_Name, to_db: UniProtKB-Swiss-Prot${args.organism ? ', plus the tax_id' : ''}) to get the reviewed accession. If it is already an accession (matches the [OPQ]... pattern), skip this step. If it is a free-text protein name, use uniprot_search_proteins (text_search, reviewed: true) and take the top hit's accession.

2. Fetch the full curated record with uniprot_get_entry for that accession. If the response comes back as an outline, re-call with sections covering function, catalyticActivity, subcellularLocation, disease, variants, goTerms, and xrefs.

3. From the entry, summarize: protein function, catalytic activity, subcellular location, and the annotation provenance (reviewed status, annotation score, protein-existence level).

4. Pull the disease and variant detail. List disease associations (with OMIM ids) and notable natural variants (with their VAR/dbSNP identifiers).

5. Surface the cross-references for downstream hops: PDB ids (for 3D structure via protein-mcp-server), ChEMBL ids (for bioactivity via chembl), and the PubMed evidence ids behind the function annotation (for citations via pubmed).

Present the dossier as: identity, function, localization, disease & variants, and cross-references — and note the curation level so the reader can weigh manual vs. predicted annotation.`,
        },
      },
    ];
  },
});
