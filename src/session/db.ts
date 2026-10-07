import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '../types.js'

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
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
    this.totalEvents = this.countEvents()
  }

  get path(): string {
    return this.file
  }

  record(event: SessionEvent): void {
    this.db
      .prepare(
        `INSERT INTO session_events(session_id, type, category, priority, content, metadata, created_at, cwd)
         VALUES (?,?,?,?,?,?,?,?)`,
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
      ? 'SELECT * FROM session_events WHERE session_id = ? ORDER BY id DESC'
      : 'SELECT * FROM session_events WHERE session_id = ? AND category = ? ORDER BY id DESC'
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
    }))
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