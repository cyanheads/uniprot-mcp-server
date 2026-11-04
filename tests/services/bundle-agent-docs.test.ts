/**
 * @fileoverview Bundle pruning retains SDK skill runtime while removing package-root agent docs.
 * @module tests/services/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as cleanerPattern,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linterPattern } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation selection', () => {
  it('retains SDK runtime skill modules at top-level and nested installations', () => {
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/consumer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/other/dist/skills/loader.js',
    ];
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    for (const entry of runtime) expect(linterPattern.test(entry)).toBe(false);
  });

  it('strips only agent documentation at package roots', () => {
    const docs = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/other/skills/research/SKILL.md',
      'node_modules/consumer/node_modules/@scope/package/.claude/config.json',
      'node_modules/other/SKILL.md',
    ];
    expect(filterAgentDocEntries(docs)).toEqual(docs);
    for (const entry of docs) expect(linterPattern.test(entry)).toBe(true);
    expect(cleanerPattern.source).toBe(linterPattern.source);
  });
});
