/**
 * @fileoverview Text fragments the entry, search, and proteome tools render the
 *   same way in `content[]`: a row's molecule label and a protein's length with
 *   its sequence flags.
 * @module mcp-server/tools/protein-format
 */

/** A row's molecule as a leading label ("Isoform 2: "), or nothing when it has none. */
export function moleculeLabel(molecule: string | undefined): string {
  return molecule ? `${molecule}: ` : '';
}

/** A protein's length in residues, with its sequence flags when UniProt sets any: "393 aa", "50 aa (Fragment)". */
export function lengthLabel(length: number, sequenceFlags: string[] | undefined): string {
  return `${length} aa${sequenceFlags?.length ? ` (${sequenceFlags.join(', ')})` : ''}`;
}
