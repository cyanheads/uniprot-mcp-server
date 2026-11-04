---
name: uniprot-guide
description: Resolve protein identity and organism scope with uniprot_* tools before interpreting annotations, mapping identifier sets, or comparing proteomes. Use for ambiguous gene names, species versus strain searches, evidence-backed protein dossiers, and claims that a protein or annotation is absent.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use UniProt for protein identity, functional annotations, sequence, cross-database identifiers, and reference-proteome context. The service is keyless. It does not provide sequence alignment, structure analysis, or a general UniParc retrieval tool. A cross-reference supplies an identifier for a downstream lookup; it does not supply that database's record.

## Identifiers

| Identifier | Origin and use |
| --- | --- |
| UniProtKB accession, such as `P04637` | Search results, UniProtKB-target mapping rows, or proteome proteins; identifies the entry to investigate. |
| NCBI taxon ID | `uniprot_get_taxonomy` or a protein's organism record; retain its name and rank when choosing the search scope. |
| Proteome UPID | `uniprot_get_proteome`; fixes the particular proteome for enumeration and comparison. |
| Isoform ID | An entry's isoforms or `uniprot_get_sequence`; keep it attached to isoform-specific conclusions rather than substituting the parent accession. |
| PubMed or database cross-reference | Entry annotation evidence or `xrefs`; preserve the database namespace when handing the identifier onward. |

## Gates

1. **Establish identity before writing a dossier.** Check the returned gene, organism, and reviewed status against the intended protein. A top-ranked name match or one-to-many identifier mapping is a candidate set, not permission to choose its first row. If candidates remain biologically distinct, narrow the query or ask which organism, strain, or protein the user means.
2. **Establish taxonomic scope before interpreting an empty result.** Inspect the resolved name and rank. Exact organism nodes and their descendants are different search sets: species-level requests can need entries assigned to strains or subspecies. A reference proteome is a particular protein set, not every UniProt entry assigned to a species. Use the query reference to make the intended scope explicit.
3. **Check coverage before claiming absence.** A reviewed-only search can miss unreviewed entries; a filtered proteome list can exclude the protein; a page can omit later matches. State the scope actually searched. A missing annotation means it was not returned or annotated in the retrieved record, not that the biological property is absent.
4. **Read evidence before making functional claims.** Search function snippets omit evidence references. Fetch the entry annotations and retain their attached evidence for a cited summary. Distinguish reviewed status, annotation score, and protein-existence evidence instead of treating any one as proof of every functional claim.
5. **Finish the mapping set before reconciling it.** Preserve source-to-target pairs and all candidate targets. A finished mapping job can still have further result pages; one page's mapping count is not a count of successfully mapped input IDs. Report unresolved inputs and any remaining pages before calling the translation complete.

## Core chain

Resolve organism identity when needed, then discover or map protein candidates. Validate the candidates against the requested biological identity before fetching the entry sections that support the answer. Retrieve sequence only when the task needs it, and keep canonical and isoform identities distinct. Follow cross-references when the answer needs information held by another database.

## Workflows

**Protein dossier.** For “human TP53 function and disease links,” resolve or verify the human taxon, identify the matching protein, and inspect its entry annotations. Keep the function's evidence with the function claim and the disease association with its disease identifier. Do not turn a natural-variant listing into a clinical interpretation without evidence that supports that interpretation.

**Species or proteome comparison.** Decide whether the comparison covers all taxonomic descendants or one selected reference proteome. Retain each chosen UPID and its organism identity so both sides use comparable scope. Distinguish the proteome's total protein count from the number matching a filter and the number returned on one page.

**External-ID translation.** Retain the source namespace, organism constraint, and requested target database with the mapping. When several active UniProtKB targets remain, inspect their identities before selecting entries for a downstream analysis. An unmapped source under those constraints is an unsuccessful translation, not evidence that its gene or protein does not exist.

## References

- [Query syntax and taxonomic scope](references/query-syntax.md)
