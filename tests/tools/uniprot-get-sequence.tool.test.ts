/**
 * @fileoverview Tests for the uniprot_get_sequence tool — handler behavior with
 *   a stubbed UniProtService: the not_found ctx.fail contract (the not_found
 *   regression — a service NotFound must surface as data.reason === 'not_found',
 *   not a leaked raw 404 throw), canonical-record selection, the include_isoforms
 *   branch, an input-validation rejection for a malformed accession, and format()
 *   rendering. A second suite drives the tool through runToolContract to pin the
 *   error envelope a client actually receives on both surfaces.
 * @module tests/tools/uniprot-get-sequence.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceRecord } from '@/services/uniprot/types.js';
import { ACCESSION_MESSAGE, ACCESSION_REGEX } from '@/services/uniprot/types.js';
import {
  contentText,
  errorEnvelope,
  expectMcpError,
  INACTIVE_MESSAGES,
  INACTIVE_STUBS,
  redirectedResponse,
  rejectUnmockedFetch,
  requestedUrls,
  routeUpstream,
  upstreamResponse,
} from '../helpers.js';

const getFastaMock = vi.fn();

vi.mock('@/services/uniprot/uniprot-service.js', () => ({
  getUniProtService: () => ({ getFasta: getFastaMock }),
}));

const { getSequence } = await import('@/mcp-server/tools/definitions/uniprot-get-sequence.tool.js');

/** The real service, for tests that drive upstream responses through getFasta. */
const { UniProtService } = await vi.importActual<
  typeof import('@/services/uniprot/uniprot-service.js')
>('@/services/uniprot/uniprot-service.js');
const realService = new UniProtService({} as never, {} as never);

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
  vi.stubGlobal('fetch', vi.fn(rejectUnmockedFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSequence inactive accessions (real service, through runToolContract)', () => {
  const P53_FASTA = '>sp|P04637|P53_HUMAN Cellular tumor antigen p53\nMEEPQSDPSV\nEPPLSQETFS\n';
  const P53_ISOFORMS = `${P53_FASTA}>sp|P04637-2|P53_HUMAN Isoform 2 of Cellular tumor antigen p53\nMEEPQSDPSV\n`;
  const ALBUMIN_FASTA =
    '>sp|P02768|ALBU_HUMAN Albumin OS=Homo sapiens OX=9606 GN=ALB PE=1 SV=2\nMKWVTFISLL\nFLFSSAYSRG\n';
  const ALBUMIN_ISOFORMS = `${ALBUMIN_FASTA}>sp|P02768-2|ALBU_HUMAN Isoform 2 of Albumin OS=Homo sapiens OX=9606 GN=ALB\nMKWVTFISLL\n`;
  const STUBS: Record<string, object> = {
    Q13140: INACTIVE_STUBS.merged,
    P62158: INACTIVE_STUBS.demerged,
    Q9ZZZ9: INACTIVE_STUBS.deleted,
  };

  /**
   * UniProt as probed live: the per-accession .fasta follows a merge's 303 to the
   * target, answers a demerged/deleted accession 200 with an empty body, and 404s an
   * unknown one; the isoform FASTA search is empty for every inactive accession; the
   * JSON search returns the inactive stub.
   */
  function upstream() {
    const fetchStub = routeUpstream((url) => {
      if (url.pathname === '/uniprotkb/P04637.fasta') return upstreamResponse(200, P53_FASTA);
      if (url.pathname === '/uniprotkb/Q13140.fasta') {
        return redirectedResponse(
          'https://rest.uniprot.org/uniprotkb/P02768.fasta?from=Q13140',
          ALBUMIN_FASTA,
        );
      }
      if (
        url.pathname === '/uniprotkb/P62158.fasta' ||
        url.pathname === '/uniprotkb/Q9ZZZ9.fasta'
      ) {
        return upstreamResponse(200, '');
      }
      if (url.pathname === '/uniprotkb/Q00000.fasta') {
        return upstreamResponse(404, 'Error encountered when streaming data.', 'Not Found');
      }
      if (url.pathname !== '/uniprotkb/search') return;
      const query = url.searchParams.get('query') ?? '';
      if (url.searchParams.get('format') === 'fasta') {
        if (query === 'accession:P04637') return upstreamResponse(200, P53_ISOFORMS);
        if (query === 'accession:P02768') return upstreamResponse(200, ALBUMIN_ISOFORMS);
        return upstreamResponse(200, '');
      }
      const accession = query.match(/^accession:\((\w+)\)$/)?.[1] ?? '';
      const stub = STUBS[accession];
      return upstreamResponse(200, { results: stub ? [stub] : [] });
    });
    vi.stubGlobal('fetch', fetchStub);
    getFastaMock.mockImplementation(realService.getFasta.bind(realService));
    return fetchStub;
  }

  type SequenceOut = {
    accession: string;
    mergedFrom?: string;
    canonical: { header: string };
    isoforms?: { isoformId: string; header: string }[];
  };

  it.each([false, true])(
    'returns an active accession labelled as requested in one request, no redirect (characterization, include_isoforms %s)',
    async (include_isoforms) => {
      const fetchStub = upstream();
      const result = await runToolContract(getSequence, { accession: 'P04637', include_isoforms });

      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as SequenceOut;
      expect(out.accession).toBe('P04637');
      expect(Object.keys(out).sort()).toEqual(
        include_isoforms ? ['accession', 'canonical', 'isoforms'] : ['accession', 'canonical'],
      );
      expect(contentText(result)).not.toContain('merged');
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it('follows a merged accession to the target and labels the sequence with the target', async () => {
    const fetchStub = upstream();
    const result = await runToolContract(getSequence, { accession: 'Q13140' });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as SequenceOut;
    expect(out.accession).toBe('P02768');
    expect(out.mergedFrom).toBe('Q13140');
    expect(out.canonical.header).toContain('|P02768|');
    const text = contentText(result);
    expect(text).toContain('Q13140 was merged into P02768');
    expect(text).toContain('# P02768');
    // The redirect rode the one request the active path also makes.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('follows a merged accession with include_isoforms, returning the target canonical and isoforms', async () => {
    const fetchStub = upstream();
    const result = await runToolContract(getSequence, {
      accession: 'Q13140',
      include_isoforms: true,
    });

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as SequenceOut;
    expect(out.accession).toBe('P02768');
    expect(out.mergedFrom).toBe('Q13140');
    expect(out.canonical.header).toContain('|P02768|');
    expect(out.isoforms?.map((i) => i.isoformId)).toEqual(['P02768-2']);
    for (const iso of out.isoforms ?? []) expect(iso.header).toContain('|P02768-');
    expect(contentText(result)).toContain('Q13140 was merged into P02768');
    // Empty isoform search → one stub lookup → the target's isoform search.
    const urls = requestedUrls(fetchStub);
    expect(urls.map((u) => u.searchParams.get('query'))).toEqual([
      'accession:Q13140',
      'accession:(Q13140)',
      'accession:P02768',
    ]);
  });

  it.each([
    ['demerged', 'P62158', false, INACTIVE_MESSAGES.demerged],
    ['demerged', 'P62158', true, INACTIVE_MESSAGES.demerged],
    ['deleted', 'Q9ZZZ9', false, INACTIVE_MESSAGES.deleted],
    ['deleted', 'Q9ZZZ9', true, INACTIVE_MESSAGES.deleted],
  ])(
    'returns not_found naming the pointer for a %s accession %s (include_isoforms %s)',
    async (_type, accession, include_isoforms, message) => {
      const fetchStub = upstream();
      const result = await runToolContract(getSequence, { accession, include_isoforms });

      expect(result.isError).toBe(true);
      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
      expect(envelope.data).toMatchObject({ reason: 'not_found' });
      expect(envelope.message).toBe(message);
      expect(contentText(result)).toContain(message);
      // The empty body costs one stub lookup, on this failure path only.
      expect(fetchStub).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'keeps the existing not_found text for an unknown accession (characterization, include_isoforms %s)',
    async (include_isoforms) => {
      upstream();
      const result = await runToolContract(getSequence, { accession: 'Q00000', include_isoforms });

      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
      expect(envelope.data).toMatchObject({ reason: 'not_found' });
      expect(envelope.message).toBe('No sequence found for accession Q00000.');
    },
  );
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
    // The declared recovery hint is filled in by the framework, not the handler —
    // the runToolContract suite below pins it on both surfaces.
    expect(err.data).toMatchObject({ reason: 'not_found' });
  });

  it('lets a non-404 service failure bubble with its own code, not as not_found', async () => {
    getFastaMock.mockRejectedValue(
      serviceUnavailable('uniprot.getFasta failed upstream (-32000).'),
    );
    const result = await runToolContract(getSequence, { accession: 'P04637' });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(envelope.message).toBe('uniprot.getFasta failed upstream (-32000).');
    expect(envelope.data?.reason).toBeUndefined();
  });

  it('returns the canonical sequence and omits isoforms when include_isoforms is false', async () => {
    getFastaMock.mockResolvedValue({ accession: 'P04637', records: [canonicalRecord] });
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
    getFastaMock.mockResolvedValue({
      accession: 'P04637',
      records: [isoformRecord, canonicalRecord],
    });
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
    getFastaMock.mockResolvedValue({ accession: 'P04637', records: [canonicalRecord] });
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

describe('getSequence error envelope (through runToolContract)', () => {
  // These drive the tool the way a client does — argument parsing, handler,
  // format(), and the dual-surface error shaping — rather than calling the
  // handler with pre-parsed input. That is the only level at which the
  // rejection code, the reason, and the content[] text are observable.

  it('rejects an out-of-schema accession as InvalidParams, not ValidationError', async () => {
    const result = await runToolContract(getSequence, {
      accession: 'not-an-accession',
    } as never);

    const envelope = errorEnvelope(result);
    expect(result.isError).toBe(true);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.code).toBe(-32602);
    expect(envelope.data).toMatchObject({ reason: 'invalid_arguments' });
    // Containment, not byte-equality: the message prefix and the reason trailer
    // move with the framework.
    expect(contentText(result)).toContain('accession');
    expect(contentText(result)).toContain('(reason invalid_arguments)');
    expect(getFastaMock).not.toHaveBeenCalled();
  });

  it.each(['not-a-valid-accession!!', 'P04637-2'])(
    'rejects malformed accession %s with the human-readable accession message, not the compiled pattern',
    async (accession) => {
      const result = await runToolContract(getSequence, { accession } as never);

      const envelope = errorEnvelope(result);
      expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(envelope.data).toMatchObject({ reason: 'invalid_arguments' });
      const expected = `accession: ${ACCESSION_MESSAGE}`;
      expect(envelope.message).toContain(expected);
      expect(contentText(result)).toContain(expected);
      expect(envelope.message).not.toContain('must match pattern');
      expect(contentText(result)).not.toContain('[OPQ]');
      expect(getFastaMock).not.toHaveBeenCalled();
    },
  );

  it('advertises the accession constraint as a bare pattern — the message is not in the schema', () => {
    const schema = JSON.stringify(z.toJSONSchema(getSequence.input));
    expect(schema).toContain(JSON.stringify(ACCESSION_REGEX.source));
    expect(schema).not.toContain('Must be a UniProtKB');
  });

  it('renders an omitted required field as missing, with a Recovery hint on both surfaces', async () => {
    const result = await runToolContract(getSequence, {} as never);

    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.InvalidParams);
    const hint = (envelope.data?.recovery as { hint?: string } | undefined)?.hint;
    expect(hint).toContain('accession');
    // The hint adds something the message does not, so it also reaches content[].
    expect(contentText(result)).toContain(`Recovery: ${hint}`);
    expect(getFastaMock).not.toHaveBeenCalled();
  });

  it('carries the declared reason and recovery hint to content[] on a not_found', async () => {
    getFastaMock.mockRejectedValue(
      notFound('No sequence found for accession Q99999.', { accession: 'Q99999' }),
    );

    const result = await runToolContract(getSequence, { accession: 'Q99999' });
    const envelope = errorEnvelope(result);
    expect(envelope.code).toBe(JsonRpcErrorCode.NotFound);
    expect(envelope.data).toMatchObject({ reason: 'not_found' });

    const text = contentText(result);
    expect(text).toContain('Recovery: Retry with a replacement accession the message names');
    expect(text).toContain('(reason not_found)');
  });

  it('puts no upstream request URL or response body on the client-facing error data', async () => {
    // The service sanitizes upstream internals before they get here; this pins
    // the second line of defense — the handler re-throws with its own data and
    // never spreads the caught error's, so leaky keys cannot ride through.
    getFastaMock.mockRejectedValue(
      notFound('No sequence found for accession Q99999.', {
        accession: 'Q99999',
        url: 'https://rest.uniprot.org/uniprotkb/Q99999.fasta',
        responseBody: '<html><body>Q99999 not found</body></html>',
      }),
    );

    const result = await runToolContract(getSequence, { accession: 'Q99999' });
    const envelope = errorEnvelope(result);
    expect(envelope.data).not.toHaveProperty('url');
    expect(envelope.data).not.toHaveProperty('responseBody');
    expect(contentText(result)).not.toContain('rest.uniprot.org');
  });
});
