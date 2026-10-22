/**
 * @fileoverview Assemble the exact UniProtKB query for a resolved proteome.
 * @module services/uniprot/proteome-query
 */
import { groupClause } from '@/services/uniprot/types.js';

/** The resolved UPID fixes membership; a caller's optional clause narrows it. */
export function proteomeQuery(upid: string, query: string | undefined): string {
  return query ? `proteome:${upid} AND ${groupClause(query)}` : `proteome:${upid}`;
}
