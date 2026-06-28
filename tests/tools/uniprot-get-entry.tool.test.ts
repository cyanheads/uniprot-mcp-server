/**
 * @fileoverview Tests for the uniprot_get_entry tool. Two layers: format()
 *   rendering for the full arm (including a sparse TrEMBL-style entry that omits
 *   every curated section), the per-accession failure arm, and the outline arm;
 *   plus handler behavior with a stubbed UniProtService — the all_not_found
 *   ctx.fail contract, the partial-success succeeded[]/failed[] split, input
 *   validation at the schema edge, and the outline-on-overflow / sections re-call
 *   paths.
 * @module tests/tools/uniprot-get-entry.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/services/uniprot/types.js';

const getEntriesMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getEntries: getEntriesMock }),
}));

const { getEntry } = await import('@/mcp-server/tools/definitions/uniprot-get-entry.tool.js');

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getEntry handler', () => {
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
    getEntriesMock.mockResolvedValue([fullEntry, brca1]);
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
    getEntriesMock.mockResolvedValue([fullEntry]);
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
    getEntriesMock.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['Q99999', 'Q88888'] });

    const err = await getEntry.handler(input, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
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
    getEntriesMock.mockResolvedValue([huge]);
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P38398'] });

    const result = await getEntry.handler(input, ctx);
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
    getEntriesMock.mockResolvedValue([huge]);
    const ctx = createMockContext({ errors: getEntry.errors });
    const input = getEntry.input.parse({ accessions: ['P04637'], sections: ['disease'] });

    const result = await getEntry.handler(input, ctx);
    expect(result.kind).toBe('full');
    const entry = result.succeeded?.[0];
    // Always-keep identity fields survive; the requested section is kept.
    expect(entry?.accession).toBe('P04637');
    expect(entry?.disease).toBeDefined();
    // The oversized, unrequested section is dropped by the projection.
    expect(entry?.function).toBeUndefined();
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
