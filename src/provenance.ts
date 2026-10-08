import { createHash } from 'node:crypto'

/**
 * One chunk exactly as its writer recorded it.
 *
 * Every optional field answers a real question for one family of sources: file
 * and directory sources know line ranges, command sources know the argv, session
 * sources know the event. Anything else is left out, which is what lets a reader
 * answer "where did this come from" by quoting a field instead of inferring one.
 */
export interface ProvenanceInput {
  readonly source: string
  readonly sourceType: string
  readonly ordinal: number
  readonly contentHash: string
  readonly indexedAt: number
  readonly updatedAt: number
  readonly pathOrUrl?: string
  readonly lineStart?: number
  readonly lineEnd?: number
  readonly command?: string
  readonly sessionId?: string
  readonly eventId?: string
}

/**
 * What a chunk can still prove about itself once the writer is gone: which
 * source it came from, when it entered the index, and which digest of its text
 * was indexed. Optional fields keep the same rule as their input — absent means
 * "never measured", never "here is a default".
 */
export interface Provenance {
  readonly source: string
  readonly sourceType: string
  readonly pathOrUrl?: string
  readonly lineStart?: number
  readonly lineEnd?: number
  readonly command?: string
  readonly sessionId?: string
  readonly eventId?: string
  readonly contentHash: string
  readonly indexedAt: number
  readonly updatedAt: number
}

/**
 * Hex width shared by every derived id: 64 bits of SHA-256. Short enough to
 * quote inside a bounded tool result, wide enough that a chance collision among
 * a repository's chunks is not a realistic event.
 */
const ID_HEX_WIDTH = 16

/** sha256 of the UTF-8 bytes, hex, truncated to the shared id width. */
function shortSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, ID_HEX_WIDTH)
}

/**
 * Derive the stable id of one source name.
 *
 * The digest rather than the name itself so the id is a fixed-width opaque
 * token: it carries no path separator, no whitespace and no caller-supplied
 * punctuation a downstream reader could mistake for structure. It is used only
 * as a SQL bound parameter matched by equality — never as a path component —
 * so a source named `../../etc/passwd` cannot reach the filesystem through it.
 * An empty name still hashes to a well-formed `src_` id, because an unnamed
 * source is a caller bug to be surfaced by validation, not by a throw from an
 * id derivation.
 */
export function deriveSourceId(source: string): string {
  return `src_${shortSha256(source)}`
}

/**
 * Chunk address within its source: the source id and the ordinal, joined.
 * Deliberately not hashed — the pair is small, readable, and lets a human
 * looking at a cache row see which chunk of which source an id points at.
 */
export function deriveChunkId(sourceId: string, ordinal: number): string {
  return `${sourceId}:${ordinal}`
}

/**
 * The handle a retrieved fact is cited by.
 *
 * It hashes source id and ordinal and nothing else. Identity is therefore
 * "where this came from and which slot it occupied", and re-indexing a source
 * with new text under the same boundaries keeps the evidence id: drift has to
 * surface as a stale hash on a known fact, not as a brand-new fact that has
 * silently lost its history. Including the text hash here would do exactly
 * that, which is why it is not an input.
 */
export function deriveEvidenceId(sourceId: string, ordinal: number): string {
  return `ev_${shortSha256(`${sourceId}|${ordinal}`)}`
}

/**
 * Lowercase hex SHA-256 of the UTF-8 bytes.
 *
 * Hashing the encoded bytes — not the JS string — is what makes the digest agree
 * with the file a chunk was read from, so staleness compares like with like
 * after a re-read. It never inspects the text, so it cannot throw on `''` or on
 * a chunk that is only a fragment of a file.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * True when the record's hash is provably no longer the live content's.
 *
 * Both sides are hashes; no timestamp, size or other proxy is consulted. A
 * timestamp would flag every chunk of a file someone touched without editing,
 * and a byte count would miss a same-length rewrite.
 *
 * An absent or empty live hash means *unknown*, not *changed*: with no live
 * content to hash there is nothing that can disagree with the record, and
 * answering "stale" would invent a drift event nobody observed. Callers get
 * false and are expected to re-read the source when they actually need to know.
 * The converse is not symmetric — a record with no hash of its own disagrees
 * with any live hash and reports stale, which schedules the chunk for re-index
 * instead of serving evidence that cannot justify itself.
 */
export function isProvenanceStale(record: { readonly contentHash: string }, liveHash: string): boolean {
  if (typeof liveHash !== 'string' || liveHash.length === 0) return false
  return record.contentHash !== liveHash
}

/**
 * A line number only when the writer actually measured one.
 *
 * The guard is what makes "do not fabricate line numbers" enforceable in one
 * place: `NaN` and `Infinity` are dropped because neither denotes a line, and a
 * negative value is dropped because no line exists before the first. Zero is a
 * measurement and is kept.
 */
function lineNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Copy one indexed record into its provenance object.
 *
 * Required fields are copied verbatim. Each optional field is copied only when
 * the value is the right type (and, for a line, a measurement); otherwise the
 * key is never created. Writing `lineStart: undefined` would be the wrong
 * default: `'lineStart' in provenance` would then report true, and any consumer
 * that tests presence rather than value reads a line range that was never
 * measured — a fabricated citation, the exact failure this rule exists to stop.
 *
 * Fields are written in declaration order so the object a tool emits reads the
 * same way whichever fields happen to be present.
 */
export function buildProvenance(input: ProvenanceInput): Provenance {
  const lineStart = lineNumber(input.lineStart)
  const lineEnd = lineNumber(input.lineEnd)

  // Conditional spreads, one per optional field: an absent or mistyped value
  // contributes no key at all, which is the mechanism the docstring describes.
  return {
    source: input.source,
    sourceType: input.sourceType,
    ...(typeof input.pathOrUrl === 'string' ? { pathOrUrl: input.pathOrUrl } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
    ...(typeof input.eventId === 'string' ? { eventId: input.eventId } : {}),
    contentHash: input.contentHash,
    indexedAt: input.indexedAt,
    updatedAt: input.updatedAt,
  }
}

/**
 * Bound `text` to `maxChars` UTF-16 code units, without splitting a surrogate
 * pair.
 *
 * A budget that is not a finite positive number is treated as 0 rather than
 * passed through: `NaN` propagates out of comparisons and a negative budget
 * would make every length check vacuously true, so clamping is the only reading
 * under which "never exceeds the budget" stays a claim.
 *
 * The surrogate check exists because a code at the cut boundary can be the lead
 * half of a pair whose tail sits beyond it; `slice` would return a lone
 * surrogate, and re-encoding that text to UTF-8 yields U+FFFD, which changes
 * bytes and therefore hashes. Dropping the lead instead keeps the result
 * decodable.
 */
export function clipSnippet(text: string, maxChars: number): string {
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0
  if (text.length <= budget) return text

  let end = budget
  const lastCode = end > 0 ? text.charCodeAt(end - 1) : 0
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * The bounded view of one chunk that retrieval hands back to a caller.
 *
 * The snippet is clipped to `maxChars` here so no caller can turn "give me more
 * context" into an unbounded tool output, and the provenance rides along so the
 * snippet is never quoted without the answers "which source, indexed when,
 * with which digest".
 *
 * `stale` is always false, and that is deliberate rather than lazy. Staleness
 * needs a second hash — the one the *live* chunk would produce — and this
 * function only ever sees the stored record next to a bounded excerpt of its own
 * text. Hashing the excerpt would compare a fragment against a whole and
 * manufacture drift on every truncated chunk. The honest answer with nothing
 * independent to compare against is false, the same value an unknown live hash
 * yields from {@link isProvenanceStale}; a caller that has re-read the source
 * calls that function directly with the live digest.
 */
export function boundedEvidenceView(record: ProvenanceInput, text: string, maxChars: number): EvidenceView {
  const sourceId = deriveSourceId(record.source)
  return {
    sourceId,
    chunkId: deriveChunkId(sourceId, record.ordinal),
    evidenceId: deriveEvidenceId(sourceId, record.ordinal),
    source: record.source,
    ordinal: record.ordinal,
    snippet: clipSnippet(text, maxChars),
    provenance: buildProvenance(record),
    stale: false,
  }
}

/** Bounded, quotable form of one chunk: ids, snippet, provenance. */
export interface EvidenceView {
  readonly sourceId: string
  readonly chunkId: string
  readonly evidenceId: string
  readonly source: string
  readonly ordinal: number
  readonly snippet: string
  readonly provenance: Provenance
  readonly stale: boolean
}
