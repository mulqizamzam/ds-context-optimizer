import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/**
 * Ceiling on the stored text of one cache row, in characters.
 *
 * Ranking a large corpus is what this cache exists to avoid repeating, but the
 * cache itself sits in the plugin's state directory, so an unbounded payload
 * would turn a write-through cache into a second, unaudited blob store that
 * grows with whatever a caller chooses to hand over. Refusing past the ceiling
 * keeps the bound explicit: the CALLER stays responsible for how big the value
 * it caches is, and this module only refuses to persist beyond it.
 */
export const MAX_PAYLOAD_CHARS = 65_536

/** Depth past which `canonicalize` stops descending. */
const MAX_CANONICAL_DEPTH = 64

/** Schema tag of the stored payload envelope, so a foreign row is detectable. */
const PAYLOAD_VERSION = 1

export interface CacheConfig {
  /**
   * False disables the cache outright: reads miss and writes store nothing,
   * while `invalidateCorpus`, `prune` and `reset` still clean up rows left by
   * an earlier enabled run.
   */
  readonly enabled: boolean
  /**
   * Lifetime of a row, in epoch milliseconds. `0` or negative means "never
   * expires": SQLite has no infinity and the column is a plain INTEGER, so such
   * a row is stored with `expires_at = Number.MAX_SAFE_INTEGER`.
   */
  readonly ttlMs: number
  /**
   * Row cap. `0` or negative stores nothing, which is how a caller says
   * "read-through only" without a separate flag.
   */
  readonly maxEntries: number
}

export interface CacheKeyParts {
  readonly query: string
  readonly corpusVersion: number
  readonly source?: string
  readonly sort?: string
  readonly limit: number
  readonly ranking: string
  readonly filters?: Readonly<Record<string, unknown>>
}

export interface CacheStats {
  readonly hits: number
  readonly misses: number
  /** Live row count, read from the table rather than from a running tally. */
  readonly entries: number
  readonly evictions: number
  readonly expirations: number
}

/** One row as read back by `get`. */
interface CacheRow {
  readonly payload: string
  readonly expires_at: number
}

/** Outcome of parsing a stored payload. */
type PayloadParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

/**
 * Local retrieval cache over the built-in `node:sqlite`.
 *
 * Ranking the corpus is the expensive half of a retrieval, and the same query
 * against the same corpus version keeps being asked turn after turn, so every
 * repeat re-ranked from scratch. This keeps the ranked result keyed by the
 * query's SHAPE — query, corpus version, source, sort, limit, ranking and
 * filters, in that canonical order — so a repeat is one row read.
 *
 * Two invariants bound it, because a cache that grows without limit or serves a
 * stale answer is worse than no cache. An index write bumps `corpusVersion`,
 * and `invalidateCorpus` then deletes every row ranked against a different one,
 * which is what keeps an out-of-date corpus from being served. Rows also expire
 * on a TTL, the table is capped at `maxEntries` oldest-first, and a payload past
 * `MAX_PAYLOAD_CHARS` is refused, so the cache can never become a way to park an
 * unbounded blob inside the plugin's state directory.
 *
 * Every read fails closed: a damaged row — unparseable, foreign, or the wrong
 * shape for this schema — is deleted and reported as a miss rather than served,
 * and a damaged database (a table the caller replaced with a view, say) surfaces
 * as a miss or a refused write instead of throwing out of the tool handler.
 */
export class RetrievalCache {
  private readonly db: DatabaseSync
  private readonly config: CacheConfig
  private inTransaction = false
  private hits = 0
  private misses = 0
  private evictions = 0
  private expirations = 0

  constructor(db: DatabaseSync, config: CacheConfig) {
    this.db = db
    this.config = config
    // Same two pragmas the content store and the session store set: WAL so a
    // reader is never blocked behind a cache write, NORMAL so a cache hit does
    // not fsync the whole database. Both are idempotent, so taking ownership of
    // a database the caller already opened in WAL is a no-op.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS retrieval_cache(
        key TEXT PRIMARY KEY,
        corpus_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_retrieval_cache_expires
        ON retrieval_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_retrieval_cache_corpus_created
        ON retrieval_cache(corpus_version, created_at);
    `)
  }

  /**
   * Read one entry.
   *
   * A hit needs three things at once: the row exists, `expires_at` is still in
   * the future, and the payload parses back into a value this module wrote. An
   * expired row is deleted on the way out so it cannot be re-read; a damaged one
   * is deleted for the same reason. Either way the caller sees `hit: false`,
   * never an exception — a cache is an optimisation, and failing to serve one
   * must never be the reason a retrieval fails.
   */
  get<T>(key: string): { readonly hit: boolean; readonly value?: T } {
    if (!this.config.enabled) return this.miss()
    let row: CacheRow | undefined
    try {
      row = this.db
        .prepare('SELECT payload, expires_at FROM retrieval_cache WHERE key = ?')
        .get(key) as CacheRow | undefined
    } catch {
      return this.miss()
    }
    if (row === undefined) return this.miss()
    // A column that is not text is not a payload this module wrote; treat it as
    // damage the same way an unparseable one is treated.
    if (typeof row.payload !== 'string' || !Number.isFinite(row.expires_at)) {
      this.dropKey(key)
      return this.miss()
    }
    if (row.expires_at <= Date.now()) {
      this.expirations += 1
      this.dropKey(key)
      return this.miss()
    }
    const parsed = parsePayload(row.payload)
    if (!parsed.ok) {
      this.dropKey(key)
      return this.miss()
    }
    this.hits += 1
    try {
      this.transaction(() => {
        this.db
          .prepare('UPDATE retrieval_cache SET hits = hits + 1 WHERE key = ?')
          .run(key)
      })
    } catch {
      /* a counter that cannot be bumped still leaves the hit itself valid */
    }
    return { hit: true, value: parsed.value as T }
  }

  /**
   * Store one entry.
   *
   * The insert is an upsert, so re-caching the same key refreshes its TTL and
   * its position in the eviction order instead of leaving a stale expiry in
   * place. Refusals are `false` and store nothing: disabled cache, a cap of
   * zero, a payload that will not serialise (circular, BigInt, `undefined`), or
   * a payload past `MAX_PAYLOAD_CHARS`. A statement that fails against a
   * damaged database also returns `false` — an unwritable cache degrades to
   * no cache, it does not fail the write the caller was performing.
   */
  set(key: string, value: unknown, corpusVersion: number): boolean {
    if (!this.config.enabled) return false
    if (this.config.maxEntries <= 0) return false
    const payload = serializePayload(value)
    if (payload === null) return false
    if (payload.length > MAX_PAYLOAD_CHARS) return false
    const now = Date.now()
    try {
      return this.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO retrieval_cache(key, corpus_version, payload, created_at, expires_at, hits)
             VALUES(?,?,?,?,?,0)
             ON CONFLICT(key) DO UPDATE SET
               corpus_version = excluded.corpus_version,
               payload = excluded.payload,
               created_at = excluded.created_at,
               expires_at = excluded.expires_at`,
          )
          .run(key, corpusVersion, payload, now, this.expiresAt(now))
        this.enforceBound()
        return true
      })
    } catch {
      return false
    }
  }

  /**
   * Delete every row ranked against a corpus version other than `corpusVersion`.
   *
   * This is how an index write invalidates cached retrievals: the caller bumps
   * the version it writes and then calls this, and every answer computed
   * against the previous corpus disappears. The key already carries the version
   * it was cached under, so entries for the current version need no further
   * check on read.
   */
  invalidateCorpus(corpusVersion: number): number {
    try {
      return this.transaction(() => {
        const result = this.db
          .prepare('DELETE FROM retrieval_cache WHERE corpus_version <> ?')
          .run(corpusVersion)
        return Number(result.changes)
      })
    } catch {
      return 0
    }
  }

  /** Delete expired rows, oldest expiry first, and report how many went. */
  prune(now: number = Date.now()): number {
    try {
      return this.transaction(() => {
        const result = this.db
          .prepare('DELETE FROM retrieval_cache WHERE expires_at <= ?')
          .run(now)
        const removed = Number(result.changes)
        this.expirations += removed
        return removed
      })
    } catch {
      return 0
    }
  }

  /** Drop every row and zero this process's counters. */
  reset(): void {
    try {
      this.transaction(() => {
        this.db.exec('DELETE FROM retrieval_cache')
      })
    } catch {
      /* rows that cannot be deleted are still invisible to a disabled read */
    }
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    this.expirations = 0
  }

  /**
   * Counters plus the live row count.
   *
   * `entries` is a `COUNT(*)` rather than a maintained tally: the number a
   * reader wants is what is actually stored, and rows can be deleted from
   * outside this object (an operator, a sibling module sharing the database).
   */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.countEntries(),
      evictions: this.evictions,
      expirations: this.expirations,
    }
  }

  /**
   * Run one write body inside `BEGIN IMMEDIATE` … `COMMIT`, with a `ROLLBACK`
   * on failure — the shape `ContentStore.transaction` uses, copied so a
   * partially applied write can never be observed. A nested call joins the
   * transaction already open rather than issuing its own BEGIN, which SQLite
   * would reject.
   */
  private transaction<T>(body: () => T): T {
    if (this.inTransaction) return body()
    this.inTransaction = true
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      this.inTransaction = false
      throw error
    }
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the transaction was already rolled back by SQLite itself */
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  /** Trim the table back to `maxEntries`, oldest row first. */
  private enforceBound(): void {
    const keep = this.config.maxEntries
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM retrieval_cache')
      .get() as { n: number }
    const excess = Number(row.n) - keep
    if (excess <= 0) return
    // Oldest means `created_at`, then `key`: rows written inside the same
    // millisecond would otherwise be deleted in whatever order the storage
    // engine walked the index, and the test that pins which rows survive would
    // be reading the clock rather than the code.
    const result = this.db
      .prepare(
        `DELETE FROM retrieval_cache WHERE key IN (
           SELECT key FROM retrieval_cache ORDER BY created_at ASC, key ASC LIMIT ?
         )`,
      )
      .run(excess)
    this.evictions += Number(result.changes)
  }

  /** Expiry timestamp for a row written at `now`. */
  private expiresAt(now: number): number {
    const ttl = this.config.ttlMs
    if (ttl <= 0) return Number.MAX_SAFE_INTEGER
    return now + ttl
  }

  /** Rows currently stored, or 0 when the table cannot be read. */
  private countEntries(): number {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM retrieval_cache')
        .get() as { n: number }
      return Number(row.n)
    } catch {
      return 0
    }
  }

  /** Delete one row, swallowing any failure — absence is all the caller sees. */
  private dropKey(key: string): void {
    try {
      this.transaction(() => {
        this.db.prepare('DELETE FROM retrieval_cache WHERE key = ?').run(key)
      })
    } catch {
      /* a row that cannot be deleted is still absent from the next hit */
    }
  }

  private miss(): { readonly hit: false } {
    this.misses += 1
    return { hit: false }
  }
}

/**
 * Serialise one cached value into the text stored in `payload`.
 *
 * The value is wrapped in a versioned envelope rather than stored bare. JSON
 * that merely parses is not proof it came from this module — a truncated row, a
 * row written by an older schema, or any other text that a damaged write leaves
 * in the column can all parse — and the envelope is what lets `get` tell a real
 * payload from a foreign one and fail closed instead of serving garbage as a
 * hit. Returns `null` for a value JSON cannot represent at all.
 */
function serializePayload(value: unknown): string | null {
  try {
    const text = JSON.stringify({ v: PAYLOAD_VERSION, d: value })
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

function parsePayload(payload: string): PayloadParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { ok: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false }
  }
  const envelope = parsed as { v?: unknown; d?: unknown }
  if (envelope.v !== PAYLOAD_VERSION) return { ok: false }
  if (!('d' in envelope)) return { ok: false }
  return { ok: true, value: envelope.d }
}

/**
 * Canonical JSON of `value`: the same string for structurally equal values, no
 * matter what order their keys were inserted in.
 *
 * The cache key is a hash of this text, so two callers describing the same
 * retrieval must produce the same bytes. `JSON.stringify` alone does not
 * guarantee that — it emits keys in insertion order — and it happily calls
 * `toJSON` on anything that carries one, which would let a filter object run
 * arbitrary code at keying time. This walks the value itself and sorts object
 * keys with the default (code-unit) comparator, which is stable across
 * processes.
 *
 * `undefined` canonicalises to `'null'`, which keeps every output valid JSON
 * and so keeps it parseable; it is the one place where two distinct inputs
 * share a canonical form, and it is only reachable through an explicit
 * `undefined` inside a filter, where `null` and `undefined` both mean "no
 * value". Values that are not JSON at all — functions, symbols, non-finite
 * numbers, BigInt — are emitted as tagged JSON so they never collide with a
 * number or a string that shares their digits, and a cyclic structure hits the
 * depth cap and stops rather than overflowing the stack.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = []
  writeCanonical(value, out, 0)
  return out.join('')
}

function writeCanonical(value: unknown, out: string[], depth: number): void {
  // A cycle in the input would otherwise recurse until the stack overflows and
  // take the calling tool handler with it; past the cap the value is simply no
  // longer distinguishable, which is the honest failure for something no real
  // filter produces.
  if (depth > MAX_CANONICAL_DEPTH) {
    out.push('null')
    return
  }
  if (value === null) {
    out.push('null')
    return
  }
  if (Array.isArray(value)) {
    // Array order is part of the value, so it is preserved; only OBJECT keys
    // are sorted, because their insertion order carries no meaning.
    out.push('[')
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(',')
      writeCanonical(value[i], out, depth + 1)
    }
    out.push(']')
    return
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value))
      return
    case 'number':
      out.push(Number.isFinite(value) ? JSON.stringify(value) : 'null')
      return
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return
    case 'bigint':
      // Collapsing a BigInt to `null` would make two different filters share
      // one cache key, so it is tagged instead.
      out.push('"bigint:')
      out.push(value.toString())
      out.push('"')
      return
    case 'object': {
      const record = value as Record<string, unknown>
      // Own enumerable properties only: an inherited enumerable property from a
      // prototype chain would make the same object canonicalise differently
      // depending on who handed it over.
      const keys = Object.keys(record).sort()
      out.push('{')
      for (let i = 0; i < keys.length; i += 1) {
        if (i > 0) out.push(',')
        out.push(JSON.stringify(keys[i]))
        out.push(':')
        writeCanonical(record[keys[i]], out, depth + 1)
      }
      out.push('}')
      return
    }
    default:
      out.push('null')
      return
  }
}

/**
 * Stable cache key for one retrieval.
 *
 * The prefix marks it as a retrieval key in the shared state directory, and the
 * 32 hex characters are a truncation of the SHA-256 of the canonical form: a
 * 128-bit prefix is far past the collision point for a table capped in the
 * thousands, and keeps the key short enough to read in a query log.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const digest = createHash('sha256').update(canonicalize(parts), 'utf8').digest('hex')
  return `q_${digest.slice(0, 32)}`
}
