/**
 * @fileoverview Which rows of an entry's position-bearing sections cover one
 *   residue of the canonical sequence — the rule behind uniprot_get_entry's
 *   `residue` input. Disulfide bonds and cross-links cover only their two bonded
 *   residues; every other row covers its span. A row the rule cannot place on
 *   the canonical sequence is excluded and counted, never matched.
 * @module services/uniprot/residue-coverage
 */

import type { Entry, FeatureLocation } from '@/services/uniprot/types.js';

/** The entry sections built from sequence features, in record order — the ones `residue` filters. */
export const POSITION_SECTIONS = [
  'sites',
  'topology',
  'ptms',
  'processing',
  'variants',
  'mutagenesis',
  'domains',
] as const satisfies readonly (keyof Entry)[];

/** A row of a position-bearing section: a feature, which names its type, or a residue change, which has none. */
export type PositionedRow = { type?: string; location: FeatureLocation };

/** One section's rows covering a residue, and its counts. */
export type SectionCoverage<T> = {
  /** The rows covering the residue, in the section's order. */
  rows: T[];
  /** Rows covering the residue — `rows.length`. */
  covered: number;
  /** Rows the rule cannot place on the canonical sequence; never in `rows`. */
  excluded: number;
  /** The section's rows before the filter. */
  total: number;
};

/**
 * Feature types whose location names the two bonded residues, not a stretch
 * between them (UniProt help `disulfid`, `crosslnk`): a bond covers its partners only.
 */
const BOND_TYPES: ReadonlySet<string> = new Set(['Disulfide bond', 'Cross-link']);

/** A bound's residue, or undefined when UniProt gives no position for it. */
function placed(position: number | undefined, modifier: string | undefined): number | undefined {
  return modifier === 'UNKNOWN' ? undefined : position;
}

/**
 * The rows of one position-bearing section that cover `residue` (1-based, on the
 * canonical sequence), in the section's order, with the section's counts.
 *
 * - A Disulfide bond or Cross-link covers only its two bonded residues; a partner
 *   at an UNKNOWN position never matches, so the bond is placed by its known one.
 * - Any other row covers `start` ≤ residue ≤ `end`. An OUTSIDE or UNSURE bound
 *   (or any other modifier UniProt adds) counts at its value.
 * - Excluded: a row numbered on an isoform (`location.isoform`), a non-bond row
 *   with an UNKNOWN bound (its span is unknown), and a bond with no known partner.
 */
export function coverResidue<T extends PositionedRow>(
  rows: readonly T[],
  residue: number,
): SectionCoverage<T> {
  const covering: T[] = [];
  let excluded = 0;
  for (const row of rows) {
    const { location } = row;
    const start = placed(location.start, location.startModifier);
    const end = placed(location.end, location.endModifier);
    if (location.isoform) {
      excluded++;
    } else if (row.type !== undefined && BOND_TYPES.has(row.type)) {
      if (start === undefined && end === undefined) excluded++;
      else if (start === residue || end === residue) covering.push(row);
    } else if (start === undefined || end === undefined) {
      excluded++;
    } else if (start <= residue && residue <= end) {
      covering.push(row);
    }
  }
  return { rows: covering, covered: covering.length, excluded, total: rows.length };
}
