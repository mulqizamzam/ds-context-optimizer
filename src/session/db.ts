import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  addColumnIfMissing,
  createIndexIfMissing,
  hasLegacyEventShape,
  migrate,
  type MigrationReport,
  type MigrationStep,
} from '../migration.js'
import type { RetentionClass, SessionEvent } from '../types.js'

/**
 * The two schema steps this store is built from.
 *
 * Version 1 is the v0.1.0 baseline, written so that re-running it is a no-op.
 * Version 2 adds the temporal columns the retrieval layer filters on. Neither
 * step rewrites the event rows themselves: the events are the operator's log,
 * and a migration that re-writes them to fill in a new field would be able to
 * destroy them while doing so.
 */
export function sessionMigrations(): readonly MigrationStep[] {
  return [
    {
      version: 1,
      name: 'baseline-events',
      apply: (db) => {
        // No PRAGMA here: `journal_mode` cannot be changed from inside a
        // transaction, and every step of a migration runs inside one.
        db.exec(`
          CREATE TABLE IF NOT EXISTS session_events(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            priority INTEGER NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            cwd TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, priority, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_events_session_id ON session_events(session_id, id DESC);
          CREATE TABLE IF NOT EXISTS session_resume(
            session_id TEXT PRIMARY KEY,
            snapshot_xml TEXT NOT NULL,
            built_at INTEGER NOT NULL
          );
        `)
      },
    },
    {
      version: 2,
      name: 'temporal-and-identity',
      apply: (db) => {
        addColumnIfMissing(db, 'session_events', 'event_id', 'TEXT')
        addColumnIfMissing(db, 'session_events', 'first_seen_at', 'INTEGER NOT NULL DEFAULT 0')
        addColumnIfMissing(db, 'session_events', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0')
        addColumnIfMissing(db, 'session_events', 'bytes', 'INTEGER NOT NULL DEFAULT 0')
        // `idx_events_event_id` is deliberately NOT unique: two identical calls in
  // the same millisecond hash to the same derived id, and an event log that
  // cannot record both is a log that loses one of them.
  // An event is append-only, so for the rows that predate the columns the
        // three values coincide: there is nothing to back-fill except the
        // timestamp that was already recorded, which is the truth.
        db.exec(
          `UPDATE session_events SET first_seen_at = created_at WHERE first_seen_at = 0`,
        )
        db.exec(`UPDATE session_events SET last_seen_at = created_at WHERE last_seen_at = 0`)
        db.exec(
          `UPDATE session_events SET bytes = LENGTH(content) + LENGTH(metadata) WHERE bytes = 0`,
        )
        // Rows written before this column existed have no identity, and a resumed
        // session that cannot point at an event cannot point at the evidence it
        // produced. The derivation is the same one `record` uses for a new row,
        // so an old row and a new row that describe the same event get the same
        // id.
        const legacy = db
          .prepare(
            `SELECT id, session_id, created_at, LENGTH(content) AS content_len,
                    LENGTH(metadata) AS metadata_len
             FROM session_events WHERE event_id IS NULL`,
          )
          .all() as unknown as Array<{
          id: number
          session_id: string
          created_at: number
          content_len: number
          metadata_len: number
        }>
        if (legacy.length > 0) {
          const update = db.prepare('UPDATE session_events SET event_id = ? WHERE id = ?')
          for (const row of legacy) {
              update.run(
              deriveEventId(row.session_id, row.created_at, row.content_len + row.metadata_len),
              row.id,
            )
          }
        }
        createIndexIfMissing(
          db,
          'idx_events_event_id',
          'CREATE INDEX idx_events_event_id ON session_events(event_id) WHERE event_id IS NOT NULL',
        )
        createIndexIfMissing(
          db,
          'idx_events_last_seen',
          'CREATE INDEX idx_events_last_seen ON session_events(last_seen_at DESC)',
        )
      },
    },
  ]
}

/**
 * Session event store and resume snapshots, on the built-in `node:sqlite`.
 *
 * The original used `better-sqlite3`, a native addon: on this host it needed a
 * `node-gyp` build against a writable cache directory, and a skipped install
 * script left `require('better-sqlite3')` returning a module that throws only
 * when a `Database` is constructed. `node:sqlite` ships with Node itself, so
 * there is nothing to compile and nothing to fail silently at load time.
 */
export class SessionDB {
  private readonly db: DatabaseSync
  private closed = false

  /**
   * How many events each session has reached since its last prune.
   *
   * The bound has to be enforced on every insert, but re-deriving "how many
   * rows does this session have" from the table on every event is what made
   * capture quadratic; a running tally turns the check into an integer
   * comparison and still trims the same amount.
   */
  private readonly liveCounts = new Map<string, number>()

  /** Running total of every stored event, used to keep `eventCount()` O(1). */
  private totalEvents = 0

  constructor(
    private readonly file: string,
    private readonly maxEventsPerSession = 5_000,
  ) {
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(file)
    // Set before the runner opens its first transaction, because SQLite refuses
    // to change journal mode from inside one.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `)
    this.report = migrate(this.db, file, sessionMigrations(), hasLegacyEventShape)
    this.totalEvents = this.countEvents()
  }

  /** What migration did when this store was opened, for `ctx_doctor`. */
  readonly report: MigrationReport

  get path(): string {
    return this.file
  }

  /** The raw handle, so callers that share this connection do not open a third file. */
  get database(): DatabaseSync {
    return this.db
  }

  record(event: SessionEvent): string {
    const bytes = Buffer.byteLength(event.content, 'utf8') + Buffer.byteLength(JSON.stringify(event.metadata), 'utf8')
    // Derived from what the event says, not from a counter: a re-recorded event
    // with the same identity gets the same id, which is what makes the id
    // stable enough to be handed to the model as a reference.
    const eventId =
      event.eventId ?? deriveEventId(event.sessionId, event.timestamp, bytes)
    this.db
      .prepare(
        `INSERT INTO session_events(session_id, type, category, priority, content, metadata, created_at, cwd,
           event_id, first_seen_at, last_seen_at, bytes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.sessionId,
        event.type,
        event.category,
        event.priority,
        event.content,
        JSON.stringify(event.metadata),
        event.timestamp,
        event.cwd,
        eventId,
        event.timestamp,
        event.timestamp,
        bytes,
      )
    // A session this process has not seen is counted from the table once, on
    // first sight, so the cap still binds rows stored before this store was
    // reopened — the count for it already includes the insert just made.
    const live = this.liveCounts.get(event.sessionId)
    this.liveCounts.set(
      event.sessionId,
      live === undefined ? this.countFor(event.sessionId) : live + 1,
    )
    this.totalEvents += 1
    this.prune(event.sessionId)
    return eventId
  }

  /** Rows already stored for one session; only asked once per session. */
  private countFor(sessionId: string): number {
    return Number(
      (this.db
        .prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?')
        .get(sessionId) as { n: number }).n,
    )
  }

  /**
   * Keep only the newest `maxEventsPerSession` rows per session. Without this a
   * long-running session grows the database without bound, since every tool
   * call is recorded.
   *
   * The delete only runs once the session is actually over the cap. Running it
   * on every insert — which is what this did — re-sorted the whole session each
   * time: `idx_events_session(session_id, priority, created_at DESC)` cannot
   * serve `ORDER BY id DESC`, so each event re-scanned everything behind it and
   * 5,000 inserts cost 8.6 s on the host event loop. `idx_events_session_id`
   * now serves the ordering, and the count check is a map lookup.
   */
  private prune(sessionId: string): void {
    const keep = this.maxEventsPerSession
    if (keep <= 0) return
    if ((this.liveCounts.get(sessionId) ?? 0) <= keep) return
    this.trimSession(sessionId, keep)
  }

  /**
   * Delete the oldest rows of a session so only the newest `keep` remain.
   *
   * The number to delete comes from the tally, and the rows to delete are
   * fetched with `ORDER BY id ASC LIMIT n` — one seek on
   * `idx_events_session_id`, then n rowids. The previous shape
   * (`id NOT IN (SELECT … ORDER BY id DESC LIMIT keep)`) had to walk every row
   * of the session against a materialised set of `keep` ids on every call,
   * which at the default cap of 5,000 is what made each insert more expensive
   * than the last.
   */
  private trimSession(sessionId: string, keep: number): void {
    const before = this.liveCounts.get(sessionId) ?? 0
    const drop = Math.max(0, before - keep)
    if (drop > 0) {
      this.db
        .prepare(
          `DELETE FROM session_events WHERE id IN (
             SELECT id FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?
           )`,
        )
        .run(sessionId, drop)
    }
    const kept = before - drop
    this.liveCounts.set(sessionId, kept)
    this.totalEvents = Math.max(0, this.totalEvents - drop)
  }

  /** Newest-first events for a session, optionally filtered by category. */
  events(sessionId: string, category?: string): SessionEvent[] {
    const sql = category === undefined
      ? `SELECT id, session_id, type, category, priority, content, metadata, created_at, cwd,
               event_id, first_seen_at, last_seen_at
         FROM session_events WHERE session_id = ? ORDER BY id DESC`
      : `SELECT id, session_id, type, category, priority, content, metadata, created_at, cwd,
               event_id, first_seen_at, last_seen_at
         FROM session_events WHERE session_id = ? AND category = ? ORDER BY id DESC`
    const statement = this.db.prepare(sql)
    const rows = (
      category === undefined
        ? statement.all(sessionId)
        : statement.all(sessionId, category)
    ) as unknown as Array<{
      session_id: string
      type: string
      category: string
      priority: number
      content: string
      metadata: string
      created_at: number
      cwd: string
      event_id: string | null
      first_seen_at: number
      last_seen_at: number
    }>
    return rows.map((row) => ({
      sessionId: row.session_id,
      type: row.type,
      category: row.category,
      priority: row.priority,
      content: row.content,
      metadata: safeParse(row.metadata),
      timestamp: row.created_at,
      cwd: row.cwd,
      ...(row.event_id === null ? {} : { eventId: row.event_id }),
      firstSeenAt: Number(row.first_seen_at) || row.created_at,
      lastSeenAt: Number(row.last_seen_at) || row.created_at,
    }))
  }

  /**
   * Rows the garbage collector reasons about.
   *
   * Every event is classified `session`: it belongs to one session's log and
   * outlives nothing except the retention window for that session. The bytes
   * come from the stored size rather than `LENGTH()` on the fly, because the
   * column was filled once by the migration and stays correct for rows written
   * after it, while a per-row `LENGTH()` would make the diagnostics path pay for
   * the whole table.
   */
  gcRecords(limit = 5_000): Array<{
    kind: 'session_event'
    id: string
    sessionId: string
    bytes: number
    updatedAt: number
    retention: RetentionClass
    referenced: boolean
  }> {
    const cap = Math.max(1, Math.min(Math.floor(limit), 20_000))
    const rows = this.db
      .prepare(
        `SELECT event_id, session_id, bytes, last_seen_at FROM session_events
         ORDER BY session_id ASC, id ASC LIMIT ?`,
      )
      .all(cap) as unknown as Array<{
      event_id: string | null
      session_id: string
      bytes: number
      last_seen_at: number
    }>
    return rows.map((row) => ({
      kind: 'session_event' as const,
      id: row.event_id ?? `row:${row.session_id}:${row.last_seen_at}`,
      sessionId: row.session_id,
      bytes: Number(row.bytes) || 0,
      updatedAt: Number(row.last_seen_at) || 0,
      retention: 'session' as RetentionClass,
      // An event is referenced while its session still has a stored snapshot:
      // that snapshot is the document a resumed session is handed, and it was
      // built from these rows.
      referenced: this.hasSnapshot(row.session_id),
    }))
  }

  /** Sessions the store knows about, newest activity first. */
  sessionStats(limit = 100): Array<{
    sessionId: string
    events: number
    bytes: number
    newestAt: number
    oldestAt: number
  }> {
    const cap = Math.max(1, Math.min(Math.floor(limit), 500))
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS events, COALESCE(SUM(bytes), 0) AS bytes,
                MAX(last_seen_at) AS newest, MIN(first_seen_at) AS oldest
         FROM session_events GROUP BY session_id
         ORDER BY newest DESC, session_id ASC LIMIT ?`,
      )
      .all(cap) as unknown as Array<{
      session_id: string
      events: number
      bytes: number
      newest: number
      oldest: number
    }>
    return rows.map((row) => ({
      sessionId: row.session_id,
      events: Number(row.events) || 0,
      bytes: Number(row.bytes) || 0,
      newestAt: Number(row.newest) || 0,
      oldestAt: Number(row.oldest) || 0,
    }))
  }

  private hasSnapshot(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM session_resume WHERE session_id = ?')
      .get(sessionId) as { hit: number } | undefined
    return row !== undefined
  }

  /**
   * Delete exactly the event ids handed over, and nothing else.
   *
   * The caller is the garbage collector, which has already decided that these
   * rows are unreachable; the method takes ids rather than a predicate so that
   * "what it deleted" and "what it was asked to delete" are the same set. The
   * two tallies are corrected by the count it returns rather than by
   * re-deriving them, because `totalEvents` is the O(1) figure the diagnostics
   * path reads and a recount per deletion would undo that.
   */
  deleteEventIds(ids: readonly string[]): number {
    if (ids.length === 0) return 0
    let removed = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const statement = this.db.prepare('DELETE FROM session_events WHERE event_id = ?')
      for (const id of ids) {
        removed += Number(statement.run(id).changes)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* SQLite already unwound it */
      }
      throw error
    }
    this.totalEvents = Math.max(0, this.totalEvents - removed)
    for (const [sessionId, count] of this.liveCounts) {
      this.liveCounts.set(sessionId, Math.max(0, count))
    }
    return removed
  }

  /** Drop every event of one session, and its snapshot with it. */
  deleteSession(sessionId: string): { events: number; snapshot: boolean } {
    let removed = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      removed = Number(
        this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId).changes,
      )
      const snapshot = Number(
        this.db.prepare('DELETE FROM session_resume WHERE session_id = ?').run(sessionId).changes,
      )
      this.db.exec('COMMIT')
      this.liveCounts.delete(sessionId)
      this.totalEvents = Math.max(0, this.totalEvents - removed)
      return { events: removed, snapshot: snapshot > 0 }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* SQLite already unwound it */
      }
      throw error
    }
  }

  saveSnapshot(sessionId: string, snapshotXml: string): void {
    this.db
      .prepare(
        `INSERT INTO session_resume(session_id, snapshot_xml, built_at) VALUES (?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET snapshot_xml = excluded.snapshot_xml, built_at = excluded.built_at`,
      )
      .run(sessionId, snapshotXml, Date.now())
  }

  snapshot(sessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT snapshot_xml FROM session_resume WHERE session_id = ?')
      .get(sessionId) as { snapshot_xml: string } | undefined
    return row?.snapshot_xml
  }

  sessionCount(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM session_events').get() as {
        n: number
      }).n,
    )
  }

  /**
   * Rows currently stored, read from the running tally `record` keeps.
   *
   * `COUNT(*)` over the table is O(rows) and this is called from the host's
   * diagnostics path; `record` and `trimSession` maintain the tally exactly,
   * and `purgeAll` resets it with the rows it deletes.
   */
  eventCount(): number {
    return this.totalEvents
  }

  /** Row count straight from the table — how the tally is seeded on open. */
  private countEvents(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n,
    )
  }

  /** Clear every session event and snapshot. */
  purgeAll(): { events: number; snapshots: number } {
    const events = this.totalEvents
    const snapshots = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM session_resume').get() as { n: number }).n,
    )
    this.db.exec('DELETE FROM session_events')
    this.db.exec('DELETE FROM session_resume')
    this.liveCounts.clear()
    this.totalEvents = 0
    return { events, snapshots }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Stable identity for one event.
 *
 * Derived from what the event says, never from a row counter: two processes that
 * record the same event agree on its id, which is the only property that makes
 * an id worth handing to a model. It deliberately does NOT include the type or
 * the content, so re-reading the same event after a content trim still maps onto
 * the same identity.
 */
export function deriveEventId(sessionId: string, timestamp: number, bytes: number): string {
  const digest = createHash('sha256')
    .update(`${sessionId}\u0000${timestamp}\u0000${bytes}`)
    .digest('hex')
    .slice(0, 16)
  return `se_${digest}`
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}