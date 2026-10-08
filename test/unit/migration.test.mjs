/**
 * Schema-migration tests for the two local stores.
 *
 * These drive `migrate` against real SQLite files on disk rather than a mock,
 * because the failure mode the module exists to prevent is invisible to a mock:
 * a corpus that reports `chunks: 39` while the provenance join behind it
 * matches nothing. Every fixture here is a `fs.mkdtempSync` temp directory
 * closed in `finally`, so one test's schema can never answer for another's.
 *
 * The v0.1 fixtures are written by hand, exactly as the pre-versioning plugin
 * wrote them, because that is the only way to exercise the legacy-adoption path
 * the runner was added for.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { MigrationError, columnNames, currentVersion, migrate, tableExists } from '../../dist/migration.js'
import { ContentStore, indexMigrations } from '../../dist/store.js'
import { SessionDB, sessionMigrations } from '../../dist/session/db.js'

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

/**
 * `node:sqlite` hands back null-prototype row objects, which
 * `deepStrictEqual` correctly refuses to match against an object literal. The
 * rows are plainified here so the comparison stays structural.
 */
const plain = (rows) => rows.map((row) => ({ ...row }))

test('a brand-new database migrates to the newest version and records the steps it applied', () => {
  const dir = temp('ctxopt-mig-fresh-')
  try {
    const file = path.join(dir, 'index.sqlite')
    const db = new DatabaseSync(file)
    try {
      const report = migrate(db, file, indexMigrations())
      assert.equal(report.fromVersion, 0, 'a fresh file did not start at version 0')
      assert.equal(report.toVersion, 2, 'the store did not reach the newest step')
      assert.deepEqual([...report.applied], ['baseline-fts5', 'provenance-and-temporal'])
      assert.equal(report.adoptedLegacy, false, 'an empty file was mistaken for a legacy one')
      assert.equal(currentVersion(db), 2)

      // The steps really ran, rather than only being recorded: the tables the
      // newest version needs are present with the columns it added.
      assert.equal(tableExists(db, 'chunks_fts'), true)
      assert.equal(tableExists(db, 'chunk_meta'), true)
      assert.equal(tableExists(db, 'store_meta'), true)
      assert.equal(columnNames(db, 'sources').includes('source_id'), true, 'provenance columns never landed')
      assert.deepEqual(
        plain(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all()),
        [
          { version: 1, name: 'baseline-fts5' },
          { version: 2, name: 'provenance-and-temporal' },
        ],
      )
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a v0.1 database migrates without losing its row, and never invents a line number', () => {
  const dir = temp('ctxopt-mig-legacy-')
  const file = path.join(dir, 'index.sqlite')
  try {
    // The v0.1 shape, exactly as the pre-versioning plugin wrote it: a sources
    // table with no provenance columns and an FTS5 table with no metadata rows.
    const legacy = new DatabaseSync(file)
    try {
      legacy.exec(`
        CREATE TABLE sources(
          name TEXT PRIMARY KEY,
          chunk_count INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          text, source UNINDEXED, ordinal UNINDEXED,
          tokenize='unicode61 remove_diacritics 2'
        );
      `)
      legacy.prepare('INSERT INTO sources(name, chunk_count, indexed_at) VALUES(?,?,?)')
        .run('legacy-docs', 1, 1_700_000_000_000)
      legacy.prepare('INSERT INTO chunks_fts(text, source, ordinal) VALUES(?,?,?)')
        .run('legacy needle content', 'legacy-docs', 0)
    } finally {
      legacy.close()
    }

    const store = new ContentStore(file)
    try {
      const stats = store.stats()
      // The row survived: the corpus is still present and still accounted for.
      assert.equal(stats.sources, 1, 'the legacy source row was lost')
      assert.equal(stats.chunks, 1, 'the legacy chunk was lost')
      assert.equal(stats.evidence, 1, 'the chunk gained no provenance row')
      assert.equal(stats.stale, 0, 'the backfilled hash disagrees with the stored text')
      assert.equal(store.report.adoptedLegacy, true, 'the legacy database was not recognised')
      assert.deepEqual([...store.report.applied], ['provenance-and-temporal'])

      // The chunk now has an evidence id and a real content hash.
      const meta = store.database
        .prepare('SELECT evidence_id, content_hash, line_start, line_end FROM chunk_meta WHERE source = ?')
        .get('legacy-docs')
      assert.match(meta.evidence_id, /^ev_[0-9a-f]{16}$/, 'no evidence id was backfilled')
      assert.notEqual(meta.content_hash, '', 'no content hash was backfilled')
      // The old index kept no per-file offsets, so the honest answer is NULL.
      assert.equal(meta.line_start, null, 'a line number was invented for a chunk that never had one')
      assert.equal(meta.line_end, null, 'a line number was invented for a chunk that never had one')

      // The content is still reachable through the search path, not just present.
      const hits = store.search('legacy', { limit: 5 })
      assert.equal(hits.length, 1)
      assert.ok(
        hits[0].snippet.replaceAll('»', '').replaceAll('«', '').includes('legacy needle content'),
        `the backfilled corpus is not searchable: ${hits[0].snippet}`,
      )
    } finally {
      store.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('running migrate a second time on an already-migrated database applies nothing', () => {
  const dir = temp('ctxopt-mig-idem-')
  try {
    const file = path.join(dir, 'index.sqlite')
    const db = new DatabaseSync(file)
    try {
      const first = migrate(db, file, indexMigrations())
      assert.equal(first.toVersion, 2)

      const second = migrate(db, file, indexMigrations())
      assert.deepEqual([...second.applied], [], 'a second run replayed steps it had already applied')
      assert.equal(second.fromVersion, 2)
      assert.equal(second.toVersion, 2)
      assert.equal(second.adoptedLegacy, false, 'a migrated database was re-adopted as legacy')
      assert.equal(currentVersion(db), 2)
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a step that throws leaves the database at the previous version with its data intact', () => {
  const dir = temp('ctxopt-mig-fail-')
  const file = path.join(dir, 'index.sqlite')
  const db = new DatabaseSync(file)
  // A second connection, the way store.test.mjs forces a failed replace: a
  // trigger is a schema object, so the runner cannot see the fault coming.
  const rival = new DatabaseSync(file)
  try {
    const baseline = {
      version: 1,
      name: 'baseline',
      apply: (d) => {
        d.exec('CREATE TABLE kept(id INTEGER PRIMARY KEY, note TEXT NOT NULL)')
      },
    }
    const failing = {
      version: 2,
      name: 'second',
      apply: (d) => {
        d.exec('CREATE TABLE rolled_back(id INTEGER PRIMARY KEY)')
      },
    }

    assert.equal(migrate(db, file, [baseline]).toVersion, 1)
    db.prepare('INSERT INTO kept(id, note) VALUES(?,?)').run(1, 'must survive')

    // Aborts the version-row insert, so the failure lands after the step's SQL
    // has already executed — the half-applied case the transaction must undo.
    rival.exec(`
      CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations
      BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;
    `)

    assert.throws(
      () => migrate(db, file, [baseline, failing]),
      (error) => {
        assert.ok(error instanceof MigrationError, `a MigrationError was expected, got ${String(error)}`)
        assert.equal(error.name, 'MigrationError')
        assert.equal(error.file, file, 'the error does not name the file it failed on')
        assert.equal(error.stepVersion, 2, 'the error does not name the step version')
        assert.match(error.message, /migration to version 2 \(second\) failed on /)
        assert.match(error.message, /forced migration failure/)
        return true
      },
    )

    // Previous version, previous data, and no half-applied step.
    assert.equal(currentVersion(db), 1, 'a failed migration moved the version forward anyway')
    assert.deepEqual(plain(db.prepare('SELECT note FROM kept').all()), [{ note: 'must survive' }])
    assert.equal(tableExists(db, 'rolled_back'), false, 'the failed step half-applied')

    // With the fault gone the same migration succeeds, so a failure is not a
    // dead store.
    rival.exec('DROP TRIGGER fail_migration')
    const recovered = migrate(db, file, [baseline, failing])
    assert.deepEqual([...recovered.applied], ['second'])
    assert.equal(recovered.fromVersion, 1)
    assert.equal(recovered.toVersion, 2)
    assert.deepEqual(plain(db.prepare('SELECT note FROM kept').all()), [{ note: 'must survive' }])
  } finally {
    try {
      rival.exec('DROP TRIGGER IF EXISTS fail_migration')
    } catch {
      /* the rival is being closed anyway */
    }
    rival.close()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('two steps claiming the same version are refused before any SQL runs', () => {
  const dir = temp('ctxopt-mig-dupe-')
  try {
    const file = path.join(dir, 'index.sqlite')
    const db = new DatabaseSync(file)
    try {
      const first = {
        version: 1,
        name: 'first',
        apply: (d) => {
          d.exec('CREATE TABLE one(x)')
        },
      }
      const second = {
        version: 1,
        name: 'second',
        apply: (d) => {
          d.exec('CREATE TABLE two(x)')
        },
      }
      assert.throws(
        () => migrate(db, file, [first, second]),
        (error) =>
          error instanceof MigrationError && /two migrations claim version 1/.test(error.message),
      )
      // Validation runs before the runner creates anything, so "refused" means
      // the database was never touched: not even the bookkeeping table exists.
      assert.equal(tableExists(db, 'schema_migrations'), false, 'SQL ran before the ambiguity was refused')
      assert.equal(tableExists(db, 'one'), false)
      assert.equal(tableExists(db, 'two'), false)
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a v0.1 session store migrates, keeps its rows and gains the temporal columns', () => {
  const dir = temp('ctxopt-mig-sess-')
  const file = path.join(dir, 'sessions.sqlite')
  try {
    // The v0.1 session shape: the event log without the temporal and identity
    // columns, exactly as the pre-versioning plugin wrote it.
    const legacy = new DatabaseSync(file)
    try {
      legacy.exec(`
        CREATE TABLE session_events(
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
        CREATE TABLE session_resume(
          session_id TEXT PRIMARY KEY,
          snapshot_xml TEXT NOT NULL,
          built_at INTEGER NOT NULL
        );
      `)
      legacy
        .prepare(
          `INSERT INTO session_events(session_id, type, category, priority, content, metadata, created_at, cwd)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run('sess-legacy', 'user/message', 'goal', 1, 'legacy goal text', '{}', 1_700_000_000_000, '/tmp')
    } finally {
      legacy.close()
    }

    const db = new SessionDB(file)
    try {
      // The report must say what happened: this database already satisfied the
      // baseline, so only the version-2 step is applied and the database is
      // recorded as adopted rather than built. Before the fix, the session store
      // was handed the index store's legacy detector, so a v0.1 sessions.sqlite
      // was reported as migrated from scratch — a false account of the operator's
      // data, which is the exact thing the legacy stamp exists to prevent.
      assert.equal(db.report.adoptedLegacy, true, 'a v0.1 session database must be recognised as legacy')
      assert.deepEqual([...db.report.applied], ['temporal-and-identity'])
      assert.equal(db.report.fromVersion, 1, 'the baseline it already satisfied is the version it came from')

      // The rows are still there, read through the real read path.
      assert.equal(db.eventCount(), 1, 'the legacy event row was lost')
      const events = db.events('sess-legacy')
      assert.equal(events.length, 1)
      assert.equal(events[0].content, 'legacy goal text', 'the event content was rewritten')
      assert.equal(events[0].sessionId, 'sess-legacy')

      // The temporal columns exist and were back-filled from the recorded time.
      const columns = columnNames(db.database, 'session_events')
      for (const column of ['event_id', 'first_seen_at', 'last_seen_at', 'bytes']) {
        assert.equal(columns.includes(column), true, `session_events gained no ${column}`)
      }
      const row = db.database
        .prepare('SELECT first_seen_at, last_seen_at, bytes FROM session_events WHERE session_id = ?')
        .get('sess-legacy')
      assert.equal(row.first_seen_at, 1_700_000_000_000, 'first_seen_at was not back-filled from created_at')
      assert.equal(row.last_seen_at, 1_700_000_000_000, 'last_seen_at was not back-filled from created_at')
      assert.ok(row.bytes > 0, 'bytes was not back-filled from the stored row size')
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('currentVersion is 0 on a database with no version row', () => {
  const dir = temp('ctxopt-mig-ver-')
  try {
    const file = path.join(dir, 'index.sqlite')
    const db = new DatabaseSync(file)
    try {
      // The runner always creates the bookkeeping table before reading it, so
      // the case under test is the table present with nothing recorded in it.
      db.exec(`CREATE TABLE schema_migrations(
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`)
      assert.equal(currentVersion(db), 0)
      // A NULL maximum is the same answer, not a different one.
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?,?,?)').run(0, 'probe', 1)
      assert.equal(currentVersion(db), 0)
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
