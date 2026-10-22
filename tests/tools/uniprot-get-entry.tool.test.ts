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

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/services/uniprot/types.js';
import { ACCESSION_MESSAGE } from '@/services/uniprot/types.js';
import p00918 from '../fixtures/p00918-xrefs.json' with { type: 'json' };
import {
  activeRawEntry,
  contentText,
  errorEnvelope,
  expectMcpError,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  RAW_ENTRIES,
  rejectUnmockedFetch,
  requestedUrls,
  routeUpstream,
  UNIPROT_400_BODIES,
  upstreamResponse,
} from '../helpers.js';

const getEntriesMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getEntries: getEntriesMock }),
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
    const base = { ...brca1, function: [{ value: 'seed' }], xrefs: {} };
    const empty = { kind: 'full' as const, succeeded: [base], failed: [] };
    const overhead = Buffer.byteLength(
      JSON.stringify({ structuredContent: empty, content: getEntry.format!(empty) }),
      'utf8',
    );
    const remaining = 24_000 - overhead;
    expect(remaining % 2).toBe(0);
    const entry = { ...base, function: [{ value: `seed${'x'.repeat(remaining / 2)}` }] };
    getEntriesMock.mockResolvedValue(batch(entry));
    const at = await runToolContract(getEntry, { accessions: ['P38398'] });
    expect(Buffer.byteLength(JSON.stringify(at), 'utf8')).toBe(24_000);
    expect(at.structuredContent).toMatchObject({ kind: 'full', succeeded: [entry] });
    getEntriesMock.mockResolvedValue(
      batch({ ...entry, function: [{ value: `${entry.function[0]?.value}x` }] }),
    );
    const over = await runToolContract(getEntry, { accessions: ['P38398'] });
    expect(over.structuredContent).toMatchObject({ kind: 'outline' });
    expect(over.structuredContent).not.toHaveProperty('succeeded');
    // Multibyte annotations consume bytes, not UTF-16 code units.
    getEntriesMock.mockResolvedValue(
      batch({ ...base, function: [{ value: 'é'.repeat(remaining / 2) }] }),
    );
    expect(
      (await runToolContract(getEntry, { accessions: ['P38398'] })).structuredContent,
    ).toMatchObject({ kind: 'outline' });
  });
  it('outlines aggregate successes in request order and preserves failures and duplicate requests', async () => {
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
    expect(result.structuredContent).toMatchObject({
      kind: 'outline',
      outlinedEntries: [{ accession: 'P38398' }, { accession: 'P04637' }, { accession: 'P38398' }],
      failed: [{ accession: 'Q00000' }],
    });
    expect(result.structuredContent).not.toHaveProperty('succeeded');
    const text = contentText(result);
    expect(text).toContain('accessions:["P38398"]');
    expect(text).toContain('accessions:["P04637"]');
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
      expect(out.kind).toBe('outline');
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
    expect(lines.filter((line) => /^- \d+: Variant /.test(line))).toEqual(
      Array.from({ length: 40 }, (_, i) => `- ${i + 1}: Variant ${i}`),
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

  it('rejects a batch larger than 20', () => {
    const tooMany = Array.from({ length: 21 }, () => 'P04637');
    expect(() => getEntry.input.parse({ accessions: tooMany })).toThrow();
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
    // Real service (sanitizer included) over a stubbed fetch answering UniProt's 400.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(upstreamResponse(400, UNIPROT_400_BODIES.badFields, 'Bad Request')),
      ),
    );
    getEntriesMock.mockImplementation(realService.getEntries.bind(realService));

    const result = await runToolContract(getEntry, {
      accessions: ['P04637'],
      fields: 'definitely_not_a_uniprot_field',
    });
    const envelope = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.message).toBe(
      "UniProt rejected the request: Invalid fields parameter value 'definitely_not_a_uniprot_field'",
    );
    expect(envelope.data).toMatchObject({ reason: 'invalid_fields' });
    const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
    expect(hint).toContain('omit fields');
    const text = contentText(result);
    expect(text).toContain("'definitely_not_a_uniprot_field'");
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
      **Function:** Acts as a tumor suppressor. (PubMed:11025664)
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
      **Function:** Acts as a tumor suppressor. (PubMed:11025664)
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
      **Function:** Acts as a tumor suppressor. (PubMed:11025664)
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
      - Region 1-9: Region 0
      - Region 11-19: Region 1
      - Region 21-29: Region 2
      - Region 31-39: Region 3
      - Region 41-49: Region 4
      - Region 51-59: Region 5
      - Region 61-69: Region 6
      - Region 71-79: Region 7
      - Region 81-89: Region 8
      - Region 91-99: Region 9
      - Region 101-109: Region 10
      - Region 111-119: Region 11
      - Region 121-129: Region 12
      - Region 131-139: Region 13
      - Region 141-149: Region 14
      - Region 151-159: Region 15
      - Region 161-169: Region 16
      - Region 171-179: Region 17
      - Region 181-189: Region 18
      - Region 191-199: Region 19
      - Region 201-209: Region 20
      - Region 211-219: Region 21
      - Region 221-229: Region 22
      - Region 231-239: Region 23
      - Region 241-249: Region 24
      - Region 251-259: Region 25
      - Region 261-269: Region 26
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
    ['section_limit 501', { section_limit: 501 }],
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
        '**Organism:** Homo sapiens (Human) [taxon 9606]',
        '**Genes:** PAH',
        '**Function:** Catalyzes the hydroxylation of L-phenylalanine to L-tyrosine (PubMed:18460651, PubMed:18835579)',
        '**Catalytic activity:**',
        `- ${RAW_ENTRIES.pah.comments[1].reaction.name} (RHEA:20273) [EC 1.14.16.1]`,
        '**Cofactors:** Fe(2+) (CHEBI:29033)',
        '**Disease:**',
        `- Phenylalanine hydroxylase deficiency (PAH deficiency) [OMIM:261600] [DI-02159]: ${RAW_ENTRIES.pah.comments[3].disease.description}`,
        '**Variants:** 3 natural variant(s)',
        '- 16 S→P [VAR_000869]: in PAH deficiency; severe; uncertain significance; dbSNP:rs62642946',
        '- 63-64 TH→PN [VAR_000881]: in PAH deficiency; severe; abolishes phenylalanine binding',
        '- 39 [VAR_000871]: in PAH deficiency; severe',
        '**PTMs:** 1',
        '- Modified residue @16: Phosphoserine; by PKA',
        '**Domains/regions:**',
        '- Domain 36-114: ACT',
        '**GO:** GO:0005829 [C] cytosol; GO:0005506 [F] iron ion binding',
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
        '**Subcellular location:** Cytoplasm; Nucleus',
        '**Isoforms:** P04637-1 (1) [Displayed], P04637-2 (2) [Described]',
        '- Esophageal cancer (ESCR) [OMIM:133239] [DI-01537]: A malignancy of the esophagus.',
        '- Region 100-370: Interaction with HIPK1',
        '- Modified residue @9: Phosphoserine; by HIPK4',
      ]),
    );
    // P08100 — a location with its membrane topology.
    expect(lines).toContain(
      '**Subcellular location:** Photoreceptor outer segment membrane (Multi-pass membrane protein)',
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
        '- Disulfide bond @31-96: Interchain (between B and A chains)',
        '- Disulfide bond @95-100',
      ]),
    );
    const [url] = requestedUrls(fetchStub);
    expect(url?.searchParams.get('fields')?.split(',')).toContain('ft_disulfid');
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
