/**
 * @fileoverview Server-specific configuration for uniprot-mcp-server — the
 *   UniProt REST base URL, request timeout, ID-mapping poll budget, default
 *   page size, and whether over-the-cap count inputs are served up to their
 *   caps. UniProt REST is keyless, so there is no API-key field. Lazy-parsed
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
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve an over-the-cap size (search, proteome) at 500 with a notice, accept any section_limit, and accept up to 500 accessions on uniprot_get_entry, fetching the first 20 distinct and deferring the rest. False advertises and enforces the strict caps: size and section_limit at most 500, at most 20 accessions.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Every field at its default: the config input schemas read before `setup()` parses the environment. */
const SCHEMA_DEFAULTS: ServerConfig = ServerConfigSchema.parse({});

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config from the environment. Maps schema
 * paths to env var names so validation errors name the variable, not the path.
 * `setup()` reaches it first, through `initUniProtService()`, after `createApp()`
 * has loaded `.env`; never call it at module import.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'UNIPROT_BASE_URL',
    timeoutMs: 'UNIPROT_TIMEOUT_MS',
    idMappingBudgetMs: 'UNIPROT_ID_MAPPING_BUDGET_MS',
    defaultPageSize: 'UNIPROT_DEFAULT_PAGE_SIZE',
    clampLimits: 'UNIPROT_CLAMP_LIMITS',
  });
  return _config;
}

/**
 * The config an input schema reads when it validates or is emitted: what
 * `getServerConfig()` parsed, or the schema defaults before it runs. Never
 * parses the environment, since `tool()` emits every input schema when its
 * definition module is imported — before `.env` is loaded.
 */
export function activeServerConfig(): ServerConfig {
  return _config ?? SCHEMA_DEFAULTS;
}
