/**
 * Deterministic contradiction detection over retrieved evidence.
 *
 * The question is deliberately narrow: do two pieces of evidence make
 * incompatible assertions about the same named thing? "Do these texts disagree"
 * is not answerable here, so nothing below attempts it. Every rule is lexical,
 * so the output is a pure function of the evidence set — no LLM, network,
 * randomness, clock, or filesystem anywhere.
 *
 * The bias is precision. A textual difference is not a contradiction until this
 * module can name the structure that makes it one, so a pair fires only on a
 * recognised class: a config key with two values, a boolean polarity flip, two
 * version literals, or a tabulated exclusive alternative. Everything else stays
 * silent, which makes an empty result over prose the expected outcome.
 */

export type ContradictionConfidence = 'none' | 'possible' | 'likely' | 'high'
export type ContradictionKind = 'key-value' | 'boolean' | 'version' | 'exclusive' | 'none'

export interface EvidenceClaim {
  readonly evidenceId: string
  readonly source: string
  readonly snippet: string
}

export interface Contradiction {
  readonly confidence: ContradictionConfidence
  readonly kind: ContradictionKind
  readonly evidenceA: EvidenceClaim
  readonly evidenceB: EvidenceClaim
  readonly subject: string
  readonly valueA?: string
  readonly valueB?: string
  readonly reason: string
}

/** Shape of a normalised value; decides how aggressively it may conflict. */
type ValueShape = 'empty' | 'boolean' | 'version' | 'number' | 'scalar' | 'phrase'

/** One recognised claim, normalised and ready to be paired with another. */
interface ParsedClaim {
  readonly subject: string
  readonly value: string
  readonly shape: ValueShape
  /** Only for boolean claims: true for on/enabled, false for off/disabled. */
  readonly polarity: boolean | null
}

/** Evidence plus its first recognised claim about one subject. */
interface BucketEntry {
  readonly evidence: EvidenceClaim
  readonly claim: ParsedClaim
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

/** The only ordering primitive here; every other comparison is built on it. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** `key = value` and `key: value`. The key may contain neither separator. */
const SEPARATED = /^([^=:]{1,96}?)\s*[=:]\s*(\S[\s\S]*)$/

/** `<subject> is enabled` — the single prose shape worth trusting. */
const BOOLEAN_PROSE = /^(.{1,96}?)\s+(?:is|are)\s+(enabled|disabled|on|off)\s*[.,;:]?$/i

/** `<subject> v1.2.3` when no separator is present, e.g. "api v1.2.3". */
const VERSION_PROSE = /^(.{1,96}?)\s+(v\d+(?:\.\d+)+)\s*[.,;:]?$/i

/** A version needs a dot, so `port = 8080` stays a plain number. */
const VERSION_LITERAL = /^v?\d+(?:\.\d+)+$/
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/

/** Schemes rejected here stop `https://a.com` parsing as the key `https`. */
const URL_SCHEME = /^(?:https?|ftps?|wss?|file|mailto|git|ssh|data|javascript|urn)$/i

const BOOLEAN_WORDS: ReadonlySet<string> = new Set([
  'true', 'false', 'yes', 'no', 'on', 'off', 'enabled', 'disabled',
])
const BOOLEAN_OFF: ReadonlySet<string> = new Set(['false', 'no', 'off', 'disabled'])

/**
 * The complete set of subjects this module is willing to call mutually
 * exclusive, each mapping an alternative to the spellings that resolve to it.
 * This table is the whole truth about exclusivity: a value outside it is NOT
 * claimed exclusive, so `authentication: jwt` versus `authentication: ldap`
 * degrades to an ordinary key/value conflict rather than an exclusivity one.
 */
const EXCLUSIVE_TABLE: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  authentication: {
    jwt: ['jwt', 'jwt-token', 'jwt-tokens', 'bearer-token'],
    'session-cookie': ['session-cookie', 'session-cookies', 'cookie-based', 'cookie', 'sessions', 'session'],
    'basic-auth': ['basic-auth', 'basic', 'http-basic'],
    oauth2: ['oauth2', 'oauth'],
  },
  transport: { tcp: ['tcp'], udp: ['udp'] },
  storage: {
    sqlite: ['sqlite', 'sqlite3'],
    postgres: ['postgres', 'postgresql'],
    mysql: ['mysql', 'mariadb'],
  },
}

/** Collapses case and whitespace so `Port`, `port ` and `"port"` join together. */
function normaliseSubject(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[-*+•]\s+/, '')
    .replace(/^the\s+/, '')
    .replace(/^(['"`])(.*)\1$/, '$2')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strips surrounding quotes and trailing punctuation; keeps the inner case. */
function normaliseValue(raw: string): string {
  const cleaned = raw.trim().replace(/[.,;]+$/, '')
  const quoted = /^(['"`])(.*)\1$/.exec(cleaned)
  return (quoted === null ? cleaned : quoted[2]).replace(/\s+/g, ' ').trim()
}

function classifyValue(value: string): { shape: ValueShape; polarity: boolean | null } {
  if (value === '') return { shape: 'empty', polarity: null }
  const lower = value.toLowerCase()
  if (BOOLEAN_WORDS.has(lower)) return { shape: 'boolean', polarity: !BOOLEAN_OFF.has(lower) }
  if (VERSION_LITERAL.test(value)) return { shape: 'version', polarity: null }
  if (NUMERIC_LITERAL.test(value)) return { shape: 'number', polarity: null }
  if (!/\s/.test(value)) return { shape: 'scalar', polarity: null }
  return { shape: 'phrase', polarity: null }
}

function parseSeparated(raw: string): ParsedClaim | null {
  const match = SEPARATED.exec(raw)
  if (match === null) return null
  const subject = normaliseSubject(match[1])
  if (subject === '' || !/[A-Za-z0-9]/.test(subject)) return null
  if (subject.includes('/') || URL_SCHEME.test(subject)) return null
  const value = normaliseValue(match[2])
  if (value === '' || value.startsWith('//')) return null
  const classified = classifyValue(value)
  return { subject, value, shape: classified.shape, polarity: classified.polarity }
}

function parseBooleanProse(raw: string): ParsedClaim | null {
  const match = BOOLEAN_PROSE.exec(raw)
  if (match === null) return null
  const subject = normaliseSubject(match[1])
  if (subject === '') return null
  const word = match[2].toLowerCase()
  return { subject, value: word, shape: 'boolean', polarity: word === 'enabled' || word === 'on' }
}

function parseVersionProse(raw: string): ParsedClaim | null {
  const match = VERSION_PROSE.exec(raw)
  if (match === null) return null
  const subject = normaliseSubject(match[1])
  if (subject === '' || VERSION_LITERAL.test(subject)) return null
  return { subject, value: match[2], shape: 'version', polarity: null }
}

/** Null for any line that carries no recognised claim. */
function parseLine(line: string): ParsedClaim | null {
  const raw = line.trim()
  if (raw === '' || raw.startsWith('#')) return null
  return parseSeparated(raw) ?? parseBooleanProse(raw) ?? parseVersionProse(raw)
}

/**
 * Maps (subject, value) onto a tabulated alternative, or null when the value is
 * outside the table. The head token is tried too, so "jwt tokens" still
 * resolves, and a subject matches a table entry when it contains it as a word.
 */
function exclusiveCanonical(subject: string, value: string): string | null {
  const words = subject.split(/\s+/)
  const keys = Object.keys(EXCLUSIVE_TABLE).sort()
  const key = keys.find((candidate) => words.includes(candidate))
  if (key === undefined) return null
  const alternatives = EXCLUSIVE_TABLE[key]
  const cleaned = value.toLowerCase().replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, '')
  const head = cleaned.split('-')[0]
  const candidates = head !== '' && head !== cleaned ? [cleaned, head] : [cleaned]
  for (const candidate of candidates) {
    for (const canonical of Object.keys(alternatives)) {
      if (alternatives[canonical].includes(candidate)) return canonical
    }
  }
  return null
}

/**
 * Decides whether two claims about one subject conflict. Null when they agree,
 * when either side is missing a value, or when the difference has no structure
 * this module is allowed to name.
 */
function compareClaims(subject: string, a: ParsedClaim, b: ParsedClaim): {
  confidence: ContradictionConfidence
  kind: ContradictionKind
  reason: string
} | null {
  if (a.shape === 'empty' || b.shape === 'empty') return null
  if (a.value.toLowerCase() === b.value.toLowerCase()) return null
  if (a.polarity !== null && b.polarity !== null) {
    return {
      confidence: 'high', kind: 'boolean',
      reason: `boolean subject "${subject}" is asserted ${a.value} in one item and ${b.value} in another`,
    }
  }
  if (a.shape === 'version' && b.shape === 'version') {
    return {
      confidence: 'high', kind: 'version',
      reason: `subject "${subject}" carries two different version literals ${a.value} and ${b.value}`,
    }
  }
  const canonicalA = exclusiveCanonical(subject, a.value)
  const canonicalB = exclusiveCanonical(subject, b.value)
  if (canonicalA !== null && canonicalB !== null && canonicalA !== canonicalB) {
    return {
      confidence: 'likely', kind: 'exclusive',
      reason: `subject "${subject}" is asserted as the mutually exclusive alternatives ${canonicalA} and ${canonicalB}`,
    }
  }
  if (a.shape === 'phrase' || b.shape === 'phrase') {
    return {
      confidence: 'possible', kind: 'key-value',
      reason: `subject "${subject}" differs but at least one value is not a scalar (${a.value} versus ${b.value})`,
    }
  }
  return {
    confidence: 'high', kind: 'key-value',
    reason: `subject "${subject}" carries conflicting values ${a.value} and ${b.value}`,
  }
}

function byEvidenceId(left: EvidenceClaim, right: EvidenceClaim): number {
  return compareText(left.evidenceId, right.evidenceId)
}

function byClaimEvidence(left: BucketEntry, right: BucketEntry): number {
  return byEvidenceId(left.evidence, right.evidence)
}

/**
 * Drops malformed items rather than throwing: a bad record degrades to silence.
 * Rebuilt instead of passed through so the emitted claims are exactly the
 * contract's shape, and sorted here so the per-(subject, evidence) tie-break in
 * detectContradictions never depends on the caller's input order.
 */
function collectItems(items: readonly EvidenceClaim[]): EvidenceClaim[] {
  const out: EvidenceClaim[] = []
  if (!Array.isArray(items)) return out
  for (const item of items as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as Partial<EvidenceClaim>
    if (typeof candidate.evidenceId !== 'string' || candidate.evidenceId.trim() === '') continue
    if (typeof candidate.source !== 'string' || typeof candidate.snippet !== 'string') continue
    out.push({ evidenceId: candidate.evidenceId, source: candidate.source, snippet: candidate.snippet })
  }
  return out.sort(byEvidenceId)
}

function normaliseLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT
  if (limit <= 0) return 0
  return Math.min(MAX_LIMIT, Math.floor(limit))
}

/** Recognised claims in text order; free prose yields nothing here. */
export function extractClaims(text: string): Array<{ subject: string; value: string }> {
  if (typeof text !== 'string' || text.trim() === '') return []
  const out: Array<{ subject: string; value: string }> = []
  for (const line of text.split(/\r?\n/)) {
    const claim = parseLine(line)
    if (claim !== null) out.push({ subject: claim.subject, value: claim.value })
  }
  return out
}

/**
 * Compares every pair of evidence that asserts claims about a shared subject.
 * Output is sorted by (subject, evidenceA.evidenceId, evidenceB.evidenceId) and
 * capped, so the result is a function of the evidence set rather than of the
 * order the retriever happened to return it in.
 */
export function detectContradictions(
  items: readonly EvidenceClaim[],
  limit?: number,
): Contradiction[] {
  const cap = normaliseLimit(limit)
  if (cap === 0) return []
  const valid = collectItems(items)
  if (valid.length < 2) return []

  // subject -> the first claim each evidence makes about it. One entry per
  // (subject, evidence) is kept, so a repeated key inside one snippet cannot
  // manufacture a second contradiction against the same neighbour.
  const buckets = new Map<string, BucketEntry[]>()
  const seen = new Set<string>()
  for (const evidence of valid) {
    for (const line of evidence.snippet.split(/\r?\n/)) {
      const claim = parseLine(line)
      if (claim === null) continue
      const slot = `${claim.subject}\u0000${evidence.evidenceId}`
      if (seen.has(slot)) continue
      seen.add(slot)
      const bucket = buckets.get(claim.subject)
      if (bucket === undefined) buckets.set(claim.subject, [{ evidence, claim }])
      else bucket.push({ evidence, claim })
    }
  }

  const out: Contradiction[] = []
  for (const subject of [...buckets.keys()].sort()) {
    const entries = buckets.get(subject)
    if (entries === undefined) continue
    const ordered = [...entries].sort(byClaimEvidence)
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const comparison = compareClaims(subject, ordered[i].claim, ordered[j].claim)
        if (comparison === null) continue
        // Orientation is by evidence id, never by input position.
        const [first, second] = byClaimEvidence(ordered[i], ordered[j]) <= 0
          ? [ordered[i], ordered[j]]
          : [ordered[j], ordered[i]]
        out.push({
          confidence: comparison.confidence,
          kind: comparison.kind,
          evidenceA: first.evidence,
          evidenceB: second.evidence,
          subject,
          valueA: first.claim.value,
          valueB: second.claim.value,
          reason: comparison.reason,
        })
      }
    }
  }

  // Field-wise, so the emitted order is exactly the documented
  // (subject, evidenceA.evidenceId, evidenceB.evidenceId) tuple.
  const order = (left: Contradiction, right: Contradiction): number =>
    compareText(left.subject, right.subject)
    || compareText(left.evidenceA.evidenceId, right.evidenceA.evidenceId)
    || compareText(left.evidenceB.evidenceId, right.evidenceB.evidenceId)
  return out.sort(order).slice(0, cap)
}
