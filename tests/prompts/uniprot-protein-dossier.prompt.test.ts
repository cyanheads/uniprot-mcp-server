/**
 * @fileoverview Tests for the uniprot_protein_dossier prompt — message
 *   generation and the optional-organism branch.
 * @module tests/prompts/uniprot-protein-dossier.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { proteinDossier } from '@/mcp-server/prompts/definitions/uniprot-protein-dossier.prompt.js';

describe('proteinDossier', () => {
  it('generates a workflow message that names the bridge and entry tools', async () => {
    const args = proteinDossier.args!.parse({ identifier: 'TP53' });
    const messages = await proteinDossier.generate(args);
    expect(messages.length).toBeGreaterThan(0);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toContain('TP53');
    expect(text).toContain('uniprot_map_ids');
    expect(text).toContain('uniprot_get_entry');
    expect(text).toContain('Swiss-Prot');
  });

  it('weaves the organism into the workflow when provided', async () => {
    const args = proteinDossier.args!.parse({ identifier: 'TP53', organism: 'Homo sapiens' });
    const messages = await proteinDossier.generate(args);
    const text = messages[0]!.content.type === 'text' ? messages[0]!.content.text : '';
    expect(text).toContain('Homo sapiens');
    expect(text).toContain('tax_id');
  });
});
