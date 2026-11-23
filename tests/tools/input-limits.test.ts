/**
 * @fileoverview The input-cap seam: what a count input accepts, rejects, and
 *   advertises with UNIPROT_CLAMP_LIMITS on (the default) and off, and what a
 *   page-size clamp and an accession deferral return, log, and count. Each tool's
 *   own tests prove only that its inputs are wired here.
 * @module tests/tools/input-limits.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';

/** Every counter the module creates and every `add` it receives. */
const recorded = vi.hoisted(() => ({
  adds: [] as { attributes: unknown; value: number }[],
  names: [] as string[],
}));

// The counter is the one effect with no other observable; record it at the factory.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    recorded.names.push(name);
    return {
      add: (value: number, attributes?: unknown) => recorded.adds.push({ attributes, value }),
    };
  },
}));

const { clampPageSize, countInput, PAGE_SIZE_CAP, recordDeferral } = await import(
  '@/mcp-server/tools/input-limits.js'
);

const describeLimit = (clamped: boolean) => (clamped ? 'clamped text' : 'strict text');

/** The property as `tools/list` advertises it. */
function advertised(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(z.object({ value: schema }), {
    io: 'input',
    target: 'draft-2020-12',
  }) as { properties: Record<string, Record<string, unknown>> };
  return json.properties.value as Record<string, unknown>;
}

beforeEach(() => {
  recorded.adds.length = 0;
});

afterEach(() => {
  getServerConfig().clampLimits = true;
});

it('pins the page-size cap at UniProt’s page maximum and creates one counter', () => {
  expect(PAGE_SIZE_CAP).toBe(500);
  expect(recorded.names).toEqual(['uniprot.input.limited']);
});

describe('a count input with UNIPROT_CLAMP_LIMITS on (the default)', () => {
  const schema = countInput(500, describeLimit);

  it('advertises an integer with a minimum and no maximum', () => {
    expect(advertised(schema)).toEqual({
      type: 'integer',
      minimum: 1,
      description: 'clamped text',
    });
  });

  it.each([1, 500, 501, 1e20])(
    'accepts %s unchanged, leaving any clamp to the handler',
    (value) => {
      expect(schema.parse(value)).toBe(value);
    },
  );

  it.each([
    [0, 'too_small'],
    [-5, 'too_small'],
    [1.5, 'invalid_type'],
    [Number.POSITIVE_INFINITY, 'invalid_type'],
    [Number.NaN, 'invalid_type'],
    ['50', 'invalid_type'],
  ])('rejects %s as %s', (value, code) => {
    const issues = schema.safeParse(value).error?.issues ?? [];
    expect(issues.map((issue) => issue.code)).toContain(code);
  });

  it('names a fraction an integer mistake, not a size one', () => {
    expect(schema.safeParse(1.5).error?.issues).toEqual([
      expect.objectContaining({ code: 'invalid_type', expected: 'int' }),
    ]);
  });
});

describe('a count input with UNIPROT_CLAMP_LIMITS=false', () => {
  const schema = countInput(500, describeLimit);

  beforeEach(() => {
    getServerConfig().clampLimits = false;
  });

  it('advertises the strict maximum and the strict description', () => {
    expect(advertised(schema)).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'strict text',
    });
  });

  it('accepts the maximum itself', () => {
    expect(schema.parse(500)).toBe(500);
  });

  it.each([501, 1e20])('rejects %s as too_big at 500', (value) => {
    expect(schema.safeParse(value).error?.issues).toEqual([
      expect.objectContaining({ code: 'too_big', maximum: 500, inclusive: true }),
    ]);
  });

  it('still names a fraction an integer mistake', () => {
    expect(schema.safeParse(1.5).error?.issues).toEqual([
      expect.objectContaining({ code: 'invalid_type', expected: 'int' }),
    ]);
  });
});

it('reads the switch on every parse and every emission of a schema built before it changed', () => {
  const schema = countInput(500, describeLimit);
  expect(schema.safeParse(501).success).toBe(true);
  expect(advertised(schema).maximum).toBeUndefined();

  getServerConfig().clampLimits = false;

  expect(schema.safeParse(501).success).toBe(false);
  expect(advertised(schema).maximum).toBe(500);
});

describe('clampPageSize', () => {
  it.each([1, 499, 500])('serves %s as asked, with no notice, log line, or count', (requested) => {
    const ctx = createMockContext();
    expect(clampPageSize(requested, 'uniprot_search_proteins', ctx)).toEqual({
      applied: requested,
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([]);
    expect(recorded.adds).toEqual([]);
  });

  it.each([501, 1e20])(
    'serves %s at 500 with a notice naming both values, one log line, and one count',
    (requested) => {
      const ctx = createMockContext();
      expect(clampPageSize(requested, 'uniprot_get_proteome', ctx)).toEqual({
        applied: 500,
        notice: `size ${String(requested)} is above UniProt's page maximum of 500, so this page was requested at size 500.`,
      });
      expect((ctx.log as MockContextLogger).calls).toEqual([
        expect.objectContaining({
          level: 'info',
          data: { tool: 'uniprot_get_proteome', requested, applied: 500 },
        }),
      ]);
      expect(recorded.adds).toEqual([
        {
          value: 1,
          attributes: {
            'mcp.tool.name': 'uniprot_get_proteome',
            'uniprot.input.name': 'size',
            'uniprot.input.limit': 'clamp',
          },
        },
      ]);
    },
  );

  it('names uniprot_map_ids on the log line and the count of an ID-mapping page clamp', () => {
    const ctx = createMockContext();
    expect(clampPageSize(501, 'uniprot_map_ids', ctx).applied).toBe(500);
    expect((ctx.log as MockContextLogger).calls).toEqual([
      expect.objectContaining({
        data: { tool: 'uniprot_map_ids', requested: 501, applied: 500 },
      }),
    ]);
    expect(recorded.adds).toEqual([
      {
        value: 1,
        attributes: {
          'mcp.tool.name': 'uniprot_map_ids',
          'uniprot.input.name': 'size',
          'uniprot.input.limit': 'clamp',
        },
      },
    ]);
  });
});

describe('recordDeferral', () => {
  it('writes one log line with the counts and adds one deferral count', () => {
    const ctx = createMockContext();
    recordDeferral({ distinct: 23, fetched: 20, deferred: 3 }, ctx);
    expect((ctx.log as MockContextLogger).calls).toEqual([
      expect.objectContaining({ level: 'info', data: { distinct: 23, fetched: 20, deferred: 3 } }),
    ]);
    expect(recorded.adds).toEqual([
      {
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
