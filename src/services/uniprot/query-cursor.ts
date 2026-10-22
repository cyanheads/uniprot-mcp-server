/**
 * @fileoverview Versioned UniProtKB cursors bound to a tool and exact result query.
 * @module services/uniprot/query-cursor
 */

import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';

const TokenSchema = z
  .object({ version: z.literal(1), fingerprint: z.string(), cursor: z.string().min(1) })
  .strict();

function fingerprint(tool: string, query: string): string {
  return createHash('sha256')
    .update(JSON.stringify([tool, query]))
    .digest('hex');
}

function rejected(): never {
  throw invalidParams(
    'The cursor is malformed, from an older version, or belongs to another query or tool. Re-call with the same query and filters but no cursor to restart from the first page.',
    { reason: 'invalid_cursor' },
  );
}

/** Encode upstream positions without exposing a reusable cross-query cursor. Empty input means first page. */
export const queryCursor = {
  encode(cursor: string, tool: string, query: string): string {
    return Buffer.from(
      JSON.stringify({ version: 1, fingerprint: fingerprint(tool, query), cursor }),
      'utf8',
    ).toString('base64url');
  },
  decode(token: string | undefined, tool: string, query: string): string | undefined {
    if (!token) return undefined;
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) return rejected();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) return rejected();
      throw error;
    }
    const parsed = TokenSchema.safeParse(value);
    if (!parsed.success || parsed.data.fingerprint !== fingerprint(tool, query)) return rejected();
    return parsed.data.cursor;
  },
};
