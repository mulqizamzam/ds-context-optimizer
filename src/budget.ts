/**
 * The one place a context budget is computed.
 *
 * Every generated payload in this plugin sizes itself through this module, so
 * the arithmetic lives here and nowhere else: two callers that each derive
 * their own section sizes drift apart the moment one of them rounds
 * differently, and the drift only ever surfaces as a payload that silently
 * overruns the window it was budgeted for. Nothing here reads the clock, the
 * filesystem, or the network, so the same budget and the same sections always
 * produce the same allocation — a payload stays reproducible from its inputs.
 */

/** Largest char count the integer arithmetic here still honours exactly. */
const MAX_CHAR_BUDGET = Number.MAX_SAFE_INTEGER

/** The families a payload's weights name, in the order the report prints them. */
type WeightField = 'recent' | 'task' | 'evidence' | 'metadata'

/**
 * How a payload prefers to split its usable characters across the four
 * families. A weight is a relative share, not a size: `{recent: 3, task: 1}`
 * and `{recent: 0.75, task: 0.25}` allocate identically.
 */
export interface BudgetWeights {
  readonly recent: number
  readonly task: number
  readonly evidence: number
  readonly metadata: number
}

/** What a caller knows about a budget before it is split. */
export interface ContextBudgetInput {
  readonly totalChars: number
  /** Characters held back from the split; clamped to `totalChars`. */
  readonly reserveChars: number
  readonly weights: BudgetWeights
}

/** The budget after clamping and normalisation, for callers that log or audit it. */
export interface BudgetReport {
  readonly totalChars: number
  readonly reserveChars: number
  readonly usableChars: number
  /** The weights as the caller supplied them, before any clamping. */
  readonly requestedWeights: BudgetWeights
  readonly normalizedWeights: Readonly<Record<'recent' | 'task' | 'evidence' | 'metadata', number>>
}

/**
 * Split a budget's usable characters across `sections`, in the order given.
 *
 * A section carries the weight of the family it names, and nothing otherwise,
 * so a payload that asks for `['recent', 'evidence']` has those two shares
 * renormalised against each other: the split fills the budget it was handed
 * instead of leaving the unnamed families' share unallocated, which is what
 * `sum(allocation) === usableChars` promises. A section naming no family
 * carries no weight, and when nothing in the list carries one — all-zero
 * weights, or a list of unnamed sections — every section takes an equal share,
 * because "no preference" still has to answer with numbers rather than with an
 * empty allocation the caller must then interpret.
 *
 * The split itself is integer floors plus the largest-remainder (Hamilton)
 * distribution of what the floors left behind, so no section can round its way
 * past the budget and no character goes unassigned. Duplicate section names are
 * collapsed to their first occurrence: a list assembled by concatenating the
 * parts of a payload would otherwise be charged for two shares while rendering
 * one.
 */
export function allocateContextBudget(
  budget: ContextBudgetInput,
  sections: readonly string[],
): Readonly<Record<string, number>> {
  const names = dedupe(sections)
  const { usableChars } = resolveBudget(budget)
  const allocation: Record<string, number> = {}

  // An empty section list has nothing to split and a zero budget splits into
  // nothing; both answer with the empty (or all-zero) allocation rather than
  // with an error, because a caller with a spent budget is not an error.
  if (names.length === 0 || usableChars === 0) {
    for (const name of names) defineOwn(allocation, name, 0)
    return allocation
  }

  const weights = names.map((name) => sectionWeight(name, budget.weights))
  const requested = weights.reduce((sum, value) => sum + value, 0)
  const shares = requested > 0 ? weights.map((value) => value / requested) : names.map(() => 1 / names.length)
  const exacts = shares.map((share) => usableChars * share)
  const counts = exacts.map((exact) => Math.floor(exact))
  distribute(counts, exacts, usableChars)

  for (const [index, name] of names.entries()) defineOwn(allocation, name, counts[index])
  return allocation
}

/**
 * The characters an allocation actually spends.
 *
 * A non-finite entry is skipped rather than summed: a hand-built or damaged
 * allocation carrying `NaN` would turn the total into `NaN`, and every
 * comparison made against it afterwards is false — which reads as "fits" to
 * code that tests `total <= budget`.
 */
export function allocationTotal(allocation: Readonly<Record<string, number>>): number {
  let total = 0
  for (const value of Object.values(allocation)) {
    if (Number.isFinite(value)) total += value
  }
  return total
}

/**
 * The leading run of `items` whose `chars` still fits `budgetChars`.
 *
 * The prefix is the point: a context payload is read in the order its sections
 * were declared, so cutting from the middle would change *what* the model sees
 * rather than how much. An item is therefore never clipped to fit, and an item
 * whose size cannot be used — non-finite, or negative because a caller
 * subtracted instead of measured — ends the run instead of being guessed at: an
 * unknown size is treated as exceeding the budget, which is the one direction
 * that cannot over-commit.
 */
export function fitToBudget<T extends { readonly chars: number }>(items: readonly T[], budgetChars: number): T[] {
  const budget = boundedChars(budgetChars)
  const kept: T[] = []
  if (budget === 0) return kept

  let used = 0
  for (const item of items) {
    const chars = item.chars
    if (!Number.isFinite(chars) || chars < 0) break
    if (used + chars > budget) break
    kept.push(item)
    used += chars
  }
  return kept
}

/**
 * How many characters `value` occupies once it is rendered.
 *
 * A bare string measures its own length: the payload a caller hands over *is*
 * the string, and charging it for the quotes of a serialisation nobody
 * performs would shrink every budget it is then compared against. Every other
 * value is measured as its canonical serial form — mappings with their keys
 * sorted at every level — so the answer cannot change with the order the keys
 * were written in. Inside that form a string is quoted the way JSON quotes it,
 * so a nested string costs its own length plus the two quotes.
 *
 * No method the value can define is ever called — not `toString`, `toJSON`, or
 * `valueOf` — so a value that lies about its size, or throws when asked, cannot
 * move this number. `undefined` measures 0; so do the other values with no
 * canonical text (symbols, functions), which are dropped from mappings and
 * stand in as `null` inside arrays, exactly as JSON treats them. A value that
 * contains itself is measured up to the cycle edge, which contributes nothing
 * rather than recursing until the stack overflows, so a corrupted payload
 * arriving from tool output degrades to a bounded number instead of an
 * exception out of a tool handler.
 */
export function measureContext(value: unknown): number {
  if (typeof value === 'string') return value.length
  return (canonicalText(value, new Set()) ?? '').length
}

/** The budget after clamping and normalisation, for callers that log or audit it. */
export function budgetReport(budget: ContextBudgetInput): BudgetReport {
  const resolved = resolveBudget(budget)
  return {
    totalChars: resolved.totalChars,
    reserveChars: resolved.reserveChars,
    usableChars: resolved.usableChars,
    // A report is a snapshot: the requested weights are copied, so a caller
    // that retunes them afterwards cannot retroactively change what was
    // already printed.
    requestedWeights: { ...budget.weights },
    normalizedWeights: normalizeWeights(budget.weights),
  }
}

/** The budget reduced to the three numbers every other function here uses. */
interface ResolvedBudget {
  readonly totalChars: number
  readonly reserveChars: number
  /** `totalChars - reserveChars`, never negative because the reserve is clamped. */
  readonly usableChars: number
}

function resolveBudget(budget: ContextBudgetInput): ResolvedBudget {
  const totalChars = boundedChars(budget.totalChars)
  // Clamping the reserve to the total is what keeps `usableChars` from going
  // negative when a caller reserves more than it has: the reserve is a promise
  // to hold characters back, not a licence to spend characters that are absent.
  const reserveChars = Math.min(boundedChars(budget.reserveChars), totalChars)
  return { totalChars, reserveChars, usableChars: totalChars - reserveChars }
}

/**
 * Coerce one caller-supplied char count into this module's working domain: a
 * non-negative integer at or below {@link MAX_CHAR_BUDGET}.
 *
 * Non-finite input becomes 0 rather than passing through. `NaN` would make
 * every downstream comparison false, so an item would look simultaneously too
 * large to fit and too small to reject; `Infinity` is precisely the
 * "everything" the contract forbids a caller from asking for. Allocating
 * nothing is the one direction that cannot over-commit. The ceiling exists
 * because past 2^53 the integer promise stops holding: `usableChars * share`
 * would stop being exact and `sum(allocation) === usableChars` would fail by
 * characters no caller can see.
 */
function boundedChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), MAX_CHAR_BUDGET)
}

/**
 * The four requested weights rescaled to sum to exactly 1.
 *
 * When every weight is 0 the split is even, because a caller that expressed no
 * preference still has to be told where its characters go. The last field is
 * derived by subtraction rather than by another division: dividing each weight
 * by the total can leave the four results summing to 1 ± 1 ulp (`[0.3, 0.3,
 * 0.3, 0.1]` does), and a caller that checks the sum — as every budget check
 * does — would then reject a normalisation that is arithmetically fine. The
 * absorbing field sits an ulp below 0 only when its own requested weight was
 * that small, which is the same statement as 0.
 */
function normalizeWeights(weights: BudgetWeights): Readonly<Record<WeightField, number>> {
  const recent = positive(weights.recent)
  const task = positive(weights.task)
  const evidence = positive(weights.evidence)
  const metadata = positive(weights.metadata)
  const total = recent + task + evidence + metadata
  if (total <= 0) return { recent: 0.25, task: 0.25, evidence: 0.25, metadata: 0.25 }
  return {
    recent: recent / total,
    task: task / total,
    evidence: evidence / total,
    metadata: 1 - (recent / total + task / total + evidence / total),
  }
}

/** A requested weight, or 0 when it asks for a negative or non-numeric share. */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The weight one named section carries: the requested weight of the family it
 * names, and 0 for anything else.
 *
 * A section the weights do not name is not an error — a payload may legitimately
 * want a part with no stated preference, and there is no number to give it. It
 * is 0 here so that the equal-share rule in {@link allocateContextBudget}
 * catches exactly the case where nothing in the list carries a preference.
 */
function sectionWeight(name: string, weights: BudgetWeights): number {
  switch (name) {
    case 'recent':
      return positive(weights.recent)
    case 'task':
      return positive(weights.task)
    case 'evidence':
      return positive(weights.evidence)
    case 'metadata':
      return positive(weights.metadata)
    default:
      return 0
  }
}

/**
 * Hand the characters the floors left over to the sections with the largest
 * remainders (Hamilton), ties broken by declared order.
 *
 * The floors under-count by construction — each section loses up to one
 * character to its own fraction — so the deficit is always below the section
 * count and one extra character per section closes it. The descending-then-
 * declared order is what makes the answer deterministic: the same budget and
 * the same section list always round the same way, which a payload hash or a
 * cached snapshot depends on.
 */
function distribute(counts: number[], exacts: readonly number[], usableChars: number): void {
  const order = exacts
    .map((exact, index) => ({ index, remainder: exact - Math.floor(exact) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)

  let leftover = usableChars - counts.reduce((sum, value) => sum + value, 0)
  for (let step = 0; step < order.length && leftover > 0; step += 1) {
    counts[order[step].index] += 1
    leftover -= 1
  }
  // The floors come from `usableChars * share` evaluated in doubles, so a share
  // whose product lands a hair below an integer can round up across it; the
  // sum of such roundings is not something to leave to chance when the promise
  // is `sum(allocation) <= usableChars` always. Undoing it mirrors the step
  // above — the smallest remainder gives a character back first — and skips
  // sections that already hold none, so a correction can never produce a
  // negative count.
  for (let step = 0; step < order.length && leftover < 0; step += 1) {
    const target = order[order.length - 1 - step].index
    if (counts[target] === 0) continue
    counts[target] -= 1
    leftover += 1
  }
}

/**
 * The section list in first-occurrence order with duplicates collapsed.
 *
 * Non-string entries are dropped rather than coerced: the list is declared
 * `readonly string[]`, so anything else arrives from a JS caller that has
 * bypassed the signature, and a `Symbol` or a number would otherwise become a
 * property key nobody asked for.
 */
function dedupe(sections: readonly string[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const name of sections) {
    if (typeof name !== 'string' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Record one section as an own, enumerable, read-only property.
 *
 * Assignment cannot carry every name: a section called `__proto__` lands on the
 * `Object.prototype` accessor, which silently drops a numeric assignment, so
 * the section would vanish from the allocation while its characters were still
 * being charged against the budget. `defineProperty` always creates the own
 * property, and the descriptor is not writable because the returned record is
 * declared readonly.
 */
function defineOwn(target: Record<string, number>, key: string, value: number): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: false, configurable: false })
}

/**
 * The canonical text of one value, or `undefined` when it has none.
 *
 * Mappings are serialised with their keys sorted at every level, which is what
 * makes the length independent of insertion order; `JSON.stringify` would
 * preserve the order the caller happened to write. The `ancestors` set holds
 * the values on the current path only — a value reached twice through
 * different branches is measured twice, as a serial form would render it —
 * while a value that contains itself is measured up to the cycle edge and
 * answers `undefined` there.
 */
function canonicalText(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  // A string nested inside the serial form carries its JSON quotes; the bare
  // string case is answered before this function is entered, by the caller
  // that knows the payload is the string rather than a serialisation of it.
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  // A BigInt has no JSON literal, but its decimal digits are literal text and
  // cost what they cost; symbols and functions have no text at all.
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return undefined
  if (ancestors.has(value)) return undefined

  ancestors.add(value)
  const text = Array.isArray(value) ? arrayText(value, ancestors) : mappingText(value, ancestors)
  ancestors.delete(value)
  return text
}

/** Canonical text of an array; an element with no text stands in as `null`, as in JSON. */
function arrayText(value: readonly unknown[], ancestors: Set<object>): string {
  const parts: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    parts.push(canonicalText(value[index], ancestors) ?? 'null')
  }
  return `[${parts.join(',')}]`
}

/** Canonical text of a mapping; keys are sorted, and properties with no text are dropped. */
function mappingText(value: object, ancestors: Set<object>): string {
  const parts: string[] = []
  for (const key of Object.keys(value).sort()) {
    const text = canonicalText((value as Record<string, unknown>)[key], ancestors)
    if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`)
  }
  return `{${parts.join(',')}}`
}
