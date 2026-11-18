/**
 * @fileoverview Tests for the UniProtKB return-field seam: the default and
 *   identity projections, the entry and search vocabularies and aliases, the split
 *   of a caller's `fields` into what goes upstream and what is ignored, the
 *   on-request entry sections, and the ignored-field notice. Per-tool tests prove
 *   only the wiring; the value table lives here.
 * @module tests/services/return-fields.test
 */

import { describe, expect, it } from 'vitest';
import {
  entryFieldRequest,
  entryFieldsParam,
  ignoredFieldsNotice,
  searchFieldRequest,
  searchFieldsParam,
} from '@/services/uniprot/return-fields.js';

const ENTRY_IDENTITY =
  'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence';
const SEARCH_IDENTITY =
  'accession,id,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence';

/** The names between "Supported fields: " and the xref_ clause of an entry notice. */
function supportedList(notice: string): string[] {
  const start = notice.indexOf('Supported fields: ') + 'Supported fields: '.length;
  return notice.slice(start, notice.indexOf(', and any ')).split(', ');
}

describe('default projections', () => {
  const defaults = entryFieldsParam(undefined).split(',');

  it('requests every annotation type the entry schema describes', () => {
    expect(defaults.slice(0, 10).join(',')).toBe(ENTRY_IDENTITY);
    // The 0.4.0 default, unchanged.
    for (const field of [
      'cc_function',
      'cc_catalytic_activity',
      'cc_cofactor',
      'cc_subcellular_location',
      'cc_disease',
      'ft_mod_res',
      'ft_carbohyd',
      'ft_variant',
      'cc_alternative_products',
      'ft_domain',
      'ft_region',
      'go',
      'keyword',
      'xref_pdb',
      'xref_ensembl',
      'xref_refseq',
      'xref_chembl',
    ])
      expect(defaults).toContain(field);
    // Types the normalizer always read but the default never fetched.
    for (const field of [
      'ft_disulfid',
      'ft_crosslnk',
      'ft_lipid',
      'ft_motif',
      'ft_repeat',
      'ft_zn_fing',
      'ft_dna_bind',
      'ft_coiled',
      'xref_alphafolddb',
    ])
      expect(defaults).toContain(field);
    // The sites, processing, topology, and comment sections, and the family/gene/network xrefs.
    for (const field of [
      'ft_act_site',
      'ft_binding',
      'ft_site',
      'ft_signal',
      'ft_transit',
      'ft_propep',
      'ft_chain',
      'ft_peptide',
      'ft_init_met',
      'ft_transmem',
      'ft_intramem',
      'ft_topo_dom',
      'cc_ptm',
      'cc_pathway',
      'cc_subunit',
      'cc_tissue_specificity',
      'xref_interpro',
      'xref_pfam',
      'xref_hgnc',
      'xref_mim',
      'xref_geneid',
      'xref_string',
    ])
      expect(defaults).toContain(field);
    expect(new Set(defaults).size).toBe(defaults.length);
  });

  it('pins the entry default projection exactly, so a field added or dropped is a deliberate change', () => {
    expect(defaults).toEqual([
      ...ENTRY_IDENTITY.split(','),
      'cc_function',
      'cc_catalytic_activity',
      'cc_cofactor',
      'cc_subcellular_location',
      'cc_disease',
      'ft_mod_res',
      'ft_carbohyd',
      'ft_lipid',
      'ft_crosslnk',
      'ft_disulfid',
      'ft_variant',
      'cc_alternative_products',
      'ft_domain',
      'ft_region',
      'ft_repeat',
      'ft_motif',
      'ft_zn_fing',
      'ft_dna_bind',
      'ft_coiled',
      'ft_act_site',
      'ft_binding',
      'ft_site',
      'ft_signal',
      'ft_transit',
      'ft_propep',
      'ft_chain',
      'ft_peptide',
      'ft_init_met',
      'ft_topo_dom',
      'ft_transmem',
      'ft_intramem',
      'cc_ptm',
      'cc_pathway',
      'cc_subunit',
      'cc_tissue_specificity',
      'go',
      'keyword',
      'xref_pdb',
      'xref_ensembl',
      'xref_refseq',
      'xref_chembl',
      'xref_alphafolddb',
      'xref_interpro',
      'xref_pfam',
      'xref_hgnc',
      'xref_mim',
      'xref_geneid',
      'xref_string',
    ]);
  });

  it('leaves the on-request sections and unnamed databases out', () => {
    expect(defaults).not.toContain('ft_mutagen');
    expect(defaults).not.toContain('cc_interaction');
    expect(defaults).not.toContain('xref_reactome');
  });

  it('keeps the search default as it was', () => {
    expect(searchFieldsParam(undefined)).toBe(
      'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence,cc_function',
    );
  });

  it('puts the identity columns in front of a caller projection, deduplicated', () => {
    expect(entryFieldsParam('ft_disulfid,accession')).toBe(`${ENTRY_IDENTITY},ft_disulfid`);
    expect(searchFieldsParam('cc_function')).toBe(`${SEARCH_IDENTITY},cc_function`);
  });

  it('sends the identity columns alone for an empty projection, the default only for none', () => {
    expect(entryFieldsParam('')).toBe(ENTRY_IDENTITY);
    expect(searchFieldsParam('')).toBe(SEARCH_IDENTITY);
  });
});

describe('entryFieldRequest', () => {
  it('leaves an absent or blank fields to the default projection', () => {
    for (const fields of [undefined, '', ' , ,']) {
      expect(entryFieldRequest(fields)).toEqual({ fields: undefined, ignored: [] });
    }
  });

  it('adds the field of each on-request section sections names, once', () => {
    const defaults = entryFieldsParam(undefined);
    expect(entryFieldRequest(undefined, ['mutagenesis'])).toEqual({
      fields: `${defaults},ft_mutagen`,
      ignored: [],
    });
    expect(entryFieldRequest(undefined, ['interactions', 'mutagenesis', 'interactions'])).toEqual({
      fields: `${defaults},cc_interaction,ft_mutagen`,
      ignored: [],
    });
    expect(entryFieldRequest(undefined, ['disease', 'variants'])).toEqual({
      fields: undefined,
      ignored: [],
    });
  });

  it('leaves a caller projection as sent when sections names an on-request section', () => {
    expect(entryFieldRequest('accession,cc_function', ['mutagenesis'])).toEqual({
      fields: 'accession,cc_function',
      ignored: [],
    });
  });

  it('lowercases field names and rewrites the aliases', () => {
    expect(entryFieldRequest(' CC_Function , Ft_Act_Site,keywordid,RHEA ')).toEqual({
      fields: 'cc_function,ft_act_site,keyword,cc_catalytic_activity',
      ignored: [],
    });
  });

  it('keeps every field an entry renders, gene name forms and GO forms included', () => {
    const names =
      'ec,gene_primary,gene_synonym,gene_oln,gene_orf,protein_families,cc_similarity,cc_domain,cc_toxic_dose,cc_interaction,ft_mutagen,ft_coiled,go_p,go_f,go_c,go_id';
    expect(entryFieldRequest(names)).toEqual({ fields: names, ignored: [] });
  });

  it('keeps any xref_ field, hyphenated database names included', () => {
    expect(
      entryFieldRequest('xref_reactome,XREF_PDB,xref_go,xref_notadb,xref_mane-select'),
    ).toEqual({
      fields: 'xref_reactome,xref_pdb,xref_go,xref_notadb,xref_mane-select',
      ignored: [],
    });
  });

  it('ignores a field an entry does not render, once each, in request order', () => {
    expect(
      entryFieldRequest('accession,sequence,ft_helix,SEQUENCE,definitely_not_a_uniprot_field'),
    ).toEqual({
      fields: 'accession',
      ignored: ['sequence', 'ft_helix', 'definitely_not_a_uniprot_field'],
    });
  });

  it('sends an empty projection when every name is ignored', () => {
    expect(entryFieldRequest('sequence,mass')).toEqual({
      fields: '',
      ignored: ['sequence', 'mass'],
    });
  });

  it('sends text that is not a field name upstream as written, for UniProt to judge', () => {
    // None of these can be ignored, so no Markdown construct ever reaches the notice.
    const tokens = [
      'not-a-field',
      'Bad Field',
      '_x_',
      '*x*',
      '[a](b)',
      '<b>',
      '`x`',
      'x__y',
      'xref_',
      'xref_a--b',
      'go_',
    ];
    expect(entryFieldRequest(tokens.join(','))).toEqual({ fields: tokens.join(','), ignored: [] });
  });
});

describe('searchFieldRequest', () => {
  it('leaves an absent or blank fields to the default', () => {
    expect(searchFieldRequest(undefined)).toEqual({ fields: undefined, ignored: [] });
    expect(searchFieldRequest(' ')).toEqual({ fields: undefined, ignored: [] });
  });

  it('keeps the columns a hit renders', () => {
    expect(searchFieldRequest('accession,gene_names,CC_FUNCTION,gene_oln')).toEqual({
      fields: 'accession,gene_names,cc_function,gene_oln',
      ignored: [],
    });
  });

  it('ignores entry-only fields, xrefs and aliases included', () => {
    expect(
      searchFieldRequest('accession,ec,cc_subcellular_location,xref_pdb,ft_act_site,keywordid'),
    ).toEqual({
      fields: 'accession',
      ignored: ['ec', 'cc_subcellular_location', 'xref_pdb', 'ft_act_site', 'keywordid'],
    });
    expect(searchFieldRequest('xref_mane-select')).toEqual({
      fields: '',
      ignored: ['xref_mane-select'],
    });
  });

  it('sends text that is not a field name upstream as written', () => {
    expect(searchFieldRequest('accession,not-a-field')).toEqual({
      fields: 'accession,not-a-field',
      ignored: [],
    });
  });
});

describe('ignoredFieldsNotice', () => {
  it('names the entry fields, points sequence to uniprot_get_sequence, and lists the supported fields', () => {
    const notice = ignoredFieldsNotice(['sequence', 'ft_helix'], 'entry');
    expect(notice).toMatch(
      /^Ignored fields: sequence, ft_helix — uniprot_get_entry does not return them, so they were not requested from UniProt\. uniprot_get_sequence returns the sequence \(FASTA\) of an accession\. Supported fields: /,
    );
    expect(notice).not.toContain('uniprot_get_entry returns');
    expect(notice.endsWith(', and any `xref_<database>` field, e.g. xref_interpro.')).toBe(true);
    const supported = supportedList(notice);
    // 72 return fields (15 identity, 7 structured comments, 18 free-text, 26 features, 6 GO/keyword) + 2 aliases.
    expect(supported).toHaveLength(74);
    for (const field of [
      'accession',
      'ec',
      'gene_oln',
      'cc_ptm',
      'ft_mutagen',
      'cc_interaction',
      'go_id',
      'keyword',
      'keywordid',
      'rhea',
    ])
      expect(supported).toContain(field);
    expect(supported).not.toContain('sequence');
  });

  it('routes search fields an entry returns to uniprot_get_entry, in one re-call', () => {
    expect(ignoredFieldsNotice(['ec', 'xref_pdb', 'ft_helix', 'keywordid'], 'search')).toBe(
      'Ignored fields: ec, xref_pdb, ft_helix, keywordid — search hits do not carry them, so they were not requested from UniProt. uniprot_get_entry returns ec, xref_pdb, keywordid: pass these results\' accessions with fields:"ec,xref_pdb,keywordid". Supported fields: accession, id, protein_name, gene_names, gene_primary, gene_synonym, gene_oln, gene_orf, organism_name, organism_id, length, reviewed, annotation_score, protein_existence, cc_function.',
    );
  });

  it('points a search sequence to uniprot_get_sequence, not uniprot_get_entry', () => {
    const notice = ignoredFieldsNotice(['sequence'], 'search');
    expect(notice).toContain('uniprot_get_sequence returns the sequence (FASTA) of an accession.');
    expect(notice).not.toContain('uniprot_get_entry');
  });
});

describe('field splitting cost', () => {
  /** 5k → 320k by doubling: the 64-fold span, for shapes no regex engine mode switch reaches. */
  const FULL_SPAN = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** 1.25k → 80k: the same 64-fold span below the size where Bun's regex engine changes mode. */
  const SHORT_SPAN = [1_250, 2_500, 5_000, 10_000, 20_000, 40_000, 80_000];

  /** Comma-joined distinct field-shaped names nothing renders, at least `size` characters. */
  function unknownNames(size: number): string {
    const names: string[] = [];
    for (let i = 0, length = 0; length < size; i++) {
      const name = `x${i.toString(36)}`;
      names.push(name);
      length += name.length + 1;
    }
    return names.join(',');
  }

  const shapes: [string, (size: number) => string, number[]][] = [
    ['distinct unknown names', unknownNames, FULL_SPAN],
    ['one long digit run', (size) => '1'.repeat(size), FULL_SPAN],
    ['an unterminated xref_ hyphen chain', (size) => `xref_${'a-'.repeat(size / 2)}!`, SHORT_SPAN],
    ['an unterminated underscore chain', (size) => `${'a_'.repeat(size / 2)}!`, SHORT_SPAN],
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`, SHORT_SPAN],
    ['line breaks throughout', (size) => '  \r\n'.repeat(size / 4), SHORT_SPAN],
  ];

  /** Split `fields` for both tools and build each notice the tool would send. */
  function splitBoth(fields: string): void {
    for (const [request, tool] of [
      [entryFieldRequest(fields), 'entry'],
      [searchFieldRequest(fields), 'search'],
    ] as const) {
      if (request.ignored.length) ignoredFieldsNotice(request.ignored, tool);
    }
  }

  /**
   * Least thread CPU time, in µs, of one `splitBoth` call over three samples. A sample is a
   * batch of calls covering at least 80k characters, so a small input clears timer resolution.
   */
  function cpuPerCall(fields: string): number {
    const batch = Math.ceil(80_000 / fields.length);
    let least = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) splitBoth(fields);
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / batch);
    }
    return least;
  }

  // Synchronous timing body: vitest cannot interrupt it, so its timeout guards no hang (timeout 0).
  it.each(shapes)(
    'splits %s in time linear in its length',
    (_shape, build, sizes) => {
      const [baseSize, ...larger] = sizes as [number, ...number[]];
      const base = build(baseSize);
      for (const size of larger) {
        const fields = build(size);
        // Baseline re-timed beside each size: the two may land on different core classes.
        let leastGrowth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 2; pair++) {
          const baseCost = cpuPerCall(base);
          const cost = cpuPerCall(fields);
          // A call costs at most 2 µs of CPU per input character.
          expect(cost).toBeLessThan(2 * size);
          leastGrowth = Math.min(leastGrowth, cost / Math.max(baseCost, 1));
        }
        // Linear growth with 4× slack: 256 across the full 64-fold span.
        expect(leastGrowth).toBeLessThan((4 * size) / baseSize);
      }
    },
    0,
  );
});
