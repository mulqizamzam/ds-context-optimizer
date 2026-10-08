// Hierarchical context folding plus the bounded expansion reference that backs
// ctx_expand. The binary this replaces was "raw chunk or fixed snippet": a model
// that wanted document shape, or only the lines mentioning one symbol, had to
// swallow the whole body or re-supply content it already held. Five levels replace
// that with a ladder a model climbs one rung at a time, and every rung is capped by
// MAX_EXPANSION_CHARS and by the caller's budget, so an expansion can never grow
// back into the giant tool output this plugin exists to prevent.

/** Rung on the ladder: metadata, structure, semantics, excerpts, raw. */
export type FoldLevel = 0 | 1 | 2 | 3 | 4

/**
 * Bounded handle a model may expand again. The id is the same opaque token the
 * store matches by SQL equality; anything wider — a path, a URL, a Windows path —
 * is rejected before it can be shaped into a lookup primitive.
 */
export type ExpansionRef =
  | { readonly kind: 'evidence'; readonly id: string }
  | { readonly kind: 'source'; readonly id: string }

/** Source identity without the source's bytes, so L0 stays body-free by construction. */
export interface FoldMetadata {
  readonly sourceId: string
  readonly source: string
  readonly sourceType: string
  readonly sourceName: string
  readonly chunks: number
  readonly charLen: number
  readonly indexedAt: number
  readonly updatedAt: number
  readonly pathOrUrl?: string
}

/**
 * One fold result. `charLen` reports the ORIGINAL input length so a caller can
 * tell how much of a source a level stands for after clipping; `truncated` tells
 * it the level did not carry all of that.
 */
export interface FoldedPayload {
  readonly level: FoldLevel
  readonly text: string
  readonly truncated: boolean
  readonly charLen: number
}

/**
 * Ceiling on any generated payload. A caller asking for more is clamped here
 * rather than served: "more detail" must never mean "the whole corpus".
 */
export const MAX_EXPANSION_CHARS = 4096

const EVIDENCE_REF = /^ev_[0-9a-f]{16}$/
const SOURCE_REF = /^src_[0-9a-f]{16}$/

const STRUCTURE_LINES = 24
const STRUCTURE_LINE_CHARS = 120
const SEMANTIC_LINES = 24
const SEMANTIC_LINE_CHARS = 240
const EXCERPT_LINES = 40
const EXCERPT_LINE_CHARS = 240

export function parseExpansionRef(raw: unknown): ExpansionRef | null {
  if (typeof raw !== 'string') return null
  if (EVIDENCE_REF.test(raw)) return { kind: 'evidence', id: raw }
  if (SOURCE_REF.test(raw)) return { kind: 'source', id: raw }
  return null
}

/**
 * Hard clip primitive. Never returns more than `budgetChars` characters, and never
 * splits a UTF-16 surrogate pair: a cut landing on a lone high surrogate pulls the
 * boundary back one character, because half a pair renders as U+FFFD downstream
 * and silently corrupts whatever text the model was shown. A non-finite, zero, or
 * negative budget yields ''.
 */
export function clipToBudget(text: string, budgetChars: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(budgetChars) || Math.floor(budgetChars) < 1) {
    return { text: '', truncated: text.length > 0 }
  }
  const limit = Math.floor(budgetChars)
  if (text.length <= limit) return { text, truncated: false }
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

/**
 * Shared clamp for every fold entry point. A finite budget below one is a
 * nonsensical request and yields nothing; a non-finite one is a request for the
 * ceiling rather than for an unlimited body. Everything above the ceiling is
 * clamped because a caller cannot opt out of the bound.
 */
function clampBudget(budgetChars: number): number {
  if (!Number.isFinite(budgetChars)) return MAX_EXPANSION_CHARS
  const floored = Math.floor(budgetChars)
  return floored < 1 ? 0 : Math.min(floored, MAX_EXPANSION_CHARS)
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

function renderField(value: string | number | undefined): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : '?'
  if (typeof value === 'string') return value.replace(/[\r\n]+/gu, ' ')
  return '?'
}

function metadataText(meta: FoldMetadata): string {
  const lines = [
    `source ${renderField(meta.sourceId)} ${renderField(meta.source)}`,
    `name ${renderField(meta.sourceName)} type ${renderField(meta.sourceType)}`,
    `chunks ${renderField(meta.chunks)} chars ${renderField(meta.charLen)}`,
    `indexed ${renderField(meta.indexedAt)} updated ${renderField(meta.updatedAt)}`,
  ]
  if (typeof meta.pathOrUrl === 'string' && meta.pathOrUrl !== '') {
    lines.push(`at ${renderField(meta.pathOrUrl)}`)
  }
  return lines.join('\n')
}

/**
 * L1. A line inventory rather than line content: the count, the character scale,
 * the widest line, then the first STRUCTURE_LINES lines each clipped. The answer to
 * "what shape is this document" is bounded no matter how large the document is.
 */
export function structuralSummary(text: string, budgetChars: number): string {
  const lines = splitLines(text)
  let widest = 0
  for (const line of lines) if (line.length > widest) widest = line.length
  const head = lines
    .slice(0, STRUCTURE_LINES)
    .map((line, index) => `${index + 1}|${clipToBudget(line.replace(/\r$/u, ''), STRUCTURE_LINE_CHARS).text}`)
  const parts = [`lines ${lines.length} chars ${text.length} widest ${widest}`, ...head]
  if (lines.length > head.length) parts.push(`(+${lines.length - head.length} more lines)`)
  return clipToBudget(parts.join('\n'), clampBudget(budgetChars)).text
}

// Extractive scoring for L2. Deterministic by construction: no clock, no randomness
// and no model call, so identical text folds identically on every host and every
// run. Headings and list- or label-introduced lines outrank running prose; a very
// long line is usually a pasted blob and a very short one is usually noise.
function lineSignal(line: string): number {
  if (line === '') return 0
  let score = 0
  const words = line.split(/\s+/u).filter((word) => word !== '').length
  if (words >= 3) score += 2
  if (words >= 8) score += 1
  if (/^#{1,6}\s/u.test(line)) score += 5
  if (/^[-*+]\s|^\d+[.)]\s/u.test(line)) score += 2
  if (/[:=]/.test(line)) score += 2
  if (/[{}()[\];,]/.test(line)) score += 1
  if (/\d/u.test(line)) score += 1
  if (line.length > 240) score -= 4
  if (line.length < 4) score -= 3
  return score
}

// Rank lines by score, highest first, then restore document order. Shared by L2 and
// L3 so both selections are explicitly tie-broken by position and reproducible.
function rankLines(lines: readonly string[], score: (line: string) => number, limit: number) {
  return lines
    .map((line, index) => ({ line, index, score: score(line) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
}

/**
 * L2. Keeps the highest-signal lines, restored to document order. It quotes rather
 * than paraphrases, so the summary cannot assert anything the source never said,
 * and it stays inside the budget by clipping its own rendering.
 */
export function semanticSummary(text: string, budgetChars: number): string {
  const body = rankLines(splitLines(text), lineSignal, SEMANTIC_LINES).map(
    (entry) => `${entry.index + 1}|${clipToBudget(entry.line, SEMANTIC_LINE_CHARS).text}`,
  )
  return clipToBudget(body.join('\n'), clampBudget(budgetChars)).text
}

function normalizeTerms(terms: readonly string[]): string[] {
  const needles: string[] = []
  if (!Array.isArray(terms)) return needles
  for (const term of terms) {
    if (typeof term !== 'string') continue
    const needle = term.trim().toLowerCase()
    if (needle !== '') needles.push(needle)
  }
  return needles
}

function termHits(line: string, needles: readonly string[]): number {
  const haystack = line.toLowerCase()
  let hits = 0
  for (const needle of needles) {
    let from = haystack.indexOf(needle)
    while (from !== -1) {
      hits += 1
      from = haystack.indexOf(needle, from + needle.length)
    }
  }
  return hits
}

/**
 * L3. With terms: the lines mentioning them, most-hits first, then restored to
 * document order. Without terms: the first EXCERPT_LINES lines. Every item is
 * clipped to the smaller of its remaining budget share and EXCERPT_LINE_CHARS, and
 * packing reserves one character per item for the joiner, so neither a single item
 * nor the joined sum can exceed the budget.
 */
export function selectExcerpts(text: string, terms: readonly string[], budgetChars: number): string[] {
  const budget = clampBudget(budgetChars)
  const lines = splitLines(text)
  if (budget < 1 || lines.length === 0) return []
  const needles = normalizeTerms(terms)
  const picked = needles.length > 0
    ? rankLines(lines, (line) => termHits(line, needles), EXCERPT_LINES).map((entry) => entry.line)
    : lines.slice(0, EXCERPT_LINES)
  const excerpts: string[] = []
  let used = 0
  for (const line of picked) {
    const room = budget - used - (excerpts.length > 0 ? 1 : 0)
    if (room < 1) break
    const piece = clipToBudget(line.replace(/\r$/u, ''), Math.min(room, EXCERPT_LINE_CHARS)).text
    if (piece.trim() === '') continue
    excerpts.push(piece)
    used += piece.length
  }
  return excerpts
}

/**
 * The expansion ladder. Every level renders a natural text, then clips it once, so
 * the budget bound is applied in exactly one place. An out-of-range level falls
 * through to metadata — the only level that cannot leak body text — and an unusable
 * budget yields an empty payload rather than an unbounded one. L3 and L4 report
 * `truncated` against the body itself, so the flag tells the model that more source
 * exists rather than that a header was cut.
 */
export function foldToLevel(
  meta: FoldMetadata,
  text: string,
  level: FoldLevel,
  budgetChars: number,
): FoldedPayload {
  const budget = clampBudget(budgetChars)
  const natural =
    level === 4 ? text
      : level === 3 ? selectExcerpts(text, [], budget).join('\n')
      : level === 2 ? semanticSummary(text, budget)
      : level === 1 ? structuralSummary(text, budget)
      : metadataText(meta)
  const clipped = clipToBudget(natural, budget)
  return {
    level,
    text: clipped.text,
    truncated: level === 3 ? clipped.text !== text : clipped.truncated,
    charLen: text.length,
  }
}
