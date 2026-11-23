/**
 * @fileoverview Input caps that follow UNIPROT_CLAMP_LIMITS — `size` on
 *   uniprot_search_proteins, uniprot_get_proteome, and uniprot_map_ids,
 *   `section_limit` and `accessions` on uniprot_get_entry. With clamping on
 *   (the default) an over-the-cap value is served up to its cap and disclosed;
 *   with UNIPROT_CLAMP_LIMITS=false the cap is advertised and enforced at the schema.
 *   Each clamp or deferral writes one log line and adds one to a counter.
 * @module mcp-server/tools/input-limits
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { activeServerConfig } from '@/config/server-config.js';

/** UniProt's page maximum: the most rows one search, proteome, or ID-mapping results page returns. */
export const PAGE_SIZE_CAP = 500;

const limited = createCounter(
  'uniprot.input.limited',
  'Over-the-cap inputs served up to their cap instead of rejected',
  '{calls}',
);

/** Whether over-the-cap inputs are served up to their caps (the default) rather than rejected. */
export function clamping(): boolean {
  return activeServerConfig().clampLimits;
}

/**
 * A whole-number count input, minimum 1, whose maximum follows
 * UNIPROT_CLAMP_LIMITS: none while clamping, `strictMaximum` while it is off.
 * The integer rule is a `.check()` with `type: 'integer'` set through
 * `.meta()`, because `.int()` advertises and enforces `Number.MAX_SAFE_INTEGER`,
 * a bound no call is served at. The getters read the switch on every parse and
 * every `tools/list` emission, never at import.
 */
export function countInput(strictMaximum: number, describe: (clamped: boolean) => string) {
  return z
    .number()
    .min(1)
    .check((payload) => {
      if (!Number.isInteger(payload.value)) {
        payload.issues.push({ code: 'invalid_type', expected: 'int', input: payload.value });
        return;
      }
      if (!clamping() && payload.value > strictMaximum) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: strictMaximum,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .meta({
      type: 'integer',
      get maximum() {
        return clamping() ? undefined : strictMaximum;
      },
      get description() {
        return describe(clamping());
      },
    });
}

/**
 * The page size a search, proteome, or ID-mapping call requests: the caller's,
 * or `PAGE_SIZE_CAP` for a larger one, which is logged, counted, and disclosed by
 * the returned notice. Under UNIPROT_CLAMP_LIMITS=false the schema has already
 * rejected anything larger.
 */
export function clampPageSize(
  requested: number,
  tool: 'uniprot_search_proteins' | 'uniprot_get_proteome' | 'uniprot_map_ids',
  ctx: Context,
): { applied: number; notice?: string } {
  if (requested <= PAGE_SIZE_CAP) return { applied: requested };
  ctx.log.info('Clamped size to the UniProt page maximum', {
    tool,
    requested,
    applied: PAGE_SIZE_CAP,
  });
  limited.add(1, {
    [ATTR_MCP_TOOL_NAME]: tool,
    'uniprot.input.name': 'size',
    'uniprot.input.limit': 'clamp',
  });
  return {
    applied: PAGE_SIZE_CAP,
    notice: `size ${requested} is above UniProt's page maximum of ${PAGE_SIZE_CAP}, so this page was requested at size ${PAGE_SIZE_CAP}.`,
  };
}

/** Log and count a uniprot_get_entry call that deferred the accessions past its fetch cap. */
export function recordDeferral(
  counts: { distinct: number; fetched: number; deferred: number },
  ctx: Context,
): void {
  ctx.log.info('Deferred accessions past the fetch cap', counts);
  limited.add(1, {
    [ATTR_MCP_TOOL_NAME]: 'uniprot_get_entry',
    'uniprot.input.name': 'accessions',
    'uniprot.input.limit': 'deferral',
  });
}
