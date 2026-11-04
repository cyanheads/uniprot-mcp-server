# Query syntax and taxonomic scope

Use the structured query input when the task requires field restrictions or Boolean logic. Plain text and structured query inputs are alternatives; the tool schema owns their current contracts.

## Choose the biological search set

| UniProtKB expression | Meaning |
| --- | --- |
| `gene_exact:TP53 AND organism_id:9606 AND reviewed:true` | Exact gene-name search within the human node and reviewed entries. Inspect the returned identity before selecting a protein. |
| `(gene_exact:gyrA OR gene_exact:recA) AND taxonomy_id:562 AND reviewed:true` | Either gene in E. coli, including descendant strains and subspecies. |
| `(gene_exact:gyrA OR gene_exact:recA) AND organism_id:562 AND reviewed:true` | The same genes assigned to the exact E. coli node; excludes entries assigned only to descendant nodes. |

`organism_id` and `taxonomy_id` above are UniProtKB query field names. The search tool's `organism_id` input includes descendants; ID mapping's `tax_id` restricts submission to the exact node. For a strain-specific mapping, use that strain's taxon ID. Do not combine an exact-node query restriction with a descendant query when the intended scope is the whole species: the intersection excludes the strains again.

Parenthesize alternatives before adding constraints. `(gene_exact:gyrA OR gene_exact:recA) AND taxonomy_id:562` restricts both alternatives to E. coli. Preserve the same effective query while paging; changing the biological scope starts a new search.

## Keep query fields separate from returned fields

The query controls which records match. The return-field projection controls which data UniProt sends for those records. These vocabularies differ: the exact-gene query uses `gene_exact`, while a primary-gene return field is `gene_primary`. Choosing a small projection does not narrow the result set.

When a query is rejected, fix the field or syntax named in the error rather than moving the expression into the plain-text input. Consult the current [UniProt query-field reference](https://www.uniprot.org/help/query-fields) for fields beyond these examples.
