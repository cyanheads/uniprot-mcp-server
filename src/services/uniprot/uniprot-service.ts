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
  IdMappingFromDb,
  IdMappingResult,
  IdMappingToDb,
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
  Taxon,
  TaxonChild,
  Variant,
} from '@/services/uniprot/types.js';
import {
  DEFAULT_ENTRY_FIELDS,
  DEFAULT_SEARCH_FIELDS,
  MANDATORY_ENTRY_FIELDS,
  MANDATORY_SEARCH_FIELDS,
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
 */
const LEAKY_ERROR_DATA_KEYS = [
  'responseBody',
  'statusCode',
  'requestId',
  'operation',
  'errorSource',
  'statusText',
] as const;

/**
 * Re-throw a raw framework HTTP `McpError` as a clean, typed domain error so
 * upstream internals never reach the client. Detection is STRUCTURAL — any
 * leaky `data` key (never a message substring) — preserving the framework's
 * status-mapped code while dropping the leaky `data` and keeping the original
 * as `cause` for server-side logs. Errors without leaky `data` (the service's
 * own `notFound`/`serviceUnavailable`, a plain parse error, an abort) pass
 * through untouched.
 *
 * `label` describes the operation for the clean message (e.g. "UniProtKB
 * search"); the code already conveys the failure class (rate limit, upstream
 * 5xx, timeout) to the agent.
 */
function sanitizeUpstreamError(err: unknown, label: string): never {
  if (
    err instanceof McpError &&
    err.data &&
    LEAKY_ERROR_DATA_KEYS.some((k) => k in (err.data as Record<string, unknown>))
  ) {
    throw new McpError(err.code, `${label} failed upstream (${err.code}).`, undefined, {
      cause: err,
    });
  }
  throw err;
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

type RawEntry = {
  primaryAccession: string;
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

  private getJson<T>(
    url: string,
    operation: string,
    ctx: Context,
  ): Promise<{ data: T; response: Response }> {
    const reqCtx = this.reqCtx(operation, ctx);
    return this.withRetry(operation, ctx, async () => {
      const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, { signal: ctx.signal });
      const text = await response.text();
      this.guardHtml(text);
      return { data: JSON.parse(text) as T, response };
    }).catch((err) => sanitizeUpstreamError(err, operation));
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
   * `cursor` walks forward. Returns hits + `totalResults` (from `x-total-results`).
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
    );

    const totalResults = Number(
      response.headers.get('x-total-results') ?? data.results?.length ?? 0,
    );
    const results = (data.results ?? []).map((e) => this.normalizeHit(e));
    const facets = data.facets?.length ? data.facets.map(normalizeFacet) : undefined;
    const cursor = this.parseNextCursor(response);

    return { results, totalResults, ...(cursor ? { cursor } : {}), ...(facets ? { facets } : {}) };
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
   * UniProtKB batch search (`query=accession:(A OR B OR …)`). Returns the parsed
   * entries; the caller cross-references against the requested set to populate
   * `failed[]`.
   */
  async getEntries(
    accessions: string[],
    fields: string | undefined,
    ctx: Context,
  ): Promise<Entry[]> {
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
    return (data.results ?? []).map((e) => this.normalizeEntry(e));
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
        return { status: 'finished', results: await this.mappingResults(jobId, ctx) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { status: 'running', ticket: jobId };
  }

  /** Fetch results for a previously-submitted ID-mapping ticket (resume path). */
  async resumeMapping(ticket: string, ctx: Context): Promise<IdMappingResult> {
    const status = await this.mappingStatus(ticket, ctx);
    if (status !== 'FINISHED') return { status: 'running', ticket };
    return { status: 'finished', results: await this.mappingResults(ticket, ctx) };
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

  private async mappingStatus(jobId: string, ctx: Context): Promise<string> {
    const { data } = await this.getJson<{ jobStatus?: string; results?: unknown[] }>(
      `${this.baseUrl}/idmapping/status/${jobId}`,
      'uniprot.mappingStatus',
      ctx,
    );
    // When a job is finished the status endpoint may 303-redirect straight to results,
    // in which case the body already carries `results` and no `jobStatus`.
    if (data.jobStatus) return data.jobStatus;
    if (data.results) return 'FINISHED';
    return 'RUNNING';
  }

  private async mappingResults(
    jobId: string,
    ctx: Context,
  ): Promise<{ from: string; to: string }[]> {
    const collected: { from: string; to: string }[] = [];
    let url: string | undefined = `${this.baseUrl}/idmapping/results/${jobId}?format=json&size=500`;

    while (url) {
      const { data, response }: { data: RawMappingResults; response: Response } =
        await this.getJson<RawMappingResults>(url, 'uniprot.mappingResults', ctx);
      for (const row of data.results ?? []) {
        collected.push({
          from: row.from,
          to: typeof row.to === 'string' ? row.to : row.to.primaryAccession,
        });
      }
      url = this.parseNextLink(response);
      if (ctx.signal.aborted) break;
    }
    return collected;
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
    if (opts.query) queryParts.push(`(${opts.query})`);
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

  /** Fetch a taxonomy record by NCBI taxon ID. */
  async getTaxonById(taxonId: number, ctx: Context): Promise<Taxon> {
    const url = `${this.baseUrl}/taxonomy/${taxonId}?format=json`;
    try {
      const { data } = await this.getJson<RawTaxon>(url, 'uniprot.getTaxonById', ctx);
      return normalizeTaxon(data);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No taxonomy record for taxon ID ${taxonId}.`, { taxonId });
      }
      throw err;
    }
  }

  /** Resolve a taxonomy record by scientific name via the taxonomy search endpoint. */
  async getTaxonByName(name: string, ctx: Context): Promise<Taxon> {
    const url = new URL(`${this.baseUrl}/taxonomy/search`);
    url.searchParams.set('query', `scientific:"${name}"`);
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

  /** Fetch immediate children of a taxon (a separate search — not inline on the record). */
  async getChildren(taxonId: number, ctx: Context): Promise<TaxonChild[]> {
    const url = new URL(`${this.baseUrl}/taxonomy/search`);
    url.searchParams.set('query', `parent:${taxonId}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('size', '100');
    const { data } = await this.getJson<{ results?: RawTaxon[] }>(
      url.toString(),
      'uniprot.getChildren',
      ctx,
    );
    return (data.results ?? []).map((t) => ({
      taxonId: t.taxonId,
      scientificName: t.scientificName,
      rank: t.rank ?? 'no rank',
    }));
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
   */
  async getFasta(
    accession: string,
    includeIsoforms: boolean,
    ctx: Context,
  ): Promise<[SequenceRecord, ...SequenceRecord[]]> {
    const url = includeIsoforms
      ? new URL(`${this.baseUrl}/uniprotkb/search`)
      : new URL(`${this.baseUrl}/uniprotkb/${accession}.fasta`);
    if (includeIsoforms) {
      url.searchParams.set('query', `accession:${accession}`);
      url.searchParams.set('format', 'fasta');
      url.searchParams.set('includeIsoform', 'true');
    }

    const reqCtx = this.reqCtx('uniprot.getFasta', ctx);
    const text = await this.withRetry('uniprot.getFasta', ctx, async () => {
      const response = await fetchWithTimeout(url.toString(), this.timeoutMs, reqCtx, {
        signal: ctx.signal,
      });
      const body = await response.text();
      this.guardHtml(body);
      return body;
    }).catch((err) => {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No sequence found for accession ${accession}.`, { accession });
      }
      return sanitizeUpstreamError(err, 'uniprot.getFasta');
    });

    const [canonical, ...rest] = parseFasta(text);
    if (!canonical) {
      throw notFound(`No sequence found for accession ${accession}.`, { accession });
    }
    return [canonical, ...rest];
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
  results?: { from: string; to: string | { primaryAccession: string } }[];
};

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
