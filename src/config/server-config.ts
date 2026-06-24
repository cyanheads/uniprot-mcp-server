/**
 * @fileoverview Server-specific configuration for uniprot-mcp-server — the
 *   UniProt REST base URL, request timeout, ID-mapping poll budget, and default
 *   page size. UniProt REST is keyless, so there is no API-key field. Lazy-parsed
 *   via `parseEnvConfig`, separate from the framework's core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('https://rest.uniprot.org')
    .describe('UniProt REST base URL. Override for a private mirror or testing.'),
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-request HTTP timeout in milliseconds.'),
  idMappingBudgetMs: z.coerce
    .number()
    .int()
    .positive()
    .default(8_000)
    .describe(
      'Wall-clock budget for the inline ID-mapping poll loop before returning a resumable ticket. Should be less than timeoutMs.',
    ),
  defaultPageSize: z.coerce
    .number()
    .int()
    .positive()
    .max(500)
    .default(25)
    .describe(
      'Default page size for search and proteome protein listing when the caller leaves it unset.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config from the environment. Maps schema
 * paths to env var names so validation errors name the variable, not the path.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'UNIPROT_BASE_URL',
    timeoutMs: 'UNIPROT_TIMEOUT_MS',
    idMappingBudgetMs: 'UNIPROT_ID_MAPPING_BUDGET_MS',
    defaultPageSize: 'UNIPROT_DEFAULT_PAGE_SIZE',
  });
  return _config;
}
