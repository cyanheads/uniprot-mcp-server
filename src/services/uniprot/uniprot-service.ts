/**
 * @fileoverview UniProt REST client — wraps the four `rest.uniprot.org`
 *   collections (UniProtKB search + entry, async ID Mapping, Proteomes,
 *   Taxonomy). Owns base-URL config, retry/backoff over the full fetch+parse
 *   pipeline, `fields`/`format` handling, cursor pagination (parsed from the
 *   `Link: rel="next"` header + `x-total-results`), and the bounded async
 *   ID-mapping run → poll → results loop. No SDK exists for UniProt REST, so a
 *   thin fetch client is the right call. Normalizers preserve upstream sparsity:
 *   absent curated fields stay absent rather than being fabricated.
 * @module services/uniprot/uniprot-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { proteomeQuery } from '@/services/uniprot/proteome-query.js';
import { entryFieldsParam, searchFieldsParam } from '@/services/uniprot/return-fields.js';
import type {
  Biophysicochemical,
  Cofactor,
  Comment,
  Disease,
  Entry,
  EvidencedText,
  Feature,
  FeatureLocation,
  FunctionText,
  GoTerm,
  IdMappingContinuation,
  IdMappingFromDb,
  IdMappingPage,
  IdMappingResult,
  IdMappingToDb,
  InactiveEntry,
  InactiveReason,
  Interaction,
  Isoform,
  Keyword,
  Location,
  MappingIdentityGap,
  MappingReadFailure,
  Organism,
  ProteinHit,
  Proteome,
  ProteomeProteinPage,
  Reaction,
  SearchFacet,
  SearchPage,
  SequenceRecord,
  SequenceResult,
  Site,
  Taxon,
  TaxonChild,
  TaxonChildrenPage,
  Variant,
} from '@/services/uniprot/types.js';
import { describeInactive, TAXON_CHILDREN_PAGE_SIZE } from '@/services/uniprot/types.js';

/**
 * Framework `data` keys that carry raw upstream internals — `fetchWithTimeout`
 * attaches these to the status-mapped `McpError` it throws on any non-2xx /
 * timeout / network failure. The handler boundary copies `error.data` onto
 * `structuredContent.error.data`, so any one of these on an error that reaches
 * the client leaks internals (status, internal request id, the internal
 * operation label). The captured body is the exception: the framework keeps
 * `body`/`responseBody` server-side unless a call sets `exposeErrorBody`, and
 * `responseBody` stays listed as a marker of a raw framework HTTP error.
 * Presence of any key flags one that must be re-thrown clean before it escapes
 * the service.
 *
 * `url` is listed even though the framework stopped attaching it by default: a
 * UniProt request URL carries the caller's query verbatim, and the opt-in that
 * puts it back is one line away. Detection stays local to this boundary.
 */
const LEAKY_ERROR_DATA_KEYS = [
  'responseBody',
  'statusCode',
  'requestId',
  'operation',
  'errorSource',
  'statusText',
  'url',
] as const;

/** Most UniProt `messages[]` entries relayed from one rejection. */
const MAX_RELAYED_MESSAGES = 5;
/** Longest single relayed message, in characters, including the `…` cut marker. */
const MAX_RELAYED_MESSAGE_LENGTH = 300;
/**
 * The marker the framework splices into an error body it captured head + tail.
 * Landing inside a JSON string, it leaves the body parseable — possibly joining
 * the head of one message to the tail of another — so a message is cut there.
 */
const ELIDED_BODY_MARKER = /…\[\d+ bytes? elided\]…/;

/**
 * Bound one relayed message: cut at a capture splice, then at the length cap.
 * `undefined` when the splice leaves nothing of the message — the capture's head
 * ended right after its opening quote — so a bare `…` is never relayed.
 */
function boundMessage(message: string): string | undefined {
  const splice = message.search(ELIDED_BODY_MARKER);
  if (splice !== -1 && message.slice(0, splice).trim() === '') return;
  const text = splice === -1 ? message : `${message.slice(0, splice)}…`;
  return text.length > MAX_RELAYED_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_RELAYED_MESSAGE_LENGTH - 1)}…`
    : text;
}

/**
 * The client-facing message for an upstream 400 — UniProt rejecting a
 * caller-supplied `query`, `fields`, `facets`, or ID-mapping pair. UniProt's 400
 * body is `{ url, messages[] }`; only the `messages[]` strings are relayed (they
 * name the rejected value), bounded in count and length. A non-JSON body, or one
 * with no message left after bounding, yields a fixed message.
 */
function upstreamRejectionMessage(body: unknown): string {
  let messages: string[] = [];
  try {
    const parsed = typeof body === 'string' ? (JSON.parse(body) as { messages?: unknown }) : {};
    if (Array.isArray(parsed.messages)) {
      messages = parsed.messages.filter(
        (m): m is string => typeof m === 'string' && m.trim() !== '',
      );
    }
  } catch {
    // Non-JSON or structurally truncated body — fall through to the fixed message.
  }
  const relayed = messages
    .slice(0, MAX_RELAYED_MESSAGES)
    .map(boundMessage)
    .filter((m): m is string => m !== undefined);
  if (!relayed.length) return 'UniProt rejected the request as invalid.';
  return `UniProt rejected the request: ${relayed.join('; ')}`;
}

/**
 * Re-throw a raw framework HTTP `McpError` as a clean, typed domain error so
 * upstream internals never reach the client. Detection is STRUCTURAL — any
 * leaky `data` key (never a message substring) — preserving the framework's
 * status-mapped code while dropping the leaky `data` and keeping the original
 * as `cause` for server-side logs. Errors without leaky `data` (the service's
 * own `notFound`/`serviceUnavailable`, a plain parse error, an abort) pass
 * through untouched.
 *
 * An upstream 400 is UniProt rejecting a caller-supplied value: it is re-thrown
 * as `InvalidParams` carrying UniProt's own `messages[]` text (see
 * `upstreamRejectionMessage`) and no `data`. The service attaches no `reason` —
 * each tool translates `InvalidParams` from the call that takes its caller text
 * into its own contract reason, the way tools translate `NotFound`.
 *
 * UniProt answers a cursor it cannot continue from (malformed or truncated) with
 * a 500, so a 500 to a request that carried a cursor — `cursorSent`, which the
 * caller clears once the request is cancelled — is re-thrown as `InvalidParams`
 * with `data.reason: 'invalid_cursor'` (see `isCursorRejection`). Every other
 * status (429, 502, 503, a 500 with no cursor), a timeout, and a network failure
 * keep the generic message: restarting from the first page would not fix an
 * outage.
 *
 * `label` describes the operation for the clean message (e.g. "UniProtKB
 * search"); the code already conveys the failure class (rate limit, upstream
 * 5xx, timeout) to the agent.
 */
function sanitizeUpstreamError(err: unknown, label: string, cursorSent = false): never {
  const data =
    err instanceof McpError ? (err.data as Record<string, unknown> | undefined) : undefined;
  if (err instanceof McpError && data && LEAKY_ERROR_DATA_KEYS.some((k) => k in data)) {
    const status = data.status ?? data.statusCode;
    if (status === 400) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        upstreamRejectionMessage(data.body ?? data.responseBody),
        undefined,
        { cause: err },
      );
    }
    if (status === 500 && cursorSent) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'UniProt could not continue from the cursor: it answered HTTP 500, so the cursor is malformed or truncated.',
        { reason: 'invalid_cursor' },
        { cause: err },
      );
    }
    throw new McpError(err.code, `${label} failed upstream (${err.code}).`, undefined, {
      cause: err,
    });
  }
  throw err;
}

/**
 * Whether an error is UniProt refusing to continue from a caller's cursor — the
 * service's `invalid_cursor` re-throw of a 500 to a cursor request. Tools check
 * it before mapping the remaining `InvalidParams` to their query reason.
 */
export function isCursorRejection(err: unknown): boolean {
  return (
    err instanceof McpError &&
    (err.data as { reason?: unknown } | undefined)?.reason === 'invalid_cursor'
  );
}

/**
 * An evidence parenthetical: matched only at `(`, its body stopping at the next
 * parenthesis. `Ref.` takes a single digit and leaves the rest to the body: a
 * `\d+` there would compete with the body for every digit and backtrack
 * quadratically over an unclosed `(Ref.` digit run.
 */
const EVIDENCE_TAG = /\((?:PubMed|UniProtKB|Ref\.\d|By similarity|Probable)[^()]*\)/g;

/**
 * Strip evidence-reference parentheticals (e.g. `(PubMed:12345)`) and the
 * whitespace before each, for a clean snippet. One pass in time linear in the
 * text: the whitespace is trimmed off the accumulated output rather than matched
 * by the pattern.
 */
function stripEvidence(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(EVIDENCE_TAG)) {
    out += text.slice(last, match.index).trimEnd();
    last = match.index + match[0].length;
  }
  return (out + text.slice(last)).trim();
}

/** Snippets of at most this many characters are returned whole; longer ones keep whole sentences within it. */
const SNIPPET_TARGET_CHARS = 250;
/** A first sentence past this many characters is cut at a word boundary and ends with `…`. */
const SNIPPET_HARD_CHARS = 400;
/** Abbreviations (lowercased, final period dropped) whose period never ends a sentence. */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'approx',
  'ca',
  'cf',
  'vs',
  'al',
  'fig',
  'figs',
  'sp',
  'spp',
  'resp',
  'no',
  'nos',
  'ref',
  'refs',
  'incl',
  'var',
  'subsp',
  'st',
  'viz',
  'ex',
]);
const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
const isUpper = (c: string | undefined) => c !== undefined && c >= 'A' && c <= 'Z';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isLetter = (c: string | undefined) =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/**
 * Sentence-end offsets (exclusive) within the first `SNIPPET_HARD_CHARS`
 * characters: a `.` outside `(…)`/`[…]`, then whitespace, then an uppercase
 * letter, a digit, or `(` — not after a listed abbreviation or a single capital
 * (`S. Typhimurium`) standing as its own word; the tail of a symbol such as
 * `IGF1R.`, `IL6ST.`, or `GPIb-IX-V.` still ends a sentence. One forward pass
 * over a bounded prefix; the whitespace skip and the abbreviation lookback each
 * read at most 8 characters.
 */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let depth = 0;
  const stop = Math.min(text.length, SNIPPET_HARD_CHARS);
  for (let i = 0; i < stop; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === '.' && depth === 0 && isSpace(text[i + 1])) {
      let j = i + 1;
      while (j < text.length && j - i <= 8 && isSpace(text[j])) j++;
      const next = text[j];
      if (!(isUpper(next) || isDigit(next) || next === '(')) continue;
      let k = i - 1;
      while (k >= 0 && i - k <= 8 && (isLetter(text[k]) || text[k] === '.')) k--;
      const token = text.slice(k + 1, i);
      const glued = k >= 0 && (isDigit(text[k]) || text[k] === '-');
      if (
        !glued &&
        (ABBREVIATIONS.has(token.toLowerCase()) || (token.length === 1 && isUpper(token)))
      )
        continue;
      ends.push(i + 1);
    }
  }
  return ends;
}

/**
 * The bounded opening of a stripped FUNCTION text: the text whole when it is at
 * most `SNIPPET_TARGET_CHARS`; otherwise whole sentences while within that
 * target, at least the first. A first sentence over `SNIPPET_HARD_CHARS` (or no
 * sentence end within it, on a longer text) is cut at the last whitespace at or
 * before that character, trailing `,`/`;`/`:` dropped, and ends with `…`.
 * At most `SNIPPET_HARD_CHARS + 1` characters.
 */
function boundedSnippet(text: string): string {
  if (text.length <= SNIPPET_TARGET_CHARS) return text;
  const ends = sentenceEnds(text);
  const first = ends[0];
  if (first === undefined) {
    if (text.length <= SNIPPET_HARD_CHARS) return text;
    let cut = SNIPPET_HARD_CHARS;
    while (cut > 0 && !isSpace(text[cut])) cut--;
    if (cut === 0) cut = SNIPPET_HARD_CHARS;
    while (cut > 0 && (isSpace(text[cut - 1]) || ',;:'.includes(text[cut - 1] as string))) cut--;
    return `${text.slice(0, cut)}…`;
  }
  let end = first;
  for (const e of ends) {
    if (e > SNIPPET_TARGET_CHARS) break;
    end = e;
  }
  return text.slice(0, end).trim();
}

/** Collect PubMed/source evidence ids from an evidences[] array. */
function collectEvidence(evidences?: RawEvidence[]): string[] | undefined {
  if (!evidences?.length) return;
  const ids = evidences
    .map((e) => (e.source && e.id ? `${e.source}:${e.id}` : e.evidenceCode))
    .filter((v): v is string => Boolean(v));
  return ids.length ? ids : undefined;
}

type RawEvidence = { evidenceCode?: string; source?: string; id?: string };
type RawText = { value: string; evidences?: RawEvidence[] };
type RawValue = { value: string };

type RawComment = {
  commentType: string;
  texts?: RawText[];
  molecule?: string;
  note?: { texts?: RawText[] };
  /** A side recorded for one product of a polyprotein carries its `chainId` (`PRO_…`). */
  interactions?: {
    interactantOne?: { uniProtKBAccession?: string; chainId?: string };
    interactantTwo: { uniProtKBAccession: string; geneName?: string; chainId?: string };
    numberOfExperiments: number;
    organismDiffer?: boolean;
  }[];
  reaction?: {
    name: string;
    ecNumber?: string;
    reactionCrossReferences?: { database: string; id: string }[];
    evidences?: RawEvidence[];
  };
  cofactors?: {
    name: string;
    evidences?: RawEvidence[];
    cofactorCrossReference?: { database: string; id: string };
  }[];
  subcellularLocations?: { location: RawText; topology?: RawText; orientation?: RawText }[];
  /** `null` on a DISEASE comment that carries only a note. */
  disease?: {
    diseaseId?: string;
    diseaseAccession?: string;
    acronym?: string;
    description?: string;
    diseaseCrossReference?: { database: string; id: string };
  } | null;
  events?: string[];
  isoforms?: {
    name?: RawValue;
    synonyms?: RawValue[];
    isoformIds?: string[];
    isoformSequenceStatus?: string;
  }[];
  // The parts of a BIOPHYSICOCHEMICAL PROPERTIES comment.
  kineticParameters?: {
    michaelisConstants?: {
      constant: number;
      unit: string;
      substrate: string;
      evidences?: RawEvidence[];
    }[];
    maximumVelocities?: {
      velocity: number;
      unit: string;
      enzyme: string;
      evidences?: RawEvidence[];
    }[];
    note?: { texts?: RawText[] };
  };
  phDependence?: { texts?: RawText[] };
  temperatureDependence?: { texts?: RawText[] };
  redoxPotential?: { texts?: RawText[] };
  /** `approximate` is sent on every absorption, `false` on an exact maximum. */
  absorption?: {
    max?: number;
    approximate?: boolean;
    note?: { texts?: RawText[] };
    evidences?: RawEvidence[];
  };
};

/** One bound of a feature location; `value` is null when `modifier` is `UNKNOWN`. */
type RawFeatureBound = { value?: number | null; modifier?: string };
/** `sequence` names the isoform the positions are numbered on, absent on the canonical sequence. */
type RawFeatureLocation = { start?: RawFeatureBound; end?: RawFeatureBound; sequence?: string };
type RawFeature = {
  type: string;
  description?: string;
  location?: RawFeatureLocation;
  featureId?: string;
  evidences?: RawEvidence[];
  alternativeSequence?: { originalSequence?: string; alternativeSequences?: string[] };
  /** On a binding site; `id` is `ChEBI:CHEBI:n`, absent for a ligand ChEBI does not cover. */
  ligand?: { name: string; id?: string; label?: string; note?: string };
  ligandPart?: { name: string; id?: string };
};

type RawCrossRef = {
  database: string;
  id: string;
  properties?: { key: string; value: string }[];
};

/** The reason block on an inactive stub (`entryType: "Inactive"`). */
type RawInactiveReason = {
  inactiveReasonType?: string;
  mergeDemergeTo?: string[];
  deletedReason?: string;
};

/** The fields that mark a UniProtKB row (search hit, entry, or ID-mapping target) inactive. */
type RawInactiveFields = {
  primaryAccession: string;
  entryType?: string;
  inactiveReason?: RawInactiveReason | null;
  extraAttributes?: { uniParcId?: string };
};

/**
 * Read an inactive stub's reason, or `undefined` for an active row. The one
 * parse of UniProt's inactive marker — entries, search hits, and ID-mapping
 * targets all go through it, and `describeInactive` turns the result into text.
 */
function parseInactive(raw: RawInactiveFields): InactiveEntry | undefined {
  if (raw.entryType !== 'Inactive') return;
  const reason = raw.inactiveReason;
  const uniParcId = raw.extraAttributes?.uniParcId;
  return {
    accession: raw.primaryAccession,
    ...(reason?.inactiveReasonType ? { reason: reason.inactiveReasonType } : {}),
    ...(reason?.mergeDemergeTo?.length ? { replacedBy: reason.mergeDemergeTo } : {}),
    ...(reason?.deletedReason ? { deletedReason: reason.deletedReason } : {}),
    ...(uniParcId ? { uniParcId } : {}),
  };
}

type RawEntry = RawInactiveFields & {
  uniProtkbId: string;
  entryType: string;
  annotationScore?: number;
  proteinExistence?: string;
  sequence?: { length: number };
  proteinDescription?: {
    recommendedName?: { fullName?: RawValue; ecNumbers?: RawValue[] };
    alternativeNames?: { fullName?: RawValue }[];
    submissionNames?: { fullName?: RawValue }[];
    /** UniProt's sequence flags, comma-separated: "Fragment", "Fragments", "Precursor", e.g. "Fragment,Precursor". */
    flag?: string;
  };
  genes?: {
    geneName?: RawValue;
    synonyms?: RawValue[];
    orderedLocusNames?: RawValue[];
    orfNames?: RawValue[];
  }[];
  organism?: { scientificName: string; commonName?: string; taxonId: number };
  comments?: RawComment[];
  features?: RawFeature[];
  keywords?: { id: string; category?: string; name: string }[];
  uniProtKBCrossReferences?: RawCrossRef[];
};

/** The REST client for all four UniProt collections. */
export class UniProtService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService) {
    const cfg = getServerConfig();
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.timeoutMs = cfg.timeoutMs;
  }

  /**
   * Build a `RequestContext` for a sub-operation from the handler `ctx`.
   * `Context extends RequestContext`, so the handler context is the parent
   * directly — requestId, traceId, tenantId, sessionId, and the `extra`
   * correlation bag all carry through instead of being hand-picked.
   */
  private reqCtx(operation: string, ctx: Context): RequestContext {
    return requestContextService.createRequestContext({ operation, parentContext: ctx });
  }

  /** Wrap a fetch+parse pipeline in retry with backoff calibrated for an occasionally rate-limited API. */
  private withRetry<T>(operation: string, ctx: Context, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      operation,
      context: this.reqCtx(operation, ctx),
      baseDelayMs: 1_000,
      signal: ctx.signal,
    });
  }

  /** Detect HTML error/maintenance pages returned with a 2xx and throw transient. */
  private guardHtml(text: string): void {
    if (/^\s*<(?:!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'UniProt returned an HTML page instead of JSON — likely rate-limited or in maintenance.',
      );
    }
  }

  /** GET and parse JSON. `cursorSent` marks a request carrying a caller's cursor (see `sanitizeUpstreamError`). */
  private getJson<T>(
    url: string,
    operation: string,
    ctx: Context,
    cursorSent = false,
  ): Promise<{ data: T; response: Response }> {
    const reqCtx = this.reqCtx(operation, ctx);
    return this.withRetry(operation, ctx, async () => {
      const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, { signal: ctx.signal });
      const text = await response.text();
      this.guardHtml(text);
      return { data: JSON.parse(text) as T, response };
    }).catch((err) => sanitizeUpstreamError(err, operation, cursorSent && !ctx.signal.aborted));
  }

  /** Parse the opaque forward cursor out of the `Link: rel="next"` header. */
  private parseNextCursor(response: Response): string | undefined {
    const link = response.headers.get('link');
    if (!link) return;
    const match = link.match(/[?&]cursor=([^&>]+)[^>]*>\s*;\s*rel="next"/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }

  // ---------------------------------------------------------------------------
  // UniProtKB search
  // ---------------------------------------------------------------------------

  /**
   * Search UniProtKB. `query` is a Lucene-style field-aware string. `fields`
   * trims the projection; `facets` requests server-side count breakdowns;
   * `cursor` walks forward. Returns hits + `totalResults` (from `x-total-results`,
   * which counts inactive stubs too). An inactive accession the query matched
   * (merged, demerged, deleted) is split into `inactive`, never built into a hit.
   */
  async search(
    query: string,
    opts: { fields?: string; facets?: string; size?: number; cursor?: string },
    ctx: Context,
  ): Promise<SearchPage> {
    const url = new URL(`${this.baseUrl}/uniprotkb/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('fields', searchFieldsParam(opts.fields));
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', String(opts.size ?? getServerConfig().defaultPageSize));
    if (opts.facets) url.searchParams.set('facets', opts.facets);
    if (opts.cursor) url.searchParams.set('cursor', opts.cursor);

    const { data, response } = await this.getJson<{ results?: RawEntry[]; facets?: RawFacet[] }>(
      url.toString(),
      'uniprot.search',
      ctx,
      Boolean(opts.cursor),
    );

    const totalResults = Number(
      response.headers.get('x-total-results') ?? data.results?.length ?? 0,
    );
    const results: ProteinHit[] = [];
    const inactive: InactiveEntry[] = [];
    for (const raw of data.results ?? []) {
      const stub = parseInactive(raw);
      if (stub) inactive.push(stub);
      else results.push(this.normalizeHit(raw));
    }
    const facets = data.facets?.length ? data.facets.map(normalizeFacet) : undefined;
    const cursor = this.parseNextCursor(response);

    return {
      results,
      inactive,
      totalResults,
      ...(cursor ? { cursor } : {}),
      ...(facets ? { facets } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // UniProtKB entries (batch)
  // ---------------------------------------------------------------------------

  /**
   * Fetch full curated entries for a batch of accessions in one round trip via
   * UniProtKB batch search (`query=accession:(A OR B OR …)`). Active rows are
   * normalized into `entries`; an inactive accession (merged, demerged, deleted)
   * comes back as a stub, reported in `inactive` with its reason and never
   * normalized into a record. The caller cross-references both against the
   * requested set to populate `failed[]`.
   */
  async getEntries(
    accessions: string[],
    fields: string | undefined,
    ctx: Context,
  ): Promise<{ entries: Entry[]; inactive: InactiveEntry[] }> {
    const url = new URL(`${this.baseUrl}/uniprotkb/search`);
    url.searchParams.set('query', `accession:(${accessions.join(' OR ')})`);
    url.searchParams.set('fields', entryFieldsParam(fields));
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', String(accessions.length));

    const { data } = await this.getJson<{ results?: RawEntry[] }>(
      url.toString(),
      'uniprot.getEntries',
      ctx,
    );
    const entries: Entry[] = [];
    const inactive: InactiveEntry[] = [];
    for (const raw of data.results ?? []) {
      const stub = parseInactive(raw);
      if (stub) inactive.push(stub);
      else entries.push(this.normalizeEntry(raw));
    }
    return { entries, inactive };
  }

  // ---------------------------------------------------------------------------
  // ID mapping (async)
  // ---------------------------------------------------------------------------

  /**
   * Run an ID-mapping job and poll it within `UNIPROT_ID_MAPPING_BUDGET_MS`. On
   * `FINISHED`, fetch and return the first `size` mappings. If the budget elapses
   * first, return a resumable ticket (the bare jobId — UniProt holds the job
   * server-side). The whole call runs under `MAPPING_CALL_BUDGET_MS`.
   */
  mapIds(
    from: IdMappingFromDb,
    to: IdMappingToDb,
    ids: string[],
    taxId: number | undefined,
    size: number,
    ctx: Context,
  ): Promise<IdMappingResult> {
    return this.withinCallBudget(ctx, async (callCtx, resumeWith) => {
      const jobId = await this.runMapping(from, to, ids, taxId, callCtx);
      resumeWith({ ticket: jobId });
      const poll = await this.pollMapping(jobId, true, callCtx);
      if (poll !== 'finished') return stillRunning(jobId, poll);
      return {
        status: 'finished',
        ...(await this.mappingResults(jobId, size, callCtx, undefined, to)),
      };
    });
  }

  /**
   * Poll a previously-submitted ID-mapping ticket within the same budget a
   * submission gets, then fetch its first `size` mappings. A caller-supplied
   * ticket or continuation job id reaches the request path only after the tool
   * has matched it against `JOB_ID_REGEX`.
   */
  resumeMapping(ticket: string, size: number, ctx: Context): Promise<IdMappingResult> {
    return this.withinCallBudget(ctx, async (callCtx, resumeWith) => {
      resumeWith({ ticket });
      const poll = await this.pollMapping(ticket, false, callCtx);
      if (poll !== 'finished') return stillRunning(ticket, poll);
      return { status: 'finished', ...(await this.mappingResults(ticket, size, callCtx)) };
    });
  }

  /**
   * Fetch the next `size` mappings of an already-completed ID-mapping job. UniProt's
   * results cursor is positional, so a continuation resumes at the next row at any size.
   */
  resumeMappingPage(
    continuation: IdMappingContinuation,
    size: number,
    ctx: Context,
  ): Promise<IdMappingResult> {
    return this.withinCallBudget(ctx, async (callCtx, resumeWith) => {
      resumeWith({ continuation });
      return {
        status: 'finished',
        ...(await this.mappingResults(continuation.jobId, size, callCtx, continuation.cursor)),
      };
    });
  }

  /**
   * Run one ID-mapping call under `MAPPING_CALL_BUDGET_MS`: every request it makes,
   * and every retry and pause between them, shares the one deadline. `run` reports
   * through `resumeWith` how a caller resumes the job once its id exists. A spent
   * budget surfaces as a `Timeout` naming it — and, past that point, the job and the
   * ticket or continuation to re-call with; caller cancellation propagates as it arrived.
   */
  private async withinCallBudget<T>(
    ctx: Context,
    run: (callCtx: Context, resumeWith: (resume: MappingResume) => void) => Promise<T>,
  ): Promise<T> {
    const budget = startDeadline(MAPPING_CALL_BUDGET_MS);
    const callCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, budget.signal]) };
    let resume: MappingResume | undefined;
    try {
      return await run(callCtx, (point) => {
        resume = point;
      });
    } catch (err) {
      if (!deadlineElapsed(callCtx.signal)) throw err;
      throw mappingBudgetSpent(resume, err);
    } finally {
      budget.clear();
    }
  }

  /**
   * Check a job's status until it is `FINISHED` or `UNIPROT_ID_MAPPING_BUDGET_MS`
   * elapses (`running`), pausing `MAPPING_POLL_INTERVAL_MS` between checks. The first
   * check always runs, and a check in flight when the budget elapses completes. The
   * call budget ending the poll also returns `running`: the job is held server-side,
   * so its ticket resumes it.
   *
   * Once the job is known to exist — `submitted` by this call, or any check answered —
   * a check failing upstream (unavailable, rate-limited, timed out, an HTML page)
   * after its retries ends the poll as `check_failed`, so the caller keeps the ticket.
   * The first check of a caller's ticket has no such fallback: it propagates. Caller
   * cancellation stops the poll with no further status request and propagates, as do
   * a job that reports an error, an unknown job, and every other failure.
   */
  private async pollMapping(
    jobId: string,
    submitted: boolean,
    ctx: Context,
  ): Promise<'finished' | 'running' | 'check_failed'> {
    const endsAt = Date.now() + getServerConfig().idMappingBudgetMs;
    let exists = submitted;
    try {
      do {
        if ((await this.mappingStatus(jobId, ctx)) === 'FINISHED') return 'finished';
        exists = true;
        await pause(MAPPING_POLL_INTERVAL_MS, ctx.signal);
      } while (Date.now() < endsAt);
      return 'running';
    } catch (err) {
      if (deadlineElapsed(ctx.signal)) return 'running';
      const failure = ctx.signal.aborted ? undefined : unavailableRead(err);
      if (exists && (failure === 'timeout' || failure === 'failed')) {
        ctx.log.warning('ID-mapping status check failed upstream; reporting the job running', {
          jobId,
        });
        return 'check_failed';
      }
      throw err;
    }
  }

  private async runMapping(
    from: string,
    to: string,
    ids: string[],
    taxId: number | undefined,
    ctx: Context,
  ): Promise<string> {
    const form = new FormData();
    form.set('from', from);
    form.set('to', to);
    form.set('ids', ids.join(','));
    if (taxId != null) form.set('taxId', String(taxId));

    const reqCtx = this.reqCtx('uniprot.runMapping', ctx);
    const { data } = await this.withRetry('uniprot.runMapping', ctx, async () => {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/idmapping/run`,
        this.timeoutMs,
        reqCtx,
        {
          method: 'POST',
          body: form,
          signal: ctx.signal,
        },
      );
      const text = await response.text();
      this.guardHtml(text);
      return { data: JSON.parse(text) as { jobId?: string; messages?: string[] } };
    }).catch((err) => {
      if (
        !ctx.signal.aborted &&
        err instanceof McpError &&
        err.code === JsonRpcErrorCode.InvalidParams
      ) {
        const raw = err.data;
        const message = upstreamRejectionMessage(raw?.body ?? raw?.responseBody);
        if (
          message.includes(`The combination of 'from=${from}' and 'to=${to}' parameters is invalid`)
        ) {
          throw new McpError(
            JsonRpcErrorCode.ValidationError,
            message,
            { reason: 'unsupported_db_pair' },
            { cause: err },
          );
        }
      }
      return sanitizeUpstreamError(err, 'uniprot.runMapping');
    });

    if (!data.jobId) {
      throw serviceUnavailable(
        `ID-mapping job submission did not return a jobId: ${data.messages?.join('; ') ?? 'unknown'}`,
      );
    }
    return data.jobId;
  }

  private mappingStatus(jobId: string, ctx: Context): Promise<string> {
    const operation = 'uniprot.mappingStatus';
    const reqCtx = this.reqCtx(operation, ctx);
    return this.withRetry(operation, ctx, async () => {
      try {
        const response = await fetchWithTimeout(
          `${this.baseUrl}/idmapping/status/${jobId}`,
          this.timeoutMs,
          reqCtx,
          {
            redirect: 'manual',
            expectedStatuses: [303],
            signal: ctx.signal,
          },
        );
        const text = await response.text();
        this.guardHtml(text);
        const data = JSON.parse(text) as RawMappingStatus;
        if (data.jobStatus === 'ERROR') throw mappingFailure(data, jobId);
        return data.jobStatus ?? 'RUNNING';
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (err instanceof McpError && err.data) {
          const raw = err.data;
          const body = raw.body ?? raw.responseBody;
          if (typeof body === 'string') {
            let parsed: RawMappingStatus | undefined;
            try {
              parsed = JSON.parse(body);
            } catch {
              /* Non-JSON failures retain HTTP classification. */
            }
            if (parsed?.jobStatus === 'ERROR') throw mappingFailure(parsed, jobId, err);
          }
        }
        const status =
          err instanceof McpError && err.data
            ? (err.data.status ?? err.data.statusCode)
            : undefined;
        if (status === 303) return 'FINISHED';
        return sanitizeUpstreamError(err, operation);
      }
    });
  }

  /**
   * One completed results page of `size` rows. The job-details read (when the target
   * database is unknown) decides which results read runs, and the identity-enriched
   * read replaces the generic one, so both get the per-request `UNIPROT_TIMEOUT_MS`;
   * either one unavailable leaves generic rows, with `identityUnavailable` naming why.
   * The inactive-target re-read is an extra read, best-effort under `OPTIONAL_READ_MS`.
   * Every read stays inside the call budget `ctx` carries.
   */
  private async mappingResults(
    jobId: string,
    size: number,
    ctx: Context,
    cursor?: string,
    target?: string,
  ): Promise<IdMappingPage> {
    let identityUnavailable: MappingIdentityGap | undefined;
    // Tickets and continuations carry no target database. Metadata is optional: never strand a usable job.
    if (target === undefined) {
      try {
        target = (
          await this.optionalMappingJson<{ to?: string }>(
            `${this.baseUrl}/idmapping/details/${jobId}`,
            'uniprot.mappingDetails',
            ctx,
          )
        ).data.to;
        if (target === undefined) identityUnavailable = 'no_target';
      } catch (err) {
        identityUnavailable = `details_${degradedRead(err, ctx.signal)}`;
      }
    }
    const enriched = target === 'UniProtKB' || target === 'UniProtKB-Swiss-Prot';
    const url = new URL(
      `${this.baseUrl}/idmapping/${enriched ? 'uniprotkb/' : ''}results/${jobId}`,
    );
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', String(size));
    if (enriched)
      url.searchParams.set(
        'fields',
        'accession,id,reviewed,organism_id,organism_name,gene_primary',
      );
    if (cursor) url.searchParams.set('cursor', cursor);

    let page: { data: RawMappingResults; response: Response };
    try {
      page = enriched
        ? await this.optionalMappingJson<RawMappingResults>(
            url.toString(),
            'uniprot.mappingResults',
            ctx,
          )
        : await this.getJson<RawMappingResults>(url.toString(), 'uniprot.mappingResults', ctx);
    } catch (err) {
      if (!enriched) throw err;
      identityUnavailable = `identity_${degradedRead(err, ctx.signal)}`;
      url.pathname = new URL(`${this.baseUrl}/idmapping/results/${jobId}`).pathname;
      url.searchParams.delete('fields');
      page = await this.getJson<RawMappingResults>(url.toString(), 'uniprot.mappingResults', ctx);
    }
    const { data, response } = page;
    let results: IdMappingPage['results'] = (data.results ?? []).map((row) => ({
      from: row.from,
      to: targetAccession(row.to),
      ...(typeof row.to === 'string' ? {} : mappingIdentity(row.to)),
    }));

    // This endpoint names target accessions only. UniProt flags a job holding any
    // inactive UniProtKB target with a job-wide obsoleteCount, and only the uniprotkb
    // results endpoint says which — so only such a job pays one more read per page.
    let inactiveUnchecked: number | undefined;
    if (data.obsoleteCount && results.length && (!enriched || identityUnavailable)) {
      const inactive = await this.optionalRead(ctx, (readCtx) =>
        this.inactiveMappingTargets(jobId, cursor, size, results, readCtx),
      );
      if (inactive) {
        results = results.map((r) => {
          const reason = inactive.get(mappingKey(r.from, r.to));
          return reason ? { ...r, inactive: reason } : r;
        });
      } else {
        ctx.log.warning('Inactive ID-mapping target lookup failed', { jobId });
        inactiveUnchecked = data.obsoleteCount;
      }
    }

    const nextUrl = this.parseNextLink(response);
    let continuation: IdMappingContinuation | undefined;
    if (nextUrl) {
      const nextCursor = new URL(nextUrl).searchParams.get('cursor');
      if (!nextCursor) {
        throw serviceUnavailable('UniProt returned an ID-mapping next-page link without a cursor.');
      }
      continuation = { jobId, cursor: nextCursor };
    }

    return {
      results,
      failedIds: data.failedIds ?? [],
      ...(response.headers.has('x-total-results')
        ? { totalMappings: Number(response.headers.get('x-total-results')) }
        : {}),
      ...(identityUnavailable ? { identityUnavailable } : {}),
      ...(continuation ? { continuation } : {}),
      ...(inactiveUnchecked ? { inactiveUnchecked } : {}),
    };
  }

  /** Best-effort metadata and identity reads get one bounded attempt; malformed JSON is not retried. */
  private async optionalMappingJson<T>(
    url: string,
    operation: string,
    ctx: Context,
  ): Promise<{ data: T; response: Response }> {
    try {
      const response = await fetchWithTimeout(url, this.timeoutMs, this.reqCtx(operation, ctx), {
        signal: ctx.signal,
      });
      const text = await response.text();
      this.guardHtml(text);
      return { data: JSON.parse(text) as T, response };
    } catch (err) {
      return sanitizeUpstreamError(err, operation);
    }
  }

  /**
   * Run one best-effort read (the inactive-target re-read) under its own
   * `OPTIONAL_READ_MS` deadline, inside the call budget `ctx` carries. Resolves
   * `undefined` when the read is unavailable, returns a different page, or either
   * deadline cuts it; caller cancellation and any other failure (a malformed body)
   * propagate.
   */
  private async optionalRead<T>(
    ctx: Context,
    read: (readCtx: Context) => Promise<T>,
  ): Promise<T | undefined> {
    const limit = startDeadline(OPTIONAL_READ_MS);
    const readCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, limit.signal]) };
    try {
      return await read(readCtx);
    } catch (err) {
      const cut = deadlineElapsed(readCtx.signal);
      if (readCtx.signal.aborted && !cut) throw err;
      if (!mappingEnrichmentUnavailable(err, cut) && !(err instanceof MappingPageMismatch))
        throw err;
      return;
    } finally {
      limit.clear();
    }
  }

  /**
   * The inactive targets on one ID-mapping results page, keyed by source ID and
   * target accession. Read from `/idmapping/uniprotkb/results/{jobId}`, the results
   * endpoint whose rows carry the target entry and so its inactive stub; the
   * generic endpoint's cursor addresses the same page there at the same `size`.
   * Throws when the re-read page lacks a row of `page`, so a drifted page is
   * disclosed as unchecked rather than left silently unmarked.
   */
  private async inactiveMappingTargets(
    jobId: string,
    cursor: string | undefined,
    size: number,
    page: { from: string; to: string }[],
    ctx: Context,
  ): Promise<Map<string, InactiveReason>> {
    const url = new URL(`${this.baseUrl}/idmapping/uniprotkb/results/${jobId}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('fields', 'accession');
    url.searchParams.set('size', String(size));
    if (cursor) url.searchParams.set('cursor', cursor);

    const { data } = await this.getJson<RawMappingResults>(
      url.toString(),
      'uniprot.inactiveMappingTargets',
      ctx,
    );
    const inactive = new Map<string, InactiveReason>();
    const reread = new Set<string>();
    for (const row of data.results ?? []) {
      const key = mappingKey(row.from, targetAccession(row.to));
      reread.add(key);
      const stub = typeof row.to === 'string' ? undefined : parseInactive(row.to);
      if (stub) {
        const { accession: _accession, ...reason } = stub;
        inactive.set(key, reason);
      }
    }
    if (page.some((r) => !reread.has(mappingKey(r.from, r.to)))) {
      throw new MappingPageMismatch(
        `ID-mapping job ${jobId}: the uniprotkb results page holds different rows.`,
      );
    }
    return inactive;
  }

  /** Full next-page URL from the Link header (results pages carry a full URL, not just a cursor). */
  private parseNextLink(response: Response): string | undefined {
    const link = response.headers.get('link');
    if (!link) return;
    const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
    return match ? match[1] : undefined;
  }

  // ---------------------------------------------------------------------------
  // Proteomes
  // ---------------------------------------------------------------------------

  /**
   * Fetch a proteome by UPID or taxon ID. Uses the proteome search endpoint
   * (which carries the top-level `proteinCount`, BUSCO report, and genome
   * assembly that the by-UPID endpoint omits).
   */
  async getProteome(
    idOrTaxon: { upid?: string; taxonId?: number },
    ctx: Context,
  ): Promise<Proteome> {
    const query = idOrTaxon.upid
      ? `(upid:${idOrTaxon.upid})`
      : `(organism_id:${idOrTaxon.taxonId}) AND (reference:true)`;
    const url = new URL(`${this.baseUrl}/proteomes/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', '1');

    const { data } = await this.getJson<{ results?: RawProteome[] }>(
      url.toString(),
      'uniprot.getProteome',
      ctx,
    );
    let raw = data.results?.[0];
    if (!raw && !idOrTaxon.upid) {
      url.searchParams.set('query', `(taxonomy_id:${idOrTaxon.taxonId}) AND (reference:true)`);
      url.searchParams.set('size', '5');
      const descendantPage = await this.getJson<{ results?: RawProteome[] }>(
        url.toString(),
        'uniprot.getProteome',
        ctx,
      );
      const candidates = descendantPage.data.results ?? [];
      let nextPage = this.parseNextLink(descendantPage.response);
      // A sparse first page cannot establish uniqueness while another page exists.
      if (candidates.length < 2 && nextPage) {
        const next = await this.getJson<{ results?: RawProteome[] }>(
          nextPage,
          'uniprot.getProteome',
          ctx,
        );
        candidates.push(...(next.data.results ?? []));
        nextPage = this.parseNextLink(next.response);
      }
      if (candidates.length > 1 || nextPage) {
        const guidance = candidates
          .map((candidate) => {
            const proteome = normalizeProteome(candidate);
            return `${proteome.upid}: taxon ${proteome.organism.taxonId}, ${proteome.organism.scientificName}`;
          })
          .join('; ');
        throw new McpError(
          JsonRpcErrorCode.InvalidParams,
          `No exact reference proteome exists for taxon ${idOrTaxon.taxonId}; choose an explicit upid from descendant candidates: ${guidance}.${nextPage ? ` This suggestion list is incomplete; retrieve the next page: ${nextPage}. Narrow taxon_id or choose a listed upid.` : ''}`,
          { reason: 'ambiguous_proteome', taxonId: idOrTaxon.taxonId },
        );
      }
      raw = candidates[0];
    }
    if (!raw) {
      // A UPID can name a non-reference or excluded proteome; only the taxon path looks for a reference one.
      throw notFound(
        idOrTaxon.upid
          ? `No proteome found for UPID ${idOrTaxon.upid}.`
          : `No reference proteome found for taxon ${idOrTaxon.taxonId}.`,
        { ...idOrTaxon },
      );
    }
    return normalizeProteome(raw);
  }

  /**
   * List proteins of a proteome, cursor-paginated. Filters UniProtKB by the
   * proteome UPID; an optional `query` narrows the set further.
   */
  async getProteomeProteins(
    upid: string,
    opts: { query?: string; size?: number; cursor?: string },
    ctx: Context,
  ): Promise<ProteomeProteinPage> {
    const page = await this.search(
      proteomeQuery(upid, opts.query),
      {
        ...(opts.size ? { size: opts.size } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      },
      ctx,
    );
    return {
      proteins: page.results,
      totalResults: page.totalResults,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Taxonomy
  // ---------------------------------------------------------------------------

  /**
   * Fetch a taxonomy record by NCBI taxon ID. UniProt answers an unknown id with a
   * 404 and an id it cannot parse (past its numeric range) with a 400 carrying the
   * parser's text; both mean no record for that id, so both become `notFound`.
   */
  async getTaxonById(taxonId: number, ctx: Context): Promise<Taxon> {
    const url = `${this.baseUrl}/taxonomy/${taxonId}?format=json`;
    try {
      const { data } = await this.getJson<RawTaxon>(url, 'uniprot.getTaxonById', ctx);
      return normalizeTaxon(data);
    } catch (err) {
      if (
        err instanceof McpError &&
        (err.code === JsonRpcErrorCode.NotFound || err.code === JsonRpcErrorCode.InvalidParams)
      ) {
        throw notFound(`No taxonomy record for taxon ID ${taxonId}.`, { taxonId });
      }
      throw err;
    }
  }

  /**
   * Resolve a full scientific/common name, mnemonic or alias across candidate pages.
   * The name is a plain name, not query syntax: `\` and `"` are escaped so any
   * name forms a valid phrase query. Compact candidates establish uniqueness
   * before fetching the selected full record, including its lineage.
   */
  async getTaxonByName(name: string, ctx: Context): Promise<Taxon> {
    const url = new URL(`${this.baseUrl}/taxonomy/search`);
    const phrase = `"${name.replace(/[\\"]/g, '\\$&')}"`;
    url.searchParams.set(
      'query',
      `(scientific:${phrase}) OR (common:${phrase}) OR (mnemonic:${phrase}) OR (${phrase})`,
    );
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', '500');
    url.searchParams.set('fields', 'id,scientific_name,common_name,mnemonic,other_names');
    const deadline = AbortSignal.timeout(45_000);
    const lookupCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, deadline]) };
    const rows: RawTaxon[] = [];
    let lastPage: RawTaxon[] = [];
    let nextPage: string | undefined = url.toString();
    try {
      while (nextPage) {
        const page = await this.getJson<{ results?: RawTaxon[] }>(
          nextPage,
          'uniprot.getTaxonByName',
          lookupCtx,
        );
        lastPage = page.data.results ?? [];
        rows.push(...lastPage);
        nextPage = this.parseNextLink(page.response);
      }
    } catch (err) {
      if (ctx.signal.aborted || !deadline.aborted) throw err;
      const suggestions = lastPage
        .map((taxon) => `${taxon.taxonId}: ${taxon.scientificName}`)
        .join('; ');
      throw new McpError(
        JsonRpcErrorCode.Timeout,
        `Taxonomy name matching exceeded its 45-second lookup budget before all candidates were checked. Narrow the name or use taxon_id.${suggestions ? ` Incomplete suggestions from the last completed page: ${suggestions}.` : ''} Continue the candidate search at ${nextPage}.`,
        { reason: 'incomplete_candidates', name },
        { cause: err },
      );
    }
    const candidates = [...new Map(rows.map((taxon) => [taxon.taxonId, taxon])).values()];
    const exact = (value: string) => value.trim().toLowerCase();
    // Only stray double quotes and backslashes are tolerated; apostrophes,
    // hyphens, digits and other meaningful scientific-name punctuation survive.
    const tolerant = (value: string) => exact(value.replace(/[\\"]/g, '').replace(/\s+/g, ' '));
    for (const normalize of [exact, tolerant]) {
      const normalizedName = normalize(name);
      for (const names of [
        (taxon: RawTaxon) => [taxon.scientificName],
        (taxon: RawTaxon) => (taxon.commonName ? [taxon.commonName] : []),
        (taxon: RawTaxon) => (taxon.mnemonic ? [taxon.mnemonic] : []),
        (taxon: RawTaxon) => taxon.otherNames ?? [],
      ]) {
        const matches = candidates.filter((taxon) =>
          names(taxon).some((value) => normalize(value) === normalizedName),
        );
        const [match] = matches;
        if (match && matches.length === 1) return this.getTaxonById(match.taxonId, lookupCtx);
        if (matches.length > 1) {
          const guidance = matches
            .map((taxon) => `${taxon.taxonId}: ${taxon.scientificName}`)
            .join('; ');
          throw new McpError(
            JsonRpcErrorCode.InvalidParams,
            `Ambiguous taxonomy name "${name}". Choose taxon_id: ${guidance}.`,
            { reason: 'ambiguous_name', name },
          );
        }
      }
    }
    const suggestions = candidates
      .map((taxon) => `${taxon.taxonId}: ${taxon.scientificName}`)
      .join('; ');
    if (!candidates.length)
      throw notFound(`No taxonomy record matched the name "${name}".`, { name });
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      `No exact taxonomy name matched "${name}". Suggestions (use taxon_id): ${suggestions}.`,
      { reason: 'no_exact_match', name },
    );
  }

  /**
   * Fetch one page of a taxon's immediate children (a separate search — not inline
   * on the record), `TAXON_CHILDREN_PAGE_SIZE` per page. Returns the page, the
   * total across all pages (`x-total-results`), and the forward cursor from the
   * `Link: rel="next"` header when another page exists.
   */
  async getChildren(
    taxonId: number,
    opts: { cursor?: string },
    ctx: Context,
  ): Promise<TaxonChildrenPage> {
    const url = new URL(`${this.baseUrl}/taxonomy/search`);
    url.searchParams.set('query', `parent:${taxonId}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', String(TAXON_CHILDREN_PAGE_SIZE));
    if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
    const { data, response } = await this.getJson<{ results?: RawTaxon[] }>(
      url.toString(),
      'uniprot.getChildren',
      ctx,
      Boolean(opts.cursor),
    );
    const children: TaxonChild[] = (data.results ?? []).map((t) => ({
      taxonId: t.taxonId,
      scientificName: t.scientificName,
      rank: t.rank ?? 'no rank',
    }));
    const totalChildren = Number(response.headers.get('x-total-results') ?? children.length);
    const cursor = this.parseNextCursor(response);
    return { children, totalChildren, ...(cursor ? { cursor } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Sequences (FASTA)
  // ---------------------------------------------------------------------------

  /**
   * Fetch canonical (+ optional isoform) sequences as FASTA and parse the records.
   *
   * The per-accession FASTA endpoint (`/uniprotkb/{accession}.fasta`) silently
   * ignores `includeIsoform` and only ever returns the canonical record, so the
   * isoform path goes through the search endpoint instead
   * (`/uniprotkb/search?query=accession:{accession}&format=fasta&includeIsoform=true`),
   * which honors the flag and returns the canonical plus every isoform as a
   * multi-record FASTA blob. The canonical-only path stays on the cheaper
   * per-accession endpoint.
   *
   * Inactive accessions: the per-accession endpoint answers a merged accession
   * with a 303 to the merge target, which `fetch` follows within the same call,
   * so the final URL names the target — the records are labelled with it and
   * `mergedFrom` names the requested accession, at no extra request. Any other
   * inactive accession, and a merged one on the isoform path, yields an empty
   * body. Only then is the accession's inactive stub looked up (one request, on
   * this failure path alone): a merge target's sequences are fetched in its
   * place, and a demerged or deleted accession throws `notFound` naming its
   * pointer.
   */
  async getFasta(
    accession: string,
    includeIsoforms: boolean,
    ctx: Context,
  ): Promise<SequenceResult> {
    const served = await this.fetchFasta(accession, includeIsoforms, ctx);
    const [canonical, ...rest] = served.records;
    if (canonical) {
      return {
        accession: served.accession,
        ...(served.accession !== accession ? { mergedFrom: accession } : {}),
        records: [canonical, ...rest],
      };
    }

    // Empty body: the accession is inactive, or has no sequence at all. The stub
    // lookup only sharpens this not-found, so its failure leaves a disclosed plain
    // not-found — unless the caller cancelled, which must not read as one.
    let stub: InactiveEntry | undefined;
    try {
      const { inactive } = await this.getEntries([accession], 'accession', ctx);
      stub = inactive.find((i) => i.accession === accession);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('Inactive-status lookup failed after an empty FASTA body', { accession });
      throw notFound(
        `No sequence found for accession ${accession}. Whether it is inactive (merged, demerged, or deleted) could not be checked; retry, or resolve it with uniprot_map_ids.`,
        { accession },
      );
    }

    const target =
      stub?.reason === 'MERGED' && stub.replacedBy?.length === 1 ? stub.replacedBy[0] : undefined;
    if (target) {
      const merged = await this.fetchFasta(target, includeIsoforms, ctx);
      const [mergedCanonical, ...mergedRest] = merged.records;
      if (mergedCanonical) {
        return {
          accession: merged.accession,
          mergedFrom: accession,
          records: [mergedCanonical, ...mergedRest],
        };
      }
    }
    throw notFound(
      stub ? describeInactive(stub) : `No sequence found for accession ${accession}.`,
      { accession },
    );
  }

  /**
   * One FASTA request, parsed. `accession` is the entry the records belong to:
   * the requested one, or the target UniProt redirected the request to.
   */
  private async fetchFasta(
    accession: string,
    includeIsoforms: boolean,
    ctx: Context,
  ): Promise<{ accession: string; records: SequenceRecord[] }> {
    const url = includeIsoforms
      ? new URL(`${this.baseUrl}/uniprotkb/search`)
      : new URL(`${this.baseUrl}/uniprotkb/${accession}.fasta`);
    if (includeIsoforms) {
      url.searchParams.set('query', `accession:${accession}`);
      url.searchParams.set('format', 'fasta');
      url.searchParams.set('includeIsoform', 'true');
    }

    const reqCtx = this.reqCtx('uniprot.getFasta', ctx);
    const { body, finalUrl } = await this.withRetry('uniprot.getFasta', ctx, async () => {
      const response = await fetchWithTimeout(url.toString(), this.timeoutMs, reqCtx, {
        signal: ctx.signal,
      });
      const text = await response.text();
      this.guardHtml(text);
      return { body: text, finalUrl: response.redirected ? response.url : undefined };
    }).catch((err) => {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No sequence found for accession ${accession}.`, { accession });
      }
      return sanitizeUpstreamError(err, 'uniprot.getFasta');
    });

    // A redirect served another entry (a merge target): label the records with the
    // accession their canonical header carries, whatever shape the redirect URL takes.
    const records = parseFasta(body);
    const redirectedTo = finalUrl
      ? records[0]?.header.match(/^(?:sp|tr)\|([^|]+)\|/)?.[1]
      : undefined;
    return { accession: redirectedTo ?? accession, records };
  }

  // ---------------------------------------------------------------------------
  // Normalizers
  // ---------------------------------------------------------------------------

  private normalizeOrganism(raw: RawEntry['organism']): Organism {
    return {
      scientificName: raw?.scientificName ?? 'unknown',
      ...(raw?.commonName ? { commonName: raw.commonName } : {}),
      taxonId: raw?.taxonId ?? 0,
    };
  }

  /** Every name of every gene, in UniProt's order: name, synonyms, ordered-locus names, ORF names. */
  private geneNames(raw: RawEntry): string[] {
    const names: string[] = [];
    for (const g of raw.genes ?? []) {
      for (const n of [
        g.geneName,
        ...(g.synonyms ?? []),
        ...(g.orderedLocusNames ?? []),
        ...(g.orfNames ?? []),
      ])
        if (n?.value) names.push(n.value);
    }
    return names;
  }

  private proteinName(raw: RawEntry): string | undefined {
    return (
      raw.proteinDescription?.recommendedName?.fullName?.value ??
      raw.proteinDescription?.submissionNames?.[0]?.fullName?.value
    );
  }

  /** The sequence flags, split; omitted when UniProt flags none. A fragment's `length` is the fragment's. */
  private sequenceFlags(raw: RawEntry): Pick<ProteinHit, 'sequenceFlags'> {
    const flags = (raw.proteinDescription?.flag ?? '')
      .split(',')
      .map((flag) => flag.trim())
      .filter(Boolean);
    return flags.length ? { sequenceFlags: flags } : {};
  }

  /**
   * The bounded opening of the first FUNCTION comment's first text, with the molecule
   * that comment is about. The molecule rides only with a snippet.
   */
  private firstFunctionSnippet(
    raw: RawEntry,
  ): Pick<ProteinHit, 'functionSnippet' | 'functionSnippetMolecule'> {
    const fn = raw.comments?.find((c) => c.commentType === 'FUNCTION');
    const text = fn?.texts?.[0]?.value;
    const snippet = text ? boundedSnippet(stripEvidence(text)) : undefined;
    if (!snippet) return {};
    return {
      functionSnippet: snippet,
      ...(fn?.molecule ? { functionSnippetMolecule: fn.molecule } : {}),
    };
  }

  private normalizeHit(raw: RawEntry): ProteinHit {
    const proteinName = this.proteinName(raw);
    return {
      accession: raw.primaryAccession,
      entryName: raw.uniProtkbId,
      ...(proteinName ? { proteinName } : {}),
      geneNames: this.geneNames(raw),
      organism: this.normalizeOrganism(raw.organism),
      length: raw.sequence?.length ?? 0,
      ...this.sequenceFlags(raw),
      reviewed: raw.entryType === 'UniProtKB reviewed (Swiss-Prot)',
      annotationScore: raw.annotationScore ?? 0,
      proteinExistence: raw.proteinExistence ?? 'unknown',
      ...this.firstFunctionSnippet(raw),
    };
  }

  private normalizeEntry(raw: RawEntry): Entry {
    const comments = raw.comments ?? [];
    const features = raw.features ?? [];
    const proteinName = this.proteinName(raw);

    // Rows of these four sections are flat parts of a comment: each carries its comment's
    // molecule, so a windowed row still says which isoform or chain it describes.
    const fn = comments
      .filter((c) => c.commentType === 'FUNCTION')
      .flatMap((c) =>
        (c.texts ?? []).map<FunctionText>((t) => ({
          value: t.value,
          ...rowQualifiers(c, t.evidences),
        })),
      );

    const catalytic = comments
      .filter((c) => c.commentType === 'CATALYTIC ACTIVITY')
      .flatMap<Reaction>((c) => {
        const reaction = c.reaction;
        if (!reaction) return [];
        const rhea = reaction.reactionCrossReferences?.find(
          (x) => x.database === 'Rhea' && x.id.startsWith('RHEA:'),
        );
        return [
          {
            name: reaction.name,
            ...(reaction.ecNumber ? { ecNumber: reaction.ecNumber } : {}),
            ...(rhea ? { rheaId: rhea.id } : {}),
            ...rowQualifiers(c, reaction.evidences),
          },
        ];
      });

    const cofactors = comments
      .filter((c) => c.commentType === 'COFACTOR')
      .flatMap((c) =>
        (c.cofactors ?? []).map<Cofactor>((cf) => ({
          name: cf.name,
          ...(cf.cofactorCrossReference?.database === 'ChEBI'
            ? { chebiId: cf.cofactorCrossReference.id }
            : {}),
          ...rowQualifiers(c, cf.evidences),
        })),
      );

    const biophysicochemical = comments
      .filter((c) => c.commentType === 'BIOPHYSICOCHEMICAL PROPERTIES')
      .map(normalizeBiophysicochemical);

    // A row's evidence is its location's own; the topology's and orientation's are not kept.
    const subcellularLocation = comments
      .filter((c) => c.commentType === 'SUBCELLULAR LOCATION')
      .flatMap((c) =>
        (c.subcellularLocations ?? []).map<Location>((l) => ({
          location: l.location.value,
          ...(l.topology?.value ? { topology: l.topology.value } : {}),
          ...(l.orientation?.value ? { orientation: l.orientation.value } : {}),
          ...rowQualifiers(c, l.location.evidences),
        })),
      );

    const disease = comments
      .filter((c) => c.commentType === 'DISEASE')
      .flatMap<Disease>((c) => {
        const d = c.disease;
        if (!d) return [];
        const omim =
          d.diseaseCrossReference?.database === 'MIM' ? d.diseaseCrossReference.id : undefined;
        const note = noteText(c);
        return [
          {
            name: d.diseaseId ?? 'Unnamed disease',
            ...(d.diseaseAccession ? { diseaseId: d.diseaseAccession } : {}),
            ...(d.acronym ? { acronym: d.acronym } : {}),
            ...(d.description ? { description: d.description } : {}),
            ...(omim ? { omimId: omim } : {}),
            ...(note ? { note } : {}),
          },
        ];
      });

    // A note covers its whole comment, so it is filed here once, one row per note text, rather
    // than copied onto each of the comment's rows in its own section. A DISEASE comment that names
    // no disease carries only a note, filed here so disease[].name stays a real disease name; a
    // named disease keeps its note as disease[].note.
    const freeText = comments.flatMap<Comment>((c) => {
      const texts = FREE_TEXT_COMMENT_TYPES.has(c.commentType)
        ? (c.texts ?? [])
        : NOTE_COMMENT_TYPES.has(c.commentType) || (c.commentType === 'DISEASE' && !c.disease)
          ? (c.note?.texts ?? [])
          : [];
      return texts.map((t) => ({
        type: c.commentType,
        value: t.value,
        ...rowQualifiers(c, t.evidences),
      }));
    });

    const interactions = comments
      .filter((c) => c.commentType === 'INTERACTION')
      .flatMap((c) => c.interactions ?? [])
      .map<Interaction>((i) => {
        const { uniProtKBAccession: one, chainId: chain } = i.interactantOne ?? {};
        const { uniProtKBAccession: partner, geneName, chainId: partnerChain } = i.interactantTwo;
        return {
          partner,
          ...(partnerChain ? { partnerChain } : {}),
          // UniProt writes "-" for a partner with no gene name.
          ...(geneName && geneName !== '-' ? { gene: geneName } : {}),
          experiments: i.numberOfExperiments,
          ...(i.organismDiffer ? { organismDiffer: true } : {}),
          ...(one && one !== raw.primaryAccession ? { isoform: one } : {}),
          ...(chain ? { chain } : {}),
        };
      });

    const ofTypes = <T>(types: ReadonlySet<string>, normalize: (f: RawFeature) => T) =>
      features.filter((f) => types.has(f.type)).map((f) => normalize(f));
    const ptms = ofTypes(PTM_TYPES, normalizeFeature);
    const domains = ofTypes(DOMAIN_TYPES, normalizeFeature);
    const processing = ofTypes(PROCESSING_TYPES, normalizeFeature);
    const topology = ofTypes(TOPOLOGY_TYPES, normalizeFeature);
    const sites = ofTypes(SITE_TYPES, normalizeSite);
    const variants = ofTypes(VARIANT_TYPES, normalizeVariant);
    const mutagenesis = ofTypes(MUTAGENESIS_TYPES, normalizeVariant);

    const ecNumbers = (raw.proteinDescription?.recommendedName?.ecNumbers ?? []).map(
      (ec) => ec.value,
    );
    const alternativeNames = (raw.proteinDescription?.alternativeNames ?? []).flatMap((n) =>
      n.fullName?.value ? [n.fullName.value] : [],
    );

    const isoforms = comments
      .filter((c) => c.commentType === 'ALTERNATIVE PRODUCTS')
      .flatMap((c) => c.isoforms ?? [])
      .map<Isoform>((iso) => {
        const synonyms = (iso.synonyms ?? []).map((s) => s.value);
        return {
          isoformId: iso.isoformIds?.[0] ?? 'unknown',
          ...(iso.name?.value ? { name: iso.name.value } : {}),
          ...(synonyms.length ? { synonyms } : {}),
          ...(iso.isoformSequenceStatus ? { sequenceStatus: iso.isoformSequenceStatus } : {}),
        };
      });

    const xrefList = raw.uniProtKBCrossReferences ?? [];
    const goTerms = xrefList
      .filter((x) => x.database === 'GO')
      .map<GoTerm>((x) => {
        const term = x.properties?.find((p) => p.key === 'GoTerm')?.value ?? '';
        const aspect = term.slice(0, 1);
        const evidenceType = x.properties?.find((p) => p.key === 'GoEvidenceType')?.value;
        return { id: x.id, term: term.slice(2), aspect, ...(evidenceType ? { evidenceType } : {}) };
      });

    const ensemblGenes = [
      ...new Set(
        xrefList.flatMap((x) =>
          x.database === 'Ensembl'
            ? (x.properties ?? []).filter((p) => p.key === 'GeneId').map((p) => p.value)
            : [],
        ),
      ),
    ];

    const keywords = (raw.keywords ?? []).map<Keyword>((k) => ({
      id: k.id,
      name: k.name,
      ...(k.category ? { category: k.category } : {}),
    }));

    // Every database the projection fetched, except GO, which goTerms carries. Keyed through a
    // Map: database names come from upstream, and a `{}` literal resolves `constructor` to its prototype.
    const xrefIds = new Map<string, string[]>();
    for (const x of xrefList) {
      if (x.database === 'GO') continue;
      const ids = xrefIds.get(x.database);
      if (ids) ids.push(x.id);
      else xrefIds.set(x.database, [x.id]);
    }
    const xrefs = Object.fromEntries(xrefIds);

    // An entry name is ACCESSION-or-mnemonic plus "_" plus the species code (P53_HUMAN).
    const nameSplit = raw.uniProtkbId.lastIndexOf('_');
    const mnemonic = nameSplit > 0 ? raw.uniProtkbId.slice(nameSplit + 1) : '';

    return {
      accession: raw.primaryAccession,
      entryName: raw.uniProtkbId,
      ...(proteinName ? { proteinName } : {}),
      ...(alternativeNames.length ? { alternativeNames } : {}),
      genes: this.geneNames(raw),
      organism: { ...this.normalizeOrganism(raw.organism), ...(mnemonic ? { mnemonic } : {}) },
      length: raw.sequence?.length ?? 0,
      ...this.sequenceFlags(raw),
      reviewed: raw.entryType === 'UniProtKB reviewed (Swiss-Prot)',
      annotationScore: raw.annotationScore ?? 0,
      proteinExistence: raw.proteinExistence ?? 'unknown',
      ...(ecNumbers.length ? { ecNumbers } : {}),
      ...(fn.length ? { function: fn } : {}),
      ...(catalytic.length ? { catalyticActivity: catalytic } : {}),
      ...(cofactors.length ? { cofactors } : {}),
      ...(biophysicochemical.length ? { biophysicochemical } : {}),
      ...(sites.length ? { sites } : {}),
      ...(subcellularLocation.length ? { subcellularLocation } : {}),
      ...(topology.length ? { topology } : {}),
      ...(disease.length ? { disease } : {}),
      ...(ptms.length ? { ptms } : {}),
      ...(processing.length ? { processing } : {}),
      ...(variants.length ? { variants } : {}),
      ...(mutagenesis.length ? { mutagenesis } : {}),
      ...(isoforms.length ? { isoforms } : {}),
      ...(domains.length ? { domains } : {}),
      ...(freeText.length ? { comments: freeText } : {}),
      ...(interactions.length ? { interactions } : {}),
      ...(goTerms.length ? { goTerms } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(Object.keys(xrefs).length ? { xrefs } : {}),
      ...(ensemblGenes.length ? { ensemblGenes } : {}),
    };
  }
}

// --- Raw upstream shapes that aren't reused on the class ---

type RawFacet = {
  name: string;
  label: string;
  values?: { value: string; label?: string; count: number }[];
};

type RawProteome = {
  id: string;
  proteomeType: string;
  proteinCount?: number;
  geneCount?: number;
  proteomeStatistics?: {
    reviewedProteinCount: number;
    unreviewedProteinCount: number;
    isoformProteinCount: number;
  };
  /** Present on excluded proteomes only. */
  exclusionReasons?: string[];
  taxonomy?: { scientificName: string; commonName?: string; taxonId: number; mnemonic?: string };
  genomeAssembly?: { assemblyId?: string };
  proteomeCompletenessReport?: {
    buscoReport?: {
      complete: number;
      completeSingle: number;
      completeDuplicated: number;
      fragmented: number;
      missing: number;
      total: number;
      lineageDb?: string;
      score?: number;
    };
    /** Only `status` carries signal: UniProt sends 0 for its numeric members. */
    cpdReport?: { status?: string };
  };
};

type RawTaxon = {
  taxonId: number;
  scientificName: string;
  commonName?: string;
  mnemonic?: string;
  rank?: string;
  parent?: { taxonId: number; scientificName: string };
  otherNames?: string[];
  lineage?: { taxonId: number; scientificName: string; commonName?: string; rank?: string }[];
};

type RawMappingResults = {
  results?: { from: string; to: string | (RawInactiveFields & Partial<RawEntry>) }[];
  /** Job-wide count of inactive UniProtKB targets; absent when there are none. */
  obsoleteCount?: number;
  failedIds?: string[];
};

/** `/idmapping/status/{jobId}`: `errors` accompanies a terminal `ERROR`. */
type RawMappingStatus = {
  jobStatus?: string;
  errors?: { code?: number; message?: string }[];
};

/** The target accession of an ID-mapping row: the generic endpoint names it, the uniprotkb one embeds the entry. */
function targetAccession(to: string | RawInactiveFields): string {
  return typeof to === 'string' ? to : to.primaryAccession;
}

/** Key of one ID-mapping row, matching the generic and uniprotkb results pages. */
function mappingKey(from: string, to: string): string {
  return `${from}\n${to}`;
}

/** A different optional page is unavailable enrichment, not a usable identity match. */
class MappingPageMismatch extends Error {}

/**
 * The one deadline an ID-mapping call runs under: submission, status polls, the
 * job-details read, the results read and its generic fallback, the inactive-target
 * re-read, and every retry and backoff between them. It sits 10 s under the 60 s
 * request timeout MCP SDK clients apply by default, so a slow or hung upstream ends
 * in this server's answer rather than a client-side timeout.
 */
const MAPPING_CALL_BUDGET_MS = 50_000;
/** The pause between two ID-mapping status checks. */
const MAPPING_POLL_INTERVAL_MS = 500;
/** How long the best-effort inactive-target re-read may take. */
const OPTIONAL_READ_MS = 2_000;

/**
 * The abort reason of this service's own deadlines. Named `TimeoutError`, so
 * `fetchWithTimeout` reports a request it cuts as a timeout; its class tells a spent
 * budget apart from a caller's cancellation.
 */
class DeadlineElapsed extends Error {
  override readonly name = 'TimeoutError';
}

/** A signal that aborts `ms` from now with a `DeadlineElapsed` reason, and the function that disarms it. */
function startDeadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DeadlineElapsed(`The ${ms} ms deadline elapsed.`)),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Whether `signal` was aborted by one of this service's deadlines, not by the caller. */
function deadlineElapsed(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof DeadlineElapsed;
}

/** Resolve after `ms`, or reject with the signal's reason the moment it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How an upstream mapping read was unavailable: it timed out, failed upstream
 * (unavailable, rate-limited, an HTML page), or was refused (a 4xx). `undefined`
 * for any other failure — a malformed body, a caller's cancellation — which is
 * never read as unavailability.
 */
function unavailableRead(err: unknown): MappingReadFailure | undefined {
  if (!(err instanceof McpError)) return;
  switch (err.code) {
    case JsonRpcErrorCode.Timeout:
      return 'timeout';
    case JsonRpcErrorCode.ServiceUnavailable:
    case JsonRpcErrorCode.RateLimited:
      return 'failed';
    case JsonRpcErrorCode.NotFound:
    case JsonRpcErrorCode.Forbidden:
    case JsonRpcErrorCode.Unauthorized:
    case JsonRpcErrorCode.ValidationError:
    case JsonRpcErrorCode.InvalidParams:
    case JsonRpcErrorCode.InvalidRequest:
      return 'refused';
    default:
      return;
  }
}

/**
 * How an optional read that decides a page's identity was unavailable. Caller
 * cancellation, a spent call budget, and any failure that is not unavailability
 * (a malformed body) are rethrown.
 */
function degradedRead(err: unknown, signal: AbortSignal): MappingReadFailure {
  const failure = signal.aborted ? undefined : unavailableRead(err);
  if (!failure) throw err;
  return failure;
}

/** Optional upstream reads degrade only for operational or endpoint availability failures. */
function mappingEnrichmentUnavailable(err: unknown, deadlineExpired: boolean): boolean {
  if (
    deadlineExpired &&
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  )
    return true;
  return (
    unavailableRead(err) !== undefined ||
    (deadlineExpired && err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled)
  );
}

/** The arguments that resume a mapping job: its ticket, or a completed-page continuation. */
type MappingResume = { ticket: string } | { continuation: IdMappingContinuation };

/**
 * The `Timeout` for a spent call budget. Before a job id exists there is nothing to
 * resume, so the call is retried; after, the error names the job and carries the
 * arguments that resume it (in `data` and the recovery hint), so a retry never
 * re-submits a job UniProt already holds.
 */
function mappingBudgetSpent(resume: MappingResume | undefined, cause: unknown): McpError {
  const budget = `this call's ${MAPPING_CALL_BUDGET_MS / 1_000}-second budget`;
  if (!resume) {
    return new McpError(
      JsonRpcErrorCode.Timeout,
      `UniProt ID mapping did not finish within ${budget}. Retry the call.`,
      undefined,
      { cause },
    );
  }
  const args = JSON.stringify(resume);
  const [jobId, reread] =
    'ticket' in resume
      ? [resume.ticket, 'to read its results without re-submitting the job']
      : [resume.continuation.jobId, 'to read this page again'];
  return new McpError(
    JsonRpcErrorCode.Timeout,
    `UniProt ID-mapping job ${jobId} is held server-side, but ${budget} ran out reading its results.`,
    { ...resume, recovery: { hint: `Re-call with ${args} ${reread}.` } },
    { cause, literals: [args] },
  );
}

/** The running result of a poll that did not see `FINISHED`. */
function stillRunning(ticket: string, poll: 'running' | 'check_failed'): IdMappingResult {
  return {
    status: 'running',
    ticket,
    ...(poll === 'check_failed' ? { statusCheckFailed: true } : {}),
  };
}

/** Identity fields are sparse and inactive stubs retain their recovery pointers. */
function mappingIdentity(
  raw: RawInactiveFields & Partial<RawEntry>,
): Partial<IdMappingPage['results'][number]> {
  const stub = parseInactive(raw);
  const { accession: _accession, ...inactive } = stub ?? {};
  return {
    ...(stub ? { inactive } : {}),
    ...(raw.uniProtkbId ? { entryName: raw.uniProtkbId } : {}),
    ...(raw.entryType?.includes('Swiss-Prot')
      ? { reviewed: true }
      : raw.entryType?.includes('TrEMBL')
        ? { reviewed: false }
        : {}),
    ...(raw.organism
      ? {
          organism: {
            taxonId: raw.organism.taxonId,
            ...(raw.organism.scientificName ? { scientificName: raw.organism.scientificName } : {}),
          },
        }
      : {}),
    ...(raw.genes?.[0]?.geneName?.value ? { gene: raw.genes[0].geneName.value } : {}),
  };
}

/** Markup in a relayed job-failure message: UniProt passes a backend's HTML error page through as one. */
const HTML_MARKUP = /<(?:!doctype|\/?(?:html|head|body|title|meta)\b)/i;

/**
 * A terminal job failure is actionable input feedback, never an outage to retry.
 * A message that would relay HTML markup — UniProt failing internally behind a
 * proxy — becomes a fixed sentence naming the job and UniProt's error code.
 */
function mappingFailure(data: RawMappingStatus, jobId: string, cause?: unknown): McpError {
  const relayed = (data.errors ?? []).flatMap((error) => {
    const message = typeof error.message === 'string' ? boundMessage(error.message) : undefined;
    if (!message) return [];
    if (!HTML_MARKUP.test(message)) return [message];
    const code = typeof error.code === 'number' ? ` (error code ${error.code})` : '';
    return [`the ID-mapping service failed internally on job ${jobId}${code}`];
  });
  const messages = [...new Set(relayed)].slice(0, MAX_RELAYED_MESSAGES);
  const limit = messages.some((message) => message.includes('number of mapped IDs'));
  return new McpError(
    JsonRpcErrorCode.ValidationError,
    messages.length
      ? `UniProt mapping failed: ${messages.join('; ')}`
      : 'UniProt mapping job failed.',
    {
      reason: 'mapping_failed',
      recovery: {
        hint: limit
          ? 'Submit fewer IDs, use an exact tax_id, or target UniProtKB-Swiss-Prot to reduce mapped results.'
          : 'Check the submitted identifiers and databases, then submit a fresh mapping job; retry later if the failure persists.',
      },
    },
    { cause },
  );
}

// --- Module-level normalizers (no class state) ---

function normalizeFacet(raw: RawFacet): SearchFacet {
  return {
    name: raw.name,
    label: raw.label,
    values: (raw.values ?? []).map((v) => ({
      value: v.value,
      label: v.label ?? v.value,
      count: v.count,
    })),
  };
}

/**
 * The one location reader for every feature-built section (`normalizeFeature`,
 * and so `normalizeSite`, and `normalizeVariant`). Keeps each bound's position
 * when UniProt gives one, its modifier only when it is not `EXACT`, and the
 * isoform the positions are numbered on; field meanings are on `FeatureLocation`.
 * An exact canonical location comes back as `{ start, end }` alone.
 */
function normalizeLocation(raw: RawFeatureLocation | undefined): FeatureLocation {
  const { start, end, sequence } = raw ?? {};
  return {
    ...(start?.value != null ? { start: start.value } : {}),
    ...(end?.value != null ? { end: end.value } : {}),
    ...(start?.modifier && start.modifier !== 'EXACT' ? { startModifier: start.modifier } : {}),
    ...(end?.modifier && end.modifier !== 'EXACT' ? { endModifier: end.modifier } : {}),
    ...(sequence ? { isoform: sequence } : {}),
  };
}

function normalizeFeature(raw: RawFeature): Feature {
  return {
    type: raw.type,
    ...(raw.description ? { description: raw.description } : {}),
    location: normalizeLocation(raw.location),
    ...(raw.featureId ? { featureId: raw.featureId } : {}),
  };
}

/** UniProt feature types by the entry section that renders them. */
const PTM_TYPES: ReadonlySet<string> = new Set([
  'Modified residue',
  'Glycosylation',
  'Lipidation',
  'Cross-link',
  'Disulfide bond',
]);
const DOMAIN_TYPES: ReadonlySet<string> = new Set([
  'Domain',
  'Region',
  'Repeat',
  'Motif',
  'Zinc finger',
  'DNA binding',
  'Coiled coil',
]);
const SITE_TYPES: ReadonlySet<string> = new Set(['Active site', 'Binding site', 'Site']);
const PROCESSING_TYPES: ReadonlySet<string> = new Set([
  'Signal',
  'Transit peptide',
  'Propeptide',
  'Chain',
  'Peptide',
  'Initiator methionine',
]);
const TOPOLOGY_TYPES: ReadonlySet<string> = new Set([
  'Topological domain',
  'Transmembrane',
  'Intramembrane',
]);
const VARIANT_TYPES: ReadonlySet<string> = new Set(['Natural variant']);
const MUTAGENESIS_TYPES: ReadonlySet<string> = new Set(['Mutagenesis']);

/** Comment types whose content is free text (`texts[]`), rendered one row per text under `comments`. */
const FREE_TEXT_COMMENT_TYPES: ReadonlySet<string> = new Set([
  'ACTIVITY REGULATION',
  'ALLERGEN',
  'BIOTECHNOLOGY',
  'CAUTION',
  'DEVELOPMENTAL STAGE',
  'DISRUPTION PHENOTYPE',
  'DOMAIN',
  'INDUCTION',
  'MISCELLANEOUS',
  'PATHWAY',
  'PHARMACEUTICAL',
  'POLYMORPHISM',
  'PTM',
  'SIMILARITY',
  'SUBUNIT',
  'TISSUE SPECIFICITY',
  'TOXIC DOSE',
]);

/**
 * Comment types whose structured rows fill their own section (subcellularLocation, cofactors,
 * isoforms) and whose `note`, when present, is rendered one row per text under `comments`.
 */
const NOTE_COMMENT_TYPES: ReadonlySet<string> = new Set([
  'ALTERNATIVE PRODUCTS',
  'COFACTOR',
  'SUBCELLULAR LOCATION',
]);

/** A comment's note texts joined, or undefined when it has none. */
function noteText(comment: RawComment): string | undefined {
  const text = (comment.note?.texts ?? []).map((t) => t.value).join(' ');
  return text || undefined;
}

/** `{ evidence }` from an evidences[] array, or nothing when it yields none. */
function evidenceOf(evidences?: RawEvidence[]): { evidence?: string[] } {
  const evidence = collectEvidence(evidences);
  return evidence ? { evidence } : {};
}

/**
 * A row's own evidence and the molecule (isoform or chain) its comment is about, each
 * omitted when UniProt sends none.
 */
function rowQualifiers(
  comment: RawComment,
  evidences?: RawEvidence[],
): Pick<Comment, 'evidence' | 'molecule'> {
  return {
    ...evidenceOf(evidences),
    ...(comment.molecule ? { molecule: comment.molecule } : {}),
  };
}

/**
 * One BIOPHYSICOCHEMICAL PROPERTIES comment as one object: its molecule on the object (UniProt
 * writes one such comment per molecule), each part omitted when UniProt sends none, and every
 * KM row, Vmax row, text, and absorption with its own evidence.
 */
function normalizeBiophysicochemical(comment: RawComment): Biophysicochemical {
  const texts = (part?: { texts?: RawText[] }): EvidencedText[] =>
    (part?.texts ?? []).map((t) => ({ value: t.value, ...evidenceOf(t.evidences) }));

  const kinetics = comment.kineticParameters;
  const michaelisConstants = (kinetics?.michaelisConstants ?? []).map((k) => ({
    constant: k.constant,
    unit: k.unit,
    substrate: k.substrate,
    ...evidenceOf(k.evidences),
  }));
  const maximumVelocities = (kinetics?.maximumVelocities ?? []).map((v) => ({
    velocity: v.velocity,
    unit: v.unit,
    enzyme: v.enzyme,
    ...evidenceOf(v.evidences),
  }));
  const kineticsNote = texts(kinetics?.note);
  const phDependence = texts(comment.phDependence);
  const temperatureDependence = texts(comment.temperatureDependence);
  const redoxPotential = texts(comment.redoxPotential);
  const max = comment.absorption?.max;
  const absorption = {
    ...(max === undefined ? {} : { maxNm: max }),
    // UniProt sends approximate on every absorption; only a maximum can be approximate.
    ...(max !== undefined && comment.absorption?.approximate ? { approximate: true as const } : {}),
    ...evidenceOf(comment.absorption?.evidences),
  };
  // Lifted beside absorption, as kineticsNote is beside the KM and Vmax rows.
  const absorptionNote = texts(comment.absorption?.note);
  return {
    ...(comment.molecule ? { molecule: comment.molecule } : {}),
    ...(michaelisConstants.length ? { michaelisConstants } : {}),
    ...(maximumVelocities.length ? { maximumVelocities } : {}),
    ...(kineticsNote.length ? { kineticsNote } : {}),
    ...(phDependence.length ? { phDependence } : {}),
    ...(temperatureDependence.length ? { temperatureDependence } : {}),
    ...(redoxPotential.length ? { redoxPotential } : {}),
    ...(Object.keys(absorption).length ? { absorption } : {}),
    ...(absorptionNote.length ? { absorptionNote } : {}),
  };
}

/** `ChEBI:CHEBI:29108` → `CHEBI:29108`; undefined for any other namespace or no id. */
function chebiId(id: string | undefined): string | undefined {
  return id?.startsWith('ChEBI:') ? id.slice('ChEBI:'.length) : undefined;
}

function normalizeSite(raw: RawFeature): Site {
  const ligand = raw.ligand;
  const part = raw.ligandPart;
  const ligandChebi = chebiId(ligand?.id);
  const partChebi = chebiId(part?.id);
  return {
    ...normalizeFeature(raw),
    ...(ligand
      ? {
          ligand: {
            name: ligand.name,
            ...(ligandChebi ? { chebiId: ligandChebi } : {}),
            ...(ligand.label ? { label: ligand.label } : {}),
            ...(ligand.note ? { note: ligand.note } : {}),
          },
        }
      : {}),
    ...(part
      ? { ligandPart: { name: part.name, ...(partChebi ? { chebiId: partChebi } : {}) } }
      : {}),
  };
}

function normalizeVariant(raw: RawFeature): Variant {
  const original = raw.alternativeSequence?.originalSequence;
  // A mutagenesis can test several substitutions at one position (UniProt "L->A,P"); keep them all.
  const variation = raw.alternativeSequence?.alternativeSequences?.join(',');
  return {
    ...(raw.description ? { description: raw.description } : {}),
    location: normalizeLocation(raw.location),
    ...(original ? { original } : {}),
    ...(variation ? { variation } : {}),
    ...(raw.featureId ? { featureId: raw.featureId } : {}),
  };
}

function normalizeProteome(raw: RawProteome): Proteome {
  const busco = raw.proteomeCompletenessReport?.buscoReport;
  const cpdStatus = raw.proteomeCompletenessReport?.cpdReport?.status;
  // UniProt computes the gene count and statistics for reference proteomes only and sends 0
  // for each elsewhere, beside a non-zero proteinCount. Reviewed and unreviewed partition
  // proteinCount, so both 0 marks the placeholder; a single 0 (E. coli's unreviewed) is real.
  const stats = raw.proteomeStatistics;
  const statsComputed =
    stats && (stats.reviewedProteinCount > 0 || stats.unreviewedProteinCount > 0);
  return {
    upid: raw.id,
    proteomeType: raw.proteomeType,
    ...(raw.exclusionReasons?.length ? { exclusionReasons: raw.exclusionReasons } : {}),
    organism: {
      scientificName: raw.taxonomy?.scientificName ?? 'unknown',
      ...(raw.taxonomy?.commonName ? { commonName: raw.taxonomy.commonName } : {}),
      taxonId: raw.taxonomy?.taxonId ?? 0,
      ...(raw.taxonomy?.mnemonic ? { mnemonic: raw.taxonomy.mnemonic } : {}),
    },
    proteinCount: raw.proteinCount ?? 0,
    ...(raw.geneCount ? { geneCount: raw.geneCount } : {}),
    ...(statsComputed
      ? {
          reviewedProteinCount: stats.reviewedProteinCount,
          unreviewedProteinCount: stats.unreviewedProteinCount,
          isoformProteinCount: stats.isoformProteinCount,
        }
      : {}),
    ...(cpdStatus ? { cpdStatus } : {}),
    ...(busco
      ? {
          busco: {
            complete: busco.complete,
            completeSingle: busco.completeSingle,
            completeDuplicated: busco.completeDuplicated,
            fragmented: busco.fragmented,
            missing: busco.missing,
            total: busco.total,
            ...(busco.lineageDb ? { lineageDb: busco.lineageDb } : {}),
            ...(busco.score != null ? { score: busco.score } : {}),
          },
        }
      : {}),
    ...(raw.genomeAssembly?.assemblyId ? { genomeAssembly: raw.genomeAssembly.assemblyId } : {}),
  };
}

function normalizeTaxon(raw: RawTaxon): Taxon {
  return {
    taxonId: raw.taxonId,
    scientificName: raw.scientificName,
    ...(raw.commonName ? { commonName: raw.commonName } : {}),
    ...(raw.mnemonic ? { mnemonic: raw.mnemonic } : {}),
    rank: raw.rank ?? 'no rank',
    ...(raw.parent
      ? { parent: { taxonId: raw.parent.taxonId, scientificName: raw.parent.scientificName } }
      : {}),
    lineage: (raw.lineage ?? []).map((l) => ({
      taxonId: l.taxonId,
      scientificName: l.scientificName,
      ...(l.commonName ? { commonName: l.commonName } : {}),
      rank: l.rank ?? 'no rank',
    })),
    ...(raw.otherNames?.length ? { otherNames: raw.otherNames } : {}),
  };
}

/** Parse a multi-record FASTA blob into header/sequence/length records. */
function parseFasta(text: string): SequenceRecord[] {
  const records: SequenceRecord[] = [];
  let header: string | undefined;
  let seqLines: string[] = [];

  const flush = () => {
    if (header == null) return;
    const sequence = seqLines.join('');
    const isoformMatch = header.match(/^(?:sp|tr)\|([^|]+)\|/);
    const isoformId = isoformMatch?.[1];
    records.push({
      ...(isoformId?.includes('-') ? { isoformId } : {}),
      header,
      sequence,
      length: sequence.length,
    });
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      flush();
      header = line.slice(1).trim();
      seqLines = [];
    } else if (line.trim()) {
      seqLines.push(line.trim());
    }
  }
  flush();
  return records;
}

// --- Init/accessor pattern ---

let _service: UniProtService | undefined;

export function initUniProtService(config: AppConfig, storage: StorageService): void {
  _service = new UniProtService(config, storage);
}

export function getUniProtService(): UniProtService {
  if (!_service) {
    throw new Error('UniProtService not initialized — call initUniProtService() in setup()');
  }
  return _service;
}
