import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SearchHit } from './types.js'

export interface StoreStats {
  readonly sources: number
  readonly chunks: number
  /**
   * Bytes this store occupies on disk: the main database file plus its WAL and
   * shared-memory sidecars. A bare main-file size under-reports by ~40% while
   * the WAL is uncheckpointed.
   */
  readonly bytes: number
  /** The same figure broken down, so a reader can see what it is made of. */
  readonly disk: StoreBytes
}

/** Outcome of one `indexSource` call. */
export interface IndexResult {
  readonly source: string
  /** Chunks now stored for `source` after this call. */
  readonly chunks: number
  /**
   * False when `text` was empty: nothing was written and any previous index
   * for this source was kept, still searchable.
   */
  readonly applied: boolean
}

export interface SearchOptions {
  readonly limit: number
  readonly source?: string
  readonly sort?: 'relevance' | 'timeline'
  /**
   * Excerpt budget in CHARACTERS of the returned snippet. Positive values are
   * honoured exactly (`snippet.length <= snippetChars`); absent, zero or
   * negative values fall back to the default budget — never "unlimited".
   */
  readonly snippetChars?: number
}

const CHUNK_CHARS = 4_000

/**
 * Default excerpt budget, in CHARACTERS of the final snippet.
 *
 * `snippet()` counts its sixth argument in FTS5 *tokens*, not characters, so
 * the number handed to FTS5 is derived from this and the returned text is then
 * clipped to this value. 240 characters is roughly four lines of prose.
 */
const DEFAULT_SNIPPET_CHARS = 240

/** Hard ceiling on a caller-supplied snippet budget. */
const MAX_SNIPPET_CHARS = 2_000

/**
 * Longest token the FTS5 unicode61 tokenizer can produce from a 4,000-char
 * chunk: a single word with no whitespace. Used to size the token dial before
 * the character clip, so the clip is the binding constraint rather than an
 * unlucky tokenizer split.
 */
const MAX_CHARS_PER_TOKEN = 64

/** Highlight markers wrapped around every matched token by `snippet()`. */
const HIGHLIGHT_OPEN = '»'
const HIGHLIGHT_CLOSE = '«'

/** What `stats()` measured, split by file, so `ctx_stats` can say what it counts. */
export interface StoreBytes {
  /** Main database file, as reported by the filesystem. */
  readonly file: number
  /** Write-ahead log, which holds committed pages the main file has not absorbed. */
  readonly wal: number
  /** Shared-memory index. Runtime metadata, never index content. */
  readonly shm: number
  /** Everything this store occupies on disk. */
  readonly total: number
}

/**
 * FTS5-backed content store.
 *
 * The original store kept an in-memory array and ranked it by counting how many
 * query terms each chunk happened to contain — no stemming, no persistence, and
 * the whole index vanished on restart. This persists to SQLite and lets FTS5's
 * BM25 do the ranking, which is the whole point of indexing in the first place.
 */
export class ContentStore {
  private readonly db: DatabaseSync
  private readonly file: string
  private inTransaction = false

  /**
   * Run one write body inside this store's transaction.
   *
   * `indexSource` composes its delete, insert and upsert out of these; it is
   * also the exposed boundary the atomicity contract is tested against, since a
   * competing writer cannot be made to fail at an exact statement between two
   * synchronous steps from outside. A failure anywhere inside — including one
   * raised after the old chunks are deleted — leaves the previous index intact.
   * Nested calls join the transaction already open rather than issuing their
   * own BEGIN, which SQLite would reject.
   */
  transaction<T>(body: () => T): T {
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

  constructor(file: string) {
    this.file = file
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sources(
        name TEXT PRIMARY KEY,
        chunk_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        source UNINDEXED,
        ordinal UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
  }

  get path(): string {
    return this.file
  }

  /**
   * Replace every chunk previously stored for `source` with `text`.
   *
   * The delete, the insert and the `sources` upsert are one transaction. Doing
   * them separately is what made a concurrent writer able to land between the
   * delete and the insert: the writer took the lock, `indexSource` threw, and
   * the previous index was already gone with nothing to replace it.
   *
   * An EMPTY body is refused before the delete is issued, so it cannot wipe an
   * existing source. `ctx_index` on a path that matches no files, a tree that is
   * entirely excluded, and re-pointing one `source` label at a different
   * directory all arrive with an empty body, and all three used to end with
   * `sources: 0, chunks: 0` and an unsearchable corpus while the caller still
   * reported success. Clearing a source on purpose is `removeSource` (or
   * `purge`), which is explicit and whose result callers can check.
   *
   * The `chunks` an empty call reports is the chunk count already stored for
   * `source` — what a reader of that number wants to know: the corpus is intact
   * and this size.
   */
  indexSource(source: string, text: string): IndexResult {
    if (text.length === 0) {
      return { source, chunks: this.chunkCountOf(source), applied: false }
    }
    const written = this.transaction(() => {
      this.removeSource(source)
      const count = this.add(source, text)
      // A source that indexed nothing must not show up as a source in stats:
      // counting zero-chunk entries inflates the number and tells an operator
      // that something was captured when nothing was. `text` is non-empty here,
      // so `count` is always at least one chunk.
      this.db
        .prepare('INSERT INTO sources(name, chunk_count, indexed_at) VALUES(?,?,?)')
        .run(source, count, Date.now())
      return count
    })
    return { source, chunks: written, applied: true }
  }

  /** Chunks currently stored for one source, as recorded when it was last written. */
  private chunkCountOf(source: string): number {
    const row = this.db
      .prepare('SELECT chunk_count FROM sources WHERE name = ?')
      .get(source) as { chunk_count: number } | undefined
    return row === undefined ? 0 : Number(row.chunk_count)
  }

  /** Append one chunk without disturbing other sources. */
  add(source: string, text: string): number {
    if (text.length === 0) return 0
    return this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO chunks_fts(text, source, ordinal) VALUES(?,?,?)')
      let count = 0
      for (let start = 0, ordinal = 0; start < text.length; start += CHUNK_CHARS, ordinal += 1) {
        insert.run(text.slice(start, start + CHUNK_CHARS), source, ordinal)
        count += 1
      }
      return count
    })
  }

  removeSource(source: string): number {
    const result = this.db.prepare('DELETE FROM chunks_fts WHERE source = ?').run(source)
    this.db.prepare('DELETE FROM sources WHERE name = ?').run(source)
    return Number(result.changes)
  }

  purge(): { chunks: number; sources: number } {
    return this.transaction(() => {
      const chunks = Number(
        (this.db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }).n,
      )
      const sources = Number(
        (this.db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n,
      )
      this.db.exec('DELETE FROM chunks_fts')
      this.db.exec('DELETE FROM sources')
      return { chunks, sources }
    })
  }

  stats(): StoreStats {
    const chunks = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }).n,
    )
    const sources = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n,
    )
    const disk = this.diskUsage()
    return { sources, chunks, bytes: disk.total, disk }
  }

  /**
   * Bytes this store occupies, sidecars included.
   *
   * `journal_mode = WAL` means committed pages sit in `index.sqlite-wal` until a
   * checkpoint absorbs them. Statting only the main file reported ~40% less
   * than the store really used, and a different number again after `close()`.
   */
  private diskUsage(): StoreBytes {
    const file = sizeOf(this.file)
    const wal = sizeOf(`${this.file}-wal`)
    const shm = sizeOf(`${this.file}-shm`)
    return { file, wal, shm, total: file + wal + shm }
  }

  /** Run one FTS5 query. Returns an empty list for a query with no usable terms. */
  search(query: string, options: SearchOptions): SearchHit[] {
    const match = toMatchExpression(query)
    if (match === null) return []

    const snippetChars = clampSnippetChars(options.snippetChars ?? DEFAULT_SNIPPET_CHARS)
    const order =
      options.sort === 'timeline'
        ? 'rowid DESC'
        : 'bm25(chunks_fts) ASC, rowid DESC'
    const limit = Math.max(1, Math.min(options.limit, 50))
    const where = options.source === undefined ? '' : ' AND source = ?'
    const sql =
      `SELECT source, ordinal, bm25(chunks_fts) AS relevance, `
      + `snippet(chunks_fts, 0, '»', '«', '…', ?) AS hit `
      + `FROM chunks_fts WHERE chunks_fts MATCH ?${where} ORDER BY ${order} LIMIT ?`

    const statement = this.db.prepare(sql)
    // FTS5's sixth snippet() argument counts TOKENS, not characters, so it is
    // only a rough dial here; `clipSnippet` enforces the character budget the
    // option name and the README promise.
    const bind: unknown[] = [Math.ceil(snippetChars * MAX_CHARS_PER_TOKEN), match]
    if (options.source !== undefined) bind.push(options.source)
    bind.push(limit)

    const rows = statement.all(...(bind as never[])) as unknown as Array<{
      source: string
      ordinal: number
      relevance: number
      hit: string
    }>
    return rows.map((row) => ({
      source: row.source,
      ordinal: row.ordinal,
      score: -row.relevance,
      snippet: clipSnippet(row.hit, snippetChars),
    }))
  }

  /** Close the database. Safe to call twice. */
  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Turn free text into a safe FTS5 MATCH expression.
 *
 * FTS5's grammar treats `-`, `*`, `:`, `(`, `"` and neighbours as operators, so
 * handing a raw query through raises a parse error on perfectly ordinary input
 * like `foo-bar` or `path/to`. Splitting first and quoting each term keeps the
 * whole surface in the literal grammar and can never inject a directive.
 */
export function toMatchExpression(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 32)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * Turn a caller-supplied snippet budget into a real character count.
 *
 * Zero and negatives used to reach FTS5 as "no token limit", which returned
 * the whole chunk — 6,665 characters from a 4,000-character document. A
 * non-finite value is meaningless too. Both fall back to the default budget;
 * every positive value is honoured up to the ceiling.
 */
function clampSnippetChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SNIPPET_CHARS
  return Math.min(Math.floor(value), MAX_SNIPPET_CHARS)
}

/** Clip an FTS5 excerpt to a character budget without unbalancing highlights. */
function clipSnippet(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  let head = value.slice(0, maxChars)
  // Never cut a surrogate pair in half: the lone half would render as a broken
  // code point in whatever renders the tool result.
  const tail = head.charCodeAt(head.length - 1)
  if (tail >= 0xd800 && tail <= 0xdbff) head = head.slice(0, -1)
  // Only rebalance when the complete excerpt was balanced to begin with:
  // source text may itself contain the marker characters.
  if (markersBalanced(value) && !markersBalanced(head)) {
    if (head.length < maxChars) {
      head += HIGHLIGHT_CLOSE
    } else if (head.endsWith(HIGHLIGHT_OPEN)) {
      head = head.slice(0, -1)
    } else {
      head = `${head.slice(0, -1)}${HIGHLIGHT_CLOSE}`
    }
  }
  return head
}

function markersBalanced(value: string): boolean {
  let opens = 0
  let closes = 0
  for (const char of value) {
    if (char === HIGHLIGHT_OPEN) opens += 1
    else if (char === HIGHLIGHT_CLOSE) closes += 1
  }
  return opens === closes
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}