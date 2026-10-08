/**
 * The retrieval pipeline. Every read path (ctx_search and anything else that
 * needs evidence) funnels through `retrieve`, which is the only place that
 * composes temporal parsing, the FTS5 query, provenance-joined hits, quality
 * scoring, contradiction detection, and the retrieval cache. Ranking therefore
 * exists exactly once, so two read paths cannot disagree about what "best" means.
 *
 * Caller input is untrusted and this function is total. The one step that can
 * reject it — parseTemporal — is contained here, and a rejected window becomes an
 * empty, hinted result rather than an exception escaping into a tool handler.
 */

import { ContentStore, type SearchOptions } from './store.js'
import type { SearchHit } from './types.js'
import { RetrievalCache, cacheKey } from './cache.js'
import { scoreRetrieval, type QualityInput, type QualityScore } from './quality.js'
import { detectContradictions, type Contradiction, type EvidenceClaim } from './contradiction.js'
import { parseTemporal, recencyScore, type TemporalFilter } from './temporal.js'
import { fitToBudget, measureContext } from './budget.js'
import type { ContextBudgetConfig, SearchConfig } from './config.js'

export interface RetrievalDeps {
  readonly store: ContentStore
  readonly cache: RetrievalCache
  /**
   * Carried so callers wire one dep bag. The budget config allocates the host's
   * context across named sections and expresses no per-result ceiling, so the
   * ceiling below stays the contract's own rather than being read from here.
   */
  readonly budget: ContextBudgetConfig
  /** Likewise: the request carries its own limit and snippet budget. */
  readonly search: SearchConfig
  /** Injected clock; defaults to Date.now. Tests pass a fixed value. */
  readonly now?: () => number
}

export interface RetrievalRequest {
  readonly query: string
  readonly limit: number
  readonly source?: string
  readonly sort?: 'relevance' | 'timeline'
  readonly snippetChars?: number
  readonly temporal?: 'any' | 'latest' | 'historical'
  readonly before?: unknown
  readonly after?: unknown
  readonly sessionId?: string
  /** Skip the cache entirely (diagnostics). */
  readonly noCache?: boolean
}

export interface RetrievalCacheReport {
  readonly enabled: boolean
  readonly hit: boolean
  readonly key: string
  readonly stored: boolean
}

export interface RetrievalResult {
  readonly query: string
  readonly matches: readonly SearchHit[]
  readonly quality: QualityScore
  readonly contradictions: readonly Contradiction[]
  readonly temporal: TemporalFilter
  readonly cache: RetrievalCacheReport
  readonly hints: readonly string[]
}

/**
 * Freshness decays with a one-week half-life. The retention ladder runs from
 * ephemeral (hours) through session and project up to persistent (years), and a
 * week sits near the geometric middle of it: evidence refreshed on a normal
 * session cadence keeps freshness ≈ 1.0, while content untouched for a full
 * project retention period has decayed by ~2^(30/7) ≈ 70x — enough to rank below
 * fresher evidence without becoming unreachable. A shorter half-life would let a
 * same-day but irrelevant hit outrank persistent knowledge; a longer one would
 * make `latest` and `historical` indistinguishable by freshness.
 */
export const FRESHNESS_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * One retrieval payload's whole measured context. The budget config splits the
 * host's context across sections and says nothing about a single tool result, so
 * this is the contract ceiling for one payload, and it is what keeps a huge
 * `limit` from producing a payload the model cannot hold.
 */
const MAX_RESULT_CONTEXT = 262_144

/** Hints are the actionable part of a payload, so they are capped hard. */
const MAX_HINTS = 3
const MAX_HINT_CHARS = 160

/**
 * Contradiction detection compares claims pairwise, so its cost grows with the
 * square of the claim count. Scoring only the first 20 hits keeps a 50-hit
 * retrieval linear in the hit count while still covering everything the ranking
 * put on top: the rest are ranked, not cross-examined.
 */
const MAX_CLAIMS = 20

/** The detector's own ceiling on how many conflicts it reports back. */
const MAX_CONTRADICTIONS = 10

/**
 * The echoed query is the only unbounded caller-controlled string in the payload.
 * Clamping it up front means the size guard below never has to shrink the query
 * itself and only ever trades hints and matches, which is the order the contract
 * fixes. The search still runs against the full string the caller sent.
 */
const MAX_QUERY_CHARS = 4096

/** Fields the temporal parser can blame, in the order it blames them. */
const TEMPORAL_FIELDS = ['temporal', 'before', 'after', 'sessionId'] as const

/** One line, no longer than `max`, with an ellipsis marking the cut. */
function clampLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 3))}...`
}

function clampEcho(query: string): string {
  return query.length <= MAX_QUERY_CHARS ? query : query.slice(0, MAX_QUERY_CHARS)
}

/**
 * The cache owns its enabled flag: a cache built disabled reports a miss and
 * refuses writes, so anything other than an explicit `false` is treated as
 * usable. A cache that does not advertise the flag must not silently turn
 * retrieval caching off, and a flag that is present but wrong cannot throw here.
 */
function cacheUsable(cache: RetrievalCache): boolean {
  return (cache as unknown as { enabled?: unknown }).enabled !== false
}

/**
 * A cache read that degrades to a miss. The payload is untrusted data written by
 * an earlier process, so it is validated against the result shape before it is
 * allowed to answer a request, and a damaged row costs nothing.
 */
function readCache(cache: RetrievalCache, key: string): RetrievalResult | undefined {
  try {
    const found = cache.get<RetrievalResult>(key)
    return found.hit && isRetrievalResult(found.value) ? found.value : undefined
  } catch {
    return undefined
  }
}

function writeCache(cache: RetrievalCache, key: string, value: RetrievalResult, corpusVersion: number): boolean {
  try {
    return cache.set(key, value, corpusVersion)
  } catch {
    return false
  }
}

function isRetrievalResult(value: unknown): value is RetrievalResult {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<RetrievalResult>
  return (
    typeof candidate.query === 'string' &&
    Array.isArray(candidate.matches) &&
    Array.isArray(candidate.contradictions) &&
    Array.isArray(candidate.hints) &&
    candidate.quality !== null && typeof candidate.quality === 'object' &&
    candidate.temporal !== null && typeof candidate.temporal === 'object'
  )
}

/**
 * parseTemporal names the field it rejected, which is the authoritative answer;
 * the request's own field order is the fallback for an error that arrives as a
 * bare string. Either way the reason names a field and stays one bounded line.
 */
function temporalFailureHint(error: unknown, request: RetrievalRequest): string {
  const message = error instanceof Error ? error.message : String(error)
  const blamed = TEMPORAL_FIELDS.find((field) => message.includes(field))
  const field = blamed ?? TEMPORAL_FIELDS.find((name) => request[name] !== undefined) ?? 'temporal'
  return clampLine(`temporal filter rejected (${field}): ${message}`, MAX_HINT_CHARS)
}

/**
 * The quality input for a hit set. An empty hit set flows through the same shape
 * and produces the all-zero score from scoreRetrieval, so there is no second,
 * hand-written notion of what "no evidence" is worth.
 */
function qualityInputOf(
  hits: readonly SearchHit[],
  contradictions: readonly Contradiction[],
  coverageTarget: number,
  now: number,
): QualityInput {
  return {
    relevance: hits.map((hit) => hit.score),
    freshness: hits.map((hit) => recencyScore(hit.updatedAt, now, FRESHNESS_HALF_LIFE_MS)),
    distinctSources: new Set(hits.map((hit) => hit.source)).size,
    totalHits: hits.length,
    coverageTarget,
    contradictionPenalty: Math.min(1, contradictions.length / Math.max(1, hits.length)),
  }
}

/**
 * Hints tell the caller what to do next, so only actionable conditions earn one:
 * where to expand, what conflicts, and how the ordering reads. A clean
 * relevance-ranked retrieval gets the expand nudge and nothing else.
 */
function buildHints(
  filter: TemporalFilter,
  hits: readonly SearchHit[],
  contradictions: readonly Contradiction[],
): string[] {
  const hints: string[] = []
  if (hits.length > 0) {
    hints.push(clampLine(`expand ${hits[0].evidenceId} to read the whole chunk and its neighbours`, MAX_HINT_CHARS))
  }
  if (contradictions.length > 0) {
    const conflict = contradictions[0]
    hints.push(clampLine(
      `contradictory evidence: ${conflict.evidenceA.evidenceId} disagrees with ${conflict.evidenceB.evidenceId}; verify which value is current`,
      MAX_HINT_CHARS,
    ))
  }
  if (filter.mode === 'historical') {
    hints.push(clampLine('historical order: the oldest matching chunk comes first', MAX_HINT_CHARS))
  }
  return hints.slice(0, MAX_HINTS)
}

/**
 * Fail-closed size guard.
 *
 * Order is fixed and each step is justified by what it costs: hints go first
 * because they are derived commentary regenerable from the same hits, then the
 * matches are fitted with the same `fitToBudget` the rest of the plugin uses, so
 * this guard cannot grow a second, subtly different opinion about how much
 * evidence fits. `quality` is never touched — it describes the hit set the
 * ranking actually produced, and shrinking it would report a worse retrieval
 * than the one that happened.
 *
 * `fitToBudget` keeps a prefix, which is what a ranked result wants: the
 * highest-ranked hits survive and the tail is what goes.
 */
function applyBudgetGuard(result: RetrievalResult): RetrievalResult {
  if (measureContext(result) <= MAX_RESULT_CONTEXT) return result
  const withoutHints: RetrievalResult = { ...result, hints: [] }
  if (measureContext(withoutHints) <= MAX_RESULT_CONTEXT) return withoutHints
  const sized = withoutHints.matches.map((hit) => ({ hit, chars: measureContext(hit) }))
  const ceiling = MAX_RESULT_CONTEXT - measureContext({ ...withoutHints, matches: [] })
  const kept = fitToBudget(sized, Math.max(0, ceiling)).map((entry) => entry.hit)
  return { ...withoutHints, matches: kept }
}

/**
 * The temporal filter as a cache-key fragment, as a record because the cache key
 * hashes a canonical JSON map. Only bounds that are present are written — never
 * `undefined` where a bound is absent — so two requests meaning the same window
 * produce the same fragment and object-key iteration order cannot leak into the
 * key.
 */
function serialiseFilter(filter: TemporalFilter): Record<string, unknown> {
  const record: Record<string, unknown> = { mode: filter.mode }
  if (filter.after !== undefined) record.after = filter.after
  if (filter.before !== undefined) record.before = filter.before
  if (filter.sessionId !== undefined) record.session = filter.sessionId
  return record
}

/** One retrieval through the whole pipeline. Never throws for caller input. */
export function retrieve(deps: RetrievalDeps, request: RetrievalRequest): RetrievalResult {
  const now = deps.now === undefined ? Date.now() : deps.now()

  let filter: TemporalFilter
  try {
    filter = parseTemporal({
      temporal: request.temporal,
      before: request.before,
      after: request.after,
      sessionId: request.sessionId,
    })
  } catch (error) {
    // Containing the rejection here is what keeps the rest of the pipeline
    // total: an unparseable window is a normal request, not an incident. The
    // cache is deliberately left unread so a bad request can neither be answered
    // from a shared entry nor write one, and the reported mode is neutral
    // because no filter was applied.
    return {
      query: clampEcho(request.query),
      matches: [],
      quality: scoreRetrieval(qualityInputOf([], [], request.limit, now)),
      contradictions: [],
      temporal: { mode: 'any' },
      cache: { enabled: cacheUsable(deps.cache), hit: false, key: '', stored: false },
      hints: [temporalFailureHint(error, request)],
    }
  }

  const usable = cacheUsable(deps.cache)
  const corpusVersion = deps.store.corpusVersion()
  const key = usable && request.noCache !== true
    ? cacheKey({
        query: request.query,
        corpusVersion,
        source: request.source,
        sort: request.sort,
        limit: request.limit,
        ranking: 'bm25',
        filters: serialiseFilter(filter),
      })
    : ''

  if (key !== '') {
    const cached = readCache(deps.cache, key)
    if (cached !== undefined) {
      // The payload was stored against this corpus version, so its quality and
      // contradiction blocks were computed over exactly these hits; recomputing
      // them could only reproduce the same numbers at real cost.
      return { ...cached, cache: { enabled: usable, hit: true, key, stored: false } }
    }
  }

  const options: SearchOptions = {
    limit: request.limit,
    source: request.source,
    sort: request.sort,
    snippetChars: request.snippetChars,
    updatedAfter: filter.after,
    updatedBefore: filter.before,
    sessionId: filter.sessionId,
    temporal: filter.mode === 'any' ? undefined : filter.mode,
  }
  const hits = deps.store.search(request.query, options)

  const claims: EvidenceClaim[] = hits
    .slice(0, MAX_CLAIMS)
    .map((hit) => ({ evidenceId: hit.evidenceId, source: hit.source, snippet: hit.snippet }))
  const contradictions = detectContradictions(claims, MAX_CONTRADICTIONS)

  const bounded = applyBudgetGuard({
    query: clampEcho(request.query),
    matches: hits,
    quality: scoreRetrieval(qualityInputOf(hits, contradictions, request.limit, now)),
    contradictions,
    temporal: filter,
    cache: { enabled: usable, hit: false, key, stored: false },
    hints: buildHints(filter, hits, contradictions),
  })

  const stored = key === '' ? false : writeCache(deps.cache, key, bounded, corpusVersion)
  return { ...bounded, cache: { enabled: usable, hit: false, key, stored } }
}
