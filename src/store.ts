import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  addColumnIfMissing,
  createIndexIfMissing,
  migrate,
  type MigrationReport,
  type MigrationStep,
} from './migration.js'
import { contentHash, deriveChunkId, deriveEvidenceId, deriveSourceId } from './provenance.js'
import type { EvidenceRecord, RetentionClass, SearchHit } from './types.js'

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
  readonly sourceId?: string
  readonly sourceType?: string
  readonly pathOrUrl?: string
  /** Aggregate hash over this source's chunks, in ordinal order. */
  readonly contentHash?: string
  readonly updatedAt?: number
  /** Epoch ms of the first write that ever created this source row. */
  readonly firstSeenAt?: number
  readonly retention?: RetentionClass
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
  /** Inclusive lower bound on the chunk's last-write time. Epoch ms. */
  readonly updatedAfter?: number
  /** Inclusive upper bound on the chunk's last-write time. Epoch ms. */
  readonly updatedBefore?: number
  /** Restrict to chunks produced while this session was active. */
  readonly sessionId?: string
  /**
   * Temporal ordering. `latest` puts the most recently written chunk first and
   * `historical` the oldest, so a caller asking for history is not handed the
   * newest evidence ranked by BM25 and told it is history. Both orderings break
   * ties with `bm25` so the sequence stays deterministic.
   */
  readonly temporal?: 'any' | 'latest' | 'historical'
}

/**
 * Everything a caller may say about where an indexed body came from.
 *
 * All fields are optional so that the two existing call sites (`ctx_index`,
 * `ctx_batch_execute`, `ctx_fetch_and_index`) can keep their current behaviour
 * while gaining provenance: an absent field is absent from the stored row, never
 * filled with a guess.
 */
export interface IndexProvenance {
  readonly sourceType?: string
  readonly pathOrUrl?: string
  readonly command?: string
  readonly sessionId?: string
  readonly retention?: RetentionClass
  /**
   * Character ranges of `text` that came verbatim from one file, so a chunk
   * that lands inside a range can carry a real line number. Without anchors the
   * store stores NULL and never invents a line.
   */
  readonly anchors?: readonly LineAnchor[]
}

/** One file's verbatim span inside the combined body handed to the store. */
export interface LineAnchor {
  readonly path: string
  /** Inclusive start offset of the file body, after its `FILE <path>` header. */
  readonly from: number
  /** Exclusive end offset of the file body. */
  readonly to: number
}

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
  /** Chunks carrying provenance rows. Equal to `chunks` after a migration. */
  readonly evidence: number
  /** Chunks whose stored hash no longer matches the text the index holds. */
  readonly stale: number
  /** Bumped by every content mutation; the retrieval cache keys off it. */
  readonly corpusVersion: number
}

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

/** One row handed to the garbage collector. */
export interface StoreGcRecord {
  readonly kind: 'source' | 'chunk'
  readonly id: string
  readonly source: string
  readonly retention: RetentionClass
  readonly bytes: number
  readonly updatedAt: number
  readonly referenced: boolean
}

/** Answer to "is the evidence I was given earlier still current?". */
export interface EvidenceCheck {
  readonly found: boolean
  readonly stale: boolean
  /** True when the chunk was written again after it was first indexed. */
  readonly rewritten: boolean
  readonly reason?: string
  readonly evidence?: EvidenceRecord
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

/** Ceiling on the rows one `chunksOfSource` call will read, boundedly. */
const MAX_SOURCE_LIST_CHUNKS = 200

/**
 * Ceiling on the characters one source-text read may return.
 *
 * `ctx_diff` needs the whole of both sides to diff them, so this is the only
 * path that reads an unbounded body back out of the store. The tool reports
 * `truncated` rather than silently diffing a prefix as if it were the source.
 */
export const MAX_SOURCE_TEXT_CHARS = 120_000

/**
 * The two schema steps this store is built from.
 *
 * Version 1 is the v0.1.0 baseline and is written so that it is idempotent: the
 * `IF NOT EXISTS` statements are what the plugin has always run at open, and
 * running them again on a database that already satisfies them is a no-op.
 * Version 2 adds provenance. It is the first step that changes a shape, and it
 * is the reason the runner in `migration.ts` exists at all.
 */
export function indexMigrations(): readonly MigrationStep[] {
  return [
    {
      version: 1,
      name: 'baseline-fts5',
      apply: (db) => {
        // No PRAGMA here: `journal_mode` cannot be changed from inside a
        // transaction, and every step of a migration runs inside one. The
        // connection is already in WAL when the runner starts.
        db.exec(`
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
      },
    },
    {
      version: 2,
      name: 'provenance-and-temporal',
      apply: (db) => {
        addColumnIfMissing(db, 'sources', 'source_id', 'TEXT')
        addColumnIfMissing(db, 'sources', 'source_type', "TEXT NOT NULL DEFAULT 'index'")
        addColumnIfMissing(db, 'sources', 'path_or_url', 'TEXT')
        addColumnIfMissing(db, 'sources', 'command', 'TEXT')
        addColumnIfMissing(db, 'sources', 'session_id', 'TEXT')
        addColumnIfMissing(db, 'sources', 'retention', "TEXT NOT NULL DEFAULT 'project'")
        addColumnIfMissing(db, 'sources', 'content_hash', "TEXT NOT NULL DEFAULT ''")
        addColumnIfMissing(db, 'sources', 'updated_at', 'INTEGER NOT NULL DEFAULT 0')
        addColumnIfMissing(db, 'sources', 'first_seen_at', 'INTEGER NOT NULL DEFAULT 0')
        db.exec(`
          CREATE TABLE IF NOT EXISTS chunk_meta(
            source TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            source_id TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            char_len INTEGER NOT NULL,
            line_start INTEGER,
            line_end INTEGER,
            session_id TEXT,
            retention TEXT NOT NULL DEFAULT 'project',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            first_seen_at INTEGER NOT NULL,
            PRIMARY KEY(source, ordinal)
          );
        `)
        createIndexIfMissing(
          db,
          'idx_chunk_meta_source_id',
          'CREATE INDEX idx_chunk_meta_source_id ON chunk_meta(source_id, ordinal)',
        )
        createIndexIfMissing(
          db,
          'idx_chunk_meta_evidence_id',
          'CREATE UNIQUE INDEX idx_chunk_meta_evidence_id ON chunk_meta(evidence_id)',
        )
        createIndexIfMissing(
          db,
          'idx_chunk_meta_updated_at',
          'CREATE INDEX idx_chunk_meta_updated_at ON chunk_meta(updated_at DESC)',
        )
        createIndexIfMissing(
          db,
          'idx_sources_source_id',
          'CREATE UNIQUE INDEX idx_sources_source_id ON sources(source_id)',
        )
        createIndexIfMissing(
          db,
          'idx_sources_updated_at',
          'CREATE INDEX idx_sources_updated_at ON sources(updated_at DESC)',
        )
        db.exec(`
          CREATE TABLE IF NOT EXISTS store_meta(
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `)
        backfillProvenance(db)
      },
    },
  ]
}

/**
 * Give the chunks a v0.1 database already had the provenance it was written
 * without.
 *
 * The hashes are computed from the text FTS5 still holds, so they describe the
 * corpus that is actually stored rather than a rebuild. Line numbers are left
 * NULL on purpose: the old index kept no per-file offsets, and a line number
 * invented now would be indistinguishable from a real one later.
 */
function backfillProvenance(db: DatabaseSync): void {
  const unbackfilled = db
    .prepare(
      `SELECT source, ordinal, text FROM chunks_fts
       WHERE NOT EXISTS (SELECT 1 FROM chunk_meta WHERE chunk_meta.source = chunks_fts.source AND chunk_meta.ordinal = chunks_fts.ordinal)`,
    )
    .all() as unknown as Array<{ source: string; ordinal: number; text: string }>
  if (unbackfilled.length === 0) return

  const insertMeta = db.prepare(
    `INSERT OR IGNORE INTO chunk_meta(source, ordinal, source_id, evidence_id, content_hash, char_len, line_start, line_end, session_id, retention, created_at, updated_at, first_seen_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const perSource = new Map<string, { hashes: string[]; updatedAt: number }>()
  for (const row of unbackfilled) {
    const sourceId = deriveSourceId(row.source)
    const hash = contentHash(row.text)
    const evidenceId = deriveEvidenceId(sourceId, row.ordinal)
    const stored = perSource.get(row.source)
    const bucket = stored ?? { hashes: [], updatedAt: 0 }
    bucket.hashes.push(hash)
    perSource.set(row.source, bucket)
    insertMeta.run(
      row.source,
      row.ordinal,
      sourceId,
      evidenceId,
      hash,
      row.text.length,
      null,
      null,
      null,
      'project',
      0,
      0,
      0,
    )
  }

  const sourceRows = db
    .prepare('SELECT name, indexed_at FROM sources')
    .all() as unknown as Array<{ name: string; indexed_at: number }>
  const indexedAtOf = new Map(sourceRows.map((row) => [row.name, Number(row.indexed_at)]))
  const updateSource = db.prepare(
    `UPDATE sources SET source_id = ?, source_type = COALESCE(NULLIF(source_type, ''), 'index'),
       path_or_url = COALESCE(path_or_url, ?), content_hash = ?, updated_at = ?, first_seen_at = ?
     WHERE name = ?`,
  )
  for (const [source, bucket] of perSource) {
    const indexedAt = indexedAtOf.get(source) ?? 0
    bucket.updatedAt = indexedAt
    const aggregate = contentHash(bucket.hashes.join(':'))
    const pathOrUrl = source.startsWith('url:') ? source.slice(4) : source
    updateSource.run(
      deriveSourceId(source),
      pathOrUrl,
      aggregate,
      indexedAt,
      indexedAt,
      source,
    )
  }
}

/**
 * FTS5-backed content store with provenance and temporal metadata.
 *
 * The original store kept an in-memory array and ranked it by counting how many
 * query terms each chunk happened to contain — no stemming, no persistence, and
 * the whole index vanished on restart. This persists to SQLite and lets FTS5's
 * BM25 do the ranking, which is the whole point of indexing in the first place.
 *
 * Chunk identity is `(source, ordinal)` and does not change when a source is
 * re-indexed, which is what makes an evidence id stable across refreshes. The
 * hash and the timestamps ride alongside it, so "the same evidence, different
 * content now" is answerable without keeping a history the store has no room
 * for.
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
    // Set before the runner opens its first transaction, because SQLite refuses
    // to change journal mode from inside one.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `)
    this.report = migrate(this.db, file, indexMigrations())
  }

  /** What migration did when this store was opened, for `ctx_doctor`. */
  readonly report: MigrationReport

  get path(): string {
    return this.file
  }

  /**
   * The raw database handle.
   *
   * Handed to the retrieval cache and the relationship graph so both can share
   * this store's connection, its WAL, and its write lock rather than opening a
   * third database file per feature. Neither module is given any path.
   */
  get database(): DatabaseSync {
    return this.db
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
  indexSource(source: string, text: string, provenance?: IndexProvenance): IndexResult {
    if (text.length === 0) {
      return {
        source,
        chunks: this.chunkCountOf(source),
        applied: false,
        ...this.identityOf(source),
      }
    }
    const written = this.transaction(() => {
      this.removeSource(source)
      const count = this.add(source, text, provenance)
      const now = Date.now()
      const sourceId = deriveSourceId(source)
      const hashes = this.chunkHashesOf(source)
      // A source that indexed nothing must not show up as a source in stats:
      // counting zero-chunk entries inflates the number and tells an operator
      // that something was captured when nothing was. `text` is non-empty here,
      // so `count` is always at least one chunk.
      this.db
        .prepare(
          `INSERT INTO sources(name, source_id, source_type, path_or_url, command, session_id, retention,
             chunk_count, content_hash, indexed_at, updated_at, first_seen_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          source,
          sourceId,
          provenance?.sourceType ?? 'index',
          provenance?.pathOrUrl ?? null,
          provenance?.command ?? null,
          provenance?.sessionId ?? null,
          provenance?.retention ?? retentionOf(provenance?.sourceType),
          count,
          contentHash(hashes.join(':')),
          now,
          now,
          // Kept across a refresh: `first_seen_at` is the answer to "when did
          // this source first enter the store", and a re-index that reset it
          // would make every source look brand new after its first refresh.
          this.firstSeenOf(source) ?? now,
        )
      this.bumpCorpus()
      return count
    })
    return {
      source,
      chunks: written,
      applied: true,
      sourceId: deriveSourceId(source),
      sourceType: provenance?.sourceType ?? 'index',
      ...(provenance?.pathOrUrl === undefined ? {} : { pathOrUrl: provenance.pathOrUrl }),
      contentHash: this.sourceHashOf(source),
      updatedAt: Date.now(),
      firstSeenAt: this.firstSeenOf(source) ?? Date.now(),
      retention: provenance?.retention ?? retentionOf(provenance?.sourceType),
    }
  }

  /** Chunks currently stored for one source, as recorded when it was last written. */
  private chunkCountOf(source: string): number {
    const row = this.db
      .prepare('SELECT chunk_count FROM sources WHERE name = ?')
      .get(source) as { chunk_count: number } | undefined
    return row === undefined ? 0 : Number(row.chunk_count)
  }

  /** Identity of a source that was NOT written by this call (the empty-body path). */
  private identityOf(source: string): Record<string, unknown> {
    const row = this.db
      .prepare(
        `SELECT source_id, source_type, path_or_url, content_hash, updated_at, first_seen_at, retention
         FROM sources WHERE name = ?`,
      )
      .get(source) as
      | {
          source_id: string
          source_type: string
          path_or_url: string | null
          content_hash: string
          updated_at: number
          first_seen_at: number
          retention: string
        }
      | undefined
    if (row === undefined) return {}
    return {
      sourceId: row.source_id,
      sourceType: row.source_type,
      ...(row.path_or_url === null ? {} : { pathOrUrl: row.path_or_url }),
      contentHash: row.content_hash,
      updatedAt: Number(row.updated_at),
      firstSeenAt: Number(row.first_seen_at),
      retention: row.retention as RetentionClass,
    }
  }

  private firstSeenOf(source: string): number | undefined {
    const row = this.db
      .prepare('SELECT first_seen_at FROM sources WHERE name = ?')
      .get(source) as { first_seen_at: number | null } | undefined
    const value = row?.first_seen_at
    return typeof value === 'number' && value > 0 ? value : undefined
  }

  private sourceHashOf(source: string): string | undefined {
    const row = this.db
      .prepare('SELECT content_hash FROM sources WHERE name = ?')
      .get(source) as { content_hash: string } | undefined
    return row?.content_hash
  }

  /** Hashes of every chunk of `source`, in ordinal order. */
  private chunkHashesOf(source: string): string[] {
    const rows = this.db
      .prepare('SELECT content_hash FROM chunk_meta WHERE source = ? ORDER BY ordinal ASC')
      .all(source) as unknown as Array<{ content_hash: string }>
    return rows.map((row) => row.content_hash)
  }

  /**
   * Append one chunk without disturbing other sources.
   *
   * Chunk metadata is written in the same transaction as the text it describes.
   * Splitting them is how a store ends up with a corpus whose provenance rows
   * describe a different body than the one FTS5 answers from.
   */
  add(source: string, text: string, provenance?: IndexProvenance): number {
    if (text.length === 0) return 0
    const sourceId = deriveSourceId(source)
    return this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO chunks_fts(text, source, ordinal) VALUES(?,?,?)')
      const insertMeta = this.db.prepare(
        `INSERT INTO chunk_meta(source, ordinal, source_id, evidence_id, content_hash, char_len,
           line_start, line_end, session_id, retention, created_at, updated_at, first_seen_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      const retention = provenance?.retention ?? retentionOf(provenance?.sourceType)
      let count = 0
      for (let start = 0, ordinal = 0; start < text.length; start += CHUNK_CHARS, ordinal += 1) {
        const chunk = text.slice(start, start + CHUNK_CHARS)
        insert.run(chunk, source, ordinal)
        const range = lineRangeFor(text, start, start + chunk.length, provenance?.anchors)
        insertMeta.run(
          source,
          ordinal,
          sourceId,
          deriveEvidenceId(sourceId, ordinal),
          contentHash(chunk),
          chunk.length,
          range === undefined ? null : range.lineStart,
          range === undefined ? null : range.lineEnd,
          provenance?.sessionId ?? null,
          retention,
          Date.now(),
          Date.now(),
          Date.now(),
        )
        count += 1
      }
      return count
    })
  }

  removeSource(source: string): number {
    return this.transaction(() => {
      const result = this.db.prepare('DELETE FROM chunks_fts WHERE source = ?').run(source)
      this.db.prepare('DELETE FROM chunk_meta WHERE source = ?').run(source)
      this.db.prepare('DELETE FROM sources WHERE name = ?').run(source)
      this.bumpCorpus()
      return Number(result.changes)
    })
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
      this.db.exec('DELETE FROM chunk_meta')
      this.bumpCorpus()
      return { chunks, sources }
    })
  }

  /**
   * Monotonic counter of content mutations.
   *
   * The retrieval cache keys every entry off this number, so every write makes
   * the whole cached generation unreachable without the cache having to know
   * which source changed. It is written in the same transaction as the mutation
   * it follows, so a rolled-back write cannot leave the counter advanced — which
   * would silently expire a cache generation that is still correct.
   */
  private bumpCorpus(): void {
    this.db
      .prepare(
        `INSERT INTO store_meta(key, value) VALUES('corpus_version', '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
      )
      .run()
  }

  corpusVersion(): number {
    try {
      const row = this.db
        .prepare(`SELECT value FROM store_meta WHERE key = 'corpus_version'`)
        .get() as { value: string } | undefined
      const parsed = Number(row?.value ?? 0)
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
    } catch {
      return 0
    }
  }

  stats(): StoreStats {
    const chunks = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }).n,
    )
    const sources = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n,
    )
    const evidence = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM chunk_meta').get() as { n: number }).n,
    )
    const stale = this.staleCount()
    const disk = this.diskUsage()
    return {
      sources,
      chunks,
      bytes: disk.total,
      disk,
      evidence,
      stale,
      corpusVersion: this.corpusVersion(),
    }
  }

  /**
   * Chunks whose stored hash disagrees with the text FTS5 currently holds.
   *
   * A count, not a list: this runs on the diagnostics path, and a store with
   * 40 000 chunks must not materialise them to answer a health question.
   */
  private staleCount(): number {
    try {
      const rows = this.db
        .prepare(
          `SELECT chunk_meta.content_hash AS expected, chunks_fts.text AS text
           FROM chunk_meta JOIN chunks_fts
             ON chunks_fts.source = chunk_meta.source AND chunks_fts.ordinal = chunk_meta.ordinal`,
        )
        .all() as unknown as Array<{ expected: string; text: string }>
      let stale = 0
      for (const row of rows) {
        if (contentHash(row.text) !== row.expected) stale += 1
      }
      return stale
    } catch {
      return 0
    }
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
    const order = orderBy(options.sort, options.temporal)
    const limit = Math.max(1, Math.min(options.limit, 50))

    const where: string[] = ['chunks_fts MATCH ?']
    const bind: unknown[] = [Math.ceil(snippetChars * MAX_CHARS_PER_TOKEN), match]
    if (options.source !== undefined) {
      where.push('chunks_fts.source = ?')
      bind.push(options.source)
    }
    if (options.updatedAfter !== undefined) {
      where.push('chunk_meta.updated_at >= ?')
      bind.push(options.updatedAfter)
    }
    if (options.updatedBefore !== undefined) {
      where.push('chunk_meta.updated_at <= ?')
      bind.push(options.updatedBefore)
    }
    if (options.sessionId !== undefined) {
      where.push('chunk_meta.session_id = ?')
      bind.push(options.sessionId)
    }
    bind.push(limit)

    const sql =
      `SELECT chunks_fts.source AS source, chunks_fts.ordinal AS ordinal, `
      + `bm25(chunks_fts) AS relevance, `
      + `snippet(chunks_fts, 0, '»', '«', '…', ?) AS hit, `
      + `chunk_meta.evidence_id AS evidence_id, chunk_meta.source_id AS source_id, `
      + `chunk_meta.content_hash AS content_hash, chunk_meta.line_start AS line_start, `
      + `chunk_meta.line_end AS line_end, chunk_meta.updated_at AS updated_at, `
      + `chunk_meta.first_seen_at AS first_seen_at, `
      + `sources.source_type AS source_type, sources.path_or_url AS path_or_url `
      + `FROM chunks_fts `
      + `LEFT JOIN chunk_meta ON chunk_meta.source = chunks_fts.source AND chunk_meta.ordinal = chunks_fts.ordinal `
      + `LEFT JOIN sources ON sources.name = chunks_fts.source `
      + `WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`

    const rows = this.db.prepare(sql).all(...(bind as never[])) as unknown as Array<{
      source: string
      ordinal: number
      relevance: number
      hit: string
      evidence_id: string | null
      source_id: string | null
      content_hash: string | null
      line_start: number | null
      line_end: number | null
      updated_at: number | null
      first_seen_at: number | null
      source_type: string | null
      path_or_url: string | null
    }>

    return rows.map((row) => {
      const sourceId = row.source_id ?? deriveSourceId(row.source)
      return {
        source: row.source,
        ordinal: row.ordinal,
        score: -row.relevance,
        snippet: clipSnippet(row.hit, snippetChars),
        sourceId,
        chunkId: deriveChunkId(sourceId, row.ordinal),
        evidenceId: row.evidence_id ?? deriveEvidenceId(sourceId, row.ordinal),
        contentHash: row.content_hash ?? '',
        ...(row.line_start === null ? {} : { lineStart: Number(row.line_start) }),
        ...(row.line_end === null ? {} : { lineEnd: Number(row.line_end) }),
        updatedAt: Number(row.updated_at ?? 0),
        firstSeenAt: Number(row.first_seen_at ?? 0),
        sourceType: row.source_type ?? 'index',
        ...(row.path_or_url === null ? {} : { pathOrUrl: row.path_or_url }),
        stale: false,
      }
    })
  }

  /** One evidence record by id, with the chunk text attached. */
  evidenceOf(evidenceId: string): EvidenceRecord | undefined {
    if (!EVIDENCE_ID.test(evidenceId)) return undefined
    const row = this.db
      .prepare(
        `SELECT chunk_meta.source AS source, chunk_meta.ordinal AS ordinal, chunk_meta.source_id AS source_id,
                chunk_meta.evidence_id AS evidence_id, chunk_meta.content_hash AS content_hash,
                chunk_meta.char_len AS char_len, chunk_meta.line_start AS line_start,
                chunk_meta.line_end AS line_end, chunk_meta.session_id AS session_id,
                chunk_meta.created_at AS created_at, chunk_meta.updated_at AS updated_at,
                chunk_meta.first_seen_at AS first_seen_at,
                sources.source_type AS source_type, sources.path_or_url AS path_or_url,
                sources.command AS command, sources.indexed_at AS indexed_at,
                chunks_fts.text AS text
         FROM chunk_meta
         JOIN chunks_fts ON chunks_fts.source = chunk_meta.source AND chunks_fts.ordinal = chunk_meta.ordinal
         LEFT JOIN sources ON sources.name = chunk_meta.source
         WHERE chunk_meta.evidence_id = ?`,
      )
      .get(evidenceId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return toEvidenceRecord(row)
  }

  /** Every chunk of one source, bounded, in ordinal order. */
  evidenceOfSource(sourceId: string, limit = MAX_SOURCE_LIST_CHUNKS): EvidenceRecord[] {
    if (!SOURCE_ID.test(sourceId)) return []
    const cap = Math.max(1, Math.min(Math.floor(limit), MAX_SOURCE_LIST_CHUNKS))
    const rows = this.db
      .prepare(
        `SELECT chunk_meta.source AS source, chunk_meta.ordinal AS ordinal, chunk_meta.source_id AS source_id,
                chunk_meta.evidence_id AS evidence_id, chunk_meta.content_hash AS content_hash,
                chunk_meta.char_len AS char_len, chunk_meta.line_start AS line_start,
                chunk_meta.line_end AS line_end, chunk_meta.session_id AS session_id,
                chunk_meta.created_at AS created_at, chunk_meta.updated_at AS updated_at,
                chunk_meta.first_seen_at AS first_seen_at,
                sources.source_type AS source_type, sources.path_or_url AS path_or_url,
                sources.command AS command, sources.indexed_at AS indexed_at,
                chunks_fts.text AS text
         FROM chunk_meta
         JOIN chunks_fts ON chunks_fts.source = chunk_meta.source AND chunks_fts.ordinal = chunk_meta.ordinal
         LEFT JOIN sources ON sources.name = chunk_meta.source
         WHERE chunk_meta.source_id = ? ORDER BY chunk_meta.ordinal ASC LIMIT ?`,
      )
      .all(sourceId, cap) as unknown as Array<Record<string, unknown>>
    return rows.map(toEvidenceRecord)
  }

  /** Metadata row of one source, by its stable id. */
  sourceOf(sourceId: string): SourceMeta | undefined {
    if (!SOURCE_ID.test(sourceId)) return undefined
    const row = this.db
      .prepare(
        `SELECT name, source_id, source_type, path_or_url, command, session_id, retention,
                chunk_count, content_hash, indexed_at, updated_at, first_seen_at
         FROM sources WHERE source_id = ?`,
      )
      .get(sourceId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : normaliseSourceMeta(row)
  }

  /**
   * The newest evidence a session produced, bounded.
   *
   * This is what lets the resume snapshot carry `<important_evidence>` without
   * the snapshot builder having to know anything about retrieval: the session's
   * own writes are the evidence it is most likely to still need. The cap is
   * applied in SQL rather than by fetching and slicing, because a long session
   * can have written thousands of chunks and the snapshot only ever wants a
   * handful of the newest.
   */
  evidenceOfSession(sessionId: string, limit = 20): EvidenceRecord[] {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const cap = Math.max(1, Math.min(Math.floor(limit), 100))
    const rows = this.db
      .prepare(
        `SELECT chunk_meta.source AS source, chunk_meta.ordinal AS ordinal, chunk_meta.source_id AS source_id,
                chunk_meta.evidence_id AS evidence_id, chunk_meta.content_hash AS content_hash,
                chunk_meta.char_len AS char_len, chunk_meta.line_start AS line_start,
                chunk_meta.line_end AS line_end, chunk_meta.session_id AS session_id,
                chunk_meta.created_at AS created_at, chunk_meta.updated_at AS updated_at,
                chunk_meta.first_seen_at AS first_seen_at,
                sources.source_type AS source_type, sources.path_or_url AS path_or_url,
                sources.command AS command, sources.indexed_at AS indexed_at,
                chunks_fts.text AS text
         FROM chunk_meta
         JOIN chunks_fts ON chunks_fts.source = chunk_meta.source AND chunks_fts.ordinal = chunk_meta.ordinal
         LEFT JOIN sources ON sources.name = chunk_meta.source
         WHERE chunk_meta.session_id = ? ORDER BY chunk_meta.updated_at DESC, chunk_meta.source ASC LIMIT ?`,
      )
      .all(sessionId, cap) as unknown as Array<Record<string, unknown>>
    return rows.map(toEvidenceRecord)
  }

  /** The text of one source, bounded, used by `ctx_diff` and `ctx_expand`. */
  sourceText(source: string, maxChars = MAX_SOURCE_TEXT_CHARS): { text: string; truncated: boolean } {
    const cap = Math.max(0, Math.min(Math.floor(maxChars), MAX_SOURCE_TEXT_CHARS))
    if (cap === 0) return { text: '', truncated: true }
    const rows = this.db
      .prepare('SELECT text FROM chunks_fts WHERE source = ? ORDER BY ordinal ASC')
      .all(source) as unknown as Array<{ text: string }>
    let text = ''
    for (const row of rows) {
      text += row.text
      if (text.length >= cap) break
    }
    const truncated = text.length > cap
    return { text: truncated ? text.slice(0, cap) : text, truncated }
  }

  /**
   * Answer "is the evidence I was handed earlier still current?".
   *
   * Two different staleness questions live here and must not be conflated:
   *
   * - integrity: the hash stored with the chunk no longer matches the text the
   *   index holds. This is damage, and it is checked by re-hashing the text.
   * - currency: the chunk at this evidence id was written again after the
   *   caller saw it, which only a caller-supplied `seenHash` can reveal,
   *   because the store keeps one row per `(source, ordinal)` rather than a
   *   history it has no room for.
   */
  checkEvidence(evidenceId: string, seenHash?: string): EvidenceCheck {
    const record = this.evidenceOf(evidenceId)
    if (record === undefined) {
      return { found: false, stale: true, rewritten: false, reason: 'no evidence with that id' }
    }
    if (record.stale) {
      return {
        found: true,
        stale: true,
        rewritten: true,
        reason: 'the stored hash no longer matches the indexed text',
        evidence: record,
      }
    }
    if (seenHash !== undefined && seenHash !== record.contentHash) {
      return {
        found: true,
        stale: true,
        rewritten: true,
        reason: 'the chunk was written again since this evidence was issued',
        evidence: record,
      }
    }
    return {
      found: true,
      stale: false,
      rewritten: record.updatedAt > record.firstSeenAt,
      evidence: record,
    }
  }

  /** Records the garbage collector reasons about, bounded by `limit`. */
  gcRecords(limit = 5_000): StoreGcRecord[] {
    const cap = Math.max(1, Math.min(Math.floor(limit), 20_000))
    const rows = this.db
      .prepare(
        `SELECT s.name AS source, s.source_id AS source_id, s.retention AS retention,
                COALESCE(s.content_hash, '') AS content_hash, s.updated_at AS updated_at,
                (SELECT COALESCE(SUM(char_len), 0) FROM chunk_meta WHERE chunk_meta.source = s.name) AS bytes
         FROM sources s ORDER BY s.name ASC LIMIT ?`,
      )
      .all(cap) as unknown as Array<{
      source: string
      source_id: string
      retention: string
      content_hash: string
      updated_at: number
      bytes: number
    }>
    return rows.map((row) => ({
      kind: 'source' as const,
      id: row.source_id,
      source: row.source,
      retention: asRetentionClass(row.retention),
      bytes: Number(row.bytes) || 0,
      updatedAt: Number(row.updated_at) || 0,
      // A source is referenced when a relationship edge points at any of its
      // chunks: that edge is the only durable pointer this store holds, and
      // deleting the source under it would leave the graph naming evidence
      // that no longer exists.
      referenced: this.isReferenced(row.source_id),
    }))
  }

  /** True when any relationship edge carries an evidence id belonging to one of this source's chunks. */
  private isReferenced(sourceId: string): boolean {
    try {
      const row = this.db
        .prepare(
          `SELECT 1 AS hit FROM relationships WHERE evidence_id IN (
             SELECT evidence_id FROM chunk_meta WHERE source_id = ? ) LIMIT 1`,
        )
        .get(sourceId) as { hit: number } | undefined
      return row !== undefined
    } catch {
      // A store that predates the graph table, or one whose graph was dropped,
      // has no references to protect. Treating that as "everything is
      // referenced" would make GC refuse forever, so it is treated as none.
      return false
    }
  }

  /** Source ids a caller asked to keep, honoured verbatim by `ctx_gc`. */
  protectedIds(): readonly string[] {
    return []
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

/** One source's metadata row, as `ctx_expand` reports it. */
export interface SourceMeta {
  readonly source: string
  readonly sourceId: string
  readonly sourceType: string
  readonly pathOrUrl?: string
  readonly command?: string
  readonly sessionId?: string
  readonly retention: RetentionClass
  readonly chunkCount: number
  readonly contentHash: string
  readonly indexedAt: number
  readonly updatedAt: number
  readonly firstSeenAt: number
}

/** `ev_` plus 16 lowercase hex. Matches {@link deriveEvidenceId}. */
const EVIDENCE_ID = /^ev_[0-9a-f]{16}$/
/** `src_` plus 16 lowercase hex. Matches {@link deriveSourceId}. */
const SOURCE_ID = /^src_[0-9a-f]{16}$/

/**
 * Map a source type onto a retention class.
 *
 * One-shot command output is ephemeral because nothing will ever ask for it
 * again once the session that produced it is over; a session's own events live
 * as long as the session; indexed project content is the default. Nothing is
 * classified persistent by itself — that is an explicit operator choice at
 * index time, because a default that cannot be reclaimed is how a store grows
 * until the disk fills.
 */
function retentionOf(sourceType: string | undefined): RetentionClass {
  switch (sourceType) {
    case 'command':
    case 'batch':
      return 'ephemeral'
    case 'session':
      return 'session'
    default:
      return 'project'
  }
}

function asRetentionClass(value: unknown): RetentionClass {
  switch (value) {
    case 'ephemeral':
    case 'session':
    case 'project':
    case 'persistent':
      return value
    default:
      return 'project'
  }
}

function normaliseSourceMeta(row: Record<string, unknown>): SourceMeta {
  return {
    source: String(row.name),
    sourceId: String(row.source_id),
    sourceType: String(row.source_type ?? 'index'),
    ...(row.path_or_url === null || row.path_or_url === undefined
      ? {}
      : { pathOrUrl: String(row.path_or_url) }),
    ...(row.command === null || row.command === undefined ? {} : { command: String(row.command) }),
    ...(row.session_id === null || row.session_id === undefined
      ? {}
      : { sessionId: String(row.session_id) }),
    retention: asRetentionClass(row.retention),
    chunkCount: Number(row.chunk_count) || 0,
    contentHash: String(row.content_hash ?? ''),
    indexedAt: Number(row.indexed_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    firstSeenAt: Number(row.first_seen_at) || 0,
  }
}

function toEvidenceRecord(row: Record<string, unknown>): EvidenceRecord {
  const text = typeof row.text === 'string' ? row.text : ''
  const storedHash = String(row.content_hash ?? '')
  return {
    evidenceId: String(row.evidence_id),
    sourceId: String(row.source_id),
    chunkId: deriveChunkId(String(row.source_id), Number(row.ordinal)),
    source: String(row.source),
    ordinal: Number(row.ordinal),
    sourceType: String(row.source_type ?? 'index'),
    ...(row.path_or_url === null || row.path_or_url === undefined
      ? {}
      : { pathOrUrl: String(row.path_or_url) }),
    ...(row.line_start === null || row.line_start === undefined
      ? {}
      : { lineStart: Number(row.line_start) }),
    ...(row.line_end === null || row.line_end === undefined
      ? {}
      : { lineEnd: Number(row.line_end) }),
    ...(row.session_id === null || row.session_id === undefined
      ? {}
      : { sessionId: String(row.session_id) }),
    ...(row.command === null || row.command === undefined ? {} : { command: String(row.command) }),
    contentHash: storedHash,
    charLen: Number(row.char_len) || text.length,
    text,
    indexedAt: Number(row.indexed_at) || Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    firstSeenAt: Number(row.first_seen_at) || 0,
    stale: storedHash !== '' && contentHash(text) !== storedHash,
  }
}

/** SQL ORDER BY for the three ranking modes and three temporal modes. */
function orderBy(
  sort: SearchOptions['sort'],
  temporal: SearchOptions['temporal'],
): string {
  const relevance = 'bm25(chunks_fts) ASC, chunks_fts.rowid DESC'
  if (temporal === 'latest') return `chunk_meta.updated_at DESC, ${relevance}`
  if (temporal === 'historical') return `chunk_meta.updated_at ASC, ${relevance}`
  if (sort === 'timeline') return 'chunks_fts.rowid DESC'
  return relevance
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

/** Line range of `text[start,end)` inside the anchored file that contains it. */
function lineRangeFor(
  text: string,
  start: number,
  end: number,
  anchors: readonly LineAnchor[] | undefined,
): { lineStart: number; lineEnd: number } | undefined {
  if (anchors === undefined || anchors.length === 0) return undefined
  const anchor = anchors.find((candidate) => candidate.from <= start && start < candidate.to)
  if (anchor === undefined) return undefined
  // A chunk that straddles a file boundary has no single line range. Leaving it
  // NULL is the honest answer; splitting the chunk would change the chunk
  // boundaries every other part of the store depends on.
  if (end > anchor.to) return undefined
  const lineStart = 1 + countNewlines(text, anchor.from, start)
  return { lineStart, lineEnd: lineStart + countNewlines(text, start, end) }
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  const limit = Math.min(to, text.length)
  for (let i = Math.max(0, from); i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}
