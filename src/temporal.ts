/**
 * Temporal context: parse the caller's freshness intent into a filter, apply
 * that filter, and provide the recency arithmetic ranking consumes.
 *
 * Old evidence must not rank as if it were current, so freshness is a
 * first-class input rather than an accident of result order. Everything here is
 * deterministic: every clock reading is a parameter (`now` is supplied by the
 * caller), never `Date.now()`, so the same evidence and the same `now` always
 * produce the same answer. That is also what makes the decay testable — a
 * test that read the wall clock could not assert an exact half-life.
 */

/** Which side of "now" a temporal query wants. */
export type TemporalMode = 'any' | 'latest' | 'historical'

/**
 * Raised for caller-supplied temporal arguments that cannot be interpreted.
 *
 * The tool layer turns this into a bounded error result instead of a crash: a
 * bad timestamp is a caller mistake to report, not a state change. It is a
 * named class rather than a bare `Error` so the handler can tell a rejected
 * argument apart from an internal failure without string-matching messages.
 */
export class TemporalFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemporalFilterError'
  }
}

/**
 * A validated temporal filter.
 *
 * Absent bounds are absent, not present-and-`undefined`: two filters built
 * from an ISO timestamp and from an epoch number must be deeply equal, and a
 * key holding `undefined` would make `deepEqual` say they differ.
 */
export interface TemporalFilter {
  readonly mode: TemporalMode
  /** Upper bound on `updatedAt`, inclusive. Newer items are excluded. */
  readonly before?: number
  /** Lower bound on `updatedAt`, inclusive. Older items are excluded. */
  readonly after?: number
  /** When present, only items from exactly this session survive. */
  readonly sessionId?: string
}

/** Raw, unvalidated tool arguments. */
export interface TemporalArgs {
  readonly temporal?: unknown
  readonly before?: unknown
  readonly after?: unknown
  readonly sessionId?: unknown
}

const MODES: readonly TemporalMode[] = ['any', 'latest', 'historical']

function isTemporalMode(value: unknown): value is TemporalMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/**
 * Render a rejected value into an error message.
 *
 * The message has to name the field and the value, because "invalid temporal
 * argument" tells the caller nothing about which of four fields was wrong and a
 * re-ask that repeats the same mistake wastes a whole model turn. Strings are
 * quoted so an empty string is visibly different from a missing one.
 */
function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`
  try {
    // JSON rather than String(), which collapses every object to the same
    // useless '[object Object]'.
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * Validate raw tool arguments into a `TemporalFilter`.
 *
 * Every rejection is a `TemporalFilterError` rather than a silent fallback,
 * because a filter that quietly means something other than what the caller
 * asked for is worse than no answer: the model would be shown a plausible
 * window over the wrong evidence. `undefined` means "the caller did not send
 * this field"; anything else that is not the documented type is an error,
 * `null` included — that is how a JSON argument with a hole in it arrives.
 */
export function parseTemporal(args: TemporalArgs): TemporalFilter {
  const mode = parseMode(args.temporal)
  const before = parseBound('before', args.before)
  const after = parseBound('after', args.after)
  if (before !== undefined && after !== undefined && after > before) {
    throw new TemporalFilterError(
      `after (${after}) is later than before (${before}): the interval is empty`,
    )
  }
  const sessionId = parseSessionId(args.sessionId)

  const filter: { mode: TemporalMode; before?: number; after?: number; sessionId?: string } = {
    mode,
  }
  if (before !== undefined) filter.before = before
  if (after !== undefined) filter.after = after
  if (sessionId !== undefined) filter.sessionId = sessionId
  return filter
}

function parseMode(value: unknown): TemporalMode {
  if (value === undefined) return 'any'
  if (isTemporalMode(value)) return value
  throw new TemporalFilterError(
    `temporal: expected 'any' | 'latest' | 'historical', received ${show(value)}`,
  )
}

/**
 * Accept a finite epoch-ms number or an ISO-8601 string, and nothing else.
 *
 * Relative phrases such as 'last week' or 'yesterday' are deliberately NOT
 * parsed: a phrase resolves against a clock the tool does not own, so the
 * caller must hand over a timestamp. Accepting them would put a second,
 * silently different clock in the path — one that moves between the moment the
 * model forms the request and the moment evidence is read — and two runs of the
 * same query would then disagree about what "last week" covers.
 */
function parseBound(field: 'before' | 'after', value: unknown): number | undefined {
  if (value === undefined) return undefined
  const invalid = () =>
    new TemporalFilterError(
      `${field}: expected a finite epoch-ms number or an ISO-8601 timestamp, received ${show(value)}`,
    )
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid()
    return value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw invalid()
    return parsed
  }
  throw invalid()
}

function parseSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TemporalFilterError(`sessionId: expected a non-empty string, received ${show(value)}`)
  }
  return value
}

/**
 * Apply a validated filter to evidence-like items.
 *
 * The bounds and the session id are applied in every mode, so a caller can
 * always narrow the window even inside `latest` and `historical`. The mode
 * then reduces the surviving set:
 *
 *  - `any` keeps everything that survived the bounds and the session filter.
 *  - `latest` keeps the single newest survivor, ties going to the earliest
 *    position in the input, so an identical tie always resolves identically.
 *  - `historical` keeps everything strictly older than the newest survivor —
 *    "what did we believe before the newest edit" — which is the only way a
 *    caller can see which evidence changed over time without re-deriving the
 *    newest item itself.
 *
 * The input is never mutated and the returned order is the input order: this
 * filter narrows, it does not rank. Ranking is the caller's business (see
 * `compareByRecency` and `recencyScore`); a filter that silently sorted would
 * make every composition downstream order-dependent on which helper ran first.
 */
export function applyTemporal<T extends { readonly updatedAt: number; readonly sessionId?: string }>(
  items: readonly T[],
  filter: TemporalFilter,
): T[] {
  const bounded = items.filter(
    (item) =>
      (filter.after === undefined || item.updatedAt >= filter.after) &&
      (filter.before === undefined || item.updatedAt <= filter.before) &&
      (filter.sessionId === undefined || item.sessionId === filter.sessionId),
  )

  if (filter.mode === 'latest') {
    // Strict `>` keeps the FIRST of a tie, matching `selectLatest`.
    let newest: T | undefined
    for (const item of bounded) {
      if (newest === undefined || item.updatedAt > newest.updatedAt) newest = item
    }
    return newest === undefined ? [] : [newest]
  }

  if (filter.mode === 'historical') {
    let newest: T | undefined
    for (const item of bounded) {
      if (newest === undefined || item.updatedAt > newest.updatedAt) newest = item
    }
    if (newest === undefined) return []
    const boundary = newest.updatedAt
    return bounded.filter((item) => item.updatedAt < boundary)
  }

  return bounded
}

/**
 * The newest item by `updatedAt`, or `undefined` for an empty list.
 *
 * Ties resolve to the first item in input order: with equal timestamps there is
 * no evidence that distinguishes them, so the answer must come from something
 * that does not change between runs — the caller's ordering — rather than from
 * whichever item happened to be visited last.
 *
 * `now` is accepted so a caller can pass one clock through the whole temporal
 * surface, and is deliberately not used to reject future-stamped items: a
 * record stamped ahead of `now` is still the newest evidence on hand, and
 * dropping it would make the answer depend on the caller's clock rather than on
 * the data.
 */
export function selectLatest<T extends { readonly updatedAt: number }>(
  items: readonly T[],
  now: number,
): T | undefined {
  let newest: T | undefined
  for (const item of items) {
    if (newest === undefined || item.updatedAt > newest.updatedAt) newest = item
  }
  return newest
}

/**
 * Items whose age exceeds `staleAfterMs`: everything the caller still counts as
 * current is dropped, leaving only historical evidence.
 *
 * The cutoff is strict — age equal to `staleAfterMs` is still current — because
 * the threshold reads "stale after this long", and an inclusive cutoff would
 * make an item stale at the exact boundary the caller named. The arithmetic is
 * total without extra guards: a non-finite `updatedAt` or `now` produces a NaN
 * age, and every comparison against NaN is false, so an unageable item is
 * dropped rather than guessed at.
 */
export function historicalOnly<T extends { updatedAt: number }>(
  items: readonly T[],
  now: number,
  staleAfterMs: number,
): T[] {
  return items.filter((item) => now - item.updatedAt > staleAfterMs)
}

/**
 * Recency in [0, 1]: 1 at or after `now`, halving every `halfLifeMs` of age.
 *
 * Exponential decay rather than a cliff, because evidence does not stop being
 * relevant the moment a threshold passes — it becomes worth less, smoothly.
 * The half-life is the caller's to choose (minutes for a live session log, days
 * for a design doc), which is why it is a parameter and not a constant here.
 *
 * The value is rounded to at most 4 decimal places: scores this small are
 * multiplied into ranking sums, and carrying 15 significant digits of a decay
 * curve into a displayed score implies a precision the input timestamps do not
 * have. A non-positive or non-finite half-life, or a non-finite timestamp,
 * yields 0 rather than NaN or a negative number, so a malformed record can
 * never poison an arithmetic ranking downstream.
 */
export function recencyScore(updatedAt: number, now: number, halfLifeMs: number): number {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return 0
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0
  const age = now - updatedAt
  if (age <= 0) return 1
  const raw = Math.pow(0.5, age / halfLifeMs)
  if (!Number.isFinite(raw)) return 0
  return Math.min(1, Math.round(raw * 10_000) / 10_000)
}

/**
 * Order newest first.
 *
 * Returns 0 for equal timestamps and relies on a stable sort for the tie, so
 * equal-timestamp items keep their input order instead of being shuffled by an
 * arbitrary tiebreak. A NaN difference — a non-finite timestamp that slipped
 * past validation — compares as equal rather than returning NaN: a comparator
 * that yields NaN makes the resulting order an artifact of the engine's
 * handling of incomparable elements, which is exactly the nondeterminism the
 * rest of this module exists to avoid.
 */
export function compareByRecency(a: { updatedAt: number }, b: { updatedAt: number }): number {
  const diff = b.updatedAt - a.updatedAt
  return Number.isNaN(diff) ? 0 : diff
}

/**
 * Whether `updatedAt` falls within `thresholdMs` of `now`.
 *
 * Inclusive at the boundary (`updatedAt === now - thresholdMs` is recent), so a
 * threshold of 0 means "this instant or later". The arithmetic is the whole
 * implementation: a non-finite threshold makes the subtraction NaN, every
 * comparison against NaN is false, and nothing is presented as current when the
 * caller could not say how wide "current" is.
 */
export function isRecent(updatedAt: number, now: number, thresholdMs: number): boolean {
  return updatedAt >= now - thresholdMs
}
