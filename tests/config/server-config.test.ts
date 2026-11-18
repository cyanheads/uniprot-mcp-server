/**
 * @fileoverview Server config parsing: UNIPROT_CLAMP_LIMITS read as a strict
 *   boolean that defaults to true, and the config input schemas read — the
 *   schema defaults before `getServerConfig()` parses the environment, the parsed
 *   values after. Each case loads a fresh module so the cached config starts empty.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the config module, its cache empty, reading the stubbed environment. */
async function freshConfig() {
  vi.resetModules();
  return await import('@/config/server-config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('UNIPROT_CLAMP_LIMITS', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('defaults to true when %s', async (_case, value) => {
    vi.stubEnv('UNIPROT_CLAMP_LIMITS', value);
    const { getServerConfig } = await freshConfig();
    expect(getServerConfig().clampLimits).toBe(true);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
  ])('reads %j as %s', async (value, expected) => {
    vi.stubEnv('UNIPROT_CLAMP_LIMITS', value);
    const { getServerConfig } = await freshConfig();
    expect(getServerConfig().clampLimits).toBe(expected);
  });

  it('rejects a value that is not a boolean word, naming the variable', async () => {
    vi.stubEnv('UNIPROT_CLAMP_LIMITS', 'maybe');
    const { getServerConfig } = await freshConfig();
    expect(() => getServerConfig()).toThrow(/UNIPROT_CLAMP_LIMITS/);
  });
});

describe('activeServerConfig', () => {
  it('returns the schema defaults before getServerConfig() runs, without reading the environment', async () => {
    vi.stubEnv('UNIPROT_CLAMP_LIMITS', 'maybe');
    vi.stubEnv('UNIPROT_DEFAULT_PAGE_SIZE', '50');
    const { activeServerConfig } = await freshConfig();
    expect(activeServerConfig()).toMatchObject({ clampLimits: true, defaultPageSize: 25 });
  });

  it('returns the parsed config once getServerConfig() has run', async () => {
    vi.stubEnv('UNIPROT_CLAMP_LIMITS', 'false');
    vi.stubEnv('UNIPROT_DEFAULT_PAGE_SIZE', '50');
    const { activeServerConfig, getServerConfig } = await freshConfig();
    getServerConfig();
    expect(activeServerConfig()).toMatchObject({ clampLimits: false, defaultPageSize: 50 });
  });
});
