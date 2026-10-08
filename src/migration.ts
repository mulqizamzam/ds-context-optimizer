import { DatabaseSync } from 'node:sqlite'

/**
 * Schema versioning for the two local stores.
 *
 * The original plugin created its tables with `CREATE TABLE IF NOT EXISTS` at
 * every open and kept no record of what it had created. That is fine exactly
 * once: the moment a column has to change, every database already on disk is an
 * unknown mixture of "has the old shape" and "has the new one", and `IF NOT
 * EXISTS` silently answers "you already have a table, do nothing" for both. The
 * failure mode is not a crash, it is a corpus that looks present and reports
 * `chunks: 39` while the provenance join behind it matches nothing.
 *
 * So the version is recorded, every change is a numbered step, and each step is
 * applied inside one transaction: a migration that fails halfway leaves the
 * database at the previous version with its old data intact, which is the only
 * state from which a retry or a rebuild is possible.
 */

/** Row recorded for every applied step. Created by {@link migrate}. */
const META_TABLE = 'schema_migrations'

export interface MigrationStep {
  readonly version: number
  readonly name: string
  apply(db: DatabaseSync): void
}

export interface MigrationReport {
  readonly file: string
  readonly fromVersion: number
  readonly toVersion: number
  /** Names of the steps this call applied, in order. Empty when already current. */
  readonly applied: readonly string[]
  /** True when a v0.1 database was detected and stamped as the baseline. */
  readonly adoptedLegacy: boolean
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly stepVersion?: number,
  ) {
    super(message)
    this.name = 'MigrationError'
  }
}

/** Version currently recorded for `db`; 0 when nothing is recorded. */
export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT MAX(version) AS v FROM ${META_TABLE}`).get() as
    | { v: number | null }
    | undefined
  return row?.v === null || row?.v === undefined ? 0 : Number(row.v)
}

/**
 * Bring `db` up to the newest step, one transaction per step.
 *
 * A database written by v0.1.0 has tables but no version row. It is stamped as
 * version 1 — the baseline it already satisfies — instead of being stamped 0,
 * because stamping 0 would replay the baseline `CREATE TABLE` statements and
 * then claim the database had been migrated from scratch, which is a false
 * account of what happened to the operator's data.
 *
 * `detectLegacy` is a parameter because the two stores in this plugin age into
 * different shapes. Passing the index shape's detector to the session store
 * would report `adoptedLegacy: false` for a v0.1 session database whose
 * `session_events` table is sitting right there without an `event_id` column,
 * and the report would then list the baseline step as applied when it was not.
 */
export function migrate(
  db: DatabaseSync,
  file: string,
  steps: readonly MigrationStep[],
  detectLegacy: (db: DatabaseSync) => boolean = hasLegacyShape,
): MigrationReport {
  const ordered = validate(steps, file)
  db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE}(
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  let version = currentVersion(db)
  let adoptedLegacy = false

  if (version === 0 && detectLegacy(db)) {
    db.prepare(`INSERT INTO ${META_TABLE}(version, name, applied_at) VALUES(?,?,?)`)
      .run(1, 'baseline-0.1.0', Date.now())
    version = 1
    adoptedLegacy = true
  }

  // Read AFTER the legacy stamp, not before it. A database that was adopted came
  // from the baseline it already satisfied, so reporting `fromVersion: 0` next to
  // `adoptedLegacy: true` and one applied step would describe a two-version jump
  // that the step list contradicts.
  const fromVersion = version

  const applied: string[] = []
  for (const step of ordered) {
    if (step.version <= version) continue
    try {
      db.exec('BEGIN IMMEDIATE')
      step.apply(db)
      db.prepare(`INSERT INTO ${META_TABLE}(version, name, applied_at) VALUES(?,?,?)`)
        .run(step.version, step.name, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* SQLite already unwound the transaction; nothing to roll back */
      }
      const reason = error instanceof Error ? error.message : String(error)
      throw new MigrationError(
        `migration to version ${step.version} (${step.name}) failed on ${file}: ${reason}`,
        file,
        step.version,
      )
    }
    version = step.version
    applied.push(step.name)
  }

  return { file, fromVersion, toVersion: version, applied, adoptedLegacy }
}

/**
 * The step list must be strictly increasing and start above zero.
 *
 * Two steps sharing a version cannot both be applied, and the one that runs
 * first would decide which schema the database ends up with, so the ambiguity is
 * refused at load time rather than resolved by list order.
 */
function validate(steps: readonly MigrationStep[], file: string): readonly MigrationStep[] {
  const ordered = [...steps].sort((a, b) => a.version - b.version)
  for (let i = 0; i < ordered.length; i += 1) {
    const step = ordered[i]!
    if (!Number.isInteger(step.version) || step.version < 1) {
      throw new MigrationError(`migration version must be a positive integer, got ${step.version}`, file)
    }
    if (step.name === '') {
      throw new MigrationError(`migration version ${step.version} has no name`, file)
    }
    if (i > 0 && step.version === ordered[i - 1]!.version) {
      throw new MigrationError(
        `two migrations claim version ${step.version}: ${ordered[i - 1]!.name} and ${step.name}`,
        file,
      )
    }
  }
  return ordered
}

/** A v0.1 index store: the sources table without the provenance columns. */
function hasLegacyShape(db: DatabaseSync): boolean {
  if (!tableExists(db, 'sources')) return false
  return columnNames(db, 'sources').includes('chunk_count') && !columnNames(db, 'sources').includes('source_id')
}

/** A v0.1 session store: session_events without the temporal columns. */
export function hasLegacyEventShape(db: DatabaseSync): boolean {
  if (!tableExists(db, 'session_events')) return false
  return columnNames(db, 'session_events').includes('category') && !columnNames(db, 'session_events').includes('event_id')
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return row !== undefined
}

export function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as Array<{
    name: string
  }>
  return rows.map((row) => row.name)
}

/**
 * Add a column only when the table does not already have it.
 *
 * `ALTER TABLE ... ADD COLUMN` is not idempotent, and a migration that throws on
 * a database which already satisfies it turns a restart into a dead store. The
 * table name is quoted rather than interpolated raw: this helper is only ever
 * called with a literal from this module, but a helper that takes an identifier
 * should not be the place where quoting is forgotten later.
 */
export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  declaration: string,
): boolean {
  if (columnNames(db, table).includes(column)) return false
  db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${declaration}`)
  return true
}

/** Quote one SQL identifier, doubling embedded quotes as SQLite requires. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Create an index only when it is not already there. */
export function createIndexIfMissing(db: DatabaseSync, name: string, statement: string): void {
  if (indexExists(db, name)) return
  db.exec(statement)
}

function indexExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { name: string } | undefined
  return row !== undefined
}
