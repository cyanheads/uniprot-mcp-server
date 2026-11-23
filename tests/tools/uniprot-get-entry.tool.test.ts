/**
 * @fileoverview Tests for the uniprot_get_entry tool. Two layers: format()
 *   rendering for the full arm (including a sparse TrEMBL-style entry that omits
 *   every curated section), the per-accession failure arm, and the outline arm;
 *   plus handler behavior with a stubbed UniProtService — the all_not_found
 *   ctx.fail contract, the partial-success succeeded[]/failed[] split, input
 *   validation at the schema edge, and the outline-on-overflow / sections re-call
 *   paths — the single-accession and absent-section rules, bounded section
 *   windows walked page by page, complete rendering past the former caps, and unbounded
 *   output pinned on both surfaces (exact structuredContent, inline-snapshot text).
 * @module tests/tools/uniprot-get-entry.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import type { Entry } from '@/services/uniprot/types.js';
import { ACCESSION_MESSAGE } from '@/services/uniprot/types.js';
import biophysicochemicalRows from '../fixtures/biophysicochemical.json' with { type: 'json' };
import p00533Mutagenesis from '../fixtures/p00533-mutagenesis.json' with { type: 'json' };
import p00533Sections from '../fixtures/p00533-sections.json' with { type: 'json' };
import p00918 from '../fixtures/p00918-xrefs.json' with { type: 'json' };
import p04637Sections from '../fixtures/p04637-sections.json' with { type: 'json' };
import p07477Default from '../fixtures/p07477-default.json' with { type: 'json' };
import qualifiedComments from '../fixtures/qualified-comments.json' with { type: 'json' };
import sectionRows from '../fixtures/section-rows.json' with { type: 'json' };
import {
  activeRawEntry,
  contentText,
  errorEnvelope,
  expectMcpError,
  featureLocationRow,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  RAW_ENTRIES,
  rejectUnmockedFetch,
  requestedUrls,
  required,
  residueCoverageRow,
  routeUpstream,
  TWO_TEXT_BIOPHYSICOCHEMICAL_ROW,
  upstreamResponse,
} from '../helpers.js';

const getEntriesMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getEntries: getEntriesMock }),
}));

/** Every `add` a counter receives, by counter name — a deferral's one effect with no other observable. */
const counterAdds = vi.hoisted(() => [] as { name: string; value: number; attributes: unknown }[]);

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => ({
    add: (value: number, attributes?: unknown) => counterAdds.push({ name, value, attributes }),
  }),
}));

const { getEntry } = await import('@/mcp-server/tools/definitions/uniprot-get-entry.tool.js');

/** The real service, for tests that drive an upstream response through its sanitizer. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

const fullEntry: Entry = {
  accession: 'P04637',
  entryName: 'P53_HUMAN',
  proteinName: 'Cellular tumor antigen p53',
  genes: ['TP53'],
  organism: {
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    taxonId: 9606,
    mnemonic: 'HUMAN',
  },
  length: 393,
  reviewed: true,
  annotationScore: 5,
  proteinExistence: '1: Evidence at protein level',
  function: [{ value: 'Acts as a tumor suppressor.', evidence: ['PubMed:11025664'] }],
  disease: [{ name: 'Li-Fraumeni syndrome', omimId: '151623', diseaseId: 'DI-00001' }],
  variants: [
    { location: { start: 175, end: 175 }, original: 'R', variation: 'H', featureId: 'VAR_044588' },
  ],
  xrefs: { PDB: ['1TUP', '2OCJ'], ChEMBL: ['CHEMBL4096'] },
};

const brca1: Entry = {
  accession: 'P38398',
  entryName: 'BRCA1_HUMAN',
  proteinName: 'Breast cancer type 1 susceptibility protein',
  genes: ['BRCA1'],
  organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
  length: 1863,
  reviewed: true,
  annotationScore: 5,
  proteinExistence: '1: Evidence at protein level',
};

/** A service batch result holding only active entries. */
function batch(...entries: Entry[]) {
  return { entries, inactive: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getEntry handler', () => {
  it('returns every captured P00918 xref in database order on an explicit section call', async () => {
    getEntriesMock.mockResolvedValue(batch(p00918));
    const result = await runToolContract(getEntry, { accessions: ['P00918'], sections: ['xrefs'] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ succeeded: [{ xrefs: p00918.xrefs }] });
    const lines = contentText(result).split('\n');
    for (const [database, identifiers] of Object.entries(p00918.xrefs)) {
      const line = lines.find((value) => value.startsWith(`- \`${database}\`: `));
      expect(
        line
          ?.split(': ')[1]
          ?.split(', ')
          .map((value) => value.slice(1, -1)),
      ).toEqual(identifiers);
    }
  });
  it('keeps the complete 24,000-byte result inline and outlines the next two UTF-8 bytes', async () => {
    // A padding character costs one byte on each surface; the second one-letter FUNCTION row
    // costs an odd number of bytes, so the remainder left to pad comes out even.
    const tail = { value: 's' };
    const base = { ...brca1, function: [{ value: 'seed' }, tail], xrefs: {} };
    const empty = { kind: 'full' as const, succeeded: [base], failed: [] };
    const overhead = Buffer.byteLength(
      JSON.stringify({ structuredContent: empty, content: getEntry.format!(empty) }),
      'utf8',
    );
    const remaining = 24_000 - overhead;
    expect(remaining % 2).toBe(0);
    const entry = { ...base, function: [{ value: `seed${'x'.repeat(remaining / 2)}` }, tail] };
    getEntriesMock.mockResolvedValue(batch(entry));
    const at = await runToolContract(getEntry, { accessions: ['P38398'] });
    expect(Buffer.byteLength(JSON.stringify(at), 'utf8')).toBe(24_000);
    expect(at.structuredContent).toMatchObject({ kind: 'full', succeeded: [entry] });
    getEntriesMock.mockResolvedValue(
      batch({ ...entry, function: [{ value: `${entry.function[0]?.value}x` }, tail] }),
    );
    const over = await runToolContract(getEntry, { accessions: ['P38398'] });
    expect(over.structuredContent).toMatchObject({ kind: 'outline' });
    expect(over.structuredContent).not.toHaveProperty('succeeded');
    // Multibyte annotations consume bytes, not UTF-16 code units.
    getEntriesMock.mockResolvedValue(
      batch({ ...base, function: [{ value: 'é'.repeat(remaining / 2) }, tail] }),
    );
    expect(
      (await runToolContract(getEntry, { accessions: ['P38398'] })).structuredContent,
    ).toMatchObject({ kind: 'outline' });
  });
  it('inlines individually fitting successes past the per-record budget in request order, keeping failures and collapsing a duplicate request', async () => {
    const first = { ...fullEntry, function: [{ value: 'é'.repeat(4000) }] };
    const second = { ...brca1, function: [{ value: 'é'.repeat(4000) }] };
    getEntriesMock.mockResolvedValue(batch(first, second));
    for (const accession of ['P04637', 'P38398']) {
      const singleton = await runToolContract(getEntry, { accessions: [accession] });
      expect(singleton.structuredContent).toMatchObject({ kind: 'full' });
      expect(Buffer.byteLength(JSON.stringify(singleton), 'utf8')).toBeLessThan(24_000);
    }
    const result = await runToolContract(getEntry, {
      accessions: ['P38398', 'Q00000', 'P04637', 'P38398'],
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(24_000);
    expect(result.structuredContent).toMatchObject({
      kind: 'full',
      succeeded: [second, first],
      failed: [{ accession: 'Q00000' }],
    });
    expect(result.structuredContent).not.toHaveProperty('outlinedEntries');
    const text = contentText(result);
    expect(text.match(/\(P38398\)/g)).toHaveLength(1);
    expect(text).toContain('(P04637)');
    expect(text).toContain('Q00000');
  });

  it.each([
    ['P04637', 'P38398'],
    ['P04637', 'Q00000'],
  ])(
    'outlines oversized records on heavy-pair and partial-success calls: %j',
    async (...accessions) => {
      getEntriesMock.mockResolvedValue(
        batch(
          { ...fullEntry, function: [{ value: 'heavy'.repeat(6000) }] },
          { ...brca1, function: [{ value: 'heavy'.repeat(6000) }] },
        ),
      );
      const result = await runToolContract(getEntry, { accessions });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as {
        kind: string;
        outlinedEntries: { accession: string; bytes: number }[];
        failed: { accession: string; error: string }[];
      };
      expect(out.kind).toBe('full');
      expect(out.outlinedEntries.map((entry) => entry.accession)).toEqual(
        accessions.includes('P38398') ? ['P04637', 'P38398'] : ['P04637'],
      );
      expect(out.failed.map((entry) => entry.accession)).toEqual(
        accessions.includes('Q00000') ? ['Q00000'] : [],
      );
      const text = contentText(result);
      for (const entry of out.outlinedEntries)
        expect(text).toContain(
          `**${entry.accession}** — ${entry.bytes} bytes; re-call with accessions:["${entry.accession}"].`,
        );
      for (const entry of out.failed) expect(text).toContain(entry.error);
    },
  );

  it('renders complete sparse variants and xrefs on a combined explicit section re-call', async () => {
    const entry = {
      ...fullEntry,
      variants: Array.from({ length: 40 }, (_, i) => ({
        location: { start: i + 1 },
        description: `Variant ${i}`,
      })),
      xrefs: { PDB: Array.from({ length: 40 }, (_, i) => `PDB-${i}`), Other: ['last-id'] },
    };
    getEntriesMock.mockResolvedValue(batch(entry));
    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: ['variants', 'xrefs'],
    });
    expect(result.structuredContent).toMatchObject({
      succeeded: [{ variants: entry.variants, xrefs: entry.xrefs }],
    });
    const lines = contentText(result).split('\n');
    // Each location carries no end, which the one span formatter renders as `?`.
    expect(lines.filter((line) => /^- \d+\.\.\?: Variant /.test(line))).toEqual(
      Array.from({ length: 40 }, (_, i) => `- ${i + 1}..?: Variant ${i}`),
    );
    expect(lines).toContain(
      `- \`PDB\`: ${Array.from({ length: 40 }, (_, i) => `\`PDB-${i}\``).join(', ')}`,
    );
    expect(lines).toContain('- `Other`: `last-id`');
    expect(contentText(result)).not.toContain('not shown');
  });
  it('rejects a malformed accession at the schema edge', () => {
    expect(() => getEntry.input.parse({ accessions: ['nope'] })).toThrow();
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it('rejects an empty accession list', () => {
    expect(() => getEntry.input.parse({ accessions: [] })).toThrow();
  });

  it('returns the full arm with succeeded entries for a multi-accession batch', async () => {
    getEntriesMock.mockResolvedValue(batch(fullEntry, brca1));
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P04637', 'P38398'] });

    const result = await getEntry.handler(input, ctx);
    expect(result.kind).toBe('full');
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result).toEqual(expect.schemaMatching(getEntry.output));
  });

  it('splits unknown accessions into failed[] while keeping the resolved ones', async () => {
    // Only one of two accessions resolves upstream.
    getEntriesMock.mockResolvedValue(batch(fullEntry));
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P04637', 'Q99999'] });

    const result = await getEntry.handler(input, ctx);
    expect(result.kind).toBe('full');
    expect(result.succeeded?.map((e) => e.accession)).toEqual(['P04637']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed?.[0]?.accession).toBe('Q99999');
    expect(result.failed?.[0]?.error).toContain('not found');
    expect(result).toEqual(expect.schemaMatching(getEntry.output));
  });

  it('throws all_not_found when no accession resolves (full batch failure)', async () => {
    getEntriesMock.mockResolvedValue(batch());
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['Q99999', 'Q88888'] });

    const err = await expectMcpError(getEntry.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'all_not_found' });
    expect((err.data as { accessions?: unknown }).accessions).toEqual(['Q99999', 'Q88888']);
  });

  it('returns an outline when a single record overflows the context budget', async () => {
    // A record with a huge section forces outlineOnOverflow to the outline arm.
    const huge: Entry = {
      ...brca1,
      function: Array.from({ length: 400 }, (_, i) => ({
        value: `Function annotation paragraph ${i} `.repeat(40),
        evidence: ['PubMed:11111111'],
      })),
    };
    getEntriesMock.mockResolvedValue(batch(huge));
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P38398'] });

    // Read through the output schema, as a client receives it.
    const result = getEntry.output.parse(await getEntry.handler(input, ctx));
    expect(result.kind).toBe('outline');
    expect(result.sections?.length).toBeGreaterThan(0);
    expect(result.sections?.some((s) => s.name === 'function')).toBe(true);
    // Re-call guidance surfaces through enrichment, not the output payload.
    expect(getEnrichment(ctx).notice).toBeTruthy();
  });

  it('projects only requested sections on a sections re-call (full arm, never outline)', async () => {
    const huge: Entry = {
      ...fullEntry,
      function: Array.from({ length: 400 }, (_, i) => ({
        value: `Function annotation paragraph ${i} `.repeat(40),
      })),
    };
    getEntriesMock.mockResolvedValue(batch(huge));
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P04637'], sections: ['disease'] });

    const result = getEntry.output.parse(await getEntry.handler(input, ctx));
    expect(result.kind).toBe('full');
    const entry = result.succeeded?.[0];
    // Always-keep identity fields survive; the requested section is kept.
    expect(entry?.accession).toBe('P04637');
    expect(entry?.disease).toEqual(fullEntry.disease);
    // The oversized, unrequested section is dropped by the projection.
    expect(entry?.function).toBeUndefined();
  });

  it('rejects an unknown section name on a sections re-call, naming the available keys', async () => {
    getEntriesMock.mockResolvedValue(batch(fullEntry));
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P04637'], sections: ['diseases'] });

    const err = await expectMcpError(getEntry.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data).toMatchObject({ unmatched: ['diseases'] });
    expect((err.data as { available?: string[] }).available).toContain('disease');
  });

  it('names every unknown section once, in the plural, when several are passed', async () => {
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({
      accessions: ['P04637'],
      sections: ['diseases', 'function', 'go', 'diseases'],
    });

    const err = await expectMcpError(getEntry.handler(input, ctx));
    expect(err.data).toMatchObject({ reason: 'unknown_section', unmatched: ['diseases', 'go'] });
    expect(err.message).toMatch(/^Unknown sections: diseases, go\. Available sections: /);
    expect(getEntriesMock).not.toHaveBeenCalled();
  });
});

/**
 * A BRCA1-shaped record whose one-accession result measures exactly `bytes` UTF-8 bytes
 * across both surfaces: every added 'x' costs one byte in structuredContent and one in
 * content[], so padding moves the size in steps of two, and a second one-letter FUNCTION
 * row, which costs an odd number of bytes, settles the parity. Accessions of one length
 * share the overhead.
 */
function sizedEntry(accession: string, bytes: number): Entry {
  for (const extra of [[], [{ value: 's' }]]) {
    const base = { ...brca1, accession, function: [{ value: 'seed' }, ...extra], xrefs: {} };
    const empty = { kind: 'full' as const, succeeded: [base], failed: [] };
    const overhead = Buffer.byteLength(
      JSON.stringify({ structuredContent: empty, content: getEntry.format!(empty) }),
      'utf8',
    );
    if ((bytes - overhead) % 2 === 0) {
      return {
        ...base,
        function: [{ value: `seed${'x'.repeat((bytes - overhead) / 2)}` }, ...extra],
      };
    }
  }
  throw new Error(`no padding reaches exactly ${bytes} bytes`);
}

/** UTF-8 bytes of a tool result across both surfaces, as the tool's budget measures it. */
const resultBytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result), 'utf8');

/** The schema `tools/list` advertises for one input property, converted as the SDK converts it. */
function advertised(property: string): Record<string, unknown> {
  const json = z.toJSONSchema(getEntry.input, { io: 'input', target: 'draft-2020-12' }) as {
    properties: Record<string, Record<string, unknown>>;
  };
  return json.properties[property] as Record<string, unknown>;
}

describe('getEntry per-record overflow (#40)', () => {
  const at = sizedEntry('P38391', 24_000);
  const over = sizedEntry('P38392', 24_002);
  const far = sizedEntry('P38393', 30_000);
  const small = { ...brca1, accession: 'P38394' };
  const edge = sizedEntry('P38395', 24_001);

  it('measures each record exactly as its one-accession call does: 24,000 inline, 24,001 outlined', async () => {
    getEntriesMock.mockResolvedValue(batch(at));
    const alone = await runToolContract(getEntry, { accessions: ['P38391'] });
    expect(alone.structuredContent).toMatchObject({ kind: 'full', succeeded: [at] });
    expect(resultBytes(alone)).toBe(24_000);
    for (const record of [edge, over, far]) {
      getEntriesMock.mockResolvedValue(batch(record));
      const outlined = await runToolContract(getEntry, { accessions: [record.accession] });
      expect(outlined.structuredContent).toMatchObject({ kind: 'outline' });
      expect(
        (outlined.structuredContent as { sections: unknown[] }).sections.length,
      ).toBeGreaterThan(0);
    }
  });

  it('inlines every record that fits alone and lists only the oversized ones, request order kept in both lists', async () => {
    getEntriesMock.mockResolvedValue(batch(small, far, edge, at, over));
    const result = await runToolContract(getEntry, {
      accessions: ['P38392', 'P38395', 'P38391', 'P38393', 'P38394'],
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.kind).toBe('full');
    expect(out.succeeded).toEqual([at, small]);
    expect(out.outlinedEntries).toEqual([
      { accession: 'P38392', bytes: 24_002 },
      { accession: 'P38395', bytes: 24_001 },
      { accession: 'P38393', bytes: 30_000 },
    ]);
    expect(out.failed).toEqual([]);
    expect(out).not.toHaveProperty('deferredAccessions');
    // No aggregate cap: the inline result is far past 24,000 bytes.
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    const text = contentText(result);
    expect(text).toContain('**Result kind:** full');
    expect(text).toContain('# Breast cancer type 1 susceptibility protein (P38391)');
    expect(text).toContain('# Breast cancer type 1 susceptibility protein (P38394)');
    expect(text).toContain('- **P38392** — 24002 bytes; re-call with accessions:["P38392"].');
    expect(text).toContain('- **P38395** — 24001 bytes; re-call with accessions:["P38395"].');
    expect(text).toContain('- **P38393** — 30000 bytes; re-call with accessions:["P38393"].');
    expect(text).not.toContain('# Breast cancer type 1 susceptibility protein (P38392)');
    expect(text).not.toContain('# Breast cancer type 1 susceptibility protein (P38395)');
    expect(out.notice).toContain('accessions:["P38392"]');
    expect(out.notice).toContain('accessions:["P38395"]');
    expect(out.notice).toContain('accessions:["P38393"]');
    expect(text).toContain(out.notice as string);
  });

  it('returns 20 records that each fit alone, inline, with no outline and no notice', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => sizedEntry(`P${38_300 + i}`, 24_000));
    getEntriesMock.mockResolvedValue(batch(...twenty));
    const result = await runToolContract(getEntry, {
      accessions: twenty.map((e) => e.accession),
    });

    const out = result.structuredContent as Record<string, unknown>;
    expect(out.kind).toBe('full');
    expect((out.succeeded as Entry[]).map((e) => e.accession)).toEqual(
      twenty.map((e) => e.accession),
    );
    expect(out).not.toHaveProperty('outlinedEntries');
    expect(out).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(19 * 24_000);
  });

  it('returns kind:"full" for a partial-success call whose only resolved record is oversized', async () => {
    getEntriesMock.mockResolvedValue(batch(over));
    const result = await runToolContract(getEntry, { accessions: ['P38392', 'Q00000'] });

    const out = result.structuredContent as Record<string, unknown>;
    expect(out.kind).toBe('full');
    expect(out.succeeded).toEqual([]);
    expect(out.outlinedEntries).toEqual([{ accession: 'P38392', bytes: 24_002 }]);
    expect(out.failed).toEqual([
      {
        accession: 'Q00000',
        error:
          'Accession Q00000 not found in UniProtKB. Verify via uniprot_search_proteins or uniprot_map_ids.',
      },
    ]);
    expect(out).not.toHaveProperty('sections');
    const text = contentText(result);
    expect(text).toContain('- **P38392** — 24002 bytes; re-call with accessions:["P38392"].');
    expect(text).toContain('- **Q00000** — Accession Q00000 not found in UniProtKB.');
  });

  it('writes one summary log line with the inlined, outlined, failed, and deferred counts', async () => {
    getEntriesMock.mockResolvedValue(batch(at, over, small));
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P38391', 'P38392', 'P38394', 'Q00000'] });

    await getEntry.handler(input, ctx);

    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toMatchObject({ inlined: 2, outlined: 1, failed: 1, deferred: 0 });
    expect(getEnrichment(ctx).notice).toContain('accessions:["P38392"]');
  });
});

describe('getEntry accession dedupe and deferral (#41)', () => {
  /** A valid accession per index: P10001, P10002, … */
  const acc = (i: number) => `P${10_000 + i}`;
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => acc(from + i));
  /** Resolve every requested accession to a small record, as UniProt would. */
  const resolveAll = () =>
    getEntriesMock.mockImplementation(async (accessions: string[]) =>
      batch(...accessions.map((accession) => ({ ...brca1, accession }))),
    );

  it('fetches the first 20 distinct in one request and defers the rest in submission order on both surfaces', async () => {
    resolveAll();
    // Duplicates on both sides of the boundary: P10005 (fetched) and P10021 (deferred).
    const submitted = [...range(1, 20), acc(5), acc(21), acc(22), acc(21), acc(23)];
    const result = await runToolContract(getEntry, { accessions: submitted });

    expect(result.isError).toBeFalsy();
    expect(getEntriesMock).toHaveBeenCalledTimes(1);
    expect(getEntriesMock.mock.calls[0]?.[0]).toEqual(range(1, 20));
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.kind).toBe('full');
    expect((out.succeeded as Entry[]).map((e) => e.accession)).toEqual(range(1, 20));
    expect(out.deferredAccessions).toEqual(['P10021', 'P10022', 'P10023']);
    expect(out.notice).toContain('deferredAccessions');
    const text = contentText(result);
    expect(text).toContain('accessions:["P10021","P10022","P10023"]');
    expect(text).toContain(out.notice as string);
  });

  it('accepts 500 accessions and rejects 501 at the schema before any request', async () => {
    resolveAll();
    const accepted = await runToolContract(getEntry, { accessions: range(1, 500) });
    expect(accepted.isError).toBeFalsy();
    expect(
      (accepted.structuredContent as { deferredAccessions: string[] }).deferredAccessions,
    ).toEqual(range(21, 500));

    getEntriesMock.mockClear();
    const rejected = await runToolContract(getEntry, { accessions: range(1, 501) });
    expect(errorEnvelope(rejected).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(rejected).message).toContain('<=500');
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it('collapses a repeated accession to one record and defers nothing', async () => {
    resolveAll();
    const result = await runToolContract(getEntry, { accessions: ['P0A7V8', 'P0A7V8'] });

    expect(getEntriesMock.mock.calls[0]?.[0]).toEqual(['P0A7V8']);
    expect(result.structuredContent).toStrictEqual({
      kind: 'full',
      succeeded: [{ ...brca1, accession: 'P0A7V8' }],
      failed: [],
    });
  });

  it('returns failed[] and deferredAccessions instead of all_not_found when none of the fetched resolve', async () => {
    getEntriesMock.mockResolvedValue(batch());
    const result = await runToolContract(getEntry, { accessions: range(1, 21) });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.kind).toBe('full');
    expect(out.succeeded).toEqual([]);
    expect((out.failed as { accession: string }[]).map((f) => f.accession)).toEqual(range(1, 20));
    expect(out.deferredAccessions).toEqual(['P10021']);
    expect(contentText(result)).toContain('accessions:["P10021"]');
  });

  it('places every distinct accession in exactly one of succeeded, outlinedEntries, failed, deferredAccessions', async () => {
    const oversized = sizedEntry('P38392', 24_002);
    getEntriesMock.mockImplementation(async (accessions: string[]) =>
      batch(
        ...accessions
          .filter((a) => a !== acc(7))
          .map((accession) =>
            accession === acc(3) ? { ...oversized, accession } : { ...brca1, accession },
          ),
      ),
    );
    const submitted = [...range(1, 22), acc(3), acc(22)];
    const result = await runToolContract(getEntry, { accessions: submitted });

    const out = result.structuredContent as {
      succeeded: Entry[];
      outlinedEntries: { accession: string }[];
      failed: { accession: string }[];
      deferredAccessions: string[];
      notice: string;
    };
    expect(out.outlinedEntries.map((e) => e.accession)).toEqual([acc(3)]);
    expect(out.failed.map((f) => f.accession)).toEqual([acc(7)]);
    expect(out.deferredAccessions).toEqual([acc(21), acc(22)]);
    const buckets = [
      ...out.succeeded.map((e) => e.accession),
      ...out.outlinedEntries.map((e) => e.accession),
      ...out.failed.map((f) => f.accession),
      ...out.deferredAccessions,
    ];
    expect([...buckets].sort()).toEqual(range(1, 22));
    // One notice carries both re-calls: the deferral and the outlined record.
    expect(out.notice).toBe(
      '2 accession(s) past the first 20 distinct were not fetched — re-call with deferredAccessions as accessions (keeping any fields) for the next batch. 1 record(s) exceed 24,000 bytes alone and are listed in outlinedEntries, not inlined — re-call each alone for its section outline: accessions:["P10003"].',
    );
    expect(contentText(result)).toContain(`> ${out.notice}`);
  });

  it.each([
    ['a repeated accession', ['P04637', 'P04637']],
    ['21 distinct accessions', range(1, 21)],
  ])('rejects sections with %s before any request', async (_case, accessions) => {
    const result = await runToolContract(getEntry, { accessions, sections: ['function'] });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'sections_single_accession' });
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it('adds no deferral, notice, or log line within 20 distinct accessions', async () => {
    resolveAll();
    const ctx = createMockContext({ errors: getEntry.errors });
    const result = await getEntry.handler(getEntry.input.parse({ accessions: range(1, 20) }), ctx);
    expect(result).not.toHaveProperty('deferredAccessions');
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect((ctx.log as MockContextLogger).calls.map((c) => c.msg)).not.toContainEqual(
      expect.stringMatching(/defer/i),
    );
  });

  it('writes the deferral log line and adds one deferral count for 21 distinct accessions', async () => {
    resolveAll();
    counterAdds.length = 0;
    const ctx = createMockContext({ errors: getEntry.errors });

    await getEntry.handler(getEntry.input.parse({ accessions: range(1, 21) }), ctx);

    expect((ctx.log as MockContextLogger).calls).toContainEqual({
      level: 'info',
      msg: 'Deferred accessions past the fetch cap',
      data: { distinct: 21, fetched: 20, deferred: 1 },
    });
    expect(counterAdds).toEqual([
      {
        name: 'uniprot.input.limited',
        value: 1,
        attributes: {
          'mcp.tool.name': 'uniprot_get_entry',
          'uniprot.input.name': 'accessions',
          'uniprot.input.limit': 'deferral',
        },
      },
    ]);
  });
});

describe('getEntry input caps and UNIPROT_CLAMP_LIMITS (#41)', () => {
  afterEach(() => {
    getServerConfig().clampLimits = true;
  });

  it('advertises accessions maxItems 500 and section_limit with a minimum and no maximum', () => {
    expect(advertised('accessions')).toMatchObject({ type: 'array', minItems: 1, maxItems: 500 });
    expect(advertised('section_limit')).toMatchObject({ type: 'integer', minimum: 1 });
    expect(advertised('section_limit').maximum).toBeUndefined();
  });

  it('returns a section_limit above the remaining items as those items, with no notice', async () => {
    for (const section_limit of [501, 1e20]) {
      getEntriesMock.mockResolvedValue(batch(heavyEntry));
      const result = await runToolContract(getEntry, {
        accessions: ['P04637'],
        sections: ['variants'],
        section_limit,
        section_offset: 10,
      });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as Record<string, unknown>;
      expect((out.succeeded as Entry[])[0]?.variants).toEqual(heavyEntry.variants?.slice(10));
      expect(out).toMatchObject({ totalCount: 30, window: { section: 'variants', offset: 10 } });
      expect(out).not.toHaveProperty('notice');
      expect(out).not.toHaveProperty('truncated');
    }
  });

  it('rejects a fractional section_limit as an integer mistake', async () => {
    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: ['variants'],
      section_limit: 1.5,
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(result).message).toContain('expected int');
  });

  it('under UNIPROT_CLAMP_LIMITS=false advertises and enforces 20 accessions and section_limit 500', async () => {
    getServerConfig().clampLimits = false;
    expect(advertised('accessions')).toMatchObject({ maxItems: 20 });
    expect(advertised('section_limit')).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 500,
    });

    const tooMany = await runToolContract(getEntry, {
      accessions: Array.from({ length: 21 }, (_, i) => `P${10_001 + i}`),
    });
    expect(errorEnvelope(tooMany).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(tooMany).message).toContain('<=20');

    const tooLarge = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: ['variants'],
      section_limit: 501,
    });
    expect(errorEnvelope(tooLarge).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(errorEnvelope(tooLarge).message).toContain('<=500');
    expect(getEntriesMock).not.toHaveBeenCalled();
  });
});

describe('getEntry accession validation (through runToolContract)', () => {
  it('rejects a malformed accession in the batch with the accession message and its index', async () => {
    const result = await runToolContract(getEntry, { accessions: ['P04637', 'bad id'] } as never);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.data).toMatchObject({ reason: 'invalid_arguments' });
    expect(envelope.message).toContain(`accessions.1: ${ACCESSION_MESSAGE}`);
    expect(contentText(result)).toContain(`accessions.1: ${ACCESSION_MESSAGE}`);
    expect(envelope.message).not.toContain('must match pattern');
    expect(getEntriesMock).not.toHaveBeenCalled();
  });
});

describe('getEntry upstream rejection (through runToolContract)', () => {
  it("a rejected fields value fails invalid_fields with UniProt's message and a recovery hint", async () => {
    // Real service (sanitizer included) over a stubbed fetch answering UniProt's 400 for an
    // xref_ database it does not know (rest.uniprot.org, release 2026_04, captured 2026-11-17).
    const fetchStub = routeUpstream(() =>
      upstreamResponse(
        400,
        {
          url: 'http://rest.uniprot.org/uniprotkb/search',
          messages: ["Invalid fields parameter value 'xref_notadb'"],
        },
        'Bad Request',
      ),
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));

    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      fields: 'accession,xref_notadb',
    });
    // Any xref_ name reaches UniProt, which judges the database.
    expect(requestedUrls(fetchStub)[0]?.searchParams.get('fields')?.split(',')).toContain(
      'xref_notadb',
    );
    const envelope = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.message).toBe(
      "UniProt rejected the request: Invalid fields parameter value 'xref_notadb'",
    );
    expect(envelope.data).toMatchObject({ reason: 'invalid_fields' });
    const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
    expect(hint).toContain('omit fields');
    const text = contentText(result);
    expect(text).toContain("'xref_notadb'");
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('(reason invalid_fields');
    expect(JSON.stringify(result)).not.toMatch(
      /rest\.uniprot\.org|Bad Request|"url"|responseBody|statusCode/,
    );
  });

  it('a non-400 upstream failure is not classified as invalid_fields', async () => {
    getEntriesMock.mockRejectedValue(
      serviceUnavailable('uniprot.getEntries failed upstream (-32000).'),
    );
    const result = await runToolContract(getEntry, { accessions: ['P04637'] });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.data?.reason).toBeUndefined();
  });
});

describe('getEntry sections re-call rules (through runToolContract)', () => {
  /** A Swiss-Prot entry with no DISEASE annotation, shaped like P0A7V8 (RS4_ECOLI). */
  const rpsD: Entry = {
    accession: 'P0A7V8',
    entryName: 'RS4_ECOLI',
    proteinName: 'Small ribosomal subunit protein uS4',
    genes: ['rpsD', 'ramA', 'b3296', 'JW3258'],
    organism: { scientificName: 'Escherichia coli (strain K12)', taxonId: 83333 },
    length: 206,
    reviewed: true,
    annotationScore: 5,
    proteinExistence: '1: Evidence at protein level',
    function: [{ value: 'One of the primary rRNA binding proteins.' }],
  };

  const IDENTITY_KEYS = [
    'accession',
    'entryName',
    'proteinName',
    'genes',
    'organism',
    'length',
    'reviewed',
    'annotationScore',
    'proteinExistence',
  ];

  it.each([
    ['an all-resolving batch', ['P04637', 'P38398']],
    ['a partial-success batch', ['P04637', 'Q00000']],
  ])(
    'rejects sections on %s before any upstream request, naming fields',
    async (_shape, accessions) => {
      getEntriesMock.mockResolvedValue(batch(fullEntry, brca1));

      const result = await runToolContract(getEntry, { accessions, sections: ['function'] });

      expect(result.isError).toBe(true);
      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(envelope.data).toMatchObject({ reason: 'sections_single_accession' });
      expect(envelope.message).toContain('fields');
      const text = contentText(result);
      expect(text).toContain('fields');
      expect(text).toContain('(reason sections_single_accession');
      expect(getEntriesMock).not.toHaveBeenCalled();
    },
  );

  it('returns kind:full with the sections the record has, naming each one it lacks on both surfaces', async () => {
    getEntriesMock.mockResolvedValue(batch(rpsD));
    const result = await runToolContract(getEntry, {
      accessions: ['P0A7V8'],
      sections: ['disease', 'function'],
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      kind: string;
      succeeded: Record<string, unknown>[];
      absentSections?: string[];
    };
    expect(out.kind).toBe('full');
    expect(Object.keys(out.succeeded[0] ?? {}).sort()).toEqual(
      [...IDENTITY_KEYS, 'function'].sort(),
    );
    expect(out.absentSections).toEqual(['disease']);
    const text = contentText(result);
    expect(text).toContain('One of the primary rRNA binding proteins.');
    expect(text).toMatch(/Absent sections:\*\* disease\b/);
  });

  it('returns only the identity keys when every requested section is absent', async () => {
    const { proteinName: _none, ...noName } = rpsD;
    getEntriesMock.mockResolvedValue(batch(noName));
    const result = await runToolContract(getEntry, {
      accessions: ['P0A7V8'],
      sections: ['disease', 'variants', 'proteinName'],
    });

    const out = result.structuredContent as {
      succeeded: Record<string, unknown>[];
      absentSections?: string[];
    };
    expect(Object.keys(out.succeeded[0] ?? {}).sort()).toEqual(
      IDENTITY_KEYS.filter((k) => k !== 'proteinName').sort(),
    );
    expect(out.absentSections).toEqual(['disease', 'variants', 'proteinName']);
    expect(contentText(result)).toContain('disease, variants, proteinName');
  });

  it.each([
    [['Function'], ['function']],
    [['GOTERMS'], ['goTerms']],
    [
      ['subcellularlocation', 'Function'],
      ['subcellularLocation', 'function'],
    ],
  ])('resolves section keys %j case-insensitively to %j', async (asSent, canonical) => {
    getEntriesMock.mockResolvedValue(batch(fullEntry));
    const sent = await runToolContract(getEntry, { accessions: ['P04637'], sections: asSent });
    getEntriesMock.mockResolvedValue(batch(fullEntry));
    const expected = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: canonical,
    });
    expect(sent.isError).toBeFalsy();
    expect(sent.structuredContent).toEqual(expected.structuredContent);
    expect(contentText(sent)).toBe(contentText(expected));
  });

  it('echoes the canonical key in absentSections and window.section', async () => {
    getEntriesMock.mockResolvedValue(batch(brca1));
    const absent = await runToolContract(getEntry, {
      accessions: ['P38398'],
      sections: ['Disease'],
    });
    expect(absent.structuredContent).toMatchObject({ absentSections: ['disease'] });

    getEntriesMock.mockResolvedValue(batch(heavyEntry));
    const windowed = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: ['VARIANTS'],
      section_limit: 10,
    });
    expect(windowed.isError).toBeFalsy();
    expect(windowed.structuredContent).toMatchObject({
      window: { section: 'variants', offset: 0 },
      totalCount: 30,
    });
  });

  it('rejects a key no casing makes valid before any upstream request, naming it as sent and listing every valid key', async () => {
    getEntriesMock.mockResolvedValue(batch(fullEntry));
    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: ['Function', 'Diseases'],
    });

    expect(result.isError).toBe(true);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    // 'Function' resolves case-insensitively; 'Diseases' matches no key and is named as sent.
    expect(envelope.data).toMatchObject({ reason: 'unknown_section', unmatched: ['Diseases'] });
    // Every key the tool emits — including ones this record lacks (catalyticActivity, ptms).
    for (const key of ['catalyticActivity', 'ptms', 'disease', 'xrefs']) {
      expect(envelope.message).toContain(key);
      expect((envelope.data as { available?: string[] }).available).toContain(key);
    }
    expect(contentText(result)).toContain('Unknown section: Diseases');
    expect(getEntriesMock).not.toHaveBeenCalled();
  });
});

/** An entry whose capped lists all run past the format() caps: 30 variants, 28 PTMs, 27 domains, 35 PDB ids. */
const heavyEntry: Entry = {
  ...fullEntry,
  variants: Array.from({ length: 30 }, (_, i) => ({
    location: { start: i + 1, end: i + 1 },
    original: 'R',
    variation: 'H',
    featureId: `VAR_${String(i).padStart(6, '0')}`,
    description: `variant ${i}`,
  })),
  ptms: Array.from({ length: 28 }, (_, i) => ({
    type: 'Modified residue',
    location: { start: i + 1, end: i + 1 },
    featureId: `PRO_${String(i).padStart(7, '0')}`,
    description: `Phosphoserine ${i}`,
  })),
  domains: Array.from({ length: 27 }, (_, i) => ({
    type: 'Region',
    location: { start: i * 10 + 1, end: i * 10 + 9 },
    description: `Region ${i}`,
  })),
  xrefs: { PDB: Array.from({ length: 35 }, (_, i) => `${i + 1}ABC`), ChEMBL: ['CHEMBL4096'] },
};

describe('getEntry unbounded output (through runToolContract)', () => {
  /** The identity keys a sections projection always keeps, read off an entry. */
  const identityOf = (e: Entry) => ({
    accession: e.accession,
    entryName: e.entryName,
    proteinName: e.proteinName,
    genes: e.genes,
    organism: e.organism,
    length: e.length,
    reviewed: e.reviewed,
    annotationScore: e.annotationScore,
    proteinExistence: e.proteinExistence,
  });

  async function call(entries: Entry[], input: Record<string, unknown>) {
    getEntriesMock.mockResolvedValue(batch(...entries));
    const result = await runToolContract(getEntry, input as never);
    expect(result.isError).toBeFalsy();
    return { structured: result.structuredContent, text: contentText(result) };
  }

  it('returns a batch whole, in request order, on both surfaces', async () => {
    const { structured, text } = await call([fullEntry, brca1], {
      accessions: ['P04637', 'P38398'],
    });
    expect(structured).toStrictEqual({ kind: 'full', succeeded: [fullEntry, brca1], failed: [] });
    expect(text).toMatchInlineSnapshot(`
      "**Result kind:** full
      # Cellular tumor antigen p53 (P04637)
      **Entry:** P53_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]
      **Genes:** TP53
      **Function:**
      - Acts as a tumor suppressor. (PubMed:11025664)
      **Disease:**
      - Li-Fraumeni syndrome [OMIM:151623] [DI-00001]
      **Variants:** 1 natural variant(s)
      - 175 R→H [VAR_044588]
      **Cross-references:**
      - \`PDB\`: \`1TUP\`, \`2OCJ\`
      - \`ChEMBL\`: \`CHEMBL4096\`

      # Breast cancer type 1 susceptibility protein (P38398)
      **Entry:** BRCA1_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 1863 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens [taxon 9606]
      **Genes:** BRCA1"
    `);
  });

  it('returns a partial-success batch with the unknown accession in failed[]', async () => {
    const { structured, text } = await call([fullEntry], { accessions: ['P04637', 'Q00000'] });
    expect(structured).toStrictEqual({
      kind: 'full',
      succeeded: [fullEntry],
      failed: [
        {
          accession: 'Q00000',
          error:
            'Accession Q00000 not found in UniProtKB. Verify via uniprot_search_proteins or uniprot_map_ids.',
        },
      ],
    });
    expect(text).toMatchInlineSnapshot(`
      "**Result kind:** full
      # Cellular tumor antigen p53 (P04637)
      **Entry:** P53_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]
      **Genes:** TP53
      **Function:**
      - Acts as a tumor suppressor. (PubMed:11025664)
      **Disease:**
      - Li-Fraumeni syndrome [OMIM:151623] [DI-00001]
      **Variants:** 1 natural variant(s)
      - 175 R→H [VAR_044588]
      **Cross-references:**
      - \`PDB\`: \`1TUP\`, \`2OCJ\`
      - \`ChEMBL\`: \`CHEMBL4096\`

      ### Not found
      - **Q00000** — Accession Q00000 not found in UniProtKB. Verify via uniprot_search_proteins or uniprot_map_ids."
    `);
  });

  it('returns a single-accession sections re-call as identity keys plus that section, with no window', async () => {
    const { structured, text } = await call([fullEntry], {
      accessions: ['P04637'],
      sections: ['disease'],
    });
    expect(structured).toStrictEqual({
      kind: 'full',
      succeeded: [{ ...identityOf(fullEntry), disease: fullEntry.disease }],
      failed: [],
    });
    expect(text).toMatchInlineSnapshot(`
      "**Result kind:** full
      # Cellular tumor antigen p53 (P04637)
      **Entry:** P53_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]
      **Genes:** TP53
      **Disease:**
      - Li-Fraumeni syndrome [OMIM:151623] [DI-00001]"
    `);
  });

  it('returns every item on both surfaces past the former renderer caps', async () => {
    const { structured, text } = await call([heavyEntry], { accessions: ['P04637'] });
    expect(structured).toStrictEqual({ kind: 'full', succeeded: [heavyEntry], failed: [] });
    expect(text).not.toContain('not shown');
    expect(text).toMatchInlineSnapshot(`
      "**Result kind:** full
      # Cellular tumor antigen p53 (P04637)
      **Entry:** P53_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]
      **Genes:** TP53
      **Function:**
      - Acts as a tumor suppressor. (PubMed:11025664)
      **Disease:**
      - Li-Fraumeni syndrome [OMIM:151623] [DI-00001]
      **Variants:** 30 natural variant(s)
      - 1 R→H [VAR_000000]: variant 0
      - 2 R→H [VAR_000001]: variant 1
      - 3 R→H [VAR_000002]: variant 2
      - 4 R→H [VAR_000003]: variant 3
      - 5 R→H [VAR_000004]: variant 4
      - 6 R→H [VAR_000005]: variant 5
      - 7 R→H [VAR_000006]: variant 6
      - 8 R→H [VAR_000007]: variant 7
      - 9 R→H [VAR_000008]: variant 8
      - 10 R→H [VAR_000009]: variant 9
      - 11 R→H [VAR_000010]: variant 10
      - 12 R→H [VAR_000011]: variant 11
      - 13 R→H [VAR_000012]: variant 12
      - 14 R→H [VAR_000013]: variant 13
      - 15 R→H [VAR_000014]: variant 14
      - 16 R→H [VAR_000015]: variant 15
      - 17 R→H [VAR_000016]: variant 16
      - 18 R→H [VAR_000017]: variant 17
      - 19 R→H [VAR_000018]: variant 18
      - 20 R→H [VAR_000019]: variant 19
      - 21 R→H [VAR_000020]: variant 20
      - 22 R→H [VAR_000021]: variant 21
      - 23 R→H [VAR_000022]: variant 22
      - 24 R→H [VAR_000023]: variant 23
      - 25 R→H [VAR_000024]: variant 24
      - 26 R→H [VAR_000025]: variant 25
      - 27 R→H [VAR_000026]: variant 26
      - 28 R→H [VAR_000027]: variant 27
      - 29 R→H [VAR_000028]: variant 28
      - 30 R→H [VAR_000029]: variant 29
      **PTMs:** 28
      - Modified residue @1 [PRO_0000000]: Phosphoserine 0
      - Modified residue @2 [PRO_0000001]: Phosphoserine 1
      - Modified residue @3 [PRO_0000002]: Phosphoserine 2
      - Modified residue @4 [PRO_0000003]: Phosphoserine 3
      - Modified residue @5 [PRO_0000004]: Phosphoserine 4
      - Modified residue @6 [PRO_0000005]: Phosphoserine 5
      - Modified residue @7 [PRO_0000006]: Phosphoserine 6
      - Modified residue @8 [PRO_0000007]: Phosphoserine 7
      - Modified residue @9 [PRO_0000008]: Phosphoserine 8
      - Modified residue @10 [PRO_0000009]: Phosphoserine 9
      - Modified residue @11 [PRO_0000010]: Phosphoserine 10
      - Modified residue @12 [PRO_0000011]: Phosphoserine 11
      - Modified residue @13 [PRO_0000012]: Phosphoserine 12
      - Modified residue @14 [PRO_0000013]: Phosphoserine 13
      - Modified residue @15 [PRO_0000014]: Phosphoserine 14
      - Modified residue @16 [PRO_0000015]: Phosphoserine 15
      - Modified residue @17 [PRO_0000016]: Phosphoserine 16
      - Modified residue @18 [PRO_0000017]: Phosphoserine 17
      - Modified residue @19 [PRO_0000018]: Phosphoserine 18
      - Modified residue @20 [PRO_0000019]: Phosphoserine 19
      - Modified residue @21 [PRO_0000020]: Phosphoserine 20
      - Modified residue @22 [PRO_0000021]: Phosphoserine 21
      - Modified residue @23 [PRO_0000022]: Phosphoserine 22
      - Modified residue @24 [PRO_0000023]: Phosphoserine 23
      - Modified residue @25 [PRO_0000024]: Phosphoserine 24
      - Modified residue @26 [PRO_0000025]: Phosphoserine 25
      - Modified residue @27 [PRO_0000026]: Phosphoserine 26
      - Modified residue @28 [PRO_0000027]: Phosphoserine 27
      **Domains/regions:**
      - Region 1..9: Region 0
      - Region 11..19: Region 1
      - Region 21..29: Region 2
      - Region 31..39: Region 3
      - Region 41..49: Region 4
      - Region 51..59: Region 5
      - Region 61..69: Region 6
      - Region 71..79: Region 7
      - Region 81..89: Region 8
      - Region 91..99: Region 9
      - Region 101..109: Region 10
      - Region 111..119: Region 11
      - Region 121..129: Region 12
      - Region 131..139: Region 13
      - Region 141..149: Region 14
      - Region 151..159: Region 15
      - Region 161..169: Region 16
      - Region 171..179: Region 17
      - Region 181..189: Region 18
      - Region 191..199: Region 19
      - Region 201..209: Region 20
      - Region 211..219: Region 21
      - Region 221..229: Region 22
      - Region 231..239: Region 23
      - Region 241..249: Region 24
      - Region 251..259: Region 25
      - Region 261..269: Region 26
      **Cross-references:**
      - \`PDB\`: \`1ABC\`, \`2ABC\`, \`3ABC\`, \`4ABC\`, \`5ABC\`, \`6ABC\`, \`7ABC\`, \`8ABC\`, \`9ABC\`, \`10ABC\`, \`11ABC\`, \`12ABC\`, \`13ABC\`, \`14ABC\`, \`15ABC\`, \`16ABC\`, \`17ABC\`, \`18ABC\`, \`19ABC\`, \`20ABC\`, \`21ABC\`, \`22ABC\`, \`23ABC\`, \`24ABC\`, \`25ABC\`, \`26ABC\`, \`27ABC\`, \`28ABC\`, \`29ABC\`, \`30ABC\`, \`31ABC\`, \`32ABC\`, \`33ABC\`, \`34ABC\`, \`35ABC\`
      - \`ChEMBL\`: \`CHEMBL4096\`"
    `);
  });

  it('returns an unbounded sections:["variants"] re-call whole, with no window', async () => {
    const { structured, text } = await call([heavyEntry], {
      accessions: ['P04637'],
      sections: ['variants'],
    });
    expect(structured).toStrictEqual({
      kind: 'full',
      succeeded: [{ ...identityOf(heavyEntry), variants: heavyEntry.variants }],
      failed: [],
    });
    expect(text).toMatchInlineSnapshot(`
      "**Result kind:** full
      # Cellular tumor antigen p53 (P04637)
      **Entry:** P53_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]
      **Genes:** TP53
      **Variants:** 30 natural variant(s)
      - 1 R→H [VAR_000000]: variant 0
      - 2 R→H [VAR_000001]: variant 1
      - 3 R→H [VAR_000002]: variant 2
      - 4 R→H [VAR_000003]: variant 3
      - 5 R→H [VAR_000004]: variant 4
      - 6 R→H [VAR_000005]: variant 5
      - 7 R→H [VAR_000006]: variant 6
      - 8 R→H [VAR_000007]: variant 7
      - 9 R→H [VAR_000008]: variant 8
      - 10 R→H [VAR_000009]: variant 9
      - 11 R→H [VAR_000010]: variant 10
      - 12 R→H [VAR_000011]: variant 11
      - 13 R→H [VAR_000012]: variant 12
      - 14 R→H [VAR_000013]: variant 13
      - 15 R→H [VAR_000014]: variant 14
      - 16 R→H [VAR_000015]: variant 15
      - 17 R→H [VAR_000016]: variant 16
      - 18 R→H [VAR_000017]: variant 17
      - 19 R→H [VAR_000018]: variant 18
      - 20 R→H [VAR_000019]: variant 19
      - 21 R→H [VAR_000020]: variant 20
      - 22 R→H [VAR_000021]: variant 21
      - 23 R→H [VAR_000022]: variant 22
      - 24 R→H [VAR_000023]: variant 23
      - 25 R→H [VAR_000024]: variant 24
      - 26 R→H [VAR_000025]: variant 25
      - 27 R→H [VAR_000026]: variant 26
      - 28 R→H [VAR_000027]: variant 27
      - 29 R→H [VAR_000028]: variant 28
      - 30 R→H [VAR_000029]: variant 29"
    `);
  });

  it('returns an unbounded sections:["xrefs"] re-call whole, naming the PDB ids past the 30-id cap', async () => {
    const { structured, text } = await call([heavyEntry], {
      accessions: ['P04637'],
      sections: ['xrefs'],
    });
    expect(structured).toStrictEqual({
      kind: 'full',
      succeeded: [{ ...identityOf(heavyEntry), xrefs: heavyEntry.xrefs }],
      failed: [],
    });
    expect(text).toMatchInlineSnapshot(`
      "**Result kind:** full
      # Cellular tumor antigen p53 (P04637)
      **Entry:** P53_HUMAN
      Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level
      **Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]
      **Genes:** TP53
      **Cross-references:**
      - \`PDB\`: \`1ABC\`, \`2ABC\`, \`3ABC\`, \`4ABC\`, \`5ABC\`, \`6ABC\`, \`7ABC\`, \`8ABC\`, \`9ABC\`, \`10ABC\`, \`11ABC\`, \`12ABC\`, \`13ABC\`, \`14ABC\`, \`15ABC\`, \`16ABC\`, \`17ABC\`, \`18ABC\`, \`19ABC\`, \`20ABC\`, \`21ABC\`, \`22ABC\`, \`23ABC\`, \`24ABC\`, \`25ABC\`, \`26ABC\`, \`27ABC\`, \`28ABC\`, \`29ABC\`, \`30ABC\`, \`31ABC\`, \`32ABC\`, \`33ABC\`, \`34ABC\`, \`35ABC\`
      - \`ChEMBL\`: \`CHEMBL4096\`"
    `);
  });
});

describe('getEntry bounded section windows (through runToolContract)', () => {
  const VARIANT_TOTAL = 1363;
  const variantId = (i: number) => `VAR_${String(i).padStart(6, '0')}`;
  /** A p53-sized record: 1,363 natural variants, well past the outline budget. */
  const p53Like: Entry = {
    ...fullEntry,
    variants: Array.from({ length: VARIANT_TOTAL }, (_, i) => ({
      location: { start: (i % 393) + 1, end: (i % 393) + 1 },
      original: 'R',
      variation: 'H',
      featureId: variantId(i),
      description: `In a tumor sample; somatic mutation ${i}.`,
    })),
  };

  type WindowOut = {
    kind: string;
    succeeded: (Record<string, unknown> & { variants?: { featureId?: string }[] })[];
    sections?: unknown;
    window?: { section: string; offset: number };
    totalCount?: number;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    nextOffset?: number;
    notice?: string;
    absentSections?: string[];
  };

  async function call(input: Record<string, unknown>, entry: Entry = p53Like) {
    getEntriesMock.mockResolvedValue(batch(entry));
    const result = await runToolContract(getEntry, { accessions: [entry.accession], ...input });
    expect(result.isError).toBeFalsy();
    return { result, out: result.structuredContent as WindowOut, text: contentText(result) };
  }

  const ids = (out: WindowOut) => out.succeeded[0]?.variants?.map((v) => v.featureId) ?? [];

  it('a fresh single call on the oversized record still outlines (characterization)', async () => {
    const { out } = await call({});
    expect(out.kind).toBe('outline');
    expect(out.succeeded).toBeUndefined();
  });

  it('returns the first window with totalCount, truncation disclosure, and nextOffset on both surfaces', async () => {
    const { out, text } = await call({ sections: ['variants'], section_limit: 100 });

    expect(out.kind).toBe('full');
    expect(ids(out)).toEqual(Array.from({ length: 100 }, (_, i) => variantId(i)));
    expect(out).toMatchObject({
      window: { section: 'variants', offset: 0 },
      totalCount: VARIANT_TOTAL,
      truncated: true,
      shown: 100,
      cap: 100,
      nextOffset: 100,
    });
    expect(out.notice).toContain('section_offset:100');
    // content[] lists every item of the window, not the first 25.
    for (let i = 0; i < 100; i++) expect(text).toContain(`[${variantId(i)}]`);
    expect(text).not.toContain(`[${variantId(100)}]`);
    expect(text).not.toMatch(/more variants not shown/);
    expect(text).toContain(`**${VARIANT_TOTAL} total**`);
    expect(text).toContain('**Next section_offset:** 100');
    expect(text).toContain('items 1–100');
  });

  it('returns a middle window starting at section_offset', async () => {
    const { out, text } = await call({
      sections: ['variants'],
      section_limit: 100,
      section_offset: 200,
    });
    expect(ids(out)).toEqual(Array.from({ length: 100 }, (_, i) => variantId(200 + i)));
    expect(out).toMatchObject({
      window: { offset: 200 },
      totalCount: VARIANT_TOTAL,
      nextOffset: 300,
    });
    expect(text).toContain('items 201–300');
    expect(text).toContain('**Next section_offset:** 300');
  });

  it('a window reaching the end returns the remainder with totalCount and no truncation fields', async () => {
    const { out, text } = await call({
      sections: ['variants'],
      section_limit: 100,
      section_offset: 1300,
    });
    expect(ids(out)).toEqual(Array.from({ length: 63 }, (_, i) => variantId(1300 + i)));
    expect(out.totalCount).toBe(VARIANT_TOTAL);
    for (const key of ['truncated', 'shown', 'cap', 'nextOffset', 'notice']) {
      expect(out).not.toHaveProperty(key);
    }
    expect(text).toContain(`[${variantId(1362)}]`);
    expect(text).not.toContain('Next section_offset');
  });

  it('a window exactly the size of the section is complete, not truncated', async () => {
    const { out } = await call(
      { sections: ['variants'], section_limit: 500 },
      {
        ...p53Like,
        variants: (p53Like.variants ?? []).slice(0, 500),
      },
    );
    expect(ids(out)).toHaveLength(500);
    expect(out.totalCount).toBe(500);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('nextOffset');
  });

  it('an offset past the end returns an empty window with totalCount and a notice', async () => {
    const { out, text } = await call({
      sections: ['variants'],
      section_limit: 100,
      section_offset: 2000,
    });
    expect(out.succeeded[0]?.variants).toEqual([]);
    expect(out.totalCount).toBe(VARIANT_TOTAL);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('nextOffset');
    expect(out.notice).toContain('past the end');
    expect(text).toContain('past the end');
    expect(text).toContain('no items at section_offset 2000');
  });

  it('section_offset alone returns the tail from that offset', async () => {
    const { out } = await call({ sections: ['variants'], section_offset: 1350 });
    expect(ids(out)).toEqual(Array.from({ length: 13 }, (_, i) => variantId(1350 + i)));
    expect(out.totalCount).toBe(VARIANT_TOTAL);
    expect(out).not.toHaveProperty('truncated');
  });

  it('windows an empty list section to an empty window with totalCount 0', async () => {
    const { out } = await call({ sections: ['genes'], section_limit: 10 }, { ...brca1, genes: [] });
    expect(out.succeeded[0]?.genes).toEqual([]);
    expect(out.totalCount).toBe(0);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
  });

  it('windows a section the record lacks to totalCount 0, naming it in absentSections', async () => {
    const { out, text } = await call({ sections: ['disease'], section_limit: 10 }, brca1);
    expect(out.succeeded[0]).not.toHaveProperty('disease');
    expect(out.totalCount).toBe(0);
    expect(out.absentSections).toEqual(['disease']);
    expect(text).toContain('**Absent sections:** disease');
  });

  it('a past-the-end offset on a section the record lacks gives no paging notice', async () => {
    const { out, text } = await call({ sections: ['disease'], section_offset: 5 }, brca1);
    expect(out.totalCount).toBe(0);
    expect(out.absentSections).toEqual(['disease']);
    expect(out).not.toHaveProperty('notice');
    expect(text).not.toContain('below 0');
  });

  it('an explicit tail-only window returns the remaining items', async () => {
    const { out } = await call({ sections: ['ptms'], section_offset: 25 }, heavyEntry);
    const ptms = out.succeeded[0]?.ptms as { featureId?: string }[];
    expect(ptms.map((p) => p.featureId)).toEqual(
      (heavyEntry.ptms ?? []).slice(25).map((p) => p.featureId),
    );
  });

  it('walks the whole section through nextOffset, page by page, with nothing lost or repeated', async () => {
    const seen: (string | undefined)[] = [];
    const pages: number[] = [];
    let offset: number | undefined = 0;
    // Bounded, so an off-by-one that never clears nextOffset fails instead of hanging the suite.
    while (offset !== undefined && pages.length < 4) {
      const { out } = await call({
        sections: ['variants'],
        section_limit: 500,
        section_offset: offset,
      });
      expect(out.kind).toBe('full');
      expect(out.sections).toBeUndefined();
      expect(out.totalCount).toBe(VARIANT_TOTAL);
      pages.push(ids(out).length);
      seen.push(...ids(out));
      offset = out.nextOffset;
    }
    expect(pages).toEqual([500, 500, 363]);
    expect(seen).toEqual(Array.from({ length: VARIANT_TOTAL }, (_, i) => variantId(i)));
  });

  it('windows a feature section other than variants (domains) the same way', async () => {
    const { out, text } = await call(
      { sections: ['domains'], section_limit: 10, section_offset: 20 },
      heavyEntry,
    );
    const domains = out.succeeded[0]?.domains as { description: string }[];
    expect(domains.map((d) => d.description)).toEqual(
      Array.from({ length: 7 }, (_, i) => `Region ${20 + i}`),
    );
    expect(out.totalCount).toBe(27);
    expect(out).not.toHaveProperty('nextOffset');
    expect(text).toContain('Region 26');
  });

  it.each([
    ['section_limit without sections', { section_limit: 10 }, 'sections was not passed'],
    ['section_offset without sections', { section_offset: 5 }, 'sections was not passed'],
    ['section_offset 0 without sections', { section_offset: 0 }, 'sections was not passed'],
    // An empty list names 0 sections — it is not reported as omitted.
    ['an empty sections list', { sections: [], section_limit: 10 }, 'sections names 0'],
    ['two sections', { sections: ['variants', 'ptms'], section_limit: 10 }, 'sections names 2'],
    [
      'a record section (xrefs)',
      { sections: ['xrefs'], section_limit: 10 },
      'xrefs is not a list section',
    ],
    [
      'an object section (organism)',
      { sections: ['organism'], section_offset: 1 },
      'organism is not a list section',
    ],
    [
      'a scalar section (length)',
      { sections: ['length'], section_limit: 1 },
      'length is not a list section',
    ],
  ])('rejects a window on %s before any upstream request', async (_case, input, why) => {
    getEntriesMock.mockResolvedValue(batch(p53Like));

    const result = await runToolContract(getEntry, { accessions: ['P04637'], ...input });

    expect(result.isError).toBe(true);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(envelope.data).toMatchObject({ reason: 'invalid_section_window' });
    expect(envelope.message).toContain(why);
    // The message lists the list sections that can be windowed.
    expect(envelope.message).toContain('variants');
    expect(contentText(result)).toContain('(reason invalid_section_window');
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it('rejects a window on a batch under the single-accession rule, before any request', async () => {
    const result = await runToolContract(getEntry, {
      accessions: ['P04637', 'P38398'],
      sections: ['variants'],
      section_limit: 10,
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'sections_single_accession' });
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it.each([
    ['section_limit 0', { section_limit: 0 }],
    ['a fractional section_limit', { section_limit: 1.5 }],
    ['a negative section_offset', { section_offset: -1 }],
  ])('rejects %s at the schema edge', async (_case, bound) => {
    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      sections: ['variants'],
      ...bound,
    } as never);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.data).toMatchObject({ reason: 'invalid_arguments' });
    expect(getEntriesMock).not.toHaveBeenCalled();
  });
});

describe('getEntry format() complete lists', () => {
  it('renders every item of the windowed section whatever its length', () => {
    const blocks = getEntry.format!({
      kind: 'full',
      succeeded: [heavyEntry],
      failed: [],
      window: { section: 'ptms', offset: 0 },
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    for (const p of heavyEntry.ptms ?? []) expect(text).toContain(`[${p.featureId}]`);
    expect(text).not.toContain('more PTMs not shown');
    for (const variant of heavyEntry.variants ?? [])
      expect(text).toContain(`[${variant.featureId}]`);
    expect(text).not.toContain('not shown');
  });
});

describe('getEntry inactive accessions (real service, through runToolContract)', () => {
  /** Answer the batch search with these raw rows, whatever accessions it names. */
  function batchReturns(...rows: object[]) {
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search' && url.searchParams.get('format') === 'json'
        ? upstreamResponse(200, { results: rows })
        : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    return fetchStub;
  }

  const p53Row = activeRawEntry('P04637', 'P53_HUMAN');

  it('keeps an unknown accession on the not-found path with the existing text (characterization)', async () => {
    const fetchStub = batchReturns(p53Row);
    const result = await runToolContract(getEntry, { accessions: ['P04637', 'Q00000'] });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      succeeded: { accession: string }[];
      failed: { accession: string; error: string }[];
    };
    expect(out.succeeded.map((e) => e.accession)).toEqual(['P04637']);
    expect(out.failed).toEqual([
      {
        accession: 'Q00000',
        error:
          'Accession Q00000 not found in UniProtKB. Verify via uniprot_search_proteins or uniprot_map_ids.',
      },
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['merged', INACTIVE_STUBS.merged, INACTIVE_MESSAGES.merged],
    ['demerged', INACTIVE_STUBS.demerged, INACTIVE_MESSAGES.demerged],
    ['deleted', INACTIVE_STUBS.deleted, INACTIVE_MESSAGES.deleted],
  ])(
    'reports a %s accession in failed[] naming its pointer, never as a record',
    async (_type, stub, message) => {
      const fetchStub = batchReturns(p53Row, stub);
      const accession = stub.primaryAccession;
      const result = await runToolContract(getEntry, { accessions: ['P04637', accession] });

      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as {
        succeeded: { accession: string }[];
        failed: { accession: string; error: string }[];
      };
      expect(out.succeeded.map((e) => e.accession)).toEqual(['P04637']);
      expect(out.failed).toEqual([{ accession, error: message }]);
      // No placeholder record is built anywhere on either surface.
      expect(JSON.stringify(out)).not.toMatch(/"taxonId":0|"scientificName":"unknown"|"length":0/);
      expect(contentText(result)).toContain(message);
      expect(contentText(result)).not.toContain('[taxon 0]');
      // The reason rides the one batch request already made.
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it('omits the UniParc pointer from a deleted accession that carries none', async () => {
    const { extraAttributes: _dropped, ...noUniParc } = INACTIVE_STUBS.deleted;
    batchReturns(p53Row, noUniParc);
    const result = await runToolContract(getEntry, { accessions: ['P04637', 'Q9ZZZ9'] });

    const out = result.structuredContent as { failed: { error: string }[] };
    expect(out.failed[0]?.error).toBe(
      'Q9ZZZ9 was deleted from UniProtKB (Not part of a reference proteome).',
    );
    expect(contentText(result)).not.toContain('UniParc');
  });

  it('still reports an unrecognized inactiveReasonType in failed[], naming the type', async () => {
    batchReturns(p53Row, {
      ...INACTIVE_STUBS.deleted,
      inactiveReason: { inactiveReasonType: 'WITHDRAWN_BY_CURATOR' },
    });
    const result = await runToolContract(getEntry, { accessions: ['P04637', 'Q9ZZZ9'] });

    const out = result.structuredContent as {
      succeeded: { accession: string }[];
      failed: { accession: string; error: string }[];
    };
    expect(out.succeeded.map((e) => e.accession)).toEqual(['P04637']);
    expect(out.failed).toEqual([
      {
        accession: 'Q9ZZZ9',
        error:
          'Q9ZZZ9 is inactive in UniProtKB (WITHDRAWN_BY_CURATOR). Its sequence survives in UniParc as UPI000008B5B6.',
      },
    ]);
  });

  it('throws all_not_found carrying every accession reason when the whole batch is inactive', async () => {
    batchReturns(INACTIVE_STUBS.merged, INACTIVE_STUBS.demerged, INACTIVE_STUBS.deleted);
    const result = await runToolContract(getEntry, {
      accessions: ['Q13140', 'P62158', 'Q9ZZZ9'],
    });

    expect(result.isError).toBe(true);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
    expect(envelope.data).toMatchObject({ reason: 'all_not_found' });
    const text = contentText(result);
    for (const message of Object.values(INACTIVE_MESSAGES)) {
      expect(envelope.message).toContain(message);
      expect(text).toContain(message);
    }
  });

  it('keeps the existing all_not_found message when every accession is simply unknown', async () => {
    batchReturns();
    const result = await runToolContract(getEntry, { accessions: ['Q00000', 'Q00001'] });

    const envelope = errorEnvelope(result);
    expect(envelope.data).toMatchObject({ reason: 'all_not_found' });
    expect(envelope.message).toBe('None of the 2 accession(s) resolved in UniProtKB.');
  });
});

describe('getEntry full curated records (real service, through runToolContract)', () => {
  it('renders every curated section UniProt sent on content[], one line per item', async () => {
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search'
        ? upstreamResponse(200, {
            results: [RAW_ENTRIES.pah, RAW_ENTRIES.p53, RAW_ENTRIES.rhodopsin],
          })
        : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));

    const result = await runToolContract(getEntry, {
      accessions: ['P00439', 'P04637', 'P08100'],
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { kind: string; succeeded: Entry[]; failed: unknown[] };
    expect(out.kind).toBe('full');
    expect(out.succeeded.map((e) => e.accession)).toEqual(['P00439', 'P04637', 'P08100']);
    expect(out.failed).toEqual([]);

    const lines = contentText(result).split('\n');
    // P00439 — every list section, with its provenance and ids.
    expect(lines).toEqual(
      expect.arrayContaining([
        '# Phenylalanine-4-hydroxylase (P00439)',
        '**Entry:** PH4H_HUMAN',
        'Reviewed (Swiss-Prot) · Score 5/5 · 452 aa · 1: Evidence at protein level',
        '**Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]',
        '**Genes:** PAH',
        '**Function:**',
        '- Catalyzes the hydroxylation of L-phenylalanine to L-tyrosine (PubMed:18460651, PubMed:18835579)',
        '**Catalytic activity:**',
        `- ${RAW_ENTRIES.pah.comments[1].reaction.name} (RHEA:20273) [EC 1.14.16.1] (PubMed:18460651)`,
        '**Cofactors:**',
        '- Fe(2+) (CHEBI:29033) (UniProtKB:P04176)',
        '**Disease:**',
        `- Phenylalanine hydroxylase deficiency (PAH deficiency) [OMIM:261600] [DI-02159]: ${RAW_ENTRIES.pah.comments[3].disease.description}`,
        '**Variants:** 3 natural variant(s)',
        '- 16 S→P [VAR_000869]: in PAH deficiency; severe; uncertain significance; dbSNP:rs62642946',
        '- 63..64 TH→PN [VAR_000881]: in PAH deficiency; severe; abolishes phenylalanine binding',
        '- 39 [VAR_000871]: in PAH deficiency; severe',
        '**PTMs:** 1',
        '- Modified residue @16: Phosphoserine; by PKA',
        '**Domains/regions:**',
        '- Domain 36..114: ACT',
        '**GO:** GO:0005829 [C] cytosol (TAS:Reactome); GO:0005506 [F] iron ion binding (IEA:InterPro)',
        '**Keywords:** 3D-structure (KW-0002) — Technical term, Allosteric enzyme (KW-0021) — Molecular function',
        '**Cross-references:**',
        '- `PDB`: `1DMW`, `1J8T`',
        '- `RefSeq`: `NP_000268.1`',
        '- `ChEMBL`: `CHEMBL3076`',
        '- `Ensembl`: `ENST00000553106.6`',
      ]),
    );
    // P04637 — synonyms, locations, isoforms, a region, and only the disease that carries a block.
    expect(lines).toEqual(
      expect.arrayContaining([
        '# Cellular tumor antigen p53 (P04637)',
        '**Genes:** TP53, P53',
        '**Subcellular location:**',
        '- Cytoplasm (PubMed:15340061)',
        '- Nucleus (PubMed:15340061)',
        '**Isoforms:** P04637-1 (1; synonyms p53, p53alpha) [Displayed], P04637-2 (2; synonyms I9RET, p53beta) [Described]',
        '- Esophageal cancer (ESCR) [OMIM:133239] [DI-01537]: A malignancy of the esophagus. — The disease is caused by variants affecting the gene represented in this entry',
        '- Region 100..370: Interaction with HIPK1',
        '- Modified residue @9: Phosphoserine; by HIPK4',
      ]),
    );
    // P08100 — a location with its membrane topology and the location's own evidence.
    expect(lines).toContain(
      '- Photoreceptor outer segment membrane (Multi-pass membrane protein) (PubMed:25664179)',
    );
    expect(contentText(result)).not.toContain('undefined');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('renders range PTMs from a caller fields projection with their span, and no text for an empty description', async () => {
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search'
        ? upstreamResponse(200, { results: [RAW_ENTRIES.insulin] })
        : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));

    const result = await runToolContract(getEntry, {
      accessions: ['P01308'],
      fields: 'ft_disulfid',
    });

    expect(result.isError).toBeFalsy();
    const lines = contentText(result).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        '# Insulin (P01308)',
        '**PTMs:** 2',
        '- Disulfide bond @31..96: Interchain (between B and A chains)',
        '- Disulfide bond @95..100',
      ]),
    );
    const [url] = requestedUrls(fetchStub);
    expect(url?.searchParams.get('fields')?.split(',')).toContain('ft_disulfid');
  });
});

/** UniProt's sequence flag (`proteinDescription.flag`), as rest.uniprot.org sent it on 2026-11-23. */
describe('getEntry sequence flags (real service, through runToolContract)', () => {
  type Out = { kind: string; succeeded: Entry[] };
  const flagged = (accession: string, length: number, flag?: string) => ({
    ...activeRawEntry(accession, `${accession}_TEST`, length),
    proteinDescription: {
      recommendedName: { fullName: { value: `Protein ${accession}` } },
      ...(flag ? { flag } : {}),
    },
    comments: [{ commentType: 'FUNCTION', texts: [{ value: 'Binds things.' }] }],
  });
  const serve = (...rows: object[]) => {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
  };

  it('qualifies a flagged entry’s length on both surfaces, and leaves an unflagged one bare', async () => {
    serve(
      flagged('O35116', 264, 'Fragment'),
      flagged('P13838', 378, 'Fragment,Precursor'),
      flagged('P04637', 393),
    );
    const result = await runToolContract(getEntry, { accessions: ['O35116', 'P13838', 'P04637'] });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Out;
    expect(out.succeeded.map((e) => [e.accession, e.sequenceFlags])).toEqual([
      ['O35116', ['Fragment']],
      ['P13838', ['Fragment', 'Precursor']],
      ['P04637', undefined],
    ]);
    expect(out.succeeded[2]).not.toHaveProperty('sequenceFlags');
    expect(
      contentText(result)
        .split('\n')
        .filter((line) => line.startsWith('Reviewed (Swiss-Prot)')),
    ).toEqual([
      'Reviewed (Swiss-Prot) · Score 5/5 · 264 aa (Fragment) · 1: Evidence at protein level',
      'Reviewed (Swiss-Prot) · Score 5/5 · 378 aa (Fragment, Precursor) · 1: Evidence at protein level',
      'Reviewed (Swiss-Prot) · Score 5/5 · 393 aa · 1: Evidence at protein level',
    ]);
  });

  it('keeps the flags beside length on a sections re-call, as identity', async () => {
    serve(flagged('O35116', 264, 'Fragment'));
    const result = await runToolContract(getEntry, {
      accessions: ['O35116'],
      sections: ['function'],
    });

    expect(result.isError).toBeFalsy();
    const [entry] = (result.structuredContent as Out).succeeded;
    expect(entry).toMatchObject({ length: 264, sequenceFlags: ['Fragment'] });
    expect(contentText(result)).toContain(
      'Reviewed (Swiss-Prot) · Score 5/5 · 264 aa (Fragment) · 1: Evidence at protein level',
    );
  });
});

/**
 * Feature locations in UniProt's notation, over the rows in `feature-locations.json`
 * (see `featureLocationRow` in tests/helpers.ts): each case of the one span formatter on
 * content[], beside the location fields structuredContent carries, once per render path —
 * featureLine (processing, topology, sites, domains), PTM rows, and residue changes.
 */
describe('getEntry feature locations (#46, real service over captured rows, through runToolContract)', () => {
  type Out = { kind: string; succeeded: Entry[] };

  /** Run the tool through the real service, the batch search answering with these rows. */
  async function call(input: Record<string, unknown>, ...rows: object[]) {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const result = await runToolContract(getEntry, input as never);
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Out;
    return {
      entry: (accession: string) => out.succeeded.find((e) => e.accession === accession),
      lines: contentText(result).split('\n'),
    };
  }

  it('renders an UNSURE, OUTSIDE, or UNKNOWN bound in UniProt notation, with its modifier on structuredContent', async () => {
    const { entry, lines } = await call(
      { accessions: ['O75339', 'O35116', 'O43240', 'O00533', 'P35573'] },
      featureLocationRow('O75339'),
      featureLocationRow('O35116'),
      featureLocationRow('O43240'),
      featureLocationRow('O00533'),
      featureLocationRow('P35573'),
    );

    expect(entry('O75339')?.processing?.map((f) => f.location)).toStrictEqual([
      { start: 1, end: 21 },
      { start: 22, end: 724, endModifier: 'UNSURE' },
      { start: 725, end: 1184, startModifier: 'UNSURE' },
    ]);
    expect(entry('O35116')?.processing?.[0]?.location).toStrictEqual({
      start: 1,
      end: 264,
      startModifier: 'OUTSIDE',
      endModifier: 'OUTSIDE',
    });
    expect(entry('O43240')?.ptms?.[0]?.location).toStrictEqual({
      end: 263,
      startModifier: 'UNKNOWN',
    });
    expect(entry('O00533')?.processing?.[0]?.location).toStrictEqual({
      start: 25,
      endModifier: 'UNKNOWN',
    });
    expect(entry('P35573')?.domains?.map((f) => f.location)).toStrictEqual([
      { start: 1, endModifier: 'UNKNOWN' },
      { end: 1532, startModifier: 'UNKNOWN' },
    ]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '- Signal 1..21',
        '- Chain 22..?724 [PRO_0000014672]: Cartilage intermediate layer protein 1 C1',
        '- Chain ?725..1184 [PRO_0000014673]: Cartilage intermediate layer protein 1 C2',
        '- Chain <1..>264 [PRO_0000064301]: Catenin delta-2',
        '- Disulfide bond @?..263',
        '- Chain 25..? [PRO_0000314777]: Processed neural cell adhesion molecule L1-like protein',
        '- Region 1..?: 4-alpha-glucanotransferase',
        '- Region ?..1532: Amylo-1,6-glucosidase',
      ]),
    );
  });

  it('prefixes a position numbered on an isoform with that isoform, in PTMs, variants, and mutagenesis', async () => {
    const { entry, lines } = await call(
      {
        accessions: ['O00139', 'A2RU49', 'O15294'],
        fields: 'accession,ft_mod_res,ft_variant,ft_mutagen',
      },
      featureLocationRow('O00139'),
      featureLocationRow('A2RU49'),
      featureLocationRow('O15294'),
    );

    expect(entry('O00139')?.ptms?.map((f) => f.location)).toStrictEqual([
      { start: 556, end: 556, isoform: 'O00139-4' },
      { start: 573, end: 573, isoform: 'O00139-4' },
    ]);
    expect(entry('A2RU49')?.variants?.[0]?.location).toStrictEqual({
      start: 165,
      end: 165,
      isoform: 'A2RU49-2',
    });
    expect(entry('O15294')?.mutagenesis?.[0]?.location).toStrictEqual({
      start: 10,
      end: 10,
      isoform: 'O15294-4',
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        '- Modified residue @O00139-4:556: Phosphoserine',
        '- Modified residue @O00139-4:573: Phosphoserine',
        '- A2RU49-2:165 V→I [VAR_082892]: in dbSNP:4380026',
        '- O15294-4:10 S→A: Does not affect global auto-O-GlcNAcylation.',
      ]),
    );
  });

  it('renders OUTSIDE bounds on membrane topology and a binding site, and a one-residue span once', async () => {
    const { entry, lines } = await call(
      { accessions: ['O70431', 'P05207', 'Q16739'] },
      featureLocationRow('O70431'),
      featureLocationRow('P05207'),
      featureLocationRow('Q16739'),
    );

    expect(entry('O70431')?.topology?.map((f) => f.location)).toStrictEqual([
      { start: 1, end: 21, startModifier: 'OUTSIDE' },
      { start: 232, end: 251, endModifier: 'OUTSIDE' },
    ]);
    expect(entry('P05207')?.sites?.[0]?.location).toStrictEqual({
      start: 82,
      end: 155,
      endModifier: 'OUTSIDE',
    });
    expect(entry('Q16739')?.domains?.[0]?.location).toStrictEqual({ start: 144, end: 144 });
    expect(lines).toEqual(
      expect.arrayContaining([
        '- Transmembrane <1..21: Helical; Name=2',
        '- Transmembrane 232..>251: Helical; Name=7',
        "- Binding site 82..>155 — 3',5'-cyclic AMP (CHEBI:58165) label 1",
        '- Motif 144: D2',
      ]),
    );
  });

  it('renders both bounds of a one-residue span whose modifier marks one side only', async () => {
    const row = featureLocationRow('Q16739');
    const motif = required(row.features[0], 'the Q16739 motif');
    const { entry, lines } = await call(
      { accessions: ['Q16739'] },
      {
        ...row,
        features: [
          { ...motif, location: { ...motif.location, start: { value: 144, modifier: 'UNSURE' } } },
          { ...motif, location: { ...motif.location, end: { value: 144, modifier: 'OUTSIDE' } } },
        ],
      },
    );

    expect(entry('Q16739')?.domains?.map((f) => f.location)).toStrictEqual([
      { start: 144, end: 144, startModifier: 'UNSURE' },
      { start: 144, end: 144, endModifier: 'OUTSIDE' },
    ]);
    expect(lines).toEqual(
      expect.arrayContaining(['- Motif ?144..144: D2', '- Motif 144..>144: D2']),
    );
  });

  it('keeps a modifier outside UniProt’s three as written, naming it after the span on content[]', async () => {
    const row = featureLocationRow('O75339');
    const c2 = required(row.features[2], 'the O75339 C2 chain');
    const { entry, lines } = await call(
      { accessions: ['O75339'] },
      {
        ...row,
        features: [
          { ...c2, location: { ...c2.location, start: { value: 725, modifier: 'APPROXIMATE' } } },
        ],
      },
    );

    expect(entry('O75339')?.processing?.[0]?.location).toStrictEqual({
      start: 725,
      end: 1184,
      startModifier: 'APPROXIMATE',
    });
    expect(lines).toContain(
      '- Chain ?725..1184 (start modifier APPROXIMATE) [PRO_0000014673]: Cartilage intermediate layer protein 1 C2',
    );
  });

  it('names an unmarked end modifier after the span too, alone or beside the start’s', async () => {
    const row = featureLocationRow('O75339');
    const signal = required(row.features[0], 'the O75339 signal');
    const c1 = required(row.features[1], 'the O75339 C1 chain');
    const { entry, lines } = await call(
      { accessions: ['O75339'] },
      {
        ...row,
        features: [
          {
            ...signal,
            location: {
              start: { value: 1, modifier: 'APPROXIMATE' },
              end: { value: 21, modifier: 'APPROXIMATE' },
            },
          },
          { ...c1, location: { ...c1.location, end: { value: 724, modifier: 'APPROXIMATE' } } },
        ],
      },
    );

    expect(entry('O75339')?.processing?.map((f) => f.location)).toStrictEqual([
      { start: 1, end: 21, startModifier: 'APPROXIMATE', endModifier: 'APPROXIMATE' },
      { start: 22, end: 724, endModifier: 'APPROXIMATE' },
    ]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '- Signal ?1..?21 (start modifier APPROXIMATE, end modifier APPROXIMATE)',
        '- Chain 22..?724 (end modifier APPROXIMATE) [PRO_0000014672]: Cartilage intermediate layer protein 1 C1',
      ]),
    );
  });
});

/**
 * The residue input (#48), through the real service over the rows in `residue-coverage.json`
 * (see `residueCoverageRow` in tests/helpers.ts) and `feature-locations.json`: the rows each
 * position-bearing section keeps, residueCoverage and the section headings on both surfaces,
 * the cut ahead of the window and the outline budget, and the two residue errors. The coverage
 * rule itself is tabled once, in tests/services/residue-coverage.test.ts.
 */
describe('getEntry residue (#48, real service over captured rows, through runToolContract)', () => {
  type Coverage = {
    residue: number;
    sections: { section: string; covered: number; excluded: number; total: number }[];
  };
  type Out = Record<string, unknown> & {
    kind: string;
    succeeded?: Entry[];
    sections?: { name: string; bytes: number }[];
    residueCoverage?: Coverage;
    notice?: string;
  };

  /** Run the tool through the real service, the batch search answering with these rows. */
  async function call(input: Record<string, unknown>, ...rows: object[]) {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const result = await runToolContract(getEntry, input as never);
    const text = contentText(result);
    return { result, out: result.structuredContent as Out, text, lines: text.split('\n') };
  }

  /** A successful call and its one record. */
  async function entryAt(input: Record<string, unknown>, ...rows: object[]) {
    const run = await call(input, ...rows);
    expect(run.result.isError).toBeFalsy();
    return { ...run, entry: required(run.out.succeeded?.[0], 'the returned record') };
  }

  /** UTF-8 bytes of a value as the outline sizes it. */
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

  const p53 = residueCoverageRow('P04637');

  /** P04637's natural variants at R175, normalized, in UniProt order. */
  const VARIANTS_175 = [
    ['VAR_005928', 'C'],
    ['VAR_005929', 'G'],
    ['VAR_005932', 'H'],
    ['VAR_005930', 'L'],
    ['VAR_005931', 'P'],
    ['VAR_044916', 'Q'],
    ['VAR_044917', 'S'],
  ].map(([featureId, variation]) => ({
    location: { start: 175, end: 175 },
    original: 'R',
    variation,
    featureId,
  }));
  const VARIANT_IDS_175 = VARIANTS_175.map((v) => v.featureId);

  /** P04637's DNA-binding region and the five interaction regions spanning 175, in UniProt order. */
  const DOMAINS_175 = [
    { type: 'DNA binding', location: { start: 102, end: 292 } },
    ...(
      [
        [1, 320, 'Interaction with CCAR2'],
        [100, 370, 'Interaction with HIPK1'],
        [100, 300, 'Required for interaction with ZNF385A'],
        [113, 236, 'Required for interaction with FBXO42'],
        [116, 292, 'Interaction with AXIN1'],
      ] as const
    ).map(([start, end, description]) => ({
      type: 'Region',
      description,
      location: { start, end },
    })),
  ];

  it('keeps the variants and domains covering P04637 R175, with residueCoverage, on both surfaces', async () => {
    const { out, entry, lines } = await entryAt(
      { accessions: ['P04637'], residue: 175, sections: ['variants', 'domains'] },
      p53,
    );

    expect(entry.variants).toStrictEqual(VARIANTS_175);
    expect(entry.domains).toStrictEqual(DOMAINS_175);
    expect(entry).not.toHaveProperty('ptms');
    expect(out.residue).toBe(175);
    expect(out.residueCoverage).toStrictEqual({
      residue: 175,
      sections: [
        { section: 'variants', covered: 7, excluded: 0, total: 1363 },
        { section: 'domains', covered: 6, excluded: 0, total: 26 },
      ],
    });
    expect(out).not.toHaveProperty('absentSections');
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Variants:** 7 natural variant(s) covering residue 175',
        ...VARIANTS_175.map((v) => `- 175 R→${v.variation} [${v.featureId}]`),
        '**Domains/regions:** covering residue 175',
        '- DNA binding 102..292',
        '- Region 1..320: Interaction with CCAR2',
        '- Region 100..370: Interaction with HIPK1',
        '- Region 100..300: Required for interaction with ZNF385A',
        '- Region 113..236: Required for interaction with FBXO42',
        '- Region 116..292: Interaction with AXIN1',
        '**Residue 175 coverage:** variants 7 of 1363 rows; domains 6 of 26 rows',
      ]),
    );
    // Only covering rows render: the neighbors at 176..177 and 169..170 are cut.
    expect(lines.filter((line) => /^- \d/.test(line))).toHaveLength(7);
    expect(lines.filter((line) => line.startsWith('- Region '))).toHaveLength(5);
  });

  it('keeps only the Zn(2+) binding site at P04637 176', async () => {
    const { out, entry, lines } = await entryAt(
      { accessions: ['P04637'], residue: 176, sections: ['sites'] },
      p53,
    );

    expect(entry.sites).toStrictEqual([
      {
        type: 'Binding site',
        location: { start: 176, end: 176 },
        ligand: { name: 'Zn(2+)', chebiId: 'CHEBI:29105' },
      },
    ]);
    expect(out.residueCoverage).toStrictEqual({
      residue: 176,
      sections: [{ section: 'sites', covered: 1, excluded: 0, total: 5 }],
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Sites:** 1 covering residue 176',
        '- Binding site 176 — Zn(2+) (CHEBI:29105)',
        '**Residue 176 coverage:** sites 1 of 5 rows',
      ]),
    );
  });

  it.each([
    [
      52,
      { type: 'Disulfide bond', location: { start: 52, end: 162 } },
      '- Disulfide bond @52..162',
    ],
    [
      263,
      { type: 'Disulfide bond', location: { end: 263, startModifier: 'UNKNOWN' } },
      '- Disulfide bond @?..263',
    ],
  ])('keeps the O43240 disulfide bond bonded at residue %i', async (residue, bond, line) => {
    const { out, entry, lines } = await entryAt(
      { accessions: ['O43240'], residue, sections: ['ptms'] },
      residueCoverageRow('O43240'),
    );

    expect(entry.ptms).toStrictEqual([bond]);
    expect(out.residueCoverage).toStrictEqual({
      residue,
      sections: [{ section: 'ptms', covered: 1, excluded: 0, total: 7 }],
    });
    expect(lines).toEqual(
      expect.arrayContaining([`**PTMs:** 1 covering residue ${residue}`, line]),
    );
  });

  it('leaves out a section no row covers — O43240 residue 100, between the 52..162 bond’s partners — without calling it absent', async () => {
    const { out, entry, text, lines } = await entryAt(
      { accessions: ['O43240'], residue: 100, sections: ['ptms'] },
      residueCoverageRow('O43240'),
    );

    expect(entry).not.toHaveProperty('ptms');
    expect(entry).toMatchObject({ accession: 'O43240', entryName: 'KLK10_HUMAN', length: 276 });
    expect(out).not.toHaveProperty('absentSections');
    expect(out.residueCoverage).toStrictEqual({
      residue: 100,
      sections: [{ section: 'ptms', covered: 0, excluded: 0, total: 7 }],
    });
    expect(text).not.toContain('**PTMs:**');
    expect(text).not.toContain('Absent sections');
    expect(lines).toContain('**Residue 100 coverage:** ptms 0 of 7 rows');
  });

  it('keeps the O75339 chains ending at an UNSURE 724 with their modifier, not the one starting at an UNSURE 725', async () => {
    const { out, entry, text, lines } = await entryAt(
      { accessions: ['O75339'], residue: 724, sections: ['processing'] },
      residueCoverageRow('O75339'),
    );

    expect(entry.processing).toStrictEqual([
      {
        type: 'Chain',
        description: 'Cartilage intermediate layer protein 1',
        location: { start: 22, end: 1184 },
        featureId: 'PRO_0000014671',
      },
      {
        type: 'Chain',
        description: 'Cartilage intermediate layer protein 1 C1',
        location: { start: 22, end: 724, endModifier: 'UNSURE' },
        featureId: 'PRO_0000014672',
      },
    ]);
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'processing', covered: 2, excluded: 0, total: 4 },
    ]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Processing:** covering residue 724',
        '- Chain 22..1184 [PRO_0000014671]: Cartilage intermediate layer protein 1',
        '- Chain 22..?724 [PRO_0000014672]: Cartilage intermediate layer protein 1 C1',
        '**Residue 724 coverage:** processing 2 of 4 rows',
      ]),
    );
    expect(text).not.toContain('PRO_0000014673');
  });

  it('cuts the default record, without sections: O35116 residue 1 keeps its chain with both OUTSIDE bounds', async () => {
    const { out, entry, lines } = await entryAt(
      { accessions: ['O35116'], residue: 1 },
      featureLocationRow('O35116'),
    );

    expect(out.kind).toBe('full');
    expect(entry.processing).toStrictEqual([
      {
        type: 'Chain',
        description: 'Catenin delta-2',
        location: { start: 1, end: 264, startModifier: 'OUTSIDE', endModifier: 'OUTSIDE' },
        featureId: 'PRO_0000064301',
      },
    ]);
    expect(out.residue).toBe(1);
    expect(out.residueCoverage).toStrictEqual({
      residue: 1,
      sections: [{ section: 'processing', covered: 1, excluded: 0, total: 1 }],
    });
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Processing:** covering residue 1',
        '- Chain <1..>264 [PRO_0000064301]: Catenin delta-2',
        '**Residue 1 coverage:** processing 1 of 1 rows',
      ]),
    );
  });

  it('cuts every position-bearing section of the default record: O75339 residue 1 keeps only its signal', async () => {
    const { out, entry } = await entryAt(
      { accessions: ['O75339'], residue: 1 },
      residueCoverageRow('O75339'),
    );

    expect(entry.processing?.map((f) => f.type)).toEqual(['Signal']);
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'processing', covered: 1, excluded: 0, total: 4 },
    ]);
  });

  it('counts the O00533 chain with an UNKNOWN end as excluded, keeping the chain that spans residue 30', async () => {
    const { out, entry, lines } = await entryAt(
      { accessions: ['O00533'], residue: 30, sections: ['processing'] },
      residueCoverageRow('O00533'),
    );

    expect(entry.processing).toStrictEqual([
      {
        type: 'Chain',
        description: 'Neural cell adhesion molecule L1-like protein',
        location: { start: 25, end: 1208 },
        featureId: 'PRO_0000247896',
      },
    ]);
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'processing', covered: 1, excluded: 1, total: 3 },
    ]);
    expect(lines).toContain(
      '**Residue 30 coverage:** processing 1 of 3 rows, 1 excluded (no canonical position)',
    );
  });

  it('counts the O00139 phosphoserines numbered on O00139-4 as excluded, so residue 556 keeps no PTM', async () => {
    const { out, entry, lines } = await entryAt(
      { accessions: ['O00139'], residue: 556, sections: ['ptms'] },
      residueCoverageRow('O00139'),
    );

    expect(entry).not.toHaveProperty('ptms');
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'ptms', covered: 0, excluded: 2, total: 9 },
    ]);
    expect(lines).toContain(
      '**Residue 556 coverage:** ptms 0 of 9 rows, 2 excluded (no canonical position)',
    );
  });

  it('cuts an on-request section: the O15294 mutagenesis row numbered on O15294-4 is excluded', async () => {
    const { out, entry } = await entryAt(
      { accessions: ['O15294'], residue: 10, sections: ['mutagenesis'] },
      featureLocationRow('O15294'),
    );

    expect(entry).not.toHaveProperty('mutagenesis');
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'mutagenesis', covered: 0, excluded: 1, total: 1 },
    ]);
  });

  it('lists no section when the named sections carry no position, and still checks the range', async () => {
    const { out, lines } = await entryAt(
      { accessions: ['O75339'], residue: 724, sections: ['keywords'] },
      residueCoverageRow('O75339'),
    );

    expect(out.residueCoverage).toStrictEqual({ residue: 724, sections: [] });
    expect(out.absentSections).toEqual(['keywords']);
    expect(lines).toContain('**Residue 724 coverage:** no position-bearing section was filtered');

    const past = await call(
      { accessions: ['O75339'], residue: 1185, sections: ['keywords'] },
      residueCoverageRow('O75339'),
    );
    expect(errorEnvelope(past.result).data).toMatchObject({ reason: 'residue_out_of_range' });
  });

  it('windows the covering rows, not the section: P04637 residue 175 pages its 7 variants 5 at a time', async () => {
    const pages: (string | undefined)[][] = [];
    let offset: number | undefined = 0;
    // Bounded, so a nextOffset that never clears fails instead of hanging the suite.
    while (offset !== undefined && pages.length < 3) {
      const { out, entry } = await entryAt(
        {
          accessions: ['P04637'],
          residue: 175,
          sections: ['variants'],
          section_limit: 5,
          section_offset: offset,
        },
        p53,
      );
      expect(out.totalCount).toBe(7);
      expect(out.residueCoverage?.sections).toStrictEqual([
        { section: 'variants', covered: 7, excluded: 0, total: 1363 },
      ]);
      pages.push((entry.variants ?? []).map((v) => v.featureId));
      offset = out.nextOffset as number | undefined;
    }
    expect(pages).toEqual([VARIANT_IDS_175.slice(0, 5), VARIANT_IDS_175.slice(5)]);
  });

  it('discloses the first window of covering rows on both surfaces, keeping residue in the paging guidance', async () => {
    const { out, text, lines } = await entryAt(
      { accessions: ['P04637'], residue: 175, sections: ['variants'], section_limit: 5 },
      p53,
    );

    expect(out).toMatchObject({
      kind: 'full',
      window: { section: 'variants', offset: 0 },
      residue: 175,
      totalCount: 7,
      truncated: true,
      shown: 5,
      cap: 5,
      nextOffset: 5,
    });
    expect(out.notice).toContain(
      '2 of 7 items in variants covering residue 175 remain. Re-call with section_offset:5 (same section_limit and residue) for the next window.',
    );
    expect(text).toContain(out.notice as string);
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Variants:** 5 natural variant(s) covering residue 175 in this window',
        '**Next section_offset:** 5',
        '**Residue 175 coverage:** variants 7 of 1363 rows',
      ]),
    );
    expect(text).toContain('items 1–5');
  });

  it.each([7, 10])(
    'returns an empty window at section_offset %i, past the 7 covering variants though the section holds 1,363',
    async (offset) => {
      const { out, entry, text } = await entryAt(
        {
          accessions: ['P04637'],
          residue: 175,
          sections: ['variants'],
          section_limit: 5,
          section_offset: offset,
        },
        p53,
      );

      expect(entry.variants).toEqual([]);
      expect(out.totalCount).toBe(7);
      expect(out).not.toHaveProperty('nextOffset');
      expect(out).not.toHaveProperty('truncated');
      expect(out.notice).toBe(
        `section_offset ${offset} is past the end of variants, which holds 7 item(s) covering residue 175 — page with section_offset below 7, keeping residue.`,
      );
      expect(text).toContain(out.notice as string);
      expect(text).toContain(`no items at section_offset ${offset}`);
    },
  );

  it('windows a section the cut emptied to totalCount 0, with no paging notice', async () => {
    const { out, entry } = await entryAt(
      { accessions: ['P04637'], residue: 175, sections: ['sites'], section_limit: 5 },
      p53,
    );

    expect(entry).not.toHaveProperty('sites');
    expect(out.totalCount).toBe(0);
    expect(out).not.toHaveProperty('notice');
    expect(out).not.toHaveProperty('absentSections');
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'sites', covered: 0, excluded: 0, total: 5 },
    ]);
  });

  it('inlines a record over budget whole once the cut fits: P04637 residue 175 without sections', async () => {
    // The uncut record, its 1,363 variants included, outlines on its own.
    const whole = await call({ accessions: ['P04637'] }, p53);
    expect(whole.result.isError).toBeFalsy();
    expect(whole.out.kind).toBe('outline');

    const { result, out, lines } = await call({ accessions: ['P04637'], residue: 175 }, p53);
    expect(result.isError).toBeFalsy();
    expect(out.kind).toBe('full');
    const entry = required(out.succeeded?.[0], 'the returned record');
    expect(entry.variants).toStrictEqual(VARIANTS_175);
    expect(entry.domains).toStrictEqual(DOMAINS_175);
    expect(entry.processing).toStrictEqual([
      {
        type: 'Chain',
        description: 'Cellular tumor antigen p53',
        location: { start: 1, end: 393 },
        featureId: 'PRO_0000185703',
      },
    ]);
    expect(entry).not.toHaveProperty('sites');
    expect(entry).not.toHaveProperty('ptms');
    expect(out.residue).toBe(175);
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Variants:** 7 natural variant(s) covering residue 175',
        '**Residue 175 coverage:** sites 0 of 5 rows; ptms 0 of 36 rows; processing 1 of 1 rows; variants 7 of 1363 rows; domains 6 of 26 rows',
      ]),
    );
  });

  it('outlines a cut record still over budget, sizing its covering rows and keeping residue in the re-call', async () => {
    // P04637's comments and GO terms outweigh the budget on their own; one long comment stands in.
    const heavy = {
      ...p53,
      comments: [{ commentType: 'MISCELLANEOUS', texts: [{ value: 'x'.repeat(30_000) }] }],
    };
    const { result, out, text, lines } = await call(
      { accessions: ['P04637'], residue: 175 },
      heavy,
    );

    expect(result.isError).toBeFalsy();
    expect(out.kind).toBe('outline');
    const sizes = new Map((out.sections ?? []).map((s) => [s.name, s.bytes]));
    const chain = {
      type: 'Chain',
      description: 'Cellular tumor antigen p53',
      location: { start: 1, end: 393 },
      featureId: 'PRO_0000185703',
    };
    expect(sizes.get('variants')).toBe(bytes(VARIANTS_175));
    expect(sizes.get('domains')).toBe(bytes(DOMAINS_175));
    expect(sizes.get('processing')).toBe(bytes([chain]));
    expect(sizes.has('sites')).toBe(false);
    expect(sizes.has('ptms')).toBe(false);
    expect(out.residue).toBe(175);
    expect(out.residueCoverage).toStrictEqual({
      residue: 175,
      sections: [
        { section: 'sites', covered: 0, excluded: 0, total: 5 },
        { section: 'ptms', covered: 0, excluded: 0, total: 36 },
        { section: 'processing', covered: 1, excluded: 0, total: 1 },
        { section: 'variants', covered: 7, excluded: 0, total: 1363 },
        { section: 'domains', covered: 6, excluded: 0, total: 26 },
      ],
    });
    expect(out.notice).toBe(
      'Re-call with accessions:["P04637"], residue:175, and sections:[...] to retrieve selected sections; use section_limit and section_offset for one list section.',
    );
    expect(text).toContain(out.notice as string);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Position-bearing section sizes count only the rows covering residue 175.',
        `- **variants** — ${bytes(VARIANTS_175)} bytes`,
        '**Residue 175 coverage:** sites 0 of 5 rows; ptms 0 of 36 rows; processing 1 of 1 rows; variants 7 of 1363 rows; domains 6 of 26 rows',
      ]),
    );

    // The same record without residue outlines every variant, and says nothing of a residue.
    const whole = await call({ accessions: ['P04637'] }, heavy);
    const wholeSizes = new Map((whole.out.sections ?? []).map((s) => [s.name, s.bytes]));
    expect(wholeSizes.get('variants')).toBeGreaterThan(100 * bytes(VARIANTS_175));
    expect(whole.out).not.toHaveProperty('residue');
    expect(whole.out).not.toHaveProperty('residueCoverage');
    expect(whole.text).not.toContain('residue');
  });

  it('returns a call without residue unchanged: no residue, no residueCoverage, unqualified headings', async () => {
    const { out, entry, text, lines } = await entryAt(
      { accessions: ['P04637'], sections: ['variants', 'domains'] },
      p53,
    );

    expect(entry.variants).toHaveLength(1363);
    expect(entry.domains).toHaveLength(26);
    expect(out).not.toHaveProperty('residue');
    expect(out).not.toHaveProperty('residueCoverage');
    expect(lines).toEqual(
      expect.arrayContaining(['**Variants:** 1363 natural variant(s)', '**Domains/regions:**']),
    );
    expect(text).not.toContain('covering residue');
  });

  it('accepts the last residue: P04637 residue 393 keeps the regions running to its C-terminus', async () => {
    const { out, entry } = await entryAt(
      { accessions: ['P04637'], residue: 393, sections: ['domains'] },
      p53,
    );

    expect(entry.domains?.map((d) => d.description)).toEqual([
      'Interaction with CARM1',
      'Disordered',
      'Interaction with MORN3',
    ]);
    expect(out.residueCoverage?.sections).toStrictEqual([
      { section: 'domains', covered: 3, excluded: 0, total: 26 },
    ]);
  });

  it('rejects a residue past the canonical length as residue_out_of_range, naming the length on both surfaces', async () => {
    const { result } = await call(
      { accessions: ['P04637'], residue: 394, sections: ['variants'] },
      p53,
    );

    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(envelope.message).toBe(
      'residue 394 is past the end of P04637: its canonical sequence has 393 residues. Pass a residue from 1 to 393.',
    );
    expect(envelope.data).toMatchObject({
      reason: 'residue_out_of_range',
      residue: 394,
      length: 393,
      recovery: {
        hint: 'Pass a residue from 1 to the length the message names, numbered on the canonical sequence.',
      },
    });
    const text = contentText(result);
    expect(text).toContain('its canonical sequence has 393 residues');
    expect(text).toContain(
      'Pass a residue from 1 to the length the message names, numbered on the canonical sequence.',
    );
    expect(text).toContain('(reason residue_out_of_range');
  });

  it.each([
    ['two accessions', ['P04637', 'P38398']],
    ['a repeated accession', ['P04637', 'P04637']],
  ])(
    'rejects residue with %s as residue_single_accession, before any request',
    async (_case, accessions) => {
      const result = await runToolContract(getEntry, { accessions, residue: 175 });

      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(envelope.message).toBe(
        'residue cuts one record, but 2 accessions were passed. Re-call one accession at a time with residue.',
      );
      expect(envelope.data).toMatchObject({
        reason: 'residue_single_accession',
        recovery: {
          hint: 'Re-call one accession at a time with residue, or drop residue for the batch.',
        },
      });
      const text = contentText(result);
      expect(text).toContain(
        'Re-call one accession at a time with residue, or drop residue for the batch.',
      );
      expect(text).toContain('(reason residue_single_accession');
      expect(text).not.toContain('sections');
      expect(getEntriesMock).not.toHaveBeenCalled();
    },
  );

  it('checks sections first: a batch passing both fails sections_single_accession', async () => {
    const result = await runToolContract(getEntry, {
      accessions: ['P04637', 'P38398'],
      residue: 175,
      sections: ['variants'],
    });
    expect(errorEnvelope(result).data).toMatchObject({ reason: 'sections_single_accession' });
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it.each([
    ['residue 0', 0],
    ['a negative residue', -1],
    ['a fractional residue', 1.5],
  ])('rejects %s at the schema edge', async (_case, residue) => {
    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      residue,
    } as never);
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.data).toMatchObject({ reason: 'invalid_arguments' });
    expect(getEntriesMock).not.toHaveBeenCalled();
  });

  it('fails an unknown accession with residue as all_not_found, before any range check', async () => {
    const { result } = await call({ accessions: ['Q00000'], residue: 1 });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
    expect(envelope.data).toMatchObject({ reason: 'all_not_found' });
  });
});

describe('getEntry molecule, row evidence, and comment notes (#45, real service, through runToolContract)', () => {
  const row = (accession: string) =>
    required(
      qualifiedComments.results.find((r) => r.primaryAccession === accession),
      `the ${accession} fixture row`,
    );
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');

  type Out = {
    kind: string;
    succeeded: Entry[];
    failed: unknown[];
    window?: { section: string; offset: number };
    totalCount?: number;
    nextOffset?: number;
  };

  /** Run the tool through the real service, the batch search answering with these raw rows. */
  async function call(input: Record<string, unknown>, ...rows: object[]) {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const result = await runToolContract(getEntry, input as never);
    expect(result.isError).toBeFalsy();
    const text = contentText(result);
    return { out: result.structuredContent as Out, text, lines: text.split('\n') };
  }

  const P04637_CYTOPLASM_EVIDENCE = [
    'PubMed:15340061',
    'PubMed:17170702',
    'PubMed:19011621',
    'PubMed:19033443',
    'PubMed:21597459',
    'PubMed:22726440',
    'PubMed:22914926',
    'PubMed:24625977',
    'PubMed:26634371',
  ];
  const P04637_ZINC_EVIDENCE = [
    'PubMed:14534297',
    'PubMed:16793544',
    'PubMed:17015838',
    'PubMed:18650397',
    'PubMed:19515728',
    'PubMed:20142040',
    'PubMed:20364130',
  ];

  it('renders rows with no molecule or evidence one per line, with no label or stray marks', async () => {
    const { out, lines, text } = await call(
      {
        accessions: ['P07477'],
        sections: ['catalyticActivity', 'cofactors', 'subcellularLocation'],
      },
      p07477,
    );
    expect(out.succeeded[0]?.cofactors).toEqual([{ name: 'Ca(2+)', chebiId: 'CHEBI:29108' }]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Catalytic activity:**',
        '- Preferential cleavage: Arg-|-Xaa, Lys-|-Xaa. [EC 3.4.21.4]',
        '**Cofactors:**',
        '- Ca(2+) (CHEBI:29108)',
        '**Subcellular location:**',
        '- Secreted, extracellular space',
      ]),
    );
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('()');
  });

  it('returns each location’s molecule and evidence, and the location and cofactor notes as comments, on both surfaces', async () => {
    const { out, lines } = await call(
      { accessions: ['P04637'], sections: ['subcellularLocation', 'cofactors', 'comments'] },
      row('P04637'),
    );

    const [entry] = out.succeeded;
    const locations = entry?.subcellularLocation ?? [];
    expect(locations).toHaveLength(19);
    expect(locations[0]).toEqual({ location: 'Cytoplasm', evidence: P04637_CYTOPLASM_EVIDENCE });
    expect(locations.filter((l) => !l.molecule).map((l) => l.evidence?.length)).toEqual([
      9, 9, 3, 1, 3, 1,
    ]);
    expect(locations.filter((l) => l.molecule).map((l) => `${l.molecule}/${l.location}`)).toEqual([
      'Isoform 1/Nucleus',
      'Isoform 1/Cytoplasm',
      'Isoform 2/Nucleus',
      'Isoform 2/Cytoplasm',
      'Isoform 3/Nucleus',
      'Isoform 3/Cytoplasm',
      'Isoform 4/Nucleus',
      'Isoform 4/Cytoplasm',
      'Isoform 7/Nucleus',
      'Isoform 7/Cytoplasm',
      'Isoform 8/Nucleus',
      'Isoform 8/Cytoplasm',
      'Isoform 9/Cytoplasm',
    ]);
    expect(entry?.cofactors).toEqual([
      { name: 'Zn(2+)', chebiId: 'CHEBI:29105', evidence: P04637_ZINC_EVIDENCE },
    ]);
    const isoform4Note =
      'Predominantly nuclear but translocates to the cytoplasm following cell stress';
    expect(entry?.comments?.map((c) => c.type)).toEqual([
      'COFACTOR',
      ...Array(7).fill('SUBCELLULAR LOCATION'),
    ]);
    expect(entry?.comments?.[0]).toEqual({
      type: 'COFACTOR',
      value: 'Binds 1 zinc ion per subunit.',
      evidence: P04637_ZINC_EVIDENCE,
    });
    expect(entry?.comments?.[1]?.evidence).toEqual([
      'PubMed:12810724',
      'PubMed:22726440',
      'PubMed:24625977',
      'PubMed:27323408',
    ]);
    expect(entry?.comments?.[5]).toEqual({
      type: 'SUBCELLULAR LOCATION',
      value: isoform4Note,
      molecule: 'Isoform 4',
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        '**Subcellular location:**',
        `- Cytoplasm (${P04637_CYTOPLASM_EVIDENCE.join(', ')})`,
        '- Nucleus, PML body (PubMed:11025664, PubMed:12810724, PubMed:36108750)',
        '- Isoform 1: Nucleus (PubMed:23752197)',
        '- Isoform 1: Cytoplasm',
        '- Isoform 9: Cytoplasm',
        '**Cofactors:**',
        `- Zn(2+) (CHEBI:29105) (${P04637_ZINC_EVIDENCE.join(', ')})`,
        `- COFACTOR: Binds 1 zinc ion per subunit. (${P04637_ZINC_EVIDENCE.join(', ')})`,
        `- SUBCELLULAR LOCATION (Isoform 4): ${isoform4Note}`,
      ]),
    );
    expect(lines.filter((line) => line.startsWith('- Isoform '))).toHaveLength(13);
    expect(lines.filter((line) => line.startsWith('- SUBCELLULAR LOCATION'))).toHaveLength(7);
  });

  it('windows a molecule-qualified section so each windowed row still names its isoform', async () => {
    const { out, lines, text } = await call(
      {
        accessions: ['P04637'],
        sections: ['subcellularLocation'],
        section_limit: 2,
        section_offset: 6,
      },
      row('P04637'),
    );
    expect(out.succeeded[0]?.subcellularLocation).toEqual([
      { location: 'Nucleus', evidence: ['PubMed:23752197'], molecule: 'Isoform 1' },
      { location: 'Cytoplasm', molecule: 'Isoform 1' },
    ]);
    expect(out.totalCount).toBe(19);
    expect(out.nextOffset).toBe(8);
    expect(text).toContain('**Window:** `subcellularLocation` items 7–8 (section_offset 6)');
    expect(lines).toEqual(
      expect.arrayContaining(['- Isoform 1: Nucleus (PubMed:23752197)', '- Isoform 1: Cytoplasm']),
    );
    expect(text).not.toContain(P04637_CYTOPLASM_EVIDENCE.join(', '));
  });

  it('returns each FUNCTION text’s and each reaction’s molecule and evidence on both surfaces', async () => {
    const { out, lines } = await call(
      { accessions: ['O14975'], sections: ['function', 'catalyticActivity'] },
      row('O14975'),
    );

    const [entry] = out.succeeded;
    expect(entry?.function?.map((f) => f.molecule)).toEqual([undefined, 'Isoform 1', 'Isoform 2']);
    const reactions = entry?.catalyticActivity ?? [];
    expect(reactions.filter((r) => r.molecule === 'Isoform 1')).toHaveLength(13);
    expect(reactions.filter((r) => r.molecule === 'Isoform 2').map((r) => r.rheaId)).toEqual([
      'RHEA:38879',
    ]);
    expect(reactions.find((r) => r.rheaId === 'RHEA:36139')).toEqual({
      name: '(E)-hexadec-2-enoate + ATP + CoA = (2E)-hexadecenoyl-CoA + AMP + diphosphate',
      rheaId: 'RHEA:36139',
      evidence: ['PubMed:24269233'],
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        '**Function:**',
        '- Isoform 2: Exhibits long-chain fatty acids (LCFA) transport activity but lacks acyl CoA synthetase towards very long-chain fatty acids (PubMed:21768100)',
        '**Catalytic activity:**',
        '- Isoform 2: a fatty acid(in) = a fatty acid(out) (RHEA:38879) (PubMed:21768100)',
        '- Isoform 1: a long-chain fatty acid + ATP + CoA = a long-chain fatty acyl-CoA + AMP + diphosphate (RHEA:15421) [EC 6.2.1.3] (PubMed:10198260, PubMed:10749848, PubMed:11980911, PubMed:22022213, PubMed:20530735)',
        '- (E)-hexadec-2-enoate + ATP + CoA = (2E)-hexadecenoyl-CoA + AMP + diphosphate (RHEA:36139) (PubMed:24269233)',
      ]),
    );
    // 13 reactions and 1 FUNCTION text are about Isoform 1.
    expect(lines.filter((line) => line.startsWith('- Isoform 1: '))).toHaveLength(14);
  });

  it('returns function, reaction, and cofactor rows with their molecule and evidence across a batch, and a cofactor note as a comment', async () => {
    const { out, lines } = await call(
      { accessions: ['P68871', 'P00751', 'P00918', 'P19367'] },
      row('P68871'),
      row('P00751'),
      row('P00918'),
      row('P19367'),
    );

    expect(out.kind).toBe('full');
    const [hbb, cfb, ca2, hk1] = out.succeeded;
    expect(hbb?.function?.map((f) => f.molecule)).toEqual([undefined, undefined, 'Spinorphin']);
    expect(cfb?.cofactors?.map((c) => c.molecule)).toEqual([
      'Complement factor B Bb',
      'Complement factor B Bb',
    ]);
    // The 22 evidences P00918's Zn(2+) cofactor carries in the fixture, in UniProt order.
    const zincEvidence = [
      '11076507',
      '12499545',
      '1336460',
      '1433293',
      '1909891',
      '19583303',
      '3151019',
      '3151020',
      '7761440',
      '7803386',
      '7901850',
      '8218160',
      '8262987',
      '8331673',
      '8399159',
      '8431430',
      '8451242',
      '8482389',
      '8639494',
      '8987974',
      '9398308',
      '9865942',
    ].map((id) => `PubMed:${id}`);
    expect(ca2?.cofactors?.[0]?.evidence).toEqual(zincEvidence);
    expect(ca2?.comments).toEqual([
      {
        type: 'COFACTOR',
        value:
          'Zinc. Can also use cobalt(II) with lower efficiency, but not copper(II), nickel(II) and manganese(II).',
        evidence: ['PubMed:19583303'],
      },
    ]);
    expect(hk1?.catalyticActivity?.[1]).toEqual({
      name: 'D-fructose + ATP = D-fructose 6-phosphate + ADP + H(+)',
      ecNumber: '2.7.1.1',
      rheaId: 'RHEA:16125',
      evidence: ['UniProtKB:P05708'],
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        '- Involved in oxygen transport from the lung to the various peripheral tissues (PubMed:28066926)',
        '- LVV-hemorphin-7 potentiates the activity of bradykinin, causing a decrease in blood pressure',
        '- Spinorphin: Functions as an endogenous inhibitor of enkephalin-degrading enzymes such as DPP3, and as a selective antagonist of the P2RX3 receptor which is involved in pain signaling, these properties implicate it as a regulator of pain and inflammation',
        '- Complement factor B Bb: Mg(2+) (CHEBI:18420) (PubMed:15068800, PubMed:19503103, PubMed:19574954, PubMed:21205667, PubMed:3638964)',
        '- Complement factor B Bb: Mn(2+) (CHEBI:29035) (PubMed:15016353)',
        `- Zn(2+) (CHEBI:29105) (${zincEvidence.join(', ')})`,
        '- Co(2+) (CHEBI:48828) (PubMed:19583303)',
        '- COFACTOR: Zinc. Can also use cobalt(II) with lower efficiency, but not copper(II), nickel(II) and manganese(II). (PubMed:19583303)',
        '- a D-hexose + ATP = a D-hexose 6-phosphate + ADP + H(+) (RHEA:22740) [EC 2.7.1.1] (PubMed:1637300, PubMed:27374331)',
        '- D-fructose + ATP = D-fructose 6-phosphate + ADP + H(+) (RHEA:16125) [EC 2.7.1.1] (UniProtKB:P05708)',
      ]),
    );
  });
});

describe('getEntry location orientation, alternative-products notes, and isoform synonyms (real service, through runToolContract)', () => {
  const row = (accession: string) =>
    required(
      qualifiedComments.results.find((r) => r.primaryAccession === accession),
      `the ${accession} fixture row`,
    );

  it('returns a location’s orientation, the ALTERNATIVE PRODUCTS note, and isoform synonyms on both surfaces', async () => {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search'
          ? upstreamResponse(200, { results: [row('O00165'), row('B3KU38')] })
          : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));

    const result = await runToolContract(getEntry, { accessions: ['O00165', 'B3KU38'] });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { kind: string; succeeded: Entry[] };
    const [pex, schip] = out.succeeded;
    expect(pex?.subcellularLocation?.find((l) => l.orientation)).toEqual({
      location: 'Cell membrane',
      topology: 'Peripheral membrane protein',
      orientation: 'Cytoplasmic side',
      evidence: ['PubMed:26997484'],
    });
    expect(pex?.comments?.at(-1)).toEqual({
      type: 'ALTERNATIVE PRODUCTS',
      value: 'Additional isoforms seem to exist.',
    });
    expect(schip?.isoforms?.[2]).toEqual({
      isoformId: 'P0DPB3-1',
      name: 'SCHIP1-1',
      synonyms: ['SCHIP-1', 'SCHIP-1a'],
      sequenceStatus: 'External',
    });

    const lines = contentText(result).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        '- Cell membrane (Peripheral membrane protein; Cytoplasmic side) (PubMed:26997484)',
        '- Cytoplasm, P-body (PubMed:23164465)',
        '- ALTERNATIVE PRODUCTS: Additional isoforms seem to exist.',
        '**Isoforms:** B3KU38-1 (IQCJ-SCHIP1-1) [Displayed], B3KU38-2 (IQCJ-SCHIP1-2) [Described], P0DPB3-1 (SCHIP1-1; synonyms SCHIP-1, SCHIP-1a) [External], P0DPB3-2 (SCHIP1-2; synonyms SCHIP-1-D241/253) [External], P0DPB3-3 (SCHIP1-3; synonyms SCHIP-1-D22/253) [External], P0DPB3-4 (SCHIP1-4) [External], Q1A5X6-1 (IQCJ-1) [External], Q1A5X6-2 (IQCJ-2) [External], Q1A5X6-3 (IQCJ-3) [External]',
      ]),
    );
  });
});

/**
 * The biophysicochemical section (#47) over `biophysicochemical.json`, rows captured from
 * rest.uniprot.org with the identity and BIOPHYSICOCHEMICAL PROPERTIES fields. The normalized
 * values are tabled in the service test; these prove the schema, the default projection,
 * sections, windows, outlines, and the content[] rendering of every value with its evidence.
 */
describe('getEntry biophysicochemical properties (#47, real service over captured rows, through runToolContract)', () => {
  const row = (accession: string) =>
    required(
      biophysicochemicalRows.results.find((r) => r.primaryAccession === accession),
      `the ${accession} fixture row`,
    );
  const IDENTITY_FIELDS =
    'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence';
  const HEADER = '**Biophysicochemical properties:**';

  type Out = {
    kind: string;
    succeeded: Entry[];
    failed: unknown[];
    sections?: { name: string; bytes: number }[];
    window?: { section: string; offset: number };
    totalCount?: number;
    nextOffset?: number;
    absentSections?: string[];
    ignoredFields?: string[];
    notice?: string;
  };

  /** Run the tool through the real service, the batch search answering with these raw rows. */
  async function call(input: Record<string, unknown>, ...rows: object[]) {
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const result = await runToolContract(getEntry, input as never);
    expect(result.isError).toBeFalsy();
    const text = contentText(result);
    const sentFields = requestedUrls(fetchStub)[0]?.searchParams.get('fields') ?? undefined;
    return { out: result.structuredContent as Out, text, lines: text.split('\n'), sentFields };
  }

  /** The biophysicochemical block of the entry whose rendering starts at `from`: its header and its rows. */
  function block(lines: string[], from = 0): string[] {
    const start = lines.indexOf(HEADER, from);
    expect(start).toBeGreaterThanOrEqual(0);
    let end = start + 1;
    while (lines[end]?.startsWith('- ')) end++;
    return lines.slice(start, end);
  }

  it('returns P00918’s five KM rows and its pH text, each with its evidence, on both surfaces', async () => {
    const { out, lines, text } = await call(
      { accessions: ['P00918'], sections: ['biophysicochemical'] },
      row('P00918'),
    );

    expect(out.kind).toBe('full');
    const [ca2] = out.succeeded;
    expect(ca2?.biophysicochemical).toHaveLength(1);
    const [only] = ca2?.biophysicochemical ?? [];
    expect(only?.michaelisConstants?.map((k) => [k.constant, k.unit, k.substrate])).toEqual([
      [9.3, 'mM', 'CO(2)'],
      [11, 'mM', 'CO(2)'],
      [8.2, 'mM', 'CO(2)'],
      [82, 'mM', 'H(2)CO(3)'],
      [2.9, 'mM', '4-nitrophenyl acetate'],
    ]);
    expect(only?.michaelisConstants?.[0]?.evidence).toEqual(['PubMed:4994926', 'PubMed:7761440']);
    expect(only?.phDependence?.[0]?.evidence).toHaveLength(5);

    expect(block(lines)).toEqual([
      HEADER,
      '- KM=9.3 mM for CO(2) (PubMed:4994926, PubMed:7761440)',
      '- KM=11 mM for CO(2) (PubMed:1909891)',
      '- KM=8.2 mM for CO(2) (PubMed:9398308)',
      '- KM=82 mM for H(2)CO(3) (PubMed:8262987)',
      '- KM=2.9 mM for 4-nitrophenyl acetate (PubMed:10550681)',
      '- pH dependence: Optimum pH is 6-8. (PubMed:15667203, PubMed:17330962, PubMed:18942852, PubMed:8262987, PubMed:9398308)',
    ]);
    expect(text).not.toContain('undefined');
  });

  it('fetches the five names in the default record and renders A9WGE2’s whole comment inline', async () => {
    const { out, lines, sentFields } = await call({ accessions: ['A9WGE2'] }, row('A9WGE2'));

    // The default projection carries the five names, after the cofactor field.
    expect(sentFields).toContain(
      'cc_cofactor,kinetics,ph_dependence,temp_dependence,redox_potential,absorption,',
    );
    expect(out.kind).toBe('full');
    expect(out.succeeded[0]?.biophysicochemical?.[0]?.absorption).toEqual({
      maxNm: 280,
      evidence: ['PubMed:17259315'],
    });
    expect(block(lines)).toEqual([
      HEADER,
      '- KM=70 uM for (R)-citramalyl-CoA (PubMed:17259315)',
      '- Kinetics note: kcat is 1.7 sec(-1) for lyase activity with (R)-citramalyl-CoA as substrate.',
      '- pH dependence: Optimum pH is 7 (at 55 degrees Celsius). (PubMed:17259315)',
      '- Temperature dependence: Optimum temperature is 55 degrees Celsius. (PubMed:17259315)',
      '- Absorption: Abs(max)=280 nm (PubMed:17259315)',
    ]);
  });

  it('renders a Vmax row, a redox potential, and an approximate absorption with its note across a batch', async () => {
    const { out, lines } = await call(
      { accessions: ['O14975', 'Q96JJ7', 'Q9SYW8'] },
      row('O14975'),
      row('Q96JJ7'),
      row('Q9SYW8'),
    );

    expect(out.kind).toBe('full');
    const [fatp2, tmx3, lhca2] = out.succeeded;
    expect(fatp2?.biophysicochemical?.[0]?.maximumVelocities).toEqual([
      {
        velocity: 1.4,
        unit: 'nmol/min/mg',
        enzyme: 'enzyme for hexadecanoyl-CoA (palmitoyl-CoA) synthesis',
        evidence: ['PubMed:11980911'],
      },
    ]);
    expect(tmx3?.biophysicochemical).toEqual([
      { redoxPotential: [{ value: 'E(0) is -157 mV.', evidence: ['PubMed:15623505'] }] },
    ]);
    expect(lhca2?.biophysicochemical).toEqual([
      {
        absorption: { maxNm: 695, approximate: true },
        absorptionNote: [{ value: 'Emission maxima at 702 nm.', evidence: ['PubMed:11553743'] }],
      },
    ]);

    const fatp2At = lines.indexOf('# Long-chain fatty acid transport protein 2 (O14975)');
    const tmx3At = lines.findIndex((line) => line.endsWith('(Q96JJ7)'));
    const lhca2At = lines.findIndex((line) => line.endsWith('(Q9SYW8)'));
    expect(block(lines, fatp2At)).toEqual([
      HEADER,
      '- KM=12 uM for hexadecanoate (palmitate) (PubMed:11980911)',
      '- Vmax=1.4 nmol/min/mg enzyme for hexadecanoyl-CoA (palmitoyl-CoA) synthesis (PubMed:11980911)',
    ]);
    expect(block(lines, tmx3At)).toEqual([
      HEADER,
      '- Redox potential: E(0) is -157 mV. (PubMed:15623505)',
    ]);
    expect(block(lines, lhca2At)).toEqual([
      HEADER,
      '- Absorption: Abs(max)=695 nm (approximate)',
      '- Absorption note: Emission maxima at 702 nm. (PubMed:11553743)',
    ]);
  });

  it('renders both texts of every text part, each with its own evidence, on both surfaces', async () => {
    const { out, lines } = await call(
      { accessions: ['P00000'], sections: ['biophysicochemical'] },
      TWO_TEXT_BIOPHYSICOCHEMICAL_ROW,
    );

    expect(out.kind).toBe('full');
    const [only] = out.succeeded[0]?.biophysicochemical ?? [];
    expect(
      [
        only?.kineticsNote,
        only?.phDependence,
        only?.temperatureDependence,
        only?.redoxPotential,
        only?.absorptionNote,
      ].map((part) => part?.map((t) => [t.value, t.evidence])),
    ).toEqual([
      [
        ['kcat is 1.7 sec(-1) for lyase activity with (R)-citramalyl-CoA as substrate.', undefined],
        ['kcat is 390 sec(-1) for NAD(+).', ['PubMed:7852410']],
      ],
      [
        ['Optimum pH is 6.5.', ['PubMed:6246102']],
        ['Optimum pH is 7 (at 55 degrees Celsius).', ['PubMed:17259315']],
      ],
      [
        ['Thermostable.', ['PubMed:37708259']],
        ['Optimum temperature is 45 degrees Celsius.', ['PubMed:29326945']],
      ],
      [
        ['E(0) is -157 mV.', ['PubMed:15623505']],
        ['E is 0 +/- 10 mV for 2Fe-2S at pH 7.5.', ['PubMed:19580816']],
      ],
      [
        ['Emission maxima at 702 nm.', ['PubMed:11553743']],
        ['Shoulder at 335 nm (at pH 7.5 and 30 degrees Celsius).', ['PubMed:22547782']],
      ],
    ]);
    expect(block(lines)).toEqual([
      HEADER,
      '- Kinetics note: kcat is 1.7 sec(-1) for lyase activity with (R)-citramalyl-CoA as substrate.',
      '- Kinetics note: kcat is 390 sec(-1) for NAD(+). (PubMed:7852410)',
      '- pH dependence: Optimum pH is 6.5. (PubMed:6246102)',
      '- pH dependence: Optimum pH is 7 (at 55 degrees Celsius). (PubMed:17259315)',
      '- Temperature dependence: Thermostable. (PubMed:37708259)',
      '- Temperature dependence: Optimum temperature is 45 degrees Celsius. (PubMed:29326945)',
      '- Redox potential: E(0) is -157 mV. (PubMed:15623505)',
      '- Redox potential: E is 0 +/- 10 mV for 2Fe-2S at pH 7.5. (PubMed:19580816)',
      '- Absorption: Abs(max)=695 nm (approximate)',
      '- Absorption note: Emission maxima at 702 nm. (PubMed:11553743)',
      '- Absorption note: Shoulder at 335 nm (at pH 7.5 and 30 degrees Celsius). (PubMed:22547782)',
    ]);
  });

  it('labels each of Q07343’s four isoform objects on its rows', async () => {
    const { out, lines } = await call(
      { accessions: ['Q07343'], sections: ['biophysicochemical'] },
      row('Q07343'),
    );
    expect(out.succeeded[0]?.biophysicochemical?.map((b) => b.molecule)).toEqual([
      'Isoform PDE4B2',
      'Isoform PDE4B1',
      'Isoform PDE4B3',
      'Isoform PDE4B5',
    ]);
    expect(block(lines)).toEqual([
      HEADER,
      "- Isoform PDE4B2: KM=15 uM for 3',5'-cyclic AMP (PubMed:8392015)",
      "- Isoform PDE4B2: KM=2.6 uM for 3',5'-cyclic AMP (PubMed:8392015)",
      "- Isoform PDE4B1: KM=2 uM for 3',5'-cyclic AMP (PubMed:8392015)",
      "- Isoform PDE4B3: KM=1.5 uM for 3',5'-cyclic AMP (PubMed:8392015)",
      "- Isoform PDE4B5: KM=5.8 uM for 3',5'-cyclic AMP (PubMed:17519386)",
    ]);
  });

  it('windows P55263 by comment: section_limit 1, section_offset 1 returns the Isoform 1 object', async () => {
    const { out, lines, text } = await call(
      {
        accessions: ['P55263'],
        sections: ['biophysicochemical'],
        section_limit: 1,
        section_offset: 1,
      },
      row('P55263'),
    );

    expect(out.succeeded[0]?.biophysicochemical).toEqual([
      {
        molecule: 'Isoform 1',
        michaelisConstants: [
          { constant: 41, unit: 'nM', substrate: 'adenosine', evidence: ['PubMed:8577746'] },
          { constant: 0.13, unit: 'uM', substrate: 'ATP', evidence: ['PubMed:9070863'] },
        ],
      },
    ]);
    expect(out.window).toEqual({ section: 'biophysicochemical', offset: 1 });
    expect(out.totalCount).toBe(3);
    expect(out.nextOffset).toBe(2);
    expect(text).toContain('**Window:** `biophysicochemical` items 2–2 (section_offset 1)');
    expect(block(lines)).toEqual([
      HEADER,
      '- Isoform 1: KM=41 nM for adenosine (PubMed:8577746)',
      '- Isoform 1: KM=0.13 uM for ATP (PubMed:9070863)',
    ]);
    expect(text).not.toContain('Optimum pH is 6.5.');
  });

  it('walks P55263’s three objects one window at a time, then answers an offset past the end', async () => {
    const pages: (string | undefined)[][] = [];
    let offset: number | undefined = 0;
    // Three objects at one per window: the walk ends on its third page.
    for (let page = 0; page < 4 && offset !== undefined; page++) {
      const { out } = await call(
        {
          accessions: ['P55263'],
          sections: ['biophysicochemical'],
          section_limit: 1,
          section_offset: offset,
        },
        row('P55263'),
      );
      expect(out.totalCount).toBe(3);
      pages.push((out.succeeded[0]?.biophysicochemical ?? []).map((b) => b.molecule));
      offset = out.nextOffset;
    }
    expect(offset).toBeUndefined();
    expect(pages).toEqual([[undefined], ['Isoform 1'], ['Isoform 2']]);

    const past = await call(
      {
        accessions: ['P55263'],
        sections: ['biophysicochemical'],
        section_limit: 1,
        section_offset: 3,
      },
      row('P55263'),
    );
    expect(past.out.succeeded[0]?.biophysicochemical).toEqual([]);
    expect(past.out.totalCount).toBe(3);
    expect(past.out.notice).toContain(
      'section_offset 3 is past the end of biophysicochemical, which holds 3 item(s)',
    );
    expect(past.text).toContain('**Window:** `biophysicochemical` — no items at section_offset 3');
    expect(past.lines).not.toContain(HEADER);
  });

  it('fetches the whole comment for fields:"accession,kinetics", ignoring nothing', async () => {
    const { out, text, sentFields } = await call(
      { accessions: ['P00918'], fields: 'accession,kinetics' },
      row('P00918'),
    );
    expect(sentFields).toBe(`${IDENTITY_FIELDS},kinetics`);
    expect(out).not.toHaveProperty('ignoredFields');
    expect(text).not.toContain('Ignored fields');
    const [only] = out.succeeded[0]?.biophysicochemical ?? [];
    expect(only?.michaelisConstants).toHaveLength(5);
    expect(only?.phDependence?.[0]?.value).toBe('Optimum pH is 6-8.');
  });

  it('omits the section from P04637, which has none, and names it in absentSections when requested', async () => {
    const full = await call({ accessions: ['P04637'] }, RAW_ENTRIES.p53);
    expect(full.out.kind).toBe('full');
    expect(full.out.succeeded[0]).not.toHaveProperty('biophysicochemical');
    expect(full.lines).not.toContain(HEADER);

    const named = await call(
      { accessions: ['P04637'], sections: ['biophysicochemical'] },
      RAW_ENTRIES.p53,
    );
    expect(named.out.absentSections).toEqual(['biophysicochemical']);
    expect(named.out.succeeded[0]).not.toHaveProperty('biophysicochemical');
    expect(named.text).toMatch(/\*\*Absent sections:\*\* biophysicochemical — /);
  });

  it('outlines Q29550’s default record, which the section carries past the budget, listing its byte size on both surfaces', async () => {
    // The Q29550 row is the default projection whole: FUNCTION, CATALYTIC ACTIVITY, and location
    // comments, features, keywords, and cross-references beside its one large comment.
    const { out, lines } = await call({ accessions: ['Q29550'] }, row('Q29550'));
    expect(out.kind).toBe('outline');

    const recall = await call(
      { accessions: ['Q29550'], sections: ['biophysicochemical'] },
      row('Q29550'),
    );
    const bytes = Buffer.byteLength(
      JSON.stringify(recall.out.succeeded[0]?.biophysicochemical),
      'utf8',
    );
    expect(out.sections?.[0]).toEqual({ name: 'biophysicochemical', bytes });
    expect(lines).toContain(`- **biophysicochemical** — ${bytes} bytes`);
  });

  it('returns Q29550’s whole comment, 39 KM and 38 Vmax rows, on a sections re-call', async () => {
    const { out, lines } = await call(
      { accessions: ['Q29550'], sections: ['biophysicochemical'] },
      row('Q29550'),
    );
    expect(out.kind).toBe('full');
    expect(out.succeeded[0]).not.toHaveProperty('function');
    const [only] = out.succeeded[0]?.biophysicochemical ?? [];
    expect(only?.michaelisConstants).toHaveLength(39);
    expect(only?.maximumVelocities).toHaveLength(38);
    const rows = block(lines);
    expect(rows.filter((line) => line.startsWith('- KM='))).toHaveLength(39);
    expect(rows.filter((line) => line.startsWith('- Vmax='))).toHaveLength(38);
    expect(rows).toContain(
      '- Vmax=0.03 nmol/min/ug enzyme with CPT-11 as substrate (PubMed:16223870, PubMed:9490062, PubMed:9799112)',
    );
    expect(rows.at(-1)).toBe(
      '- pH dependence: Optimum pH is 8.0 with tributylglycerol as substrate, and 8.2 with retinyl palmitate as substrate. Active from pH 4.5-9.5 with retinyl palmitate as substrate. (PubMed:16223870, PubMed:9490062, PubMed:9799112)',
    );
  });

  it('renders a sparse comment whole: no row evidence, no maximum, a molecule, a lone temperature text', async () => {
    const { out, lines, text } = await call(
      { accessions: ['P00000'], sections: ['biophysicochemical'] },
      {
        ...activeRawEntry('P00000', 'TEST_HUMAN'),
        comments: [
          {
            commentType: 'BIOPHYSICOCHEMICAL PROPERTIES',
            molecule: 'Isoform 2',
            kineticParameters: {
              michaelisConstants: [{ constant: 1.97e-8, unit: 'M', substrate: 'X' }],
              maximumVelocities: [{ velocity: 0, unit: 'umol/min/mg', enzyme: 'enzyme toward X' }],
            },
            absorption: {
              approximate: false,
              evidences: [{ evidenceCode: 'ECO:0000269', source: 'PubMed', id: '3' }],
              note: { texts: [{ value: 'Broad band.' }] },
            },
          },
          {
            commentType: 'BIOPHYSICOCHEMICAL PROPERTIES',
            temperatureDependence: { texts: [{ value: 'Thermostable.' }] },
            absorption: { approximate: false, note: { texts: [{ value: 'Note only.' }] } },
          },
        ],
      },
    );
    expect(out.succeeded[0]?.biophysicochemical).toEqual([
      {
        molecule: 'Isoform 2',
        michaelisConstants: [{ constant: 1.97e-8, unit: 'M', substrate: 'X' }],
        maximumVelocities: [{ velocity: 0, unit: 'umol/min/mg', enzyme: 'enzyme toward X' }],
        absorption: { evidence: ['PubMed:3'] },
        absorptionNote: [{ value: 'Broad band.' }],
      },
      {
        temperatureDependence: [{ value: 'Thermostable.' }],
        absorptionNote: [{ value: 'Note only.' }],
      },
    ]);
    expect(block(lines)).toEqual([
      HEADER,
      '- Isoform 2: KM=1.97e-8 M for X',
      '- Isoform 2: Vmax=0 umol/min/mg enzyme toward X',
      '- Isoform 2: Absorption (PubMed:3)',
      '- Isoform 2: Absorption note: Broad band.',
      '- Temperature dependence: Thermostable.',
      '- Absorption note: Note only.',
    ]);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('()');
  });
});

describe('getEntry return fields (#34, real service, through runToolContract)', () => {
  type Out = {
    kind: string;
    succeeded: Entry[];
    failed: unknown[];
    ignoredFields?: string[];
    absentSections?: string[];
    notice?: string;
  };
  const IDENTITY_FIELDS =
    'accession,id,protein_name,gene_names,organism_name,organism_id,length,reviewed,annotation_score,protein_existence';
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');
  const trypsinRow = (extra: object) => ({
    ...activeRawEntry('P07477', 'TRY1_HUMAN', 247),
    ...extra,
  });

  /** Answer the batch search with these raw rows, whatever it asks for. */
  function upstreamReturns(...rows: object[]) {
    const fetchStub = routeUpstream((url) =>
      url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
    );
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    return fetchStub;
  }

  /** The `fields` the one upstream request carried. */
  function sentFields(fetchStub: ReturnType<typeof routeUpstream>): string[] {
    return requestedUrls(fetchStub)[0]?.searchParams.get('fields')?.split(',') ?? [];
  }

  it('fetches the default types it once left out: P07477 returns its disulfide bonds and AlphaFoldDB id', async () => {
    const fetchStub = upstreamReturns(p07477);
    const result = await runToolContract(getEntry, { accessions: ['P07477'] });

    expect(result.isError).toBeFalsy();
    const fields = sentFields(fetchStub);
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
      expect(fields).toContain(field);
    for (const field of ['ft_mutagen', 'cc_interaction', 'xref_reactome'])
      expect(fields).not.toContain(field);
    const out = result.structuredContent as Out;
    const [trypsin] = out.succeeded;
    expect(trypsin?.ptms?.filter((p) => p.type === 'Disulfide bond')).toHaveLength(5);
    expect(trypsin?.xrefs?.AlphaFoldDB).toEqual(['P07477']);
    expect(trypsin?.xrefs).not.toHaveProperty('GO');
    expect(trypsin?.goTerms).toHaveLength(6);
    // Nothing ignored: no ignoredFields, no notice.
    expect(out).not.toHaveProperty('ignoredFields');
    expect(out).not.toHaveProperty('notice');
    const text = contentText(result);
    expect(text.split('\n')).toEqual(
      expect.arrayContaining(['- Disulfide bond @30..160', '- `AlphaFoldDB`: `P07477`']),
    );
    expect(text).not.toContain('Ignored fields');
  });

  it('returns P04637’s DNA-binding region under domains for fields:"accession,ft_dna_bind"', async () => {
    const dnaBinding = required(p04637Sections.results[0], 'the P04637 fixture row').features;
    const fetchStub = upstreamReturns({
      ...activeRawEntry('P04637', 'P53_HUMAN'),
      features: dnaBinding,
    });
    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      fields: 'accession,ft_dna_bind',
    });

    expect(sentFields(fetchStub).join(',')).toBe(`${IDENTITY_FIELDS},ft_dna_bind`);
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.domains).toEqual([
      { type: 'DNA binding', location: { start: 102, end: 292 } },
    ]);
    expect(contentText(result).split('\n')).toContain('- DNA binding 102..292');
  });

  it('lists P0A7V8’s ordered-locus names among its genes', async () => {
    upstreamReturns({
      ...activeRawEntry('P0A7V8', 'RS4_ECOLI', 206),
      genes: sectionRows.P0A7V8.genes,
    });
    const result = await runToolContract(getEntry, { accessions: ['P0A7V8'] });

    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.genes).toEqual(['rpsD', 'ramA', 'b3296', 'JW3258']);
    expect(contentText(result).split('\n')).toContain('**Genes:** rpsD, ramA, b3296, JW3258');
  });

  it('fills xrefs with every xref_ database fields names', async () => {
    // P07477 under these fields (rest.uniprot.org, release 2026_04, captured 2026-11-17).
    const xrefsOf = (database: string) =>
      p07477.uniProtKBCrossReferences.filter((x) => x.database === database);
    const reactome = (id: string, PathwayName: string) => ({
      database: 'Reactome',
      id,
      properties: [{ key: 'PathwayName', value: PathwayName }],
    });
    const fetchStub = upstreamReturns(
      trypsinRow({
        uniProtKBCrossReferences: [
          ...xrefsOf('InterPro'),
          ...xrefsOf('Pfam'),
          reactome('R-HSA-1592389', 'Activation of Matrix Metalloproteinases'),
          reactome('R-HSA-9758881', 'Uptake of dietary cobalamins into enterocytes'),
          reactome('R-HSA-9925561', 'Developmental Lineage of Pancreatic Acinar Cells'),
        ],
      }),
    );
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      fields: 'accession,xref_interpro,xref_pfam,xref_reactome',
    });

    expect(sentFields(fetchStub).join(',')).toBe(
      `${IDENTITY_FIELDS},xref_interpro,xref_pfam,xref_reactome`,
    );
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.xrefs).toEqual({
      InterPro: ['IPR009003', 'IPR001314', 'IPR050127', 'IPR001254', 'IPR018114', 'IPR033116'],
      Pfam: ['PF00089'],
      Reactome: ['R-HSA-1592389', 'R-HSA-9758881', 'R-HSA-9925561'],
    });
    expect(out).not.toHaveProperty('ignoredFields');
    expect(contentText(result).split('\n')).toEqual(
      expect.arrayContaining([
        '- `Pfam`: `PF00089`',
        '- `Reactome`: `R-HSA-1592389`, `R-HSA-9758881`, `R-HSA-9925561`',
      ]),
    );
  });

  it('sends keywordid as keyword, so keywords keep their names, and rhea as cc_catalytic_activity', async () => {
    const fetchStub = upstreamReturns(
      trypsinRow({ keywords: p07477.keywords.slice(0, 2), comments: [p07477.comments[1]] }),
    );
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      fields: 'accession,keywordid,rhea',
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub).join(',')).toBe(
      `${IDENTITY_FIELDS},keyword,cc_catalytic_activity`,
    );
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.keywords).toEqual([
      { id: 'KW-0002', name: '3D-structure', category: 'Technical term' },
      { id: 'KW-0106', name: 'Calcium', category: 'Ligand' },
    ]);
    expect(out.succeeded[0]?.catalyticActivity?.[0]?.ecNumber).toBe('3.4.21.4');
    expect(out).not.toHaveProperty('ignoredFields');
  });

  it('leaves a field it cannot return out of the request and names it in ignoredFields and one notice', async () => {
    const fetchStub = upstreamReturns(trypsinRow({}));
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      fields: 'accession,sequence,ft_helix',
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub).join(',')).toBe(IDENTITY_FIELDS);
    const out = result.structuredContent as Out;
    expect(out.succeeded.map((e) => e.accession)).toEqual(['P07477']);
    expect(out.ignoredFields).toEqual(['sequence', 'ft_helix']);
    const notice = required(out.notice, 'the ignored-field notice');
    expect(notice.startsWith('Ignored fields: sequence, ft_helix — ')).toBe(true);
    expect(notice).toContain('uniprot_get_sequence returns the sequence (FASTA) of an accession.');
    expect(notice).toContain('Supported fields: accession, id, protein_name, ec, gene_names,');
    expect(notice).toContain(', and any `xref_<database>` field, e.g. xref_interpro.');
    // content[]: the trailer line, and the same notice text as a block quote.
    const text = contentText(result);
    expect(text).toContain('**Ignored fields:** sequence, ft_helix');
    expect(text).toContain(`> ${notice}`);
  });

  it('ignores a name UniProt does not know instead of sending it', async () => {
    const fetchStub = upstreamReturns(trypsinRow({}));
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      fields: 'definitely_not_a_uniprot_field',
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub).join(',')).toBe(IDENTITY_FIELDS);
    expect((result.structuredContent as Out).ignoredFields).toEqual([
      'definitely_not_a_uniprot_field',
    ]);
  });

  it('joins the ignored-field notice to the deferral notice, on both surfaces', async () => {
    upstreamReturns(activeRawEntry('P10000', 'P10000_HUMAN'));
    const accessions = Array.from({ length: 21 }, (_, i) => `P${10_000 + i}`);
    const result = await runToolContract(getEntry, { accessions, fields: 'accession,ft_helix' });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Out & { deferredAccessions?: string[] };
    expect(out.deferredAccessions).toEqual(['P10020']);
    const notice = required(out.notice, 'the joined notice');
    expect(notice).toContain('1 accession(s) past the first 20 distinct were not fetched');
    expect(notice).toContain('Ignored fields: ft_helix — ');
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('sends the ignored-field notice on a sections re-call, on both surfaces', async () => {
    const fetchStub = upstreamReturns(p07477);
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      sections: ['disease'],
      fields: 'accession,cc_disease,sequence',
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub).join(',')).toBe(`${IDENTITY_FIELDS},cc_disease`);
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.disease).toHaveLength(1);
    expect(out).not.toHaveProperty('absentSections');
    expect(out.ignoredFields).toEqual(['sequence']);
    const notice = required(out.notice, 'the ignored-field notice');
    expect(notice).toContain(
      'Ignored fields: sequence — uniprot_get_entry does not return them, so they were not requested from UniProt.',
    );
    const text = contentText(result);
    expect(text).toContain('**Ignored fields:** sequence');
    expect(text).toContain(`> ${notice}`);
  });

  it('joins the ignored-field notice to a lone record’s outline notice, on both surfaces', async () => {
    getEntriesMock.mockResolvedValue(batch(sizedEntry('P38392', 24_002)));
    const result = await runToolContract(getEntry, {
      accessions: ['P38392'],
      fields: 'accession,cc_function,sequence',
    });

    expect(result.isError).toBeFalsy();
    expect(getEntriesMock).toHaveBeenCalledWith(
      ['P38392'],
      'accession,cc_function',
      expect.anything(),
    );
    const out = result.structuredContent as Out;
    expect(out.kind).toBe('outline');
    expect(out.ignoredFields).toEqual(['sequence']);
    const notice = required(out.notice, 'the joined notice');
    expect(notice).toContain(
      'Ignored fields: sequence — uniprot_get_entry does not return them, so they were not requested from UniProt.',
    );
    expect(notice).toContain(
      'Re-call with accessions:["P38392"] and sections:[...] to retrieve selected sections; use section_limit and section_offset for one list section.',
    );
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('fetches mutagenesis when sections names it without fields: P07477’s Tyr-154 row', async () => {
    const fetchStub = upstreamReturns(trypsinRow({ features: [sectionRows.P07477Mutagenesis] }));
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      sections: ['mutagenesis'],
    });

    expect(result.isError).toBeFalsy();
    const fields = sentFields(fetchStub);
    expect(fields).toContain('ft_mutagen');
    expect(fields).toContain('ft_disulfid');
    expect(fields).not.toContain('cc_interaction');
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.mutagenesis).toEqual([
      {
        description: 'Lack of sulfation.',
        location: { start: 154, end: 154 },
        original: 'Y',
        variation: 'F',
      },
    ]);
    expect(contentText(result).split('\n')).toContain('- 154 Y→F: Lack of sulfation.');
  });

  it('matches sections case-insensitively before choosing fields: MUTAGENESIS fetches P07477’s Tyr-154 row', async () => {
    // Answers as UniProt does: the mutagenesis feature comes back only when ft_mutagen is requested.
    const fetchStub = routeUpstream((url) => {
      if (url.pathname !== '/uniprotkb/search') return;
      const requested = url.searchParams.get('fields')?.split(',') ?? [];
      const features = requested.includes('ft_mutagen') ? [sectionRows.P07477Mutagenesis] : [];
      return upstreamResponse(200, { results: [trypsinRow({ features })] });
    });
    vi.stubGlobal('fetch', fetchStub);
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));

    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      sections: ['MUTAGENESIS'],
    });

    expect(result.isError).toBeFalsy();
    expect(sentFields(fetchStub)).toContain('ft_mutagen');
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.mutagenesis).toEqual([
      {
        description: 'Lack of sulfation.',
        location: { start: 154, end: 154 },
        original: 'Y',
        variation: 'F',
      },
    ]);
    expect(out).not.toHaveProperty('absentSections');
    const lines = contentText(result).split('\n');
    expect(lines).toContain('- 154 Y→F: Lack of sulfation.');
    expect(lines.some((line) => line.startsWith('**Absent sections:**'))).toBe(false);
  });

  it('fetches interactions when sections names them without fields: P00533’s partners', async () => {
    const fetchStub = upstreamReturns(
      required(p00533Sections.results[0], 'the P00533 fixture row'),
    );
    const result = await runToolContract(getEntry, {
      accessions: ['P00533'],
      sections: ['interactions'],
    });

    expect(result.isError).toBeFalsy();
    const fields = sentFields(fetchStub);
    expect(fields).toContain('cc_interaction');
    expect(fields).not.toContain('ft_mutagen');
    const out = result.structuredContent as Out;
    expect(out.succeeded[0]?.interactions).toHaveLength(25);
    expect(out.succeeded[0]?.interactions?.[0]).toEqual({
      partner: 'P00519',
      gene: 'ABL1',
      experiments: 3,
    });
    expect(contentText(result).split('\n')).toContain('- P00519 (ABL1): 3 experiment(s)');
  });

  it('leaves a caller projection as sent when sections names an on-request section', async () => {
    const fetchStub = upstreamReturns(trypsinRow({}));
    const result = await runToolContract(getEntry, {
      accessions: ['P07477'],
      fields: 'accession',
      sections: ['mutagenesis'],
    });

    expect(sentFields(fetchStub).join(',')).toBe(IDENTITY_FIELDS);
    expect((result.structuredContent as Out).absentSections).toEqual(['mutagenesis']);
  });
});

describe('getEntry format', () => {
  it('format() renders the full arm with curated sections and provenance', () => {
    const blocks = getEntry.format!({ kind: 'full', succeeded: [fullEntry], failed: [] });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('P04637');
    expect(text).toContain('P53_HUMAN');
    expect(text).toContain('Reviewed (Swiss-Prot)');
    expect(text).toContain('tumor suppressor');
    expect(text).toContain('PubMed:11025664');
    expect(text).toContain('Li-Fraumeni');
    expect(text).toContain('VAR_044588');
    expect(text).toContain('1TUP');
    expect(text).toContain('CHEMBL4096');
  });

  it('format() renders a sparse entry (only required fields) without fabricating sections', () => {
    const sparse = {
      accession: 'A0A0A0A0A0',
      entryName: 'A0A0A0A0A0_BACSU',
      genes: [],
      organism: { scientificName: 'Bacillus subtilis', taxonId: 1423 },
      length: 120,
      reviewed: false,
      annotationScore: 1,
      proteinExistence: '4: Predicted',
    };
    const blocks = getEntry.format!({ kind: 'full', succeeded: [sparse], failed: [] });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('A0A0A0A0A0');
    expect(text).toContain('Unreviewed (TrEMBL)');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('**Disease:**');
    expect(text).not.toContain('**Function:**');
  });

  it('format() renders per-accession failures alongside successes', () => {
    const blocks = getEntry.format!({
      kind: 'full',
      succeeded: [fullEntry],
      failed: [{ accession: 'A0A0A0A0A0', error: 'Accession A0A0A0A0A0 not found in UniProtKB.' }],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Not found');
    expect(text).toContain('A0A0A0A0A0');
  });

  it('format() renders the outline arm', () => {
    const blocks = getEntry.format!({
      kind: 'outline',
      sections: [
        { name: 'function', bytes: 4000 },
        { name: 'variants', bytes: 12000 },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('outline');
    expect(text).toContain('variants');
  });
});

/**
 * P26663's INTERACTION comment (POLG_HCVBK, the hepatitis C virus genotype 1b polyprotein) as
 * rest.uniprot.org returned it for fields=accession,cc_interaction (release 2026_04, captured
 * 2026-11-17). A row recorded for one of this entry's chains names that chain in
 * interactantOne.chainId and carries no accession there; UniProt writes "-" as the gene name
 * of a partner that has none.
 */
const P26663_INTERACTION_COMMENT = {
  commentType: 'INTERACTION',
  interactions: [
    {
      interactantOne: { uniProtKBAccession: 'P26663', intActId: 'EBI-6857429' },
      interactantTwo: { uniProtKBAccession: 'P52480', geneName: 'Pkm', intActId: 'EBI-647785' },
      numberOfExperiments: 3,
      organismDiffer: true,
    },
    {
      interactantOne: { uniProtKBAccession: 'P26663', intActId: 'EBI-6857429' },
      interactantTwo: { uniProtKBAccession: 'Q62245', geneName: 'Sos1', intActId: 'EBI-1693' },
      numberOfExperiments: 2,
      organismDiffer: true,
    },
    {
      interactantOne: { chainId: 'PRO_0000037536', intActId: 'EBI-6838571' },
      interactantTwo: {
        uniProtKBAccession: 'P26663',
        geneName: '-',
        chainId: 'PRO_0000037537',
        intActId: 'EBI-6838576',
      },
      numberOfExperiments: 6,
      organismDiffer: false,
    },
    {
      interactantOne: { chainId: 'PRO_0000037536', intActId: 'EBI-6838571' },
      interactantTwo: { uniProtKBAccession: 'P04637', geneName: 'TP53', intActId: 'EBI-366083' },
      numberOfExperiments: 9,
      organismDiffer: true,
    },
    {
      interactantOne: { chainId: 'PRO_0000037540', intActId: 'EBI-6874437' },
      interactantTwo: {
        uniProtKBAccession: 'P26663',
        geneName: '-',
        chainId: 'PRO_0000037540',
        intActId: 'EBI-6874437',
      },
      numberOfExperiments: 2,
      organismDiffer: false,
    },
    {
      interactantOne: { chainId: 'PRO_0000037540', intActId: 'EBI-6874437' },
      interactantTwo: {
        uniProtKBAccession: 'Q9WMX2',
        chainId: 'PRO_0000037548',
        intActId: 'EBI-6863741',
      },
      numberOfExperiments: 5,
      organismDiffer: true,
    },
  ],
};

describe('getEntry #35 sections (real service over captured rows, through runToolContract)', () => {
  const p07477 = required(p07477Default.results[0], 'the P07477 fixture row');
  const p04637 = required(p04637Sections.results[0], 'the P04637 fixture row');
  const p00533Row = required(p00533Sections.results[0], 'the P00533 fixture row');
  /** P00533 with its membrane topology, ACTIVITY REGULATION comment, 25 interactions, and all 37 mutagenesis rows. */
  const p00533 = {
    ...p00533Row,
    features: [
      ...p00533Row.features,
      ...required(p00533Mutagenesis.results[0], 'the P00533 mutagenesis row').features,
    ],
  };
  const p26663 = {
    ...activeRawEntry('P26663', 'POLG_HCVBK', 3010),
    organism: { scientificName: 'Hepatitis C virus genotype 1b (isolate BK)', taxonId: 11105 },
    comments: [P26663_INTERACTION_COMMENT],
  };

  /** The sections #35 adds, every one a list. */
  const NEW_KEYS = [
    'alternativeNames',
    'ecNumbers',
    'sites',
    'topology',
    'processing',
    'mutagenesis',
    'comments',
    'interactions',
    'ensemblGenes',
  ];

  const PTM_CLEAVAGE =
    'Occurs in a single-chain form and a two-chain form, produced by proteolytic cleavage after Arg-122';
  const PTM_SULFATION =
    "Sulfation at Tyr-154 increases selectivity towards basic versus apolar residues at the P2' position of inhibitors that bind in a substrate-like fashion. Although the increase in selectivity is relatively small, it may facilitate digestion of a broader range of dietary proteins";
  /** P07477's COFACTOR comment note, filed under comments ahead of SUBUNIT in UniProt's comment order. */
  const COFACTOR_NOTE = 'Binds 1 Ca(2+) ion per subunit.';

  type Out = {
    kind: string;
    succeeded: Entry[];
    sections?: { name: string; bytes: number }[];
    window?: { section: string; offset: number };
    totalCount?: number;
    nextOffset?: number;
  };

  /** Run the tool through the real service, the batch search answering with these raw rows. */
  async function call(input: Record<string, unknown>, ...rows: object[]) {
    vi.stubGlobal(
      'fetch',
      routeUpstream((url) =>
        url.pathname === '/uniprotkb/search' ? upstreamResponse(200, { results: rows }) : undefined,
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));
    const result = await runToolContract(getEntry, input as never);
    expect(result.isError).toBeFalsy();
    const text = contentText(result);
    return { out: result.structuredContent as Out, text, lines: text.split('\n') };
  }

  /** One section of the first returned record, as a plain list. */
  const section = (out: Out, key: string) =>
    (out.succeeded[0] as unknown as Record<string, unknown[] | undefined>)[key];

  it('returns P07477’s sites, processing, EC number, comments, alternative names, and Ensembl genes on both surfaces', async () => {
    const { out, lines } = await call(
      {
        accessions: ['P07477'],
        sections: [
          'alternativeNames',
          'ecNumbers',
          'sites',
          'processing',
          'comments',
          'ensemblGenes',
        ],
      },
      p07477,
    );

    const [entry] = out.succeeded;
    const charge = (start: number) => ({
      type: 'Active site',
      description: 'Charge relay system',
      location: { start, end: start },
    });
    const calcium = (start: number) => ({
      type: 'Binding site',
      location: { start, end: start },
      ligand: { name: 'Ca(2+)', chebiId: 'CHEBI:29108' },
    });
    expect(entry?.sites).toEqual([
      charge(63),
      charge(107),
      charge(200),
      calcium(75),
      calcium(77),
      calcium(80),
      calcium(85),
      { type: 'Site', description: 'Required for specificity', location: { start: 194, end: 194 } },
    ]);
    expect(entry?.processing).toEqual([
      { type: 'Signal', location: { start: 1, end: 15 } },
      {
        type: 'Propeptide',
        description: 'Activation peptide',
        location: { start: 16, end: 23 },
        featureId: 'PRO_0000028197',
      },
      {
        type: 'Chain',
        description: 'Serine protease 1',
        location: { start: 24, end: 247 },
        featureId: 'PRO_0000028198',
      },
      {
        type: 'Chain',
        description: 'Alpha-trypsin chain 1',
        location: { start: 24, end: 122 },
        featureId: 'PRO_0000313570',
      },
      {
        type: 'Chain',
        description: 'Alpha-trypsin chain 2',
        location: { start: 123, end: 247 },
        featureId: 'PRO_0000313571',
      },
    ]);
    expect(entry?.ecNumbers).toEqual(['3.4.21.4']);
    expect(entry?.alternativeNames).toEqual([
      'Anionic trypsin I',
      'Anionic trypsin-I',
      'Beta-trypsin',
      'Cationic trypsinogen',
      'Pretrypsinogen I',
      'Trypsin I',
      'Trypsin-1',
    ]);
    expect(entry?.comments).toEqual([
      { type: 'COFACTOR', value: COFACTOR_NOTE },
      { type: 'SUBUNIT', value: 'Interacts with SERPINA1', evidence: ['PubMed:11057674'] },
      { type: 'PTM', value: PTM_CLEAVAGE },
      { type: 'PTM', value: PTM_SULFATION, evidence: ['PubMed:25010489'] },
    ]);
    expect(entry?.ensemblGenes).toEqual(['ENSG00000204983.15', 'ENSG00000274247.4']);

    expect(lines).toEqual(
      expect.arrayContaining([
        '**Alternative names:** Anionic trypsin I; Anionic trypsin-I; Beta-trypsin; Cationic trypsinogen; Pretrypsinogen I; Trypsin I; Trypsin-1',
        '**EC numbers:** 3.4.21.4',
        '**Sites:** 8',
        '- Active site 63: Charge relay system',
        '- Active site 107: Charge relay system',
        '- Active site 200: Charge relay system',
        '- Binding site 75 — Ca(2+) (CHEBI:29108)',
        '- Binding site 77 — Ca(2+) (CHEBI:29108)',
        '- Binding site 80 — Ca(2+) (CHEBI:29108)',
        '- Binding site 85 — Ca(2+) (CHEBI:29108)',
        '- Site 194: Required for specificity',
        '**Processing:**',
        '- Signal 1..15',
        '- Propeptide 16..23 [PRO_0000028197]: Activation peptide',
        '- Chain 24..247 [PRO_0000028198]: Serine protease 1',
        '- Chain 24..122 [PRO_0000313570]: Alpha-trypsin chain 1',
        '- Chain 123..247 [PRO_0000313571]: Alpha-trypsin chain 2',
        '**Comments:**',
        `- COFACTOR: ${COFACTOR_NOTE}`,
        '- SUBUNIT: Interacts with SERPINA1 (PubMed:11057674)',
        `- PTM: ${PTM_CLEAVAGE}`,
        `- PTM: ${PTM_SULFATION} (PubMed:25010489)`,
        '**Ensembl genes:** `ENSG00000204983.15`, `ENSG00000274247.4`',
      ]),
    );
  });

  it('keeps a ligand part, a ligand with no ChEBI id, and a labelled ligand with its note on both surfaces', async () => {
    const { out, lines, text } = await call(
      { accessions: ['P69905', 'P00505', 'P00327'] },
      { ...activeRawEntry('P69905', 'HBA_HUMAN', 142), features: [sectionRows.P69905BindingSite] },
      sectionRows.P00505,
      sectionRows.P00327,
    );

    const [hba, aatm, adh] = out.succeeded;
    expect(hba?.sites).toEqual([
      {
        type: 'Binding site',
        description: 'proximal binding residue',
        location: { start: 88, end: 88 },
        ligand: { name: 'heme b', chebiId: 'CHEBI:60344' },
        ligandPart: { name: 'Fe', chebiId: 'CHEBI:18248' },
      },
    ]);
    expect(aatm?.sites?.[0]).toEqual({
      type: 'Binding site',
      location: { start: 65, end: 65 },
      ligand: { name: 'substrate' },
    });
    expect(aatm?.ecNumbers).toEqual(['2.6.1.1', '2.6.1.7']);
    expect(aatm?.processing).toEqual([
      { type: 'Transit peptide', description: 'Mitochondrion', location: { start: 1, end: 29 } },
    ]);
    expect(adh?.sites).toEqual([
      {
        type: 'Binding site',
        location: { start: 47, end: 47 },
        ligand: { name: 'Zn(2+)', chebiId: 'CHEBI:29105', label: '1', note: 'catalytic' },
      },
      {
        type: 'Binding site',
        location: { start: 98, end: 98 },
        ligand: { name: 'Zn(2+)', chebiId: 'CHEBI:29105', label: '2' },
      },
    ]);

    expect(lines).toEqual(
      expect.arrayContaining([
        '- Binding site 88: proximal binding residue — heme b (CHEBI:60344); part Fe (CHEBI:18248)',
        '- Binding site 65 — substrate',
        '**EC numbers:** 2.6.1.1, 2.6.1.7',
        '- Transit peptide 1..29: Mitochondrion',
        '- Binding site 47 — Zn(2+) (CHEBI:29105) label 1, catalytic',
        '- Binding site 98 — Zn(2+) (CHEBI:29105) label 2',
      ]),
    );
    expect(text).not.toContain('substrate (');
  });

  it('returns processing and membrane topology on both surfaces', async () => {
    const { out, lines } = await call(
      { accessions: ['P01308', 'P29972', 'P00533'] },
      sectionRows.P01308,
      sectionRows.P29972,
      p00533Row,
    );

    const [insulin, aqp1, egfr] = out.succeeded;
    expect(insulin?.processing).toEqual([
      { type: 'Signal', location: { start: 1, end: 24 } },
      {
        type: 'Peptide',
        description: 'Insulin B chain',
        location: { start: 25, end: 54 },
        featureId: 'PRO_0000015819',
      },
      {
        type: 'Propeptide',
        description: 'C peptide',
        location: { start: 57, end: 87 },
        featureId: 'PRO_0000015820',
      },
      {
        type: 'Peptide',
        description: 'Insulin A chain',
        location: { start: 90, end: 110 },
        featureId: 'PRO_0000015821',
      },
    ]);
    expect(aqp1?.processing).toEqual([
      { type: 'Initiator methionine', description: 'Removed', location: { start: 1, end: 1 } },
    ]);
    expect(egfr?.topology).toEqual([
      {
        type: 'Topological domain',
        description: 'Extracellular',
        location: { start: 25, end: 645 },
      },
      { type: 'Transmembrane', description: 'Helical', location: { start: 646, end: 668 } },
      {
        type: 'Topological domain',
        description: 'Cytoplasmic',
        location: { start: 669, end: 1210 },
      },
    ]);
    expect(aqp1?.topology?.map((f) => f.type).sort()).toEqual([
      ...Array(2).fill('Intramembrane'),
      ...Array(9).fill('Topological domain'),
      ...Array(6).fill('Transmembrane'),
    ]);

    expect(lines).toEqual(
      expect.arrayContaining([
        '**Processing:**',
        '- Signal 1..24',
        '- Peptide 25..54 [PRO_0000015819]: Insulin B chain',
        '- Propeptide 57..87 [PRO_0000015820]: C peptide',
        '- Peptide 90..110 [PRO_0000015821]: Insulin A chain',
        '- Initiator methionine 1: Removed',
        '**Topology:**',
        '- Topological domain 25..645: Extracellular',
        '- Transmembrane 646..668: Helical',
        '- Topological domain 669..1210: Cytoplasmic',
        '- Intramembrane 69..82',
      ]),
    );
    const count = (prefix: string) => lines.filter((line) => line.startsWith(prefix)).length;
    expect(count('- Transmembrane ')).toBe(7);
    expect(count('- Intramembrane ')).toBe(2);
    expect(count('- Topological domain ')).toBe(11);
  });

  it('returns a mutagenesis row with its residue change and effect on both surfaces', async () => {
    const { out, lines } = await call(
      { accessions: ['P07477'], fields: 'accession,ft_mutagen' },
      { ...activeRawEntry('P07477', 'TRY1_HUMAN', 247), features: [sectionRows.P07477Mutagenesis] },
    );

    expect(out.succeeded[0]?.mutagenesis).toEqual([
      {
        description: 'Lack of sulfation.',
        location: { start: 154, end: 154 },
        original: 'Y',
        variation: 'F',
      },
    ]);
    expect(lines).toEqual(
      expect.arrayContaining(['**Mutagenesis:** 1', '- 154 Y→F: Lack of sulfation.']),
    );
  });

  it('keeps every substitution a mutagenesis row tested at one position', async () => {
    const { out, lines } = await call(
      { accessions: ['P00533'], sections: ['mutagenesis'] },
      p00533,
    );

    const at = (pos: number) =>
      out.succeeded[0]?.mutagenesis?.find((m) => m.location.start === pos);
    expect(at(692)).toMatchObject({ original: 'L', variation: 'A,P' });
    expect(at(745)).toMatchObject({ original: 'K', variation: 'A,M' });
    expect(lines).toEqual(
      expect.arrayContaining([
        '- 692 L→A,P: Strongly reduced phosphorylation.',
        '- 745 K→A,M: Abolishes kinase activity.',
      ]),
    );
  });

  it('names fields as a cause when a requested section is absent', async () => {
    const { out, lines } = await call(
      { accessions: ['P07477'], sections: ['mutagenesis'], fields: 'accession,cc_function' },
      activeRawEntry('P07477', 'TRY1_HUMAN', 247),
    );

    expect((out as { absentSections?: string[] }).absentSections).toEqual(['mutagenesis']);
    expect(lines).toContain(
      '**Absent sections:** mutagenesis — not in this response: UniProt holds no data of that kind for this record, or fields left it out.',
    );
  });

  it('returns P04637’s disease notes, free-text comments, GO evidence, Ensembl genes, and interactions on both surfaces', async () => {
    const { out, lines } = await call(
      {
        accessions: ['P04637'],
        sections: ['disease', 'comments', 'interactions', 'goTerms', 'xrefs', 'ensemblGenes'],
      },
      p04637,
    );

    const [entry] = out.succeeded;
    const causal = 'The disease is caused by variants affecting the gene represented in this entry';
    const pathogenesis = 'The gene represented in this entry is involved in disease pathogenesis';
    const susceptibility =
      'Disease susceptibility is associated with variants affecting the gene represented in this entry';
    expect(entry?.disease?.map((d) => d.note)).toEqual([
      causal,
      causal,
      pathogenesis,
      causal,
      causal,
      causal,
      susceptibility,
      causal,
    ]);
    const diseaseNote = p04637.comments[0]?.note?.texts[0]?.value;
    const isoformNote =
      'Expressed in quiescent lymphocytes. Seems to be non-functional. May be produced at very low levels due to a premature stop codon in the mRNA, leading to nonsense-mediated mRNA decay';
    expect(entry?.comments).toEqual([
      { type: 'DISEASE', value: diseaseNote },
      {
        type: 'MISCELLANEOUS',
        value: isoformNote,
        evidence: ['ECO:0000305'],
        molecule: 'Isoform 2',
      },
    ]);
    expect(entry?.goTerms).toEqual([
      { id: 'GO:0005813', term: 'centrosome', aspect: 'C', evidenceType: 'IDA:UniProtKB' },
      { id: 'GO:0000785', term: 'chromatin', aspect: 'C', evidenceType: 'IDA:BHF-UCL' },
    ]);
    expect(entry?.ensemblGenes).toEqual(['ENSG00000141510.20']);
    expect(entry?.xrefs?.Ensembl).toHaveLength(22);
    expect(entry?.xrefs?.Ensembl?.every((id) => id.startsWith('ENST'))).toBe(true);
    expect(entry?.interactions?.map((i) => i.partner)).toEqual([
      'P00519',
      'Q13155',
      'Q7L7W2',
      'P26663',
      'P17844',
      'P17844',
    ]);
    expect(entry?.interactions?.filter((i) => i.isoform)).toEqual([
      { partner: 'P17844', gene: 'DDX5', experiments: 2, isoform: 'P04637-1' },
      { partner: 'P17844', gene: 'DDX5', experiments: 2, isoform: 'P04637-7' },
    ]);

    expect(lines).toEqual(
      expect.arrayContaining([
        `- Esophageal cancer (ESCR) [OMIM:133239] [DI-01537]: ${p04637.comments[1]?.disease?.description} — ${causal}`,
        `- DISEASE: ${diseaseNote}`,
        `- MISCELLANEOUS (Isoform 2): ${isoformNote} (ECO:0000305)`,
        '**GO:** GO:0005813 [C] centrosome (IDA:UniProtKB); GO:0000785 [C] chromatin (IDA:BHF-UCL)',
        '**Ensembl genes:** `ENSG00000141510.20`',
        '**Interactions:** 6 partner(s)',
        '- P00519 (ABL1): 2 experiment(s)',
        '- Q13155 (AIMP2): 6 experiment(s)',
        '- Q7L7W2: 2 experiment(s)',
        "- P17844 (DDX5): 2 experiment(s); for this entry's isoform P04637-1",
        "- P17844 (DDX5): 2 experiment(s); for this entry's isoform P04637-7",
      ]),
    );
    const notes = (note: string) => lines.filter((line) => line.endsWith(` — ${note}`)).length;
    expect([notes(causal), notes(pathogenesis), notes(susceptibility)]).toEqual([6, 1, 1]);
    expect(lines.find((line) => line.startsWith('- `Ensembl`: '))?.match(/`ENST/g)).toHaveLength(
      22,
    );
  });

  it('renders a free-text type named in fields (cc_activity_regulation) into comments, beside 25 interactions', async () => {
    const { out, lines } = await call(
      { accessions: ['P00533'], fields: 'accession,cc_activity_regulation,cc_interaction' },
      p00533Row,
    );

    const regulation =
      'Endocytosis and inhibition of the activated EGFR by phosphatases like PTPRJ and PTPRK constitute immediate regulatory mechanisms. Upon EGF-binding phosphorylates EPS15 that regulates EGFR endocytosis and activity. Moreover, inducible feedback inhibitors including LRIG1, SOCS4, SOCS5 and ERRFI1 constitute alternative regulatory mechanisms for the EGFR signaling. Up-regulated by NEU3-mediated desialylation of N-linked glycan at Asn-528';
    const evidence = [
      'PubMed:15282549',
      'PubMed:15590694',
      'PubMed:17334392',
      'PubMed:18046415',
      'PubMed:19836242',
      'PubMed:25922362',
    ];
    const [egfr] = out.succeeded;
    expect(egfr?.comments).toEqual([{ type: 'ACTIVITY REGULATION', value: regulation, evidence }]);
    expect(egfr?.interactions).toHaveLength(25);
    expect(egfr?.interactions?.slice(0, 2)).toEqual([
      { partner: 'P00519', gene: 'ABL1', experiments: 3 },
      { partner: 'P42684', gene: 'ABL2', experiments: 9 },
    ]);

    expect(lines).toEqual(
      expect.arrayContaining([
        `- ACTIVITY REGULATION: ${regulation} (${evidence.join(', ')})`,
        '**Interactions:** 25 partner(s)',
        '- P00519 (ABL1): 3 experiment(s)',
        '- P42684 (ABL2): 9 experiment(s)',
      ]),
    );
    expect(lines.filter((line) => / experiment\(s\)/.test(line))).toHaveLength(25);
  });

  it('names the chain of a polyprotein partner and of this entry, dropping UniProt’s "-" gene placeholder', async () => {
    const p53 = await call({ accessions: ['P04637'], sections: ['interactions'] }, p04637);
    expect(p53.out.succeeded[0]?.interactions?.[3]).toEqual({
      partner: 'P26663',
      partnerChain: 'PRO_0000037536',
      experiments: 9,
      organismDiffer: true,
    });
    expect(p53.lines).toContain(
      '- P26663 [PRO_0000037536]: 9 experiment(s); partner from another organism',
    );

    const hcv = await call({ accessions: ['P26663'], sections: ['interactions'] }, p26663);
    expect(hcv.out.succeeded[0]?.interactions).toEqual([
      { partner: 'P52480', gene: 'Pkm', experiments: 3, organismDiffer: true },
      { partner: 'Q62245', gene: 'Sos1', experiments: 2, organismDiffer: true },
      {
        partner: 'P26663',
        partnerChain: 'PRO_0000037537',
        experiments: 6,
        chain: 'PRO_0000037536',
      },
      {
        partner: 'P04637',
        gene: 'TP53',
        experiments: 9,
        organismDiffer: true,
        chain: 'PRO_0000037536',
      },
      {
        partner: 'P26663',
        partnerChain: 'PRO_0000037540',
        experiments: 2,
        chain: 'PRO_0000037540',
      },
      {
        partner: 'Q9WMX2',
        partnerChain: 'PRO_0000037548',
        experiments: 5,
        organismDiffer: true,
        chain: 'PRO_0000037540',
      },
    ]);
    expect(hcv.lines).toEqual(
      expect.arrayContaining([
        '- P52480 (Pkm): 3 experiment(s); partner from another organism',
        "- P26663 [PRO_0000037537]: 6 experiment(s); for this entry's chain PRO_0000037536",
        "- P04637 (TP53): 9 experiment(s); partner from another organism; for this entry's chain PRO_0000037536",
        "- P26663 [PRO_0000037540]: 2 experiment(s); for this entry's chain PRO_0000037540",
        "- Q9WMX2 [PRO_0000037548]: 5 experiment(s); partner from another organism; for this entry's chain PRO_0000037540",
      ]),
    );
    expect(hcv.text).not.toContain('(-)');
  });

  /** The count header a windowed section renders, labelled as the window's count; other sections render none. */
  const WINDOW_COUNT_LINES: Record<string, string[]> = {
    sites: ['**Sites:** 1 in this window'],
    mutagenesis: ['**Mutagenesis:** 1 in this window'],
    interactions: ['**Interactions:** 1 partner(s) in this window'],
  };

  it.each([
    [
      'alternativeNames',
      'P07477',
      7,
      '**Alternative names:** Anionic trypsin I',
      '**Alternative names:** Anionic trypsin-I',
    ],
    ['ecNumbers', 'P00505', 2, '**EC numbers:** 2.6.1.1', '**EC numbers:** 2.6.1.7'],
    [
      'sites',
      'P07477',
      8,
      '- Active site 63: Charge relay system',
      '- Active site 107: Charge relay system',
    ],
    [
      'topology',
      'P00533',
      3,
      '- Topological domain 25..645: Extracellular',
      '- Transmembrane 646..668: Helical',
    ],
    [
      'processing',
      'P01308',
      4,
      '- Signal 1..24',
      '- Peptide 25..54 [PRO_0000015819]: Insulin B chain',
    ],
    [
      'mutagenesis',
      'P00533',
      37,
      '- 275 Y→A: Strongly reduced autophosphorylation and activation of downstream kinases; when associated with A-309.',
      '- 287 F→A: Strongly reduced autophosphorylation and activation of downstream kinases; when associated with A-309.',
    ],
    [
      'comments',
      'P07477',
      4,
      `- COFACTOR: ${COFACTOR_NOTE}`,
      '- SUBUNIT: Interacts with SERPINA1 (PubMed:11057674)',
    ],
    [
      'interactions',
      'P04637',
      6,
      '- P00519 (ABL1): 2 experiment(s)',
      '- Q13155 (AIMP2): 6 experiment(s)',
    ],
    [
      'ensemblGenes',
      'P07477',
      2,
      '**Ensembl genes:** `ENSG00000204983.15`',
      '**Ensembl genes:** `ENSG00000274247.4`',
    ],
  ])(
    'windows %s (%s) with section_limit and section_offset on both surfaces',
    async (key, accession, total, firstItemLine, secondItemLine) => {
      const rows: Record<string, object> = {
        P07477: p07477,
        P00505: sectionRows.P00505,
        P00533: p00533,
        P01308: sectionRows.P01308,
        P04637: p04637,
      };
      const row = required(rows[accession], `the ${accession} row`);
      const whole = await call({ accessions: [accession], sections: [key] }, row);
      const items = section(whole.out, key) ?? [];
      expect(items).toHaveLength(total);

      const { out, lines, text } = await call(
        { accessions: [accession], sections: [key], section_limit: 1, section_offset: 1 },
        row,
      );
      expect(section(out, key)).toEqual(items.slice(1, 2));
      expect(out.window).toEqual({ section: key, offset: 1 });
      expect(out.totalCount).toBe(total);
      expect(out.nextOffset).toBe(total > 2 ? 2 : undefined);
      expect(text).toContain(`**Window:** \`${key}\` items 2–2 (section_offset 1)`);
      expect(lines.filter((line) => line.endsWith(' in this window'))).toEqual(
        WINDOW_COUNT_LINES[key] ?? [],
      );
      expect(lines).toContain(secondItemLine);
      expect(lines).not.toContain(firstItemLine);
    },
  );

  it('outlines a record over the budget, listing every new section with its byte size on both surfaces', async () => {
    const combined = {
      ...p07477,
      features: [...p07477.features, ...p00533.features],
      comments: [...p07477.comments, ...p04637.comments],
    };
    const { out, lines } = await call({ accessions: ['P07477'] }, combined);

    expect(out.kind).toBe('outline');
    for (const key of NEW_KEYS) {
      const recall = await call({ accessions: ['P07477'], sections: [key] }, combined);
      const value = section(recall.out, key);
      expect(value?.length).toBeGreaterThan(0);
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      expect(out.sections).toContainEqual({ name: key, bytes });
      expect(lines).toContain(`- **${key}** — ${bytes} bytes`);
    }
  });

  it('omits every new section from a record without those annotations, on both surfaces', async () => {
    const { out, text } = await call(
      { accessions: ['C9JYS6'] },
      activeRawEntry('C9JYS6', 'C9JYS6_HUMAN', 120),
    );

    expect(Object.keys(out.succeeded[0] ?? {}).sort()).toEqual([
      'accession',
      'annotationScore',
      'entryName',
      'genes',
      'length',
      'organism',
      'proteinExistence',
      'reviewed',
    ]);
    expect(text).toBe(
      [
        '**Result kind:** full',
        '# C9JYS6_HUMAN (C9JYS6)',
        '**Entry:** C9JYS6_HUMAN',
        'Reviewed (Swiss-Prot) · Score 5/5 · 120 aa · 1: Evidence at protein level',
        '**Organism:** Homo sapiens (Human) "HUMAN" [taxon 9606]',
      ].join('\n'),
    );
  });
});
