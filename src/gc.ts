/**
 * Retention planning for obsolete stored records.
 *
 * Two rules carry the whole module and both are here because getting them wrong
 * destroys data an operator still needs:
 *
 * 1. **Age never deletes anything on its own.** A record is reclaimable only
 *    when it is old AND unreferenced AND not persistent. A store that drops
 *    project content after 30 days looks tidy and quietly loses the corpus the
 *    next session was going to search.
 * 2. **Referenced means referenced, at any age.** The planner takes an explicit
 *    list of protected ids and honours a per-record flag, so the caller can hold
 *    back anything a live provenance reference still points at. The planner
 *    cannot know what is referenced; it only refuses to touch what it is told.
 *
 * Nothing here touches the filesystem, the network, or a clock. `now` is a
 * parameter so a plan is reproducible and a dry run can be replayed.
 */

export type RetentionClass = 'ephemeral' | 'session' | 'project' | 'persistent'

export interface RetentionConfig {
  /** Age after which an ephemeral record (one-shot command output) is reclaimable. */
  readonly ephemeralMs: number
  /** Age after which a session-scoped record stops being protected by its session. */
  readonly sessionMs: number
  /** Age after which a project record is reclaimable. Zero means never. */
  readonly projectMs: number
  /** Hard row cap per session, independent of age. */
  readonly maxEventsPerSession: number
}

/** One stored record as the planner sees it. */
export interface GcRecord {
  readonly kind: 'source' | 'chunk' | 'session_event'
  /** Opaque store id. Never a path; the planner only compares it for equality. */
  readonly id: string
  readonly class: RetentionClass
  readonly bytes: number
  readonly updatedAt: number
  readonly sessionId?: string
  /** Set when a live provenance reference names this record. */
  readonly referenced?: boolean
}

export interface GcCandidate {
  readonly kind: GcRecord['kind']
  readonly id: string
  readonly class: RetentionClass
  readonly ageMs: number
  readonly bytes: number
  readonly reason: string
}

export interface GcPlan {
  readonly dryRun: boolean
  readonly now: number
  readonly scanned: { readonly records: number; readonly bytes: number }
  readonly reclaimable: { readonly records: number; readonly bytes: number }
  readonly protected: { readonly records: number; readonly bytes: number }
  readonly deleted: readonly GcCandidate[]
  readonly truncated: boolean
}

export interface GcInput {
  readonly records: readonly GcRecord[]
  /** Ids the caller must keep, whatever their age. */
  readonly protectedRefs?: readonly string[]
  readonly maxDeletes?: number
}

/** Default and maximum ceiling on how many records one plan may remove. */
export const DEFAULT_MAX_DELETES = 1_000
export const MAX_DELETES = 10_000

/**
 * The class a record carries.
 *
 * Age does not re-classify: a record classified `project` by whoever indexed it
 * stays `project`, because only the caller knows what the record is. The
 * planner's job is to refuse, not to reinterpret.
 */
export function classifyRecord(record: GcRecord, now: number, config: RetentionConfig): RetentionClass {
  return record.class
}

/**
 * Whether one record may be removed, evaluated in a fixed order.
 *
 * The order is the contract: reference first, then persistence, then age. A
 * referenced persistent record and an unreferenced ephemeral one must not be
 * able to trade places by being listed in a different order.
 */
export function isReclaimable(record: GcRecord, now: number, config: RetentionConfig): boolean {
  if (record.referenced === true) return false
  const bytes = sanitiseBytes(record.bytes)
  if (bytes < 0) return false
  if (!Number.isFinite(record.updatedAt) || record.updatedAt < 0) return false
  if (typeof record.id !== 'string' || record.id === '') return false

  const age = now - record.updatedAt
  if (age < 0) return false

  switch (record.class) {
    case 'persistent':
      return false
    case 'ephemeral':
      return age >= Math.max(0, config.ephemeralMs)
    case 'session':
      return age >= Math.max(0, config.sessionMs)
    case 'project':
      // Zero is a documented value meaning "never reclaim by age", which is how
      // an operator says "keep my indexed project content" without a second
      // switch that could disagree with this one.
      if (config.projectMs <= 0) return false
      return age >= config.projectMs
    default:
      return false
  }
}

/**
 * Build the plan. A dry run still lists what it would delete: a plan that
 * reports nothing until it deletes is a plan the operator cannot check.
 */
export function planGc(
  input: GcInput,
  now: number,
  config: RetentionConfig,
  dryRun = true,
): GcPlan {
  const records = Array.isArray(input.records) ? input.records : []
  const protectedRefs = new Set(input.protectedRefs ?? [])
  const cap = clampDeletes(input.maxDeletes)
  const keep = Math.max(0, Math.floor(config.maxEventsPerSession))
  const bySession = new Map<string, GcRecord[]>()
  const isProtected = (record: GcRecord): boolean =>
    record.referenced === true || protectedRefs.has(record.id) || record.class === 'persistent'

  let scannedBytes = 0
  let protectedRecords = 0
  let protectedBytes = 0
  const candidates: GcRecord[] = []

  for (const record of records) {
    const bytes = sanitiseBytes(record.bytes)
    scannedBytes += bytes
    const guarded = protectedRefs.has(record.id) ? { ...record, referenced: true } : record

    if (record.kind === 'session_event') {
      // Session rows are decided by the row cap first and the age window
      // second, because the two answer different questions: the cap is "this
      // session's log is too long", the window is "this session is over".
      // A long, still-active session has to be trimmed by the cap even while
      // every row in it is too young for the window, which is exactly what the
      // store's own insert-time prune does.
      const bucket = bySession.get(sessionKey(guarded))
      if (bucket === undefined) bySession.set(sessionKey(guarded), [guarded])
      else bucket.push(guarded)
      continue
    }

    if (isReclaimable(guarded, now, config)) candidates.push(guarded)
    else {
      protectedRecords += 1
      protectedBytes += bytes
    }
  }

  for (const bucket of bySession.values()) {
    // Oldest first, because the cap has to drop the oldest rows of a session,
    // not the alphabetically first ones. `compareRecords` orders by id, which
    // is the right total order for the plan's output but the wrong one here.
    const ordered = [...bucket].sort((a, b) => {
      // `now` is the plan's own clock: comparing ages against a zero clock
      // would make every row look equally old and hand the cap an ordering by
      // id, which is exactly what this comparator replaced.
      // Descending by age: the cap drops the OLDEST rows of a session, and an
      // ascending sort would hand it the newest ones — which is the difference
      // between discarding the tail of a log and discarding the work that was
      // just recorded.
      const ageA = ageOf(a, now)
      const ageB = ageOf(b, now)
      if (ageA !== ageB) return ageA > ageB ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    const overCapCount = Math.max(0, ordered.length - keep)
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index]!
      const overCap = index < overCapCount
      if (overCap) {
        if (isProtected(row) || row.class === 'persistent') {
          protectedRecords += 1
          protectedBytes += sanitiseBytes(row.bytes)
          continue
        }
        candidates.push(row)
        continue
      }
      if (isReclaimable(row, now, config)) candidates.push(row)
      else {
        protectedRecords += 1
        protectedBytes += sanitiseBytes(row.bytes)
      }
    }
  }

  const merged = [...candidates].sort((a, b) => compareRecords(a, b))

  const reclaimBytes = merged.reduce((total, record) => total + sanitiseBytes(record.bytes), 0)
  const deleted: GcCandidate[] = merged
    .slice(0, cap)
    .map((record) => ({
      kind: record.kind,
      id: record.id,
      class: record.class,
      ageMs: ageOf(record, now),
      bytes: sanitiseBytes(record.bytes),
      reason: reasonFor(record, now, config),
    }))

  return {
    dryRun,
    now,
    scanned: { records: records.length, bytes: scannedBytes },
    reclaimable: { records: merged.length, bytes: reclaimBytes },
    // Records kept by the reference rule are counted with the age filter's
    // survivors' counterparts, so `scanned` is always protected + reclaimable
    // plus the rows the cap trimmed out of a session that the age filter had
    // already let through.
    protected: { records: protectedRecords, bytes: protectedBytes },
    deleted,
    truncated: merged.length > cap,
  }
}

/** Sum the bytes of a record list, never returning a negative total. */
export function reclaimableBytes(records: readonly GcRecord[]): number {
  let total = 0
  for (const record of records) {
    const bytes = sanitiseBytes(record.bytes)
    if (bytes > 0) total += bytes
  }
  return total
}

function sessionKey(record: GcRecord): string {
  return typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : ''
}

/** Why one record is reclaimable, in the words the plan reports. */
function reasonFor(record: GcRecord, now: number, config: RetentionConfig): string {
  switch (record.class) {
    case 'ephemeral':
      return `ephemeral record older than ${config.ephemeralMs}ms`
    case 'session':
      // A session row can be reclaimable for either of two reasons, and the
      // plan says which: the row cap does not care how young the row is.
      if (record.sessionId !== undefined) {
        return `session ${record.sessionId} is over the ${config.maxEventsPerSession} row cap`
      }
      return `session record older than ${config.sessionMs}ms`
    case 'project':
      return `project record older than ${config.projectMs}ms`
    default:
      return 'reclaimable record'
  }
}

/** Deterministic total order: by kind, then id. */
function compareRecords(a: GcRecord, b: GcRecord): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  const aTime = Number.isFinite(a.updatedAt) ? a.updatedAt : 0
  const bTime = Number.isFinite(b.updatedAt) ? b.updatedAt : 0
  return aTime - bTime
}

function ageOf(record: GcRecord, now: number): number {
  if (!Number.isFinite(record.updatedAt) || record.updatedAt < 0) return 0
  return Math.max(0, now - record.updatedAt)
}

/**
 * A byte count that cannot be negative or non-finite.
 *
 * A malformed row reports 0 rather than being dropped, so the planner's totals
 * still account for every record it was handed.
 */
function sanitiseBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function clampDeletes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_DELETES
  return Math.min(Math.floor(value), MAX_DELETES)
}
