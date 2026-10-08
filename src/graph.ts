import { DatabaseSync } from 'node:sqlite'

/**
 * A relationship graph over indexed entities, stored in SQLite.
 *
 * This is deliberately not a graph database. There is no recursive CTE, no path
 * algebra, and no stored shortest path: the whole surface is one table, one
 * bounded breadth-first walk with a depth ceiling and a node budget, and a
 * visited set for cycle protection. Relations are cut out of indexed content by
 * other modules, so the shape that has to survive is "a few thousand edges, ask
 * for the neighbourhood of one entity, get a bounded answer" — and the shapes
 * that have to be impossible are an unbounded walk, an unbounded result, and an
 * entity name that means anything outside the store.
 */
export type RelationType =
  | 'defines' | 'imports' | 'references' | 'calls'
  | 'derived_from' | 'supersedes' | 'contradicts' | 'belongs_to_session'

/** One directed relation between two opaque entity tokens. */
export interface RelationInput {
  readonly from: string
  readonly type: RelationType
  readonly to: string
  /** Provenance of the edge, when the relation was derived from evidence. */
  readonly evidenceId?: string
}

/** One entity reached by a walk, plus how the walk got there. */
export interface TraversalNode {
  readonly entity: string
  readonly depth: number
  /** The edge that reached this node. Absent on the start node. */
  readonly via?: { readonly from: string; readonly type: RelationType }
  /** Provenance of the edge that reached this node, when it had any. */
  readonly evidenceId?: string
}

export interface TraversalResult {
  readonly nodes: readonly TraversalNode[]
  /** Relation rows the walk examined, cycle-closing rows included. */
  readonly edges: number
  /** True when the node budget stopped the walk before the frontier ran out. */
  readonly truncated: boolean
}

/** Longest entity token this module will store or look up. */
export const MAX_ENTITY_CHARS = 128
/** Deepest hop a traversal may take. */
export const MAX_DEPTH = 3
/** Largest node count a traversal may report. */
export const MAX_NODES = 200

/** Every relation the table may hold, as a runtime set as well as a type. */
const RELATION_TYPES: ReadonlySet<string> = new Set<string>([
  'defines', 'imports', 'references', 'calls',
  'derived_from', 'supersedes', 'contradicts', 'belongs_to_session',
])

/** Shape of one row as read back, before the type guards run. */
interface RelationRow {
  readonly from_entity: string
  readonly relation: string
  readonly to_entity: string
  readonly evidence_id: string | null
}

/** Start node of a walk, built without the optional keys so it compares clean. */
const START_VIA = undefined

/**
 * A relationship graph over indexed entities, kept in one SQLite table.
 *
 * The table is created idempotently in the constructor, so a second
 * `RelationshipGraph` over the same file — or over the same open handle — is a
 * no-op rather than an error, and a reopened store sees the rows the previous
 * handle wrote.
 */
export class RelationshipGraph {
  private readonly db: DatabaseSync
  private inTransaction = false

  /**
   * Run one write body inside a transaction, joining an outer one when there is
   * one. `addEdges` issues its rows through this; a failure anywhere inside —
   * including one raised on the last row of a long batch — leaves the table
   * exactly as it was before the call. Nested calls join the transaction already
   * open rather than issuing their own BEGIN, which SQLite would reject.
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

  constructor(db: DatabaseSync) {
    this.db = db
    // WAL is set here rather than left to whoever opened the handle so a caller
    // that hands over a bare DatabaseSync still gets the durability behaviour
    // every other store in the plugin has; re-issuing it on a handle that is
    // already in WAL is a no-op.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS relationships(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity TEXT NOT NULL,
        relation TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        evidence_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_from_type_to
        ON relationships(from_entity, relation, to_entity);
      CREATE INDEX IF NOT EXISTS idx_relationships_from_entity
        ON relationships(from_entity);
      CREATE INDEX IF NOT EXISTS idx_relationships_to_entity
        ON relationships(to_entity);
    `)
  }

  /**
   * Insert one relation, or nothing.
   *
   * An edge whose endpoints do not normalise is dropped silently — no throw, no
   * row — because the caller is a pipeline cutting relations out of indexed
   * content, where a malformed pair is routine and aborting a run over one is
   * worse than skipping it. The unique triple index is what makes the insert
   * idempotent: the same (from, type, to) twice is one row, and the evidence id
   * the FIRST writer attached is the one the traversal reports.
   */
  addEdge(input: RelationInput): void {
    const from = normalizeEntity(input.from)
    const to = normalizeEntity(input.to)
    const type = toRelationType(input.type)
    if (from === null || to === null || type === null) return
    this.db
      .prepare(
        `INSERT OR IGNORE INTO relationships(from_entity, relation, to_entity, evidence_id, created_at)
         VALUES(?,?,?,?,?)`,
      )
      .run(from, type, to, toEvidenceId(input.evidenceId), Date.now())
  }

  /**
   * Insert a batch in ONE transaction.
   *
   * Validation runs before the transaction opens, so a batch of entirely
   * malformed edges never begins one. Inside the transaction the rows go in
   * order and a failure on any row rolls the whole batch back: a half-applied
   * batch is worse than a failed one, because the caller cannot tell which half
   * landed and a retry would double the half that did.
   */
  addEdges(inputs: readonly RelationInput[]): void {
    const rows: Array<{
      readonly from: string
      readonly type: RelationType
      readonly to: string
      readonly evidenceId: string | null
    }> = []
    for (const input of inputs) {
      const from = normalizeEntity(input.from)
      const to = normalizeEntity(input.to)
      const type = toRelationType(input.type)
      if (from === null || to === null || type === null) continue
      rows.push({ from, type, to, evidenceId: toEvidenceId(input.evidenceId) })
    }
    if (rows.length === 0) return
    // One timestamp for the batch rather than one per row: `created_at` records
    // when the batch was applied, which is what a reader of it wants.
    const now = Date.now()
    this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO relationships(from_entity, relation, to_entity, evidence_id, created_at)
         VALUES(?,?,?,?,?)`,
      )
      for (const row of rows) insert.run(row.from, row.type, row.to, row.evidenceId, now)
    })
  }

  /**
   * Delete every relation carrying `evidenceId` and report how many went.
   *
   * This is the cleanup path for a re-indexed or GC'd source: the evidence a
   * relation was derived from disappears, and every relation whose provenance
   * was that evidence has to go with it. Relations with no evidence are never
   * touched — `NULL = ?` matches nothing in SQL, which is the behaviour wanted
   * here rather than an accident of it.
   */
  removeEvidence(evidenceId: string): number {
    if (typeof evidenceId !== 'string' || evidenceId.length === 0) return 0
    const result = this.db
      .prepare('DELETE FROM relationships WHERE evidence_id = ?')
      .run(evidenceId)
    return Number(result.changes)
  }

  /**
   * Direct successors of `entity`, ordered by (relation, to_entity).
   *
   * The order is total — the unique triple index forbids two rows sharing a
   * relation and a to_entity — so the page a caller sees for the same entity is
   * the same page every time, whatever order the edges were added in.
   */
  neighbors(entity: string, limit?: number): readonly RelationInput[] {
    const from = normalizeEntity(entity)
    if (from === null) return []
    const rows = this.db
      .prepare(
        `SELECT from_entity, relation, to_entity, evidence_id
           FROM relationships WHERE from_entity = ? ORDER BY relation, to_entity LIMIT ?`,
      )
      .all(from, clampLimit(limit ?? MAX_NODES)) as unknown as RelationRow[]
    const out: RelationInput[] = []
    for (const row of rows) {
      const type = toRelationType(row.relation)
      if (type === null) continue
      out.push(toRelationInput(row, type))
    }
    return out
  }

  /**
   * Breadth-first walk from `entity`, bounded by `depth` and `limit`.
   *
   * DEPTH: 0 returns the start node alone; N returns everything reachable in N
   * hops. The start node is always `nodes[0]` with `depth: 0` and no `via`,
   * because it was not reached through an edge. An entity that appears in NO
   * row at all — neither endpoint — is missing from the graph and yields
   * `{ nodes: [], edges: 0, truncated: false }` instead of a lone start node,
   * so a caller can tell "unknown entity" from "known entity with no outgoing
   * edges", which reports itself.
   *
   * ORDER: (depth asc, entity asc, via type asc). BFS supplies the depth order;
   * the candidates of one level are sorted before any of them is expanded, so
   * which edge wins when two relations lead to the same entity — and the `via`
   * recorded for it — never depends on insertion order.
   *
   * BOUNDS: when the node budget runs out the walk stops and reports
   * `truncated: true`; a walk that ran out of frontier reports `false`. A
   * caller asking for "the whole neighbourhood" therefore always gets a bounded
   * answer plus a flag saying whether it was the whole answer. The rows fetched
   * for one level are not node-budget bounded — sorting the level before
   * expanding it is what makes the smallest entities win the budget — but they
   * come straight off `idx_relationships_from_entity`.
   *
   * `edges` counts every relation row the walk examined, including rows whose
   * target the visited set had already claimed, which is why a cycle reports
   * both of its edges while reporting each entity once.
   */
  traverse(entity: string, depth?: number, limit?: number): TraversalResult {
    const start = normalizeEntity(entity)
    if (start === null) return { nodes: [], edges: 0, truncated: false }
    const maxDepth = clampDepth(depth ?? MAX_DEPTH)
    const budget = clampLimit(limit ?? MAX_NODES)

    // Presence is decided by the table, not by the walk: an entity that only
    // ever appears as a target is in the graph and reports itself.
    const present = this.db
      .prepare('SELECT 1 AS present FROM relationships WHERE from_entity = ? OR to_entity = ? LIMIT 1')
      .get(start, start) as unknown as { present: number } | undefined
    if (present === undefined) return { nodes: [], edges: 0, truncated: false }

    const nodes: TraversalNode[] = [{ entity: start, depth: 0 }]
    const visited = new Set<string>([start])
    // The start node is seeded into `visited` before the first level is read, so
    // a self-loop a->a adds nothing and a 2-cycle a->b->a terminates on the
    // second level rather than ping-ponging between the two.
    let frontier: string[] = [start]
    let edges = 0
    let truncated = false

    for (let level = 1; level <= maxDepth; level += 1) {
      const select = this.db.prepare(
        `SELECT from_entity, relation, to_entity, evidence_id
           FROM relationships WHERE from_entity = ? ORDER BY relation, to_entity`,
      )
      const candidates: Array<{
        readonly entity: string
        readonly via: { readonly from: string; readonly type: RelationType }
        readonly evidenceId: string | undefined
      }> = []
      for (const current of frontier) {
        const rows = select.all(current) as unknown as RelationRow[]
        edges += rows.length
        for (const row of rows) {
          const type = toRelationType(row.relation)
          const target = normalizeEntity(row.to_entity)
          if (type === null || target === null) continue
          candidates.push({
            entity: target,
            via: { from: current, type },
            evidenceId: toEvidenceId(row.evidence_id) ?? START_VIA,
          })
        }
      }
      if (candidates.length === 0) break
      candidates.sort(
        (a, b) =>
          compareStrings(a.entity, b.entity)
          || compareStrings(a.via.type, b.via.type)
          || compareStrings(a.via.from, b.via.from),
      )
      const next: string[] = []
      for (const candidate of candidates) {
        if (visited.has(candidate.entity)) continue
        if (nodes.length >= budget) {
          truncated = true
          break
        }
        visited.add(candidate.entity)
        nodes.push(makeNode(candidate.entity, level, candidate.via, candidate.evidenceId))
        next.push(candidate.entity)
      }
      if (truncated) break
      frontier = next
      if (frontier.length === 0) break
    }

    return { nodes, edges, truncated }
  }

  /**
   * Row counts read from the table, never from an in-memory tally.
   *
   * A tally would have to be maintained by every mutation and drifts the moment
   * another process — or a second `RelationshipGraph` over the same file —
   * writes. Two COUNT queries over one bounded table cannot lie.
   */
  stats(): { readonly relations: number; readonly entities: number } {
    const relations = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM relationships').get() as { n: number }).n,
    )
    // UNION rather than COUNT(DISTINCT from) + COUNT(DISTINCT to): an entity
    // that appears on both sides of some relation would be counted twice.
    const entities = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT from_entity AS entity FROM relationships
             UNION SELECT to_entity FROM relationships
           )`,
        )
        .get() as { n: number }).n,
    )
    return { relations, entities }
  }
}

/**
 * Validate an entity token.
 *
 * An entity is an opaque identifier, never a filesystem path: it exists only as
 * a value matched by equality in SQL. Entity names are cut out of indexed
 * content by other modules, so `../../etc/passwd` is exactly the sort of string
 * that can arrive here, and a name carrying a separator, a NUL, or a `..`
 * segment is refused rather than trimmed into something that merely looks
 * usable. That is what keeps a traversal driven by indexed content from ever
 * addressing anything outside the store: the answer set is entities, and the
 * only thing done with them afterwards is another equality match.
 */
export function normalizeEntity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const token = raw.trim()
  if (token.length === 0) return null
  if (token.length > MAX_ENTITY_CHARS) return null
  if (token.includes('\0')) return null
  if (token.includes('/') || token.includes('\\') || token.includes('..')) return null
  return token
}

/** Relation type guard: a stored relation outside the union is skipped, not thrown. */
function toRelationType(value: unknown): RelationType | null {
  if (typeof value !== 'string' || !RELATION_TYPES.has(value)) return null
  return value as RelationType
}

/** Evidence id is optional opaque provenance; anything else is stored as absent. */
function toEvidenceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toRelationInput(row: RelationRow, type: RelationType): RelationInput {
  const evidenceId = toEvidenceId(row.evidence_id)
  return {
    from: row.from_entity,
    type,
    to: row.to_entity,
    ...(evidenceId === null ? {} : { evidenceId }),
  }
}

/**
 * Build a traversal node without the optional keys when they are absent, so a
 * node with no provenance compares deep-equal to a node that never had one.
 */
function makeNode(
  entity: string,
  depth: number,
  via: { readonly from: string; readonly type: RelationType },
  evidenceId: string | undefined,
): TraversalNode {
  return { entity, depth, via, ...(evidenceId === undefined ? {} : { evidenceId }) }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Clamp a caller's depth into [0, MAX_DEPTH].
 *
 * A non-finite value is treated as "unspecified" and clamped to the ceiling,
 * not to the floor: a caller passing NaN meant "give me the default", not "give
 * me the start node".
 */
function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return MAX_DEPTH
  return Math.max(0, Math.min(Math.floor(value), MAX_DEPTH))
}

/**
 * Clamp a caller's node budget into [1, MAX_NODES].
 *
 * The floor is 1 rather than 0 because a traversal always reports at least the
 * start node; asking for zero nodes means "one", and a budget of one already
 * returns just the start node with `truncated: true` when more exists.
 */
function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_NODES
  return Math.max(1, Math.min(Math.floor(value), MAX_NODES))
}
