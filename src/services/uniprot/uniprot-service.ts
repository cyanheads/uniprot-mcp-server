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
import type {
  Cofactor,
  Disease,
  Entry,
  EvidencedText,
  Feature,
  GoTerm,
  IdMappingContinuation,
  IdMappingFromDb,
  IdMappingPage,
  IdMappingResult,
  IdMappingToDb,
  InactiveEntry,
  InactiveReason,
  Isoform,
  Keyword,
  Location,
  Organism,
  ProteinHit,
  Proteome,
  ProteomeProteinPage,
  Reaction,
  SearchFacet,
  SearchPage,
  SequenceRecord,
  SequenceResult,
  Taxon,
  TaxonChild,
  TaxonChildrenPage,
  Variant,
} from '@/services/uniprot/types.js';
import {
  DEFAULT_ENTRY_FIELDS,
  DEFAULT_SEARCH_FIELDS,
  describeInactive,
  groupClause,
  MANDATORY_ENTRY_FIELDS,
  MANDATORY_SEARCH_FIELDS,
  TAXON_CHILDREN_PAGE_SIZE,
} from '@/services/uniprot/types.js';

/**
 * Framework `data` keys that carry raw upstream internals — `fetchWithTimeout`
 * attaches these to the status-mapped `McpError` it throws on any non-2xx /
 * timeout / network failure. The handler boundary copies `error.data` verbatim
 * onto `structuredContent.error.data`, so any one of these on an error that
 * reaches the client leaks internals (`responseBody` is up to 500 bytes of the
 * raw upstream error page; the rest expose status, internal request id, and the
 * internal operation label). Presence of any key flags a raw framework HTTP
 * error that must be re-thrown clean before it escapes the service.
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

/** Strip evidence-reference parentheticals (e.g. `(PubMed:12345)`) for a clean snippet. */
function stripEvidence(text: string): string {
  return text
    .replace(/\s*\((?:PubMed|UniProtKB|Ref\.\d+|By similarity|Probable)[^)]*\)/g, '')
    .trim();
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
  reaction?: {
    name: string;
    ecNumber?: string;
    reactionCrossReferences?: { database: string; id: string }[];
  };
  cofactors?: {
    name: string;
    evidences?: RawEvidence[];
    cofactorCrossReference?: { database: string; id: string };
  }[];
  subcellularLocations?: { location: RawText; topology?: RawText }[];
  disease?: {
    diseaseId?: string;
    diseaseAccession?: string;
    acronym?: string;
    description?: string;
    diseaseCrossReference?: { database: string; id: string };
  };
  events?: string[];
  isoforms?: {
    name?: RawValue;
    isoformIds?: string[];
    isoformSequenceStatus?: string;
  }[];
};

type RawFeatureLocation = { start?: { value?: number }; end?: { value?: number } };
type RawFeature = {
  type: string;
  description?: string;
  location?: RawFeatureLocation;
  featureId?: string;
  evidences?: RawEvidence[];
  alternativeSequence?: { originalSequence?: string; alternativeSequences?: string[] };
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
    recommendedName?: { fullName?: RawValue };
    submissionNames?: { fullName?: RawValue }[];
  };
  genes?: { geneName?: RawValue; synonyms?: RawValue[] }[];
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
    url.searchParams.set('fields', this.searchFields(opts.fields));
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

  /**
   * Resolve the upstream `fields` for a search. A caller-supplied `fields` trims
   * the projection but always carries the mandatory identity/provenance columns
   * the required `ProteinHit` output schema demands — UniProt omits `id`,
   * `length`, organism, score, and existence unless explicitly requested, so
   * without this a custom `fields` (e.g. "accession,gene_names") would crash on
   * the missing `entryName` or fabricate provenance. Returns the default set when
   * none is given. Mirrors `entryFields()`.
   */
  private searchFields(fields: string | undefined): string {
    if (!fields) return DEFAULT_SEARCH_FIELDS;
    const requested = fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const merged = new Set<string>([...MANDATORY_SEARCH_FIELDS, ...requested]);
    return [...merged].join(',');
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
    url.searchParams.set('fields', this.entryFields(fields));
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

  /**
   * Resolve the upstream `fields` for an entry fetch. A caller-supplied `fields`
   * trims sections but always carries the mandatory identity/provenance columns
   * the required output schema demands — UniProt omits `id`, `length`, score,
   * existence, and organism unless explicitly requested, so without this a custom
   * `fields` would crash on the missing `entryName` or fabricate provenance.
   */
  private entryFields(fields: string | undefined): string {
    if (!fields) return DEFAULT_ENTRY_FIELDS;
    const requested = fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    const merged = new Set<string>([...MANDATORY_ENTRY_FIELDS, ...requested]);
    return [...merged].join(',');
  }

  // ---------------------------------------------------------------------------
  // ID mapping (async)
  // ---------------------------------------------------------------------------

  /**
   * Run an ID-mapping job and poll within a wall-clock budget. On `FINISHED`,
   * fetch and return the mappings. If the budget elapses first, return a
   * resumable ticket (the bare jobId — UniProt holds the job server-side).
   */
  async mapIds(
    from: IdMappingFromDb,
    to: IdMappingToDb,
    ids: string[],
    taxId: number | undefined,
    ctx: Context,
  ): Promise<IdMappingResult> {
    const cfg = getServerConfig();
    const jobId = await this.runMapping(from, to, ids, taxId, ctx);
    const deadline = Date.now() + cfg.idMappingBudgetMs;

    while (Date.now() < deadline) {
      if (ctx.signal.aborted) break;
      const status = await this.mappingStatus(jobId, ctx);
      if (status === 'FINISHED') {
        return { status: 'finished', ...(await this.mappingResults(jobId, ctx)) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { status: 'running', ticket: jobId };
  }

  /**
   * Fetch results for a previously-submitted ID-mapping ticket (resume path). A
   * caller-supplied ticket or continuation job id reaches the request path only
   * after the tool has matched it against `JOB_ID_REGEX`.
   */
  async resumeMapping(ticket: string, ctx: Context): Promise<IdMappingResult> {
    const status = await this.mappingStatus(ticket, ctx);
    if (status !== 'FINISHED') return { status: 'running', ticket };
    return { status: 'finished', ...(await this.mappingResults(ticket, ctx)) };
  }

  /** Fetch the next page of an already-completed ID-mapping job. */
  async resumeMappingPage(
    continuation: IdMappingContinuation,
    ctx: Context,
  ): Promise<IdMappingResult> {
    return {
      status: 'finished',
      ...(await this.mappingResults(continuation.jobId, ctx, continuation.cursor)),
    };
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
    }).catch((err) => sanitizeUpstreamError(err, 'uniprot.runMapping'));

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
        const data = JSON.parse(text) as { jobStatus?: string };
        return data.jobStatus ?? 'RUNNING';
      } catch (err) {
        const status =
          err instanceof McpError && err.data
            ? ((err.data as Record<string, unknown>).status ??
              (err.data as Record<string, unknown>).statusCode)
            : undefined;
        if (status === 303) return 'FINISHED';
        return sanitizeUpstreamError(err, operation);
      }
    });
  }

  private async mappingResults(
    jobId: string,
    ctx: Context,
    cursor?: string,
  ): Promise<IdMappingPage> {
    const url = new URL(`${this.baseUrl}/idmapping/results/${jobId}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', '500');
    if (cursor) url.searchParams.set('cursor', cursor);

    const { data, response } = await this.getJson<RawMappingResults>(
      url.toString(),
      'uniprot.mappingResults',
      ctx,
    );
    let results: IdMappingPage['results'] = (data.results ?? []).map((row) => ({
      from: row.from,
      to: targetAccession(row.to),
    }));

    // This endpoint names target accessions only. UniProt flags a job holding any
    // inactive UniProtKB target with a job-wide obsoleteCount, and only the uniprotkb
    // results endpoint says which — so only such a job pays one more read per page.
    let inactiveUnchecked: number | undefined;
    if (data.obsoleteCount && results.length) {
      try {
        const inactive = await this.inactiveMappingTargets(jobId, cursor, results, ctx);
        results = results.map((r) => {
          const reason = inactive.get(mappingKey(r.from, r.to));
          return reason ? { ...r, inactive: reason } : r;
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
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
      ...(continuation ? { continuation } : {}),
      ...(inactiveUnchecked ? { inactiveUnchecked } : {}),
    };
  }

  /**
   * The inactive targets on one ID-mapping results page, keyed by source ID and
   * target accession. Read from `/idmapping/uniprotkb/results/{jobId}`, the results
   * endpoint whose rows carry the target entry and so its inactive stub; the
   * generic endpoint's cursor addresses the same page there. Throws when the
   * re-read page lacks a row of `page`, so a drifted page is disclosed as
   * unchecked rather than left silently unmarked.
   */
  private async inactiveMappingTargets(
    jobId: string,
    cursor: string | undefined,
    page: { from: string; to: string }[],
    ctx: Context,
  ): Promise<Map<string, InactiveReason>> {
    const url = new URL(`${this.baseUrl}/idmapping/uniprotkb/results/${jobId}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('fields', 'accession');
    url.searchParams.set('size', '500');
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
      throw new Error(`ID-mapping job ${jobId}: the uniprotkb results page holds different rows.`);
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
    const raw = data.results?.[0];
    if (!raw) {
      const label = idOrTaxon.upid ?? `taxon ${idOrTaxon.taxonId}`;
      throw notFound(`No reference proteome found for ${label}.`, { ...idOrTaxon });
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
    const queryParts = [`proteome:${upid}`];
    if (opts.query) queryParts.push(groupClause(opts.query));
    const page = await this.search(
      queryParts.join(' AND '),
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
   * Resolve a taxonomy record by scientific name via the taxonomy search endpoint.
   * The name is a plain name, not query syntax: `\` and `"` are escaped so any
   * name forms a valid phrase query. UniProt tokenizes the phrase, so a stray
   * quote or backslash in a name does not by itself prevent a match.
   */
  async getTaxonByName(name: string, ctx: Context): Promise<Taxon> {
    const url = new URL(`${this.baseUrl}/taxonomy/search`);
    url.searchParams.set('query', `scientific:"${name.replace(/[\\"]/g, '\\$&')}"`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', '1');
    const { data } = await this.getJson<{ results?: RawTaxon[] }>(
      url.toString(),
      'uniprot.getTaxonByName',
      ctx,
    );
    const raw = data.results?.[0];
    if (!raw) throw notFound(`No taxonomy record matched the name "${name}".`, { name });
    return normalizeTaxon(raw);
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

  private geneNames(raw: RawEntry): string[] {
    const names: string[] = [];
    for (const g of raw.genes ?? []) {
      if (g.geneName?.value) names.push(g.geneName.value);
      for (const s of g.synonyms ?? []) if (s.value) names.push(s.value);
    }
    return names;
  }

  private proteinName(raw: RawEntry): string | undefined {
    return (
      raw.proteinDescription?.recommendedName?.fullName?.value ??
      raw.proteinDescription?.submissionNames?.[0]?.fullName?.value
    );
  }

  private firstFunctionSnippet(raw: RawEntry): string | undefined {
    const fn = raw.comments?.find((c) => c.commentType === 'FUNCTION');
    const text = fn?.texts?.[0]?.value;
    return text ? stripEvidence(text) : undefined;
  }

  private normalizeHit(raw: RawEntry): ProteinHit {
    const proteinName = this.proteinName(raw);
    const fnSnippet = this.firstFunctionSnippet(raw);
    return {
      accession: raw.primaryAccession,
      entryName: raw.uniProtkbId,
      ...(proteinName ? { proteinName } : {}),
      geneNames: this.geneNames(raw),
      organism: this.normalizeOrganism(raw.organism),
      length: raw.sequence?.length ?? 0,
      reviewed: raw.entryType === 'UniProtKB reviewed (Swiss-Prot)',
      annotationScore: raw.annotationScore ?? 0,
      proteinExistence: raw.proteinExistence ?? 'unknown',
      ...(fnSnippet ? { functionSnippet: fnSnippet } : {}),
    };
  }

  private normalizeEntry(raw: RawEntry): Entry {
    const comments = raw.comments ?? [];
    const features = raw.features ?? [];
    const proteinName = this.proteinName(raw);

    const fn = comments
      .filter((c) => c.commentType === 'FUNCTION')
      .flatMap((c) => c.texts ?? [])
      .map<EvidencedText>((t) => {
        const evidence = collectEvidence(t.evidences);
        return { value: t.value, ...(evidence ? { evidence } : {}) };
      });

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
          },
        ];
      });

    const cofactors = comments
      .filter((c) => c.commentType === 'COFACTOR')
      .flatMap((c) => c.cofactors ?? [])
      .map<Cofactor>((cf) => ({
        name: cf.name,
        ...(cf.cofactorCrossReference?.database === 'ChEBI'
          ? { chebiId: cf.cofactorCrossReference.id }
          : {}),
      }));

    const subcellularLocation = comments
      .filter((c) => c.commentType === 'SUBCELLULAR LOCATION')
      .flatMap((c) => c.subcellularLocations ?? [])
      .map<Location>((l) => ({
        location: l.location.value,
        ...(l.topology?.value ? { topology: l.topology.value } : {}),
      }));

    const disease = comments
      .filter((c) => c.commentType === 'DISEASE')
      .flatMap<Disease>((c) => {
        const d = c.disease;
        if (!d) return [];
        const omim =
          d.diseaseCrossReference?.database === 'MIM' ? d.diseaseCrossReference.id : undefined;
        return [
          {
            name: d.diseaseId ?? 'Unnamed disease',
            ...(d.diseaseAccession ? { diseaseId: d.diseaseAccession } : {}),
            ...(d.acronym ? { acronym: d.acronym } : {}),
            ...(d.description ? { description: d.description } : {}),
            ...(omim ? { omimId: omim } : {}),
          },
        ];
      });

    const ptmTypes = new Set([
      'Modified residue',
      'Glycosylation',
      'Lipidation',
      'Cross-link',
      'Disulfide bond',
    ]);
    const ptms = features.filter((f) => ptmTypes.has(f.type)).map((f) => normalizeFeature(f));

    const domainTypes = new Set([
      'Domain',
      'Region',
      'Repeat',
      'Motif',
      'Zinc finger',
      'DNA-binding region',
    ]);
    const domains = features.filter((f) => domainTypes.has(f.type)).map((f) => normalizeFeature(f));

    const variants = features
      .filter((f) => f.type === 'Natural variant')
      .map((f) => normalizeVariant(f));

    const isoforms = comments
      .filter((c) => c.commentType === 'ALTERNATIVE PRODUCTS')
      .flatMap((c) => c.isoforms ?? [])
      .map<Isoform>((iso) => ({
        isoformId: iso.isoformIds?.[0] ?? 'unknown',
        ...(iso.name?.value ? { name: iso.name.value } : {}),
        ...(iso.isoformSequenceStatus ? { sequenceStatus: iso.isoformSequenceStatus } : {}),
      }));

    const xrefList = raw.uniProtKBCrossReferences ?? [];
    const goTerms = xrefList
      .filter((x) => x.database === 'GO')
      .map<GoTerm>((x) => {
        const term = x.properties?.find((p) => p.key === 'GoTerm')?.value ?? '';
        const aspect = term.slice(0, 1);
        return { id: x.id, term: term.slice(2), aspect };
      });

    const keywords = (raw.keywords ?? []).map<Keyword>((k) => ({
      id: k.id,
      name: k.name,
      ...(k.category ? { category: k.category } : {}),
    }));

    const xrefDatabases = ['PDB', 'Ensembl', 'RefSeq', 'ChEMBL', 'AlphaFoldDB'];
    const xrefs: Record<string, string[]> = {};
    for (const x of xrefList) {
      if (!xrefDatabases.includes(x.database)) continue;
      const bucket = xrefs[x.database] ?? [];
      bucket.push(x.id);
      xrefs[x.database] = bucket;
    }

    return {
      accession: raw.primaryAccession,
      entryName: raw.uniProtkbId,
      ...(proteinName ? { proteinName } : {}),
      genes: this.geneNames(raw),
      organism: this.normalizeOrganism(raw.organism),
      length: raw.sequence?.length ?? 0,
      reviewed: raw.entryType === 'UniProtKB reviewed (Swiss-Prot)',
      annotationScore: raw.annotationScore ?? 0,
      proteinExistence: raw.proteinExistence ?? 'unknown',
      ...(fn.length ? { function: fn } : {}),
      ...(catalytic.length ? { catalyticActivity: catalytic } : {}),
      ...(cofactors.length ? { cofactors } : {}),
      ...(subcellularLocation.length ? { subcellularLocation } : {}),
      ...(disease.length ? { disease } : {}),
      ...(ptms.length ? { ptms } : {}),
      ...(variants.length ? { variants } : {}),
      ...(isoforms.length ? { isoforms } : {}),
      ...(domains.length ? { domains } : {}),
      ...(goTerms.length ? { goTerms } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(Object.keys(xrefs).length ? { xrefs } : {}),
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
  results?: { from: string; to: string | RawInactiveFields }[];
  /** Job-wide count of inactive UniProtKB targets; absent when there are none. */
  obsoleteCount?: number;
  failedIds?: string[];
};

/** The target accession of an ID-mapping row: the generic endpoint names it, the uniprotkb one embeds the entry. */
function targetAccession(to: string | RawInactiveFields): string {
  return typeof to === 'string' ? to : to.primaryAccession;
}

/** Key of one ID-mapping row, matching the generic and uniprotkb results pages. */
function mappingKey(from: string, to: string): string {
  return `${from}\n${to}`;
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

function normalizeFeature(raw: RawFeature): Feature {
  return {
    type: raw.type,
    ...(raw.description ? { description: raw.description } : {}),
    location: {
      ...(raw.location?.start?.value != null ? { start: raw.location.start.value } : {}),
      ...(raw.location?.end?.value != null ? { end: raw.location.end.value } : {}),
    },
    ...(raw.featureId ? { featureId: raw.featureId } : {}),
  };
}

function normalizeVariant(raw: RawFeature): Variant {
  const original = raw.alternativeSequence?.originalSequence;
  const variation = raw.alternativeSequence?.alternativeSequences?.[0];
  return {
    ...(raw.description ? { description: raw.description } : {}),
    location: {
      ...(raw.location?.start?.value != null ? { start: raw.location.start.value } : {}),
      ...(raw.location?.end?.value != null ? { end: raw.location.end.value } : {}),
    },
    ...(original ? { original } : {}),
    ...(variation ? { variation } : {}),
    ...(raw.featureId ? { featureId: raw.featureId } : {}),
  };
}

function normalizeProteome(raw: RawProteome): Proteome {
  const busco = raw.proteomeCompletenessReport?.buscoReport;
  return {
    upid: raw.id,
    proteomeType: raw.proteomeType,
    organism: {
      scientificName: raw.taxonomy?.scientificName ?? 'unknown',
      ...(raw.taxonomy?.commonName ? { commonName: raw.taxonomy.commonName } : {}),
      taxonId: raw.taxonomy?.taxonId ?? 0,
      ...(raw.taxonomy?.mnemonic ? { mnemonic: raw.taxonomy.mnemonic } : {}),
    },
    proteinCount: raw.proteinCount ?? 0,
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
