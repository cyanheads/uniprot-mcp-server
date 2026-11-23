/**
 * @fileoverview Tests for the residue coverage rule (`coverResidue`) behind
 *   uniprot_get_entry's `residue` input, tabled once at its own seam over
 *   normalized locations as `normalizeLocation` builds them: spans with exact,
 *   OUTSIDE, and UNSURE bounds; disulfide bonds and cross-links covering only their
 *   two residues; and the rows the rule excludes and counts — isoform-numbered rows,
 *   non-bond rows with an UNKNOWN bound, and a bond with no known partner.
 * @module tests/services/residue-coverage.test
 */

import { describe, expect, it } from 'vitest';
import { coverResidue, POSITION_SECTIONS } from '@/services/uniprot/residue-coverage.js';
import type { FeatureLocation } from '@/services/uniprot/types.js';

/** A feature row of the given type at a location. */
const row = (type: string | undefined, location: FeatureLocation, id = '') => ({
  ...(type === undefined ? {} : { type }),
  location,
  id,
});

/** The ids of the rows covering `residue`. */
const covering = (rows: ReturnType<typeof row>[], residue: number) =>
  coverResidue(rows, residue).rows.map((r) => r.id);

describe('coverResidue', () => {
  it('names the seven position-bearing sections in record order', () => {
    expect(POSITION_SECTIONS).toEqual([
      'sites',
      'topology',
      'ptms',
      'processing',
      'variants',
      'mutagenesis',
      'domains',
    ]);
  });

  it.each([
    [99, []],
    [100, ['region']],
    [175, ['region']],
    [300, ['region']],
    [301, []],
  ])('a span covers start through end, both included: residue %i', (residue, ids) => {
    expect(covering([row('Region', { start: 100, end: 300 }, 'region')], residue)).toEqual(ids);
  });

  it('a one-residue row covers that residue only', () => {
    const site = [row('Binding site', { start: 176, end: 176 }, 'zn')];
    expect(covering(site, 176)).toEqual(['zn']);
    expect(covering(site, 175)).toEqual([]);
    expect(covering(site, 177)).toEqual([]);
  });

  it('counts an OUTSIDE or UNSURE bound at its value, and any other modifier too', () => {
    const chain = [
      row(
        'Chain',
        { start: 1, end: 264, startModifier: 'OUTSIDE', endModifier: 'OUTSIDE' },
        'ctnd2',
      ),
    ];
    expect(covering(chain, 1)).toEqual(['ctnd2']);
    expect(covering(chain, 264)).toEqual(['ctnd2']);
    expect(covering(chain, 265)).toEqual([]);

    // O75339: C1 ends at an UNSURE 724, C2 starts at an UNSURE 725.
    const chains = [
      row('Chain', { start: 22, end: 1184 }, 'chain'),
      row('Chain', { start: 22, end: 724, endModifier: 'UNSURE' }, 'c1'),
      row('Chain', { start: 725, end: 1184, startModifier: 'UNSURE' }, 'c2'),
    ];
    expect(covering(chains, 724)).toEqual(['chain', 'c1']);
    expect(covering(chains, 725)).toEqual(['chain', 'c2']);

    const approximate = [
      row('Chain', { start: 725, end: 1184, startModifier: 'APPROXIMATE' }, 'a'),
    ];
    expect(covering(approximate, 725)).toEqual(['a']);
    expect(covering(approximate, 724)).toEqual([]);
  });

  it.each([
    ['Disulfide bond', 52, 162, [51, 53, 100, 161, 163]],
    // A range-form cross-link (P01023 972..975) names its two residues, not the stretch.
    ['Cross-link', 972, 975, [971, 973, 974, 976]],
  ])('a %s covers its two bonded residues only', (type, start, end, misses) => {
    const bond = [row(type, { start, end }, 'bond')];
    expect(covering(bond, start)).toEqual(['bond']);
    expect(covering(bond, end)).toEqual(['bond']);
    for (const residue of misses) expect(covering(bond, residue)).toEqual([]);
    expect(coverResidue(bond, 100).excluded).toBe(0);
  });

  it('an interchain cross-link on one residue covers that residue', () => {
    expect(covering([row('Cross-link', { start: 24, end: 24 }, 'ub')], 24)).toEqual(['ub']);
  });

  it('places a bond with one UNKNOWN partner by its known residue, without excluding it', () => {
    const bonds = [
      row('Disulfide bond', { end: 263, startModifier: 'UNKNOWN' }, 'tail'),
      row('Disulfide bond', { start: 301, endModifier: 'UNKNOWN' }, 'head'),
    ];
    expect(covering(bonds, 263)).toEqual(['tail']);
    expect(covering(bonds, 301)).toEqual(['head']);
    expect(coverResidue(bonds, 280)).toEqual({ rows: [], covered: 0, excluded: 0, total: 2 });
  });

  it('excludes a bond with no known partner', () => {
    const bond = [
      row('Disulfide bond', { startModifier: 'UNKNOWN', endModifier: 'UNKNOWN' }, 'nowhere'),
    ];
    expect(coverResidue(bond, 1)).toEqual({ rows: [], covered: 0, excluded: 1, total: 1 });
  });

  it.each([
    ['an UNKNOWN end', { start: 25, endModifier: 'UNKNOWN' }, [25, 30, 1208]],
    ['an UNKNOWN start', { end: 1532, startModifier: 'UNKNOWN' }, [1, 1000, 1532]],
    // The modifier decides, should UniProt ever send a position beside UNKNOWN.
    ['an UNKNOWN end that carries a value', { start: 25, end: 40, endModifier: 'UNKNOWN' }, [30]],
  ])(
    'excludes a non-bond row with %s at every residue, never matching it',
    (_case, location, residues) => {
      for (const residue of residues) {
        expect(coverResidue([row('Chain', location as FeatureLocation, 'x')], residue)).toEqual({
          rows: [],
          covered: 0,
          excluded: 1,
          total: 1,
        });
      }
    },
  );

  it.each([
    ['a PTM', 'Modified residue', { start: 556, end: 556, isoform: 'O00139-4' }, 556],
    ['a bond', 'Disulfide bond', { start: 52, end: 162, isoform: 'X00000-2' }, 52],
    ['a residue change', undefined, { start: 165, end: 165, isoform: 'A2RU49-2' }, 165],
  ])(
    'excludes %s numbered on an isoform, even at its own position',
    (_case, type, location, residue) => {
      expect(coverResidue([row(type, location, 'iso')], residue)).toEqual({
        rows: [],
        covered: 0,
        excluded: 1,
        total: 1,
      });
    },
  );

  it('applies the span rule to residue changes, which carry no type', () => {
    const variants = [
      row(undefined, { start: 175, end: 175 }, 'VAR_005928'),
      row(undefined, { start: 176, end: 177 }, 'VAR_047167'),
      row(undefined, { start: 169, end: 170 }, 'VAR_047166'),
    ];
    expect(covering(variants, 175)).toEqual(['VAR_005928']);
    expect(covering(variants, 177)).toEqual(['VAR_047167']);
  });

  it('keeps the covering rows in section order with covered, excluded, and total counts', () => {
    // P04637 domains around residue 175: ranges that open before it sort first in UniProt order.
    const domains = [
      row('DNA binding', { start: 102, end: 292 }, 'dna'),
      row('Region', { start: 1, end: 320 }, 'ccar2'),
      row('Region', { start: 1, end: 83 }, 'hrmt1l2'),
      row('Region', { start: 100, end: 370 }, 'hipk1'),
      row('Region', { start: 116, end: 292 }, 'axin1'),
      row('Region', { start: 241, end: 248 }, '53bp2'),
      row('Region', { end: 1532, startModifier: 'UNKNOWN' }, 'unknown'),
      row('Motif', { start: 170, end: 180, isoform: 'P04637-2' }, 'isoform'),
    ];
    const result = coverResidue(domains, 175);
    expect(result.rows.map((r) => r.id)).toEqual(['dna', 'ccar2', 'hipk1', 'axin1']);
    expect(result.rows[0]).toBe(domains[0]);
    expect(result).toMatchObject({ covered: 4, excluded: 2, total: 8 });
  });

  it('reports zero counts for an empty section', () => {
    expect(coverResidue([], 1)).toEqual({ rows: [], covered: 0, excluded: 0, total: 0 });
  });
});
