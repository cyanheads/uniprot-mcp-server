/**
 * @fileoverview Tests for the query-clause helpers in services/uniprot/types:
 *   the accession-token test (`ACCESSION_TOKEN_REGEX`) and the OR-condition count
 *   (`orConditionCount`) uniprot_search_proteins weighs a clause by before it
 *   admits inactive stubs, with the count checked against what rest.uniprot.org
 *   accepts and refuses, and both scans timed for linear growth.
 * @module tests/services/types.test
 */

import { describe, expect, it } from 'vitest';
import {
  ACCESSION_REGEX,
  ACCESSION_TOKEN_REGEX,
  MAX_OR_CONDITIONS,
  orConditionCount,
} from '@/services/uniprot/types.js';

describe('ACCESSION_TOKEN_REGEX', () => {
  it.each(['P04637', 'Q15086', 'O00139', 'A0A0A0A0A0', 'A0A024R161'])(
    'finds the accession %s, which ACCESSION_REGEX accepts, in a clause',
    (accession) => {
      expect(ACCESSION_REGEX.test(accession)).toBe(true);
      expect(ACCESSION_TOKEN_REGEX.test(accession)).toBe(true);
      expect(ACCESSION_TOKEN_REGEX.test(`gene:TP53 OR accession:${accession}`)).toBe(true);
    },
  );

  it.each([
    'accession:q15086',
    '(P04637)',
    'P04637-2',
    String.raw`P04637\-2 isoform`,
    'kinase "OR" Q15086',
  ])('finds an accession-shaped token in %j', (clause) => {
    expect(ACCESSION_TOKEN_REGEX.test(clause)).toBe(true);
  });

  it.each([
    'gene:TP53',
    'kinase apoptosis',
    'C9orf72',
    'P53_HUMAN',
    'P04637_HUMAN',
    'P046371',
    'XP04637',
    'KW-0539',
    'IPR000001',
    'PF00001',
    'GO:0005634',
    'taxonomy_id:9606',
    'NOTCH1 ORF1 IL-6',
    '*',
  ])('finds no accession-shaped token in %j', (clause) => {
    expect(ACCESSION_TOKEN_REGEX.test(clause)).toBe(false);
  });
});

describe('orConditionCount', () => {
  it.each([
    ['', 0],
    ['gene:TP53', 0],
    ['gene:TP53 OR gene:MDM2', 2],
    // The parser's default operator is OR, so terms set side by side are optional too.
    ['gene:TP53 gene:MDM2', 2],
    [`gene:TP53${String.fromCodePoint(0x3000)}gene:MDM2`, 2],
    ['gene:TP53\tgene:MDM2\r\ngene:BRCA1', 3],
    ['gene:TP53 || gene:MDM2', 2],
    // A lowercase "or" is a term, not an operator.
    ['gene:TP53 or gene:MDM2', 3],
    ['gene:TP53 AND gene:MDM2', 0],
    ['gene:TP53 && gene:MDM2', 0],
    // AND makes the clause on each side required.
    ['a OR b AND c', 1],
    ['a AND b OR c', 1],
    ['a OR b AND c OR d', 2],
    // A mark makes its clause required or prohibited; "!" also ends the term before it.
    ['a OR NOT b', 1],
    ['a -b +c', 1],
    ['a !b', 1],
    ['a!b', 1],
    ['a AND NOT b', 0],
    ['NOT gene:TP53', 0],
    // A bare mark followed by whitespace is a term of its own.
    ['+ a', 2],
    // Every group's own optional clauses count; a group of one clause counts none.
    ['(a OR b) AND (c OR d)', 4],
    ['(a OR b) OR c', 4],
    ['((a OR b))', 2],
    ['(a) OR (b)', 2],
    // A field prefix belongs to the clause after it, whitespace or not.
    ['accession:(Q15086 OR P38398 OR P04637)', 3],
    ['gene: TP53 OR gene: MDM2', 2],
    ['gene:"tumor antigen" OR gene:MDM2', 2],
    // Quoted phrases are one clause each, adjacent or not; their contents never count.
    ['"a b" "c d"', 2],
    ['"a""b"', 2],
    ['"a OR b"', 0],
    [String.raw`"say \"x OR y\"" OR z`, 2],
    // Escaped characters belong to the term.
    [String.raw`a\ b OR c`, 2],
    [String.raw`gene\:x OR y`, 2],
    [String.raw`IL\-6 receptor\: signaling`, 3],
    // The tool's escaped text_search form: a quoted "OR" is a term.
    ['kinase "OR" apoptosis', 3],
    ['*:* OR x', 2],
    // A range's bounds count as terms of their own, so the count runs high.
    ['length:[100 TO 200]', 3],
  ])('counts %j as %i', (clause, conditions) => {
    expect(orConditionCount(clause)).toBe(conditions);
  });

  /** `count` field terms gene:A0, gene:A1, … joined by `separator`. */
  const terms = (count: number, separator: string, prefix = 'A') =>
    Array.from({ length: count }, (_, i) => `gene:${prefix}${i}`).join(separator);

  // Each shape below was sent to rest.uniprot.org (release 2026_04, 2026-11-23): it answered
  // 200 for those within MAX_OR_CONDITIONS and 400 "Too many OR conditions in query.
  // Maximum allowed is 100." for the rest.
  it.each([
    ['100 OR-ed terms', terms(100, ' OR '), 100, true],
    ['101 OR-ed terms', terms(101, ' OR '), 101, false],
    ['two OR groups of 50', `(${terms(50, ' OR ')}) AND (${terms(50, ' OR ', 'B')})`, 100, true],
    [
      'OR groups of 51 and 50',
      `(${terms(51, ' OR ')}) AND (${terms(50, ' OR ', 'B')})`,
      101,
      false,
    ],
    [
      'OR groups of 50 and 49 with the stub branch',
      `((${terms(50, ' OR ')}) AND (${terms(49, ' OR ', 'B')})) AND ((reviewed:true) OR active:false)`,
      101,
      false,
    ],
    ['100 terms joined by ||', terms(100, ' || '), 100, true],
    ['101 terms joined by ||', terms(101, ' || '), 101, false],
    ['101 space-separated terms', terms(101, ' '), 101, false],
    ['101 terms joined by a lowercase or', terms(101, ' or '), 201, false],
    ['101 OR-ed terms, then AND one more', `${terms(101, ' OR ')} AND gene:B0`, 100, true],
    ['101 AND-ed terms', terms(101, ' AND '), 0, true],
    ['101 prohibited terms', terms(101, ' -').replace(/^/, '-'), 0, true],
    // A mark set apart by whitespace is a condition of its own and marks nothing.
    ['98 OR-ed terms, then a bare - and one more', `${terms(98, ' OR ')} - gene:B0`, 100, true],
    ['99 OR-ed terms, then a bare - and one more', `${terms(99, ' OR ')} - gene:B0`, 101, false],
    ['98 OR-ed terms, then a bare ! and one more', `${terms(98, ' OR ')} ! gene:B0`, 100, true],
    ['99 OR-ed terms, then a bare ! and one more', `${terms(99, ' OR ')} ! gene:B0`, 101, false],
    ['99 OR-ed terms, then a bare + and one more', `${terms(99, ' OR ')} + gene:B0`, 101, false],
    [
      '101 adjacent quoted phrases',
      Array.from({ length: 101 }, (_, i) => `"A${i}"`).join(''),
      101,
      false,
    ],
  ])('counts %s as UniProt does', (_shape, clause, conditions, accepted) => {
    expect(orConditionCount(clause)).toBe(conditions);
    expect(orConditionCount(clause) <= MAX_OR_CONDITIONS).toBe(accepted);
  });
});

describe('query-clause scan cost', () => {
  /** 5k → 320k by doubling: the 64-fold span. */
  const FULL_SPAN = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** 1.25k → 80k: the same 64-fold span, for a shape whose allocations crowd memory above it. */
  const SHORT_SPAN = [1_250, 2_500, 5_000, 10_000, 20_000, 40_000, 80_000];

  /** `unit` repeated to exactly `size` characters. */
  const repeated = (unit: string) => (size: number) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

  const shapes: [string, (size: number) => string, number[]][] = [
    ['one long digit run', repeated('1'), FULL_SPAN],
    ['one long letter run', repeated('a'), FULL_SPAN],
    ['six-character near misses', repeated('Q1AAA-'), FULL_SPAN],
    ['ten-character near misses', repeated('A0A0A0A0A-'), FULL_SPAN],
    ['OR runs', repeated('a OR '), FULL_SPAN],
    ['marked terms', repeated('-a '), FULL_SPAN],
    ['an unclosed quote', (size) => `"${repeated('a ')(size - 1)}`, FULL_SPAN],
    ['backslash runs', repeated('\\'), FULL_SPAN],
    ['nested groups', (size) => `${'('.repeat(size / 2)}${')'.repeat(size / 2)}`, SHORT_SPAN],
    ['one long line ending in a break', (size) => `${repeated('§1 x')(size)}\ny`, FULL_SPAN],
    ['line breaks throughout', repeated('  \r\n'), FULL_SPAN],
  ];

  /** Both scans uniprot_search_proteins runs on a filtered clause. */
  function scan(clause: string): void {
    ACCESSION_TOKEN_REGEX.test(clause);
    orConditionCount(clause);
  }

  /**
   * Least thread CPU time, in µs, of one `scan` call over three samples. A sample is a
   * batch of calls covering at least 80k characters, so a small input clears timer resolution.
   */
  function cpuPerCall(clause: string): number {
    const batch = Math.ceil(80_000 / clause.length);
    let least = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) scan(clause);
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / batch);
    }
    return least;
  }

  // Synchronous timing body: vitest cannot interrupt it, so its timeout guards no hang (timeout 0).
  it.each(shapes)(
    'scans %s in time linear in its length',
    (_shape, build, sizes) => {
      const [baseSize, ...larger] = sizes as [number, ...number[]];
      const base = build(baseSize);
      for (const size of larger) {
        const clause = build(size);
        // Baseline re-timed beside each size: the two may land on different core classes.
        let leastGrowth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 2; pair++) {
          const baseCost = cpuPerCall(base);
          const cost = cpuPerCall(clause);
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
