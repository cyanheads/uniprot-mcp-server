/**
 * @fileoverview Shared rejection assertions, error-envelope readers, and
 *   upstream fixtures for the test suite.
 *
 * Replaces the `promise.catch((e) => e as McpError)` idiom. That idiom types as
 * `T | McpError` — which no longer compiles now that `tests/` is typechecked —
 * and, more importantly, lets a call that unexpectedly *resolves* flow into the
 * assertions as though it had thrown, turning a real regression into a
 * confusing `undefined`-property failure. These helpers make a non-rejection a
 * loud, self-describing failure.
 *
 * @module tests/helpers
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { vi } from 'vitest';
import featureLocations from './fixtures/feature-locations.json' with { type: 'json' };
import residueCoverage from './fixtures/residue-coverage.json' with { type: 'json' };

/**
 * Await a call that must reject, and return the thrown `Error`.
 *
 * Takes `unknown` because a definition's `handler` is typed `T | Promise<T>` —
 * a synchronous handler is legal — so the argument is not always a `PromiseLike`.
 */
export async function expectRejection(call: unknown): Promise<Error> {
  try {
    await call;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Expected the call to reject with an Error, got: ${String(err)}`);
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/** Await a call that must reject with an `McpError`, and return it. */
export async function expectMcpError(call: unknown): Promise<McpError> {
  const err = await expectRejection(call);
  if (!(err instanceof McpError)) {
    throw new Error(`Expected an McpError, got ${err.name}: ${err.message}`);
  }
  return err;
}

/** The `structuredContent.error` envelope a client reads off a failed call. */
export type ErrorEnvelope = {
  code: number;
  message: string;
  data?: Record<string, unknown>;
};

/** Read the error envelope out of a `runToolContract` result. */
export function errorEnvelope(result: { structuredContent?: unknown }): ErrorEnvelope {
  const envelope = (result.structuredContent as { error?: ErrorEnvelope } | undefined)?.error;
  if (!envelope) throw new Error('Expected the call to return an error envelope.');
  return envelope;
}

/** Join a `runToolContract` result's text blocks — the `content[]` surface. */
export function contentText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
}

/**
 * HTTP 400 bodies as rest.uniprot.org returned them (captured 2026-10-12). Every
 * UniProt 400 is `{ url, messages[] }`; only `messages[]` may reach a client.
 */
export const UNIPROT_400_BODIES = {
  badFields: {
    url: 'http://rest.uniprot.org/uniprotkb/search',
    messages: ["Invalid fields parameter value 'definitely_not_a_uniprot_field'"],
  },
  badQueryField: {
    url: 'http://rest.uniprot.org/uniprotkb/search',
    messages: ["'badfield' is not a valid search field"],
  },
  invalidSyntax: {
    url: 'http://rest.uniprot.org/uniprotkb/search',
    messages: ['query parameter has an invalid syntax'],
  },
  badFacet: {
    url: 'http://rest.uniprot.org/uniprotkb/search',
    messages: [
      "Invalid facet name 'not_a_facet'. Expected value can be [structure_3d, fragment, proteins_with, length, existence, reviewed, annotation_score, model_organism, other_organism, proteome].",
    ],
  },
  /** UniProt answers a bad `query` and a bad `fields` together with both messages in one array, query first. */
  badQueryAndFields: {
    url: 'http://rest.uniprot.org/uniprotkb/search',
    messages: [
      "'badfield' is not a valid search field",
      "Invalid fields parameter value 'definitely_not_a_uniprot_field'",
    ],
  },
  unsupportedDbPair: {
    url: 'http://rest.uniprot.org/idmapping/run',
    messages: ["The combination of 'from=PDB' and 'to=Gene_Name' parameters is invalid"],
  },
  /** `/taxonomy/{id}` for an id too large to parse; `3000000000` still answers 404. */
  taxonIdUnparseable: {
    url: 'http://rest.uniprot.org/taxonomy/100000000000000000000',
    messages: ['For input string: "100000000000000000000"'],
  },
} as const;

/** A real `Response` for a stubbed global `fetch`, as rest.uniprot.org would send it. */
export function upstreamResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

/** Default global `fetch` stub: a call a test did not mock fails loudly instead of reaching the network. */
export function rejectUnmockedFetch(input: unknown): Promise<never> {
  return Promise.reject(new Error(`Unmocked fetch in test: ${String(input)}`));
}

/** The URL a stubbed `fetch` was called with. */
function urlOf(input: unknown): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

/**
 * A stubbed global `fetch` that answers by URL. `route` returns the response for
 * a request it recognizes and `undefined` for one it does not, which rejects the
 * way `rejectUnmockedFetch` does. `.mock.calls` records every request, so a test
 * can count round trips.
 */
export function routeUpstream(route: (url: URL) => Response | undefined) {
  return vi.fn((input: unknown) => {
    const response = route(urlOf(input));
    return response ? Promise.resolve(response) : rejectUnmockedFetch(input);
  });
}

/** The URLs a `routeUpstream` stub was called with, in order. */
export function requestedUrls(fetchStub: ReturnType<typeof routeUpstream>): URL[] {
  return fetchStub.mock.calls.map(([input]) => urlOf(input));
}

/**
 * A 200 that the platform reached by following a redirect — how `fetch` hands
 * back `/uniprotkb/Q13140.fasta` after UniProt's 303 to the merge target.
 * `Response` cannot be constructed with `redirected`/`url`, so they are set here.
 */
export function redirectedResponse(finalUrl: string, body: string): Response {
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
  Object.defineProperty(response, 'url', { value: finalUrl });
  Object.defineProperty(response, 'redirected', { value: true });
  return response;
}

/**
 * Inactive UniProtKB stubs as `rest.uniprot.org` returned them (release 2026_03,
 * captured 2026-10-12): the search/entry JSON for a merged, a demerged, and a
 * deleted accession, and a deleted ID-mapping target as
 * `/idmapping/uniprotkb/results/{job}?fields=accession` returns it.
 */
export const INACTIVE_STUBS = {
  merged: {
    entryType: 'Inactive',
    primaryAccession: 'Q13140',
    uniProtkbId: 'Q13140',
    annotationScore: 0.0,
    inactiveReason: { inactiveReasonType: 'MERGED', mergeDemergeTo: ['P02768'] },
    extraAttributes: { uniParcId: 'UPI000016A1A8' },
  },
  demerged: {
    entryType: 'Inactive',
    primaryAccession: 'P62158',
    uniProtkbId: 'CALM_HUMAN',
    annotationScore: 0.0,
    inactiveReason: {
      inactiveReasonType: 'DEMERGED',
      mergeDemergeTo: ['P0DP25', 'P0DP23', 'P0DP24'],
    },
    extraAttributes: { uniParcId: 'UPI0000020B41' },
  },
  deleted: {
    entryType: 'Inactive',
    primaryAccession: 'Q9ZZZ9',
    uniProtkbId: 'Q9ZZZ9_9HEXA',
    annotationScore: 0.0,
    inactiveReason: {
      inactiveReasonType: 'DELETED',
      deletedReason: 'Not part of a reference proteome',
    },
    extraAttributes: { uniParcId: 'UPI000008B5B6' },
  },
  deletedMappingTarget: {
    entryType: 'Inactive',
    primaryAccession: 'Q9ZZZ9',
    inactiveReason: {
      inactiveReasonType: 'DELETED',
      deletedReason: 'Not part of a reference proteome',
    },
    extraAttributes: { uniParcId: 'UPI000008B5B6' },
  },
} as const;

/** The caller-facing text each inactive stub above must produce. */
export const INACTIVE_MESSAGES = {
  merged: 'Q13140 is inactive in UniProtKB: merged into P02768. Retry with P02768.',
  demerged:
    'P62158 is inactive in UniProtKB: demerged into P0DP25, P0DP23, P0DP24. Pick the one matching your gene and organism, then retry.',
  deleted:
    'Q9ZZZ9 was deleted from UniProtKB (Not part of a reference proteome). Its sequence survives in UniParc as UPI000008B5B6.',
} as const;

/** A minimal active UniProtKB search/entry row, as the default projection returns it. */
export function activeRawEntry(accession: string, entryName: string, length = 393) {
  return {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: accession,
    uniProtkbId: entryName,
    annotationScore: 5.0,
    proteinExistence: '1: Evidence at protein level',
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    sequence: { length },
  };
}

// --- #46: feature locations ---

/**
 * Entry name and length for each accession in `fixtures/feature-locations.json`:
 * feature rows captured from rest.uniprot.org (release 2026_04, 2026-11-23), each
 * as UniProt sent it and cut to the rows used — bounds UniProt marks UNSURE,
 * OUTSIDE, or UNKNOWN, and positions it numbers on an isoform.
 */
const FEATURE_LOCATION_ENTRIES = {
  O75339: ['CILP1_HUMAN', 1184],
  O35116: ['CTND2_RAT', 264],
  O43240: ['KLK10_HUMAN', 276],
  O00533: ['NCHL1_HUMAN', 1208],
  P35573: ['GDE_HUMAN', 1532],
  O00139: ['KIF2A_HUMAN', 706],
  A2RU49: ['HYKK_HUMAN', 373],
  O15294: ['OGT1_HUMAN', 1046],
  O70431: ['ADRB2_MERUN', 251],
  P05207: ['KAP2_PIG', 155],
  Q16739: ['CEGT_HUMAN', 394],
} as const satisfies Record<keyof typeof featureLocations, readonly [string, number]>;

/** An accession captured in `fixtures/feature-locations.json`. */
export type FeatureLocationAccession = keyof typeof featureLocations;

/** An active entry row carrying one accession's captured feature rows. */
export function featureLocationRow(accession: FeatureLocationAccession) {
  const [entryName, length] = FEATURE_LOCATION_ENTRIES[accession];
  return { ...activeRawEntry(accession, entryName, length), features: featureLocations[accession] };
}

// --- #48: residue coverage ---

/**
 * Entry name and length for each accession in `fixtures/residue-coverage.json`:
 * position-bearing feature rows captured from rest.uniprot.org (release 2026_04,
 * 2026-11-23), in UniProt order with evidences cut — each accession's rows of the
 * sections a residue case reads. P04637 holds every row of its default record's
 * sites, PTMs, processing, and domains as UniProt sent them (its four Binding site
 * rows also without their `featureCrossReferences`), and its 1,363 natural variants
 * written compactly as `[featureId, start, end, original, variation]` (every bound
 * EXACT; descriptions cut).
 */
const RESIDUE_COVERAGE_ENTRIES = {
  P04637: ['P53_HUMAN', 393],
  O43240: ['KLK10_HUMAN', 276],
  O75339: ['CILP1_HUMAN', 1184],
  O00533: ['NCHL1_HUMAN', 1208],
  O00139: ['KIF2A_HUMAN', 706],
} as const satisfies Record<keyof typeof residueCoverage, readonly [string, number]>;

/** An accession captured in `fixtures/residue-coverage.json`. */
export type ResidueCoverageAccession = keyof typeof residueCoverage;

/** An active entry row carrying one accession's captured position-bearing rows. */
export function residueCoverageRow(accession: ResidueCoverageAccession) {
  const [entryName, length] = RESIDUE_COVERAGE_ENTRIES[accession];
  const rows = residueCoverage[accession];
  const features = Array.isArray(rows)
    ? rows
    : [
        ...rows.features,
        ...rows.variants.map(([featureId, start, end, original, variation]) => ({
          type: 'Natural variant',
          location: {
            start: { value: start, modifier: 'EXACT' },
            end: { value: end, modifier: 'EXACT' },
          },
          featureId,
          alternativeSequence: { originalSequence: original, alternativeSequences: [variation] },
        })),
      ];
  return { ...activeRawEntry(accession, entryName, length), features };
}

const pubmed = (id: string) => ({ evidenceCode: 'ECO:0000269', source: 'PubMed', id });
const exact = (start: number, end: number) => ({
  start: { value: start, modifier: 'EXACT' },
  end: { value: end, modifier: 'EXACT' },
});

// --- #47: a biophysicochemical part with two texts ---

/**
 * An active entry row whose one BIOPHYSICOCHEMICAL PROPERTIES comment carries two texts in
 * each of its five text parts, each with its own evidence (the first kinetics note has none,
 * as UniProt sent it). The captured comments send one text per part, so this one is assembled
 * from texts rest.uniprot.org sent for other entries (release 2026_04, captured 2026-11-23):
 * the kinetics notes of A9WGE2 and P09874, the pH texts of P55263 and A9WGE2, the temperature
 * texts of O75503 and P14920, the redox potentials of Q96JJ7 and Q8N5K1, and Q9SYW8's
 * absorption with its note beside B0F481's.
 */
export const TWO_TEXT_BIOPHYSICOCHEMICAL_ROW = {
  ...activeRawEntry('P00000', 'TEST_HUMAN'),
  comments: [
    {
      commentType: 'BIOPHYSICOCHEMICAL PROPERTIES',
      kineticParameters: {
        note: {
          texts: [
            {
              value: 'kcat is 1.7 sec(-1) for lyase activity with (R)-citramalyl-CoA as substrate.',
            },
            { value: 'kcat is 390 sec(-1) for NAD(+).', evidences: [pubmed('7852410')] },
          ],
        },
      },
      phDependence: {
        texts: [
          { value: 'Optimum pH is 6.5.', evidences: [pubmed('6246102')] },
          { value: 'Optimum pH is 7 (at 55 degrees Celsius).', evidences: [pubmed('17259315')] },
        ],
      },
      temperatureDependence: {
        texts: [
          { value: 'Thermostable.', evidences: [pubmed('37708259')] },
          { value: 'Optimum temperature is 45 degrees Celsius.', evidences: [pubmed('29326945')] },
        ],
      },
      redoxPotential: {
        texts: [
          { value: 'E(0) is -157 mV.', evidences: [pubmed('15623505')] },
          { value: 'E is 0 +/- 10 mV for 2Fe-2S at pH 7.5.', evidences: [pubmed('19580816')] },
        ],
      },
      absorption: {
        max: 695,
        approximate: true,
        note: {
          texts: [
            { value: 'Emission maxima at 702 nm.', evidences: [pubmed('11553743')] },
            {
              value: 'Shoulder at 335 nm (at pH 7.5 and 30 degrees Celsius).',
              evidences: [pubmed('22547782')],
            },
          ],
        },
      },
    },
  ],
};

/**
 * Full curated UniProtKB rows as `rest.uniprot.org/uniprotkb/search` returned
 * them under the default entry projection (release 2026_03, captured
 * 2026-10-12). Arrays are cut to a few representative items and long texts to
 * their first sentence; every object keeps the shape UniProt sent.
 *
 * - `pah` (P00439): function with PubMed evidence, a catalytic activity with a
 *   Rhea id and EC number, a ChEBI cofactor, a disease with an OMIM xref, a
 *   domain, a modified residue, a substitution variant and a variant whose
 *   `alternativeSequence` is empty, keywords, and PDB/RefSeq/ChEMBL/Ensembl/GO xrefs.
 * - `p53` (P04637): a gene with a synonym, subcellular locations without
 *   topology, isoforms, a DISEASE comment that carries only a note (no disease
 *   block), a disease with no evidence, and a region whose evidence has no source.
 * - `rhodopsin` (P08100): a subcellular location with a membrane topology.
 * - `insulin` (P01308), requested with `fields` naming the identity columns plus
 *   `ft_disulfid`: disulfide bonds spanning a range, one with an empty description.
 */
export const RAW_ENTRIES = {
  pah: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P00439',
    uniProtkbId: 'PH4H_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: {
      recommendedName: {
        fullName: { value: 'Phenylalanine-4-hydroxylase' },
        shortNames: [{ value: 'PAH' }],
        ecNumbers: [{ evidences: [pubmed('18460651')], value: '1.14.16.1' }],
      },
      alternativeNames: [{ fullName: { value: 'Phe-4-monooxygenase' } }],
    },
    genes: [{ geneName: { value: 'PAH' } }],
    comments: [
      {
        texts: [
          {
            evidences: [pubmed('18460651'), pubmed('18835579')],
            value: 'Catalyzes the hydroxylation of L-phenylalanine to L-tyrosine',
          },
        ],
        commentType: 'FUNCTION',
      },
      {
        commentType: 'CATALYTIC ACTIVITY',
        reaction: {
          name: '(6R)-L-erythro-5,6,7,8-tetrahydrobiopterin + L-phenylalanine + O2 = (4aS,6R)-4a-hydroxy-L-erythro-5,6,7,8-tetrahydrobiopterin + L-tyrosine',
          reactionCrossReferences: [
            { database: 'Rhea', id: 'RHEA:20273' },
            { database: 'ChEBI', id: 'CHEBI:15379' },
          ],
          ecNumber: '1.14.16.1',
          evidences: [pubmed('18460651')],
        },
      },
      {
        commentType: 'COFACTOR',
        cofactors: [
          {
            name: 'Fe(2+)',
            evidences: [{ evidenceCode: 'ECO:0000250', source: 'UniProtKB', id: 'P04176' }],
            cofactorCrossReference: { database: 'ChEBI', id: 'CHEBI:29033' },
          },
        ],
      },
      {
        commentType: 'DISEASE',
        disease: {
          diseaseId: 'Phenylalanine hydroxylase deficiency',
          diseaseAccession: 'DI-02159',
          acronym: 'PAH deficiency',
          description:
            'An autosomal recessive inborn error of phenylalanine metabolism characterized by intolerance to dietary intake of the essential amino acid phenylalanine',
          diseaseCrossReference: { database: 'MIM', id: '261600' },
          evidences: [pubmed('10200057')],
        },
      },
    ],
    features: [
      {
        type: 'Domain',
        location: exact(36, 114),
        description: 'ACT',
        evidences: [{ evidenceCode: 'ECO:0000255', source: 'PROSITE-ProRule', id: 'PRU01007' }],
      },
      {
        type: 'Modified residue',
        location: exact(16, 16),
        description: 'Phosphoserine; by PKA',
        evidences: [pubmed('12185072')],
      },
      {
        type: 'Natural variant',
        location: exact(16, 16),
        description: 'in PAH deficiency; severe; uncertain significance; dbSNP:rs62642946',
        featureCrossReferences: [{ database: 'dbSNP', id: 'rs62642946' }],
        evidences: [pubmed('32668217')],
        featureId: 'VAR_000869',
        alternativeSequence: { originalSequence: 'S', alternativeSequences: ['P'] },
      },
      {
        type: 'Natural variant',
        location: exact(63, 64),
        description: 'in PAH deficiency; severe; abolishes phenylalanine binding',
        evidences: [pubmed('8889590'), pubmed('9634518')],
        featureId: 'VAR_000881',
        alternativeSequence: { originalSequence: 'TH', alternativeSequences: ['PN'] },
      },
      {
        type: 'Natural variant',
        location: exact(39, 39),
        description: 'in PAH deficiency; severe',
        evidences: [pubmed('23792259')],
        featureId: 'VAR_000871',
        alternativeSequence: {},
      },
    ],
    keywords: [
      { id: 'KW-0002', category: 'Technical term', name: '3D-structure' },
      { id: 'KW-0021', category: 'Molecular function', name: 'Allosteric enzyme' },
    ],
    uniProtKBCrossReferences: [
      {
        database: 'PDB',
        id: '1DMW',
        properties: [
          { key: 'Method', value: 'X-ray' },
          { key: 'Resolution', value: '2.00 A' },
          { key: 'Chains', value: 'A=118-424' },
        ],
      },
      {
        database: 'PDB',
        id: '1J8T',
        properties: [
          { key: 'Method', value: 'X-ray' },
          { key: 'Resolution', value: '1.70 A' },
          { key: 'Chains', value: 'A=103-427' },
        ],
      },
      {
        database: 'RefSeq',
        id: 'NP_000268.1',
        properties: [{ key: 'NucleotideSequenceId', value: 'NM_000277.3' }],
      },
      { database: 'ChEMBL', id: 'CHEMBL3076', properties: [{ key: 'Description', value: '-' }] },
      {
        database: 'Ensembl',
        id: 'ENST00000553106.6',
        properties: [
          { key: 'ProteinId', value: 'ENSP00000448059.1' },
          { key: 'GeneId', value: 'ENSG00000171759.11' },
        ],
      },
      {
        database: 'GO',
        id: 'GO:0005829',
        properties: [
          { key: 'GoTerm', value: 'C:cytosol' },
          { key: 'GoEvidenceType', value: 'TAS:Reactome' },
        ],
      },
      {
        database: 'GO',
        id: 'GO:0005506',
        properties: [
          { key: 'GoTerm', value: 'F:iron ion binding' },
          { key: 'GoEvidenceType', value: 'IEA:InterPro' },
        ],
      },
    ],
    sequence: { length: 452 },
    extraAttributes: { uniParcId: 'UPI00001318A0' },
  },
  p53: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P04637',
    uniProtkbId: 'P53_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: {
      recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } },
      alternativeNames: [{ fullName: { value: 'Antigen NY-CO-13' } }],
    },
    genes: [{ geneName: { value: 'TP53' }, synonyms: [{ value: 'P53' }] }],
    comments: [
      {
        commentType: 'SUBCELLULAR LOCATION',
        subcellularLocations: [
          { location: { evidences: [pubmed('15340061')], value: 'Cytoplasm', id: 'SL-0086' } },
          { location: { evidences: [pubmed('15340061')], value: 'Nucleus', id: 'SL-0191' } },
        ],
      },
      {
        commentType: 'ALTERNATIVE PRODUCTS',
        events: ['Alternative promoter usage', 'Alternative splicing'],
        isoforms: [
          {
            name: { value: '1' },
            synonyms: [{ value: 'p53' }, { value: 'p53alpha' }],
            isoformIds: ['P04637-1'],
            isoformSequenceStatus: 'Displayed',
          },
          {
            name: { value: '2' },
            synonyms: [{ value: 'I9RET' }, { value: 'p53beta' }],
            isoformIds: ['P04637-2'],
            sequenceIds: ['VSP_006535', 'VSP_006536'],
            isoformSequenceStatus: 'Described',
          },
        ],
      },
      {
        commentType: 'DISEASE',
        note: {
          texts: [
            { value: 'TP53 is found in increased amounts in a wide variety of transformed cells' },
          ],
        },
      },
      {
        commentType: 'DISEASE',
        disease: {
          diseaseId: 'Esophageal cancer',
          diseaseAccession: 'DI-01537',
          acronym: 'ESCR',
          description: 'A malignancy of the esophagus.',
          diseaseCrossReference: { database: 'MIM', id: '133239' },
        },
        note: {
          texts: [
            {
              value:
                'The disease is caused by variants affecting the gene represented in this entry',
            },
          ],
        },
      },
    ],
    features: [
      {
        type: 'Region',
        location: exact(100, 370),
        description: 'Interaction with HIPK1',
        evidences: [{ evidenceCode: 'ECO:0000250' }],
      },
      {
        type: 'Modified residue',
        location: exact(9, 9),
        description: 'Phosphoserine; by HIPK4',
        evidences: [pubmed('18022393')],
      },
    ],
    sequence: { length: 393 },
    extraAttributes: { uniParcId: 'UPI000002ED67' },
  },
  rhodopsin: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P08100',
    uniProtkbId: 'OPSD_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: {
      recommendedName: {
        fullName: {
          evidences: [{ evidenceCode: 'ECO:0000303', source: 'PubMed', id: '6589631' }],
          value: 'Rhodopsin',
        },
      },
      alternativeNames: [{ fullName: { value: 'Opsin-2' } }],
    },
    genes: [
      {
        geneName: {
          evidences: [{ evidenceCode: 'ECO:0000312', source: 'HGNC', id: 'HGNC:10012' }],
          value: 'RHO',
        },
        synonyms: [{ value: 'OPN2' }],
      },
    ],
    comments: [
      {
        commentType: 'SUBCELLULAR LOCATION',
        subcellularLocations: [
          {
            location: {
              evidences: [pubmed('25664179')],
              value: 'Photoreceptor outer segment membrane',
              id: 'SL-0513',
            },
            topology: {
              evidences: [pubmed('19934218')],
              value: 'Multi-pass membrane protein',
              id: 'SL-9909',
            },
          },
        ],
      },
    ],
    sequence: { length: 348 },
    extraAttributes: { uniParcId: 'UPI0000046CE6' },
  },
  insulin: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P01308',
    uniProtkbId: 'INS_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: {
      recommendedName: { fullName: { value: 'Insulin' } },
      contains: [
        { recommendedName: { fullName: { value: 'Insulin B chain' } } },
        { recommendedName: { fullName: { value: 'Insulin A chain' } } },
      ],
      flag: 'Precursor',
    },
    genes: [{ geneName: { value: 'INS' } }],
    features: [
      {
        type: 'Disulfide bond',
        location: exact(31, 96),
        description: 'Interchain (between B and A chains)',
        evidences: [pubmed('1433291'), { evidenceCode: 'ECO:0007744', source: 'PDB', id: '1AI0' }],
      },
      {
        type: 'Disulfide bond',
        location: exact(95, 100),
        description: '',
        evidences: [pubmed('1433291'), { evidenceCode: 'ECO:0007744', source: 'PDB', id: '1AI0' }],
      },
    ],
    sequence: { length: 110 },
    extraAttributes: { uniParcId: 'UPI00000017EA' },
  },
} as const;

// --- #45: the molecule behind a hit's function snippet ---

/**
 * `/uniprotkb/search` rows under the default search projection (UniProt release
 * 2026_04, captured 2026-11-23), cut to the identity fields and FUNCTION comments,
 * each comment's text kept without its `evidences` array. P01275 and P00747 open
 * with a FUNCTION comment UniProt qualifies with a `molecule`; P01275 keeps the
 * first 2 of its 5 FUNCTION comments, and P00747 also keeps one of its later
 * unqualified FUNCTION comments. P04637's first FUNCTION comment
 * names no molecule. The P01275 second text and the P04637 text are cut after
 * their first two sentences, P04637's evidence lists to two PubMed IDs each.
 */
export const RAW_SNIPPET_ROWS = {
  P01275: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P01275',
    uniProtkbId: 'GLUC_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: {
      recommendedName: { fullName: { value: 'Pro-glucagon' } },
      flag: 'Precursor',
    },
    genes: [{ geneName: { value: 'GCG' } }],
    comments: [
      {
        commentType: 'FUNCTION',
        molecule: 'Glucagon',
        texts: [
          {
            value:
              'Plays a key role in glucose metabolism and homeostasis. Regulates blood glucose by increasing gluconeogenesis and decreasing glycolysis. A counterregulatory hormone of insulin, raises plasma glucose levels in response to insulin-induced hypoglycemia. Plays an important role in initiating and maintaining hyperglycemic conditions in diabetes. Binds to and activates the glucagon receptor GCGR, which couples to the G(s) G protein and elevates intracellular cAMP, triggering downstream metabolic responses (PubMed:32193322)',
          },
        ],
      },
      {
        commentType: 'FUNCTION',
        molecule: 'Glucagon-like peptide 1',
        texts: [
          {
            value:
              'Potent stimulator of glucose-dependent insulin release (PubMed:22037645, PubMed:40446798). Also stimulates insulin release in response to IL6 (PubMed:22037645).',
          },
        ],
      },
    ],
    sequence: { length: 180 },
  },
  P00747: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P00747',
    uniProtkbId: 'PLMN_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: {
      recommendedName: { fullName: { value: 'Plasminogen' } },
      flag: 'Precursor',
    },
    genes: [{ geneName: { value: 'PLG' } }],
    comments: [
      {
        commentType: 'FUNCTION',
        molecule: 'Plasmin',
        texts: [
          {
            value:
              'Protease which primary function is to degrade fibrin, the main component of blood clots (PubMed:6094526, PubMed:6919539). Also cleaves other components of blood clots like thrombospondin-1/THBS1 and von Willebrand factor (VWF) (PubMed:24449821, PubMed:7679575). Can also directly and/or through the activation of other proteases degrade the various components of the extracellular matrix including collagen, fibronectin and laminin (PubMed:14699093, PubMed:28849762, PubMed:9171346). Thereby, regulates a variety of biological processes including embryonic development, tissue remodeling, and inflammation (PubMed:9171346). In ovulation, weakens the walls of the Graafian follicle (By similarity). In vitro, it is also able to cleave several complement zymogens, such as C1, C4 and C5 (PubMed:6447255)',
          },
        ],
      },
      {
        commentType: 'FUNCTION',
        texts: [
          {
            value:
              '(Microbial infection) Binds to OspC on the surface of B.burgdorferi cells, possibly conferring an extracellular protease activity on the bacteria that allows it to traverse host tissue',
          },
        ],
      },
    ],
    sequence: { length: 810 },
  },
  P04637: {
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    primaryAccession: 'P04637',
    uniProtkbId: 'P53_HUMAN',
    annotationScore: 5.0,
    organism: { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 },
    proteinExistence: '1: Evidence at protein level',
    proteinDescription: { recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } } },
    genes: [{ geneName: { value: 'TP53' }, synonyms: [{ value: 'P53' }] }],
    comments: [
      {
        commentType: 'FUNCTION',
        texts: [
          {
            value:
              'Multifunctional transcription factor that induces cell cycle arrest, DNA repair or apoptosis upon binding to its target DNA sequence (PubMed:11025664, PubMed:12524540). Acts as a tumor suppressor in many tumor types; induces growth arrest or apoptosis depending on the physiological circumstances and cell type (PubMed:11025664, PubMed:12524540).',
          },
        ],
      },
    ],
    sequence: { length: 393 },
  },
} as const;

/**
 * The human reference proteome as `rest.uniprot.org/proteomes/search` returned
 * it (captured 2026-10-12), cut to the fields the service read then plus the
 * `description` it ignores, so it carries no `geneCount` or
 * `proteomeStatistics`; the description is cut to its first sentence.
 */
export const RAW_HUMAN_PROTEOME = {
  id: 'UP000005640',
  description:
    'Homo sapiens (Homo sapiens sapiens) or modern humans are the only living species of the evolutionary branch of great apes known as hominids.',
  taxonomy: {
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    taxonId: 9606,
    mnemonic: 'HUMAN',
  },
  proteomeType: 'Reference proteome',
  proteomeCompletenessReport: {
    buscoReport: {
      complete: 13716,
      completeSingle: 5103,
      completeDuplicated: 8613,
      fragmented: 5,
      missing: 59,
      total: 13780,
      lineageDb: 'primates_odb10',
      score: 99,
    },
    cpdReport: { proteomeCount: 0, stdCdss: 0.0, averageCdss: 0, confidence: 0, status: 'Unknown' },
  },
  genomeAssembly: {
    assemblyId: 'GCA_000001405.29',
    genomeAssemblyUrl: 'http://www.ensembl.org/Homo_sapiens/Info/Annotation',
    level: 'full',
    source: 'Ensembl',
  },
  proteinCount: 147520,
} as const;

// --- #49: proteome counts and exclusion reasons ---

/**
 * Proteome records as `rest.uniprot.org/proteomes/search` returned them on
 * UniProt release 2026_04 (captured 2026-11-23), cut to the fields the service
 * reads. UniProt computes the gene count and protein statistics for reference
 * proteomes only: the non-reference and excluded records carry its 0
 * placeholders beside a non-zero `proteinCount`. Only an excluded record carries
 * `exclusionReasons`.
 */
export const RAW_PROTEOMES = {
  human: {
    id: 'UP000005640',
    taxonomy: {
      scientificName: 'Homo sapiens',
      commonName: 'Human',
      taxonId: 9606,
      mnemonic: 'HUMAN',
    },
    proteomeType: 'Reference proteome',
    proteinCount: 263886,
    geneCount: 20652,
    proteomeStatistics: {
      reviewedProteinCount: 20414,
      unreviewedProteinCount: 243472,
      isoformProteinCount: 22131,
    },
    proteomeCompletenessReport: {
      buscoReport: {
        complete: 13716,
        completeSingle: 5103,
        completeDuplicated: 8613,
        fragmented: 5,
        missing: 59,
        total: 13780,
        lineageDb: 'primates_odb10',
        score: 99,
      },
      cpdReport: {
        proteomeCount: 85,
        stdCdss: 0.0,
        averageCdss: 0,
        confidence: 0,
        status: 'Outlier (high value)',
      },
    },
    genomeAssembly: { assemblyId: 'GCA_000001405.29' },
  },
  ecoli: {
    id: 'UP000000625',
    taxonomy: {
      scientificName: 'Escherichia coli (strain K12)',
      taxonId: 83333,
      mnemonic: 'ECOLI',
    },
    proteomeType: 'Reference proteome',
    proteinCount: 4403,
    geneCount: 4403,
    proteomeStatistics: {
      reviewedProteinCount: 4403,
      unreviewedProteinCount: 0,
      isoformProteinCount: 12,
    },
    proteomeCompletenessReport: {
      buscoReport: {
        complete: 440,
        completeSingle: 436,
        completeDuplicated: 4,
        fragmented: 0,
        missing: 0,
        total: 440,
        lineageDb: 'enterobacterales_odb10',
        score: 100,
      },
      cpdReport: {
        proteomeCount: 26943,
        stdCdss: 0.0,
        averageCdss: 0,
        confidence: 0,
        status: 'Close to standard (low value)',
      },
    },
    genomeAssembly: { assemblyId: 'GCA_000005845.2' },
  },
  nonReference: {
    id: 'UP000000318',
    taxonomy: {
      scientificName: 'Escherichia coli (strain K12)',
      taxonId: 83333,
      mnemonic: 'ECOLI',
    },
    proteomeType: 'Non Reference proteome',
    proteinCount: 4227,
    geneCount: 0,
    proteomeStatistics: {
      reviewedProteinCount: 0,
      unreviewedProteinCount: 0,
      isoformProteinCount: 0,
    },
    proteomeCompletenessReport: {
      buscoReport: {
        complete: 440,
        completeSingle: 438,
        completeDuplicated: 2,
        fragmented: 0,
        missing: 0,
        total: 440,
        lineageDb: 'enterobacterales_odb10',
        score: 100,
      },
      cpdReport: {
        proteomeCount: 26943,
        stdCdss: 0.0,
        averageCdss: 0,
        confidence: 0,
        status: 'Close to standard (low value)',
      },
    },
    genomeAssembly: { assemblyId: 'GCA_000010245.1' },
  },
  excluded: {
    id: 'UP000005626',
    taxonomy: {
      scientificName: 'Escherichia coli str. K-12 substr. MDS42',
      taxonId: 1110693,
      mnemonic: 'ECOLI',
    },
    proteomeType: 'Excluded',
    proteinCount: 3547,
    geneCount: 0,
    proteomeStatistics: {
      reviewedProteinCount: 0,
      unreviewedProteinCount: 0,
      isoformProteinCount: 0,
    },
    proteomeCompletenessReport: {
      buscoReport: {
        complete: 440,
        completeSingle: 438,
        completeDuplicated: 2,
        fragmented: 0,
        missing: 0,
        total: 440,
        lineageDb: 'enterobacterales_odb10',
        score: 100,
      },
      cpdReport: {
        proteomeCount: 26944,
        stdCdss: 0.0,
        averageCdss: 0,
        confidence: 0,
        status: 'Outlier (low value)',
      },
    },
    genomeAssembly: { assemblyId: 'GCA_000350185.1' },
    exclusionReasons: ['genome length too small'],
  },
} as const;

/**
 * The `facets` block of `/uniprotkb/search?query=gene:TP53&facets=reviewed,annotation_score`
 * (captured 2026-10-12). `annotation_score` values carry no `label`.
 */
export const RAW_SEARCH_FACETS = [
  {
    label: 'Status',
    name: 'reviewed',
    allowMultipleSelection: false,
    values: [
      { label: 'Reviewed (Swiss-Prot)', value: 'true', count: 34 },
      { label: 'Unreviewed (TrEMBL)', value: 'false', count: 547 },
    ],
  },
  {
    label: 'Annotation score',
    name: 'annotation_score',
    allowMultipleSelection: true,
    values: [
      { value: '5', count: 87 },
      { value: '4', count: 69 },
    ],
  },
] as const;

/**
 * Narrow an optional definition field the definition under test does declare
 * (`params` on a resource, `enrichment` on a tool). Both are optional on the
 * shared definition type, so reading them under a typechecked `tests/` needs a
 * narrowing step — this makes an accidental removal a named failure rather than
 * a `possibly undefined` diagnostic silenced with `!`.
 */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Expected the definition to declare ${what}.`);
  return value;
}
