/**
 * @fileoverview Tests for the uniprot_get_sequence tool — handler behavior with
 *   a stubbed UniProtService: the not_found ctx.fail contract (the not_found
 *   regression — a service NotFound must surface as data.reason === 'not_found',
 *   not a leaked raw 404 throw), canonical-record selection, the include_isoforms
 *   branch, an input-validation rejection for a malformed accession, and format()
 *   rendering.
 * @module tests/tools/uniprot-get-sequence.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceRecord } from '@/services/uniprot/types.js';
import { expectMcpError } from '../helpers.js';

const getFastaMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getFasta: getFastaMock }),
}));

const { getSequence } = await import('@/mcp-server/tools/definitions/uniprot-get-sequence.tool.js');

const canonicalRecord: SequenceRecord = {
  header:
    'sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4',
  sequence: 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGP',
  length: 59,
};

const isoformRecord: SequenceRecord = {
  isoformId: 'P04637-2',
  header: 'sp|P04637-2|P53_HUMAN Isoform 2 OS=Homo sapiens OX=9606 GN=TP53',
  sequence: 'MEEPQSDPSVEPPLSQETFSDLWKLL',
  length: 26,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSequence', () => {
  it('rejects a malformed accession at the schema edge before any upstream call', () => {
    expect(() => getSequence.input.parse({ accession: 'not-an-accession' })).toThrow();
    expect(getFastaMock).not.toHaveBeenCalled();
  });

  it('rejects an isoform-suffixed accession at the schema edge', () => {
    // The canonical accession is the lookup key — the -N suffix must be stripped first.
    expect(() => getSequence.input.parse({ accession: 'P04637-2' })).toThrow();
  });

  it('routes the service NotFound through ctx.fail("not_found") with a clean typed error', async () => {
    getFastaMock.mockRejectedValue(
      notFound('No sequence found for accession Q99999.', { accession: 'Q99999' }),
    );
    const ctx = createMockContext({ errors: getSequence.errors });
    const input = getSequence.input.parse({ accession: 'Q99999' });

    const err = await expectMcpError(getSequence.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ reason: 'not_found' });
    expect((err.data as { recovery?: unknown }).recovery).toBeDefined();
  });

  it('returns the canonical sequence and omits isoforms when include_isoforms is false', async () => {
    getFastaMock.mockResolvedValue([canonicalRecord]);
    const ctx = createMockContext({ errors: getSequence.errors });
    const input = getSequence.input.parse({ accession: 'P04637' });

    const result = await getSequence.handler(input, ctx);
    expect(getFastaMock).toHaveBeenCalledWith('P04637', false, ctx);
    expect(result.accession).toBe('P04637');
    expect(result.canonical.length).toBe(59);
    expect(result.isoforms).toBeUndefined();
    expect(result).toEqual(expect.schemaMatching(getSequence.output));
  });

  it('selects the non-isoform record as canonical and returns isoforms when requested', async () => {
    // Service returns isoform first; handler must still pick the canonical (no -N id) record.
    getFastaMock.mockResolvedValue([isoformRecord, canonicalRecord]);
    const ctx = createMockContext({ errors: getSequence.errors });
    const input = getSequence.input.parse({ accession: 'P04637', include_isoforms: true });

    const result = await getSequence.handler(input, ctx);
    expect(getFastaMock).toHaveBeenCalledWith('P04637', true, ctx);
    expect(result.canonical.length).toBe(59);
    expect(result.canonical.header).toContain('P53_HUMAN');
    expect(result.isoforms).toHaveLength(1);
    expect(result.isoforms?.[0]?.isoformId).toBe('P04637-2');
    expect(result).toEqual(expect.schemaMatching(getSequence.output));
  });

  it('omits the isoforms key when include_isoforms is true but none exist', async () => {
    getFastaMock.mockResolvedValue([canonicalRecord]);
    const ctx = createMockContext({ errors: getSequence.errors });
    const input = getSequence.input.parse({ accession: 'P04637', include_isoforms: true });

    const result = await getSequence.handler(input, ctx);
    expect(result.isoforms).toBeUndefined();
  });

  it('format() renders the canonical FASTA block', () => {
    const blocks = getSequence.format!({
      accession: 'P04637',
      canonical: canonicalRecord,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('P04637');
    expect(text).toContain('59 aa');
    expect(text).toContain('P53_HUMAN');
    expect(text).toContain(canonicalRecord.sequence);
  });

  it('format() renders isoform FASTA blocks when present', () => {
    const blocks = getSequence.format!({
      accession: 'P04637',
      canonical: canonicalRecord,
      isoforms: [isoformRecord as SequenceRecord & { isoformId: string }],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Isoforms (1)');
    expect(text).toContain('P04637-2');
    expect(text).toContain('26 aa');
  });
});
