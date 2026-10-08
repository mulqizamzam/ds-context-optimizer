/**
 * Deterministic retrieval quality, attached to every retrieval.
 *
 * This is NOT a probability that the answer is true. It is a documented,
 * reproducible function of measurable inputs, so a reader can recompute every
 * number below by hand from the hit list — which is the only property that
 * makes the figure auditable at all. Two retrievals with the same measurable
 * inputs always score identically; nothing here consults a model, a clock, a
 * network, or a random source.
 *
 * Fake precision is the failure mode this module exists to avoid: every
 * component is rounded to 2 decimal places, and the weighted mean is built from
 * those rounded components so the published score is internally consistent
 * instead of carrying a hidden third decimal.
 *
 * FORMULA (every component in [0,1], rounded to 2 dp):
 *
 *   relevance  = mean(hit / top) over hits whose score is finite and > 0,
 *                where top = max such score. 0 when top <= 0 or there are no
 *                hits. A score that is non-finite or negative is not on the
 *                scale at all and contributes 0 rather than poisoning the mean.
 *   freshness  = mean(clamp01(freshness)); a non-finite entry counts as 0.
 *                0 with no hits.
 *   coverage   = min(1, distinctSources / coverageTarget). 0 when
 *                coverageTarget <= 0 or non-finite, or totalHits <= 0.
 *   diversity  = min(1, distinctSources / totalHits). 0 when totalHits <= 0.
 *                Duplicate chunks dominating a result therefore LOWER the
 *                score, which is the documented behaviour.
 *   penalty    = clamp01(contradictionPenalty); a non-finite value counts as 0.
 *   overall    = max(0, round2(clamp01(0.45*relevance + 0.25*freshness
 *                                       + 0.20*coverage + 0.10*diversity)
 *                          - 0.5 * penalty))
 */

export interface QualityInput {
  /** Relevance per returned hit, any non-negative scale (e.g. BM25 scores). */
  readonly relevance: readonly number[]
  /** Freshness per hit, already in [0, 1]. */
  readonly freshness: readonly number[]
  /** Distinct sources among the returned hits. */
  readonly distinctSources: number
  /** Total hits returned. */
  readonly totalHits: number
  /** Contradiction pressure already computed elsewhere, in [0, 1]. */
  readonly contradictionPenalty: number
  /** How many distinct sources the caller expected at best. */
  readonly coverageTarget: number
}

export interface QualityScore {
  readonly relevance: number
  readonly freshness: number
  readonly coverage: number
  readonly diversity: number
  readonly contradictionPenalty: number
  readonly overall: number
}

/**
 * Weights of the quality mixture. They sum to exactly 1 so the weighted mean
 * of four in-range components is itself in range, and the mean is what a
 * caller recomputing by hand will get.
 */
export const QUALITY_WEIGHTS: Readonly<{
  relevance: number; freshness: number; coverage: number; diversity: number
}> = {
  relevance: 0.45,
  freshness: 0.25,
  coverage: 0.2,
  diversity: 0.1,
}

export function scoreRetrieval(input: QualityInput): QualityScore {
  const relevance = relevanceOf(input.relevance)
  const freshness = freshnessOf(input.freshness)
  const coverage = coverageOf(input.distinctSources, input.totalHits, input.coverageTarget)
  const diversity = diversityOf(input.distinctSources, input.totalHits)
  const contradictionPenalty = clamp01OrZero(input.contradictionPenalty)

  // Built from the ROUNDED components so the published score reproduces itself:
  // a reader adding the six numbers above gets `overall` without a hidden
  // residual. `max(0, ...)` keeps a heavy penalty from pushing the figure
  // negative, which would be meaningless as a quality.
  const weighted =
    QUALITY_WEIGHTS.relevance * relevance
    + QUALITY_WEIGHTS.freshness * freshness
    + QUALITY_WEIGHTS.coverage * coverage
    + QUALITY_WEIGHTS.diversity * diversity
  const overall = round2(Math.max(0, clamp01OrZero(weighted) - 0.5 * contradictionPenalty))

  return { relevance, freshness, coverage, diversity, contradictionPenalty, overall }
}

/**
 * One bounded line describing a score, safe to hand to a model.
 *
 * The values are sanitised and clamped before formatting, so even a
 * hand-assembled `QualityScore` cannot emit `NaN`, a control character, or an
 * out-of-range figure. The layout is fixed-width in the names only; the whole
 * line stays under 120 characters for any score.
 */
export function qualitySummary(score: QualityScore): string {
  const show = (value: number): string => clamp01OrZero(value).toFixed(2)
  return (
    `quality relevance=${show(score.relevance)} `
    + `freshness=${show(score.freshness)} `
    + `coverage=${show(score.coverage)} `
    + `diversity=${show(score.diversity)} `
    + `penalty=${show(score.contradictionPenalty)} `
    + `overall=${show(score.overall)}`
  )
}

/**
 * Mean of the per-hit relevance values rescaled so the top hit is 1.0.
 *
 * Scores arrive on whatever scale the ranker used (BM25 is unbounded above), so
 * the raw mean is meaningless across engines; dividing by the top hit puts every
 * retrieval on the same [0,1] footing. A zero or unusable top has nothing to
 * divide by and yields 0 rather than `Infinity` or `NaN`.
 */
function relevanceOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  let top = 0
  for (const value of values) {
    if (Number.isFinite(value) && value > top) top = value
  }
  if (top <= 0) return 0
  let sum = 0
  for (const value of values) {
    sum += Number.isFinite(value) && value > 0 ? value / top : 0
  }
  return round2(sum / values.length)
}

/** Mean freshness, clamped per hit. An unusable entry counts as 0, not as 1. */
function freshnessOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) {
    sum += clamp01OrZero(value)
  }
  return round2(sum / values.length)
}

/**
 * How much of the expected source spread the retrieval actually reached.
 *
 * Saturating at 1 rather than scaling past it is deliberate: six sources
 * against a target of four is "target met", not a better-than-perfect result.
 * A caller that asked for no sources has expressed no expectation, so there is
 * nothing to cover and the component is 0 instead of dividing by zero.
 */
function coverageOf(distinctSources: number, totalHits: number, coverageTarget: number): number {
  if (!Number.isFinite(totalHits) || totalHits <= 0) return 0
  if (!Number.isFinite(coverageTarget) || coverageTarget <= 0) return 0
  const sources = Number.isFinite(distinctSources) ? Math.max(0, distinctSources) : 0
  return round2(Math.min(1, sources / coverageTarget))
}

/**
 * Share of the hits that are distinct sources.
 *
 * A result of four chunks from one source scores 0.25 and one from four sources
 * scores 1.0. That asymmetry is the point: duplicate chunks dominating a result
 * is a retrieval failure even when every chunk is relevant, and a score that
 * ignored it would call the two cases equal.
 */
function diversityOf(distinctSources: number, totalHits: number): number {
  if (!Number.isFinite(totalHits) || totalHits <= 0) return 0
  const sources = Number.isFinite(distinctSources) ? Math.max(0, distinctSources) : 0
  return round2(Math.min(1, sources / totalHits))
}

/** Clamp to [0,1]; a non-finite value is not on the scale and becomes 0. */
function clamp01OrZero(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Round to 2 decimal places, collapsing `-0`.
 *
 * `Math.round(-0.0001 * 100) / 100` is `-0`, which serialises as "-0" and reads
 * as a negative component in a log line; the components are documented as
 * non-negative, so the sign is dropped.
 */
function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100
  return rounded === 0 ? 0 : rounded
}
