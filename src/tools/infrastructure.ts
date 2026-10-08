import {
  ContentStore,
  MAX_SOURCE_TEXT_CHARS,
  type SourceMeta,
} from '../store.js'
import type { SessionDB } from '../session/db.js'
import { RelationshipGraph, normalizeEntity, MAX_DEPTH, MAX_NODES } from '../graph.js'
import {
  MAX_EXPANSION_CHARS,
  foldToLevel,
  parseExpansionRef,
  type FoldedPayload,
  type FoldLevel,
  type FoldMetadata,
} from '../fold.js'
import { diffSourceVersions, diffSnapshots } from '../diff.js'
import { planGc, type GcRecord, type GcPlan, type RetentionConfig } from '../gc.js'
import { buildSnapshot } from '../session/snapshot.js'
import { allocateContextBudget } from '../budget.js'
import type { ContextOptimizerConfig } from '../config.js'
import { defineTool, JSON_OBJECT_OUTPUT, JSON_OBJECT_RENDER } from '../host.js'

/**
 * The four model-facing tools that exist because the retrieval layer needed a
 * way to ask for more without re-supplying what it already has.
 *
 * They live here rather than in `src/index.ts` for one reason: every one of them
 * is a bounded view over the same store, and keeping them in one module keeps
 * the shared shape — parse an identifier, look it up by equality, fold the
 * answer to a budget, report provenance — in one place to read and to test.
 */

export interface InfrastructureDeps {
  readonly store: ContentStore
  readonly db: SessionDB
  readonly graph: RelationshipGraph
  readonly config: ContextOptimizerConfig
}

/** Chars a folded source-level payload may occupy. */
const SOURCE_FOLD_BUDGET_CHARS = 2_000

/**
 * The character ceiling one expansion may return.
 *
 * Read from the same budget the rest of the plugin allocates with, so an
 * expansion cannot hand the model a payload larger than the slice of context
 * that was set aside for evidence in the first place. When the budget is
 * disabled, or is too small to be worth a slice, the fold's own ceiling stands
 * — an expansion is never silenced by a misconfigured budget.
 */
function expansionCeiling(config: ContextOptimizerConfig): number {
  if (!config.contextBudget.enabled) return MAX_EXPANSION_CHARS
  const usable = Math.max(0, config.contextBudget.totalChars - config.contextBudget.reserveChars)
  if (usable <= 0) return MAX_EXPANSION_CHARS
  const allocation = allocateContextBudget(config.contextBudget, ['recent', 'task', 'evidence', 'metadata'])
  const share = allocation.evidence ?? 0
  if (share < 256) return MAX_EXPANSION_CHARS
  return Math.min(MAX_EXPANSION_CHARS, share)
}

/** Chunks listed for one source expansion. */
const MAX_SOURCE_EXPAND_CHUNKS = 50

/** Diff entries one call reports, bounded by the diff module as well. */
const MAX_DIFF_ENTRIES = 20

/** Events the garbage collector will look at in one call. */
const MAX_GC_RECORDS = 5_000

function failure(reason: string, detail: Record<string, unknown> = {}): unknown {
  return { ok: false, error: reason, ...detail }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return fallback
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

function foldLevelOf(value: unknown, fallback: FoldLevel): FoldLevel {
  if (value === 0 || value === 1 || value === 2 || value === 3 || value === 4) return value
  return fallback
}

/**
 * Build the fold's metadata view from the store's source row.
 *
 * The two shapes differ because they answer different questions: the store keeps
 * retention and hashes, the fold needs chunk and character counts it can report
 * without reading a body. Mapping explicitly is what keeps the fold from ever
 * being handed a field it would have to guess about.
 */
function foldMetaOf(meta: SourceMeta, charLen: number, chunks: number): FoldMetadata {
  return {
    sourceId: meta.sourceId,
    source: meta.source,
    sourceType: meta.sourceType,
    sourceName: meta.source,
    chunks,
    charLen,
    indexedAt: meta.indexedAt,
    updatedAt: meta.updatedAt,
    ...(meta.pathOrUrl === undefined ? {} : { pathOrUrl: meta.pathOrUrl }),
  }
}

/** Split bounded text into the ordinal keyed rows the diff module consumes. */
function toOrdinalRows(text: string, maxRows = 400): Array<{ ordinal: number; text: string }> {
  const lines = text.split('\n')
  const capped = lines.slice(0, maxRows)
  return capped.map((line, index) => ({ ordinal: index, text: line }))
}

/**
 * `ctx_expand` — ask for more detail about one piece of evidence.
 *
 * The argument is an identifier the store already handed out, never content:
 * re-supplying the body would defeat the entire point of indexing it. The
 * identifier is only ever compared for equality inside SQL, so it cannot become
 * a path.
 */
export function defineExpandTool(deps: InfrastructureDeps) {
  return defineTool({
    name: `${deps.config.toolPrefix}expand`,
    description:
      'Expand one indexed source or one evidence id into a bounded folded payload: metadata, structure, excerpt, or raw text at a level the caller chooses.'
      + ' Never re-supply the content; reference the id a previous search returned.',
    parameters: {
      type: 'object',
      properties: {
        evidenceId: { type: 'string', description: 'Evidence id from a previous search result.' },
        sourceId: { type: 'string', description: 'Source id, to list that source instead of one chunk.' },
        level: { type: 'integer', description: 'Fold level 0 metadata, 1 structural, 2 summary, 3 excerpts, 4 raw.' },
        budgetChars: { type: 'integer', description: 'Character ceiling for the returned payload.' },
        maxChunks: { type: 'integer', description: 'Chunks listed for a source expansion.' },
        seenHash: { type: 'string', description: 'Content hash an earlier retrieval reported, to check for drift.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
    execute: (async (rawArgs: unknown) => {
      const args = asRecord(rawArgs)
      const ref = parseExpansionRef(args.evidenceId ?? args.sourceId)
      if (ref === null) {
        return failure(
          'evidenceId must be ev_ plus 16 hex characters, or sourceId must be src_ plus 16 hex characters',
          { expandable: false },
        )
      }
      const ceiling = expansionCeiling(deps.config)
      const requested = toInt(args.budgetChars, ceiling)
      const budget = Math.max(1, Math.min(requested, ceiling, MAX_EXPANSION_CHARS))

      if (ref.kind === 'evidence') {
        const check = deps.store.checkEvidence(ref.id, typeof args.seenHash === 'string' ? args.seenHash : undefined)
        if (!check.found || check.evidence === undefined) {
          return failure('no evidence with that id', { evidenceId: ref.id, expandable: false })
        }
        const record = check.evidence
        const level = foldLevelOf(args.level, 4)
        // Built as the fold's own metadata shape rather than as a `SourceMeta`,
        // because the store's row type carries fields this call has no value
        // for — retention and a chunk count of one source are not facts about a
        // single chunk, and filling them in would be invention.
        const meta: FoldMetadata = {
          sourceId: record.sourceId,
          source: record.source,
          sourceType: record.sourceType,
          sourceName: record.source,
          chunks: 1,
          charLen: record.charLen,
          indexedAt: record.indexedAt,
          updatedAt: record.updatedAt,
          ...(record.pathOrUrl === undefined ? {} : { pathOrUrl: record.pathOrUrl }),
        }
        const folded: FoldedPayload = foldToLevel(meta, record.text, level, budget)
        return {
          ok: true,
          expandable: true,
          evidenceId: record.evidenceId,
          chunkId: record.chunkId,
          sourceId: record.sourceId,
          source: record.source,
          ordinal: record.ordinal,
          level: folded.level,
          truncated: folded.truncated,
          charLen: record.charLen,
          text: folded.text,
          stale: check.stale,
          rewritten: check.rewritten,
          ...(check.reason === undefined ? {} : { reason: check.reason }),
          provenance: {
            source: record.source,
            sourceType: record.sourceType,
            ...(record.pathOrUrl === undefined ? {} : { pathOrUrl: record.pathOrUrl }),
            ...(record.lineStart === undefined ? {} : { lineStart: record.lineStart }),
            ...(record.lineEnd === undefined ? {} : { lineEnd: record.lineEnd }),
            ...(record.command === undefined ? {} : { command: record.command }),
            ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
            contentHash: record.contentHash,
            indexedAt: record.indexedAt,
            updatedAt: record.updatedAt,
            firstSeenAt: record.firstSeenAt,
          },
        }
      }

      const meta = deps.store.sourceOf(ref.id)
      if (meta === undefined) {
        return failure('no source with that id', { sourceId: ref.id, expandable: false })
      }
      const chunks = deps.store.evidenceOfSource(ref.id, toInt(args.maxChunks, MAX_SOURCE_EXPAND_CHUNKS))
      const text = chunks.map((chunk) => chunk.text).join('')
      const body = text.length === 0 ? '' : text
      const folded = foldToLevel(
        foldMetaOf(meta, body.length, chunks.length),
        body,
        foldLevelOf(args.level, 0),
        SOURCE_FOLD_BUDGET_CHARS,
      )
      return {
        ok: true,
        expandable: true,
        sourceId: meta.sourceId,
        source: meta.source,
        sourceType: meta.sourceType,
        ...(meta.pathOrUrl === undefined ? {} : { pathOrUrl: meta.pathOrUrl }),
        chunkCount: meta.chunkCount,
        contentHash: meta.contentHash,
        indexedAt: meta.indexedAt,
        updatedAt: meta.updatedAt,
        firstSeenAt: meta.firstSeenAt,
        retention: meta.retention,
        level: folded.level,
        text: folded.text,
        truncated: folded.truncated,
        chunks: chunks.map((chunk) => ({
          evidenceId: chunk.evidenceId,
          ordinal: chunk.ordinal,
          charLen: chunk.charLen,
          ...(chunk.lineStart === undefined ? {} : { lineStart: chunk.lineStart }),
          ...(chunk.lineEnd === undefined ? {} : { lineEnd: chunk.lineEnd }) ,
          updatedAt: chunk.updatedAt,
        })),
        chunksTruncated: chunks.length < meta.chunkCount,
      }
    }) as never,
  })
}

/**
 * `ctx_gc` — lifecycle management.
 *
 * Dry run is the default, and an applying run needs `confirm: true` as well as
 * `dryRun: false`. Two flags rather than one because a caller that means to
 * inspect and a caller that means to delete are answering different questions,
 * and the plan it prints is the only chance to see what the apply would take.
 */
export function defineGcTool(deps: InfrastructureDeps) {
  return defineTool({
    name: `${deps.config.toolPrefix}gc`,
    description:
      'Report or apply the retention policy: what is reclaimable, what is protected because live provenance still points at it, and how many bytes would come back. Dry run by default.',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Report only. Defaults to true.' },
        confirm: { type: 'boolean', description: 'Must be true for an applying run to delete anything.' },
        maxDeletes: { type: 'integer', description: 'Ceiling on records this call may remove.' },
        protect: { type: 'array', description: 'Source or evidence ids to keep regardless of age.', items: { type: 'string' } },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
    execute: (async (rawArgs: unknown) => {
      const args = asRecord(rawArgs)
      const dryRun = args.dryRun === undefined ? true : args.dryRun === true
      const confirmed = args.confirm === true
      const retention: RetentionConfig = {
        ephemeralMs: deps.config.retention.ephemeralMs,
        sessionMs: deps.config.retention.sessionMs,
        projectMs: deps.config.retention.projectMs,
        maxEventsPerSession: deps.config.session.maxEventsPerSession,
      }

      if (!dryRun && !confirmed) {
        return failure('an applying run needs confirm true and dryRun false; nothing was removed', {
          dryRun: false,
          deleted: 0,
        })
      }

      const protect = optionalStringArray(args.protect) ?? []
      const storeRecords = deps.store.gcRecords(MAX_GC_RECORDS)
      const eventRecords = deps.db.gcRecords(MAX_GC_RECORDS)
      const records: GcRecord[] = [
        ...storeRecords.map((record) => ({
          kind: 'source' as const,
          id: record.id,
          class: record.retention,
          bytes: record.bytes,
          updatedAt: record.updatedAt,
          referenced: record.referenced,
        })),
        ...eventRecords.map((record) => ({
          kind: 'session_event' as const,
          id: record.id,
          class: record.retention,
          bytes: record.bytes,
          updatedAt: record.updatedAt,
          sessionId: record.sessionId,
          referenced: record.referenced,
        })),
      ]

      const plan: GcPlan = planGc(
        { records, protectedRefs: protect, maxDeletes: toInt(args.maxDeletes, 1000) },
        Date.now(),
        retention,
        dryRun,
      )

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          deleted: 0,
          scanned: plan.scanned,
          reclaimable: plan.reclaimable,
          protected: plan.protected,
          truncated: plan.truncated,
          candidates: plan.deleted.slice(0, 50).map((candidate) => ({
            kind: candidate.kind,
            id: candidate.id,
            class: candidate.class,
            ageMs: candidate.ageMs,
            bytes: candidate.bytes,
            reason: candidate.reason,
          })),
          candidatesTruncated: plan.deleted.length > 50,
        }
      }

      const removed = applyPlan(deps, plan)
      return {
        ok: true,
        dryRun: false,
        deleted: removed.total,
        sourcesRemoved: removed.sources,
        eventsRemoved: removed.events,
        scanned: plan.scanned,
        reclaimable: plan.reclaimable,
        protected: plan.protected,
        truncated: plan.truncated,
        removedIds: removed.ids.slice(0, 50),
        removedIdsTruncated: removed.ids.length > 50,
      }
    }) as never,
  })
}

/**
 * Carry out a plan the planner produced.
 *
 * Splitting plan from apply is what makes the delete path auditable: the tool
 * deletes exactly the ids the plan names, so a dry run's candidate list is the
 * apply's work list rather than a guess at it.
 */
function applyPlan(
  deps: InfrastructureDeps,
  plan: GcPlan,
): { total: number; sources: number; events: number; ids: string[] } {
  let sources = 0
  let events = 0
  const ids: string[] = []
  for (const candidate of plan.deleted) {
    if (candidate.kind === 'source') {
      const row = deps.store.sourceOf(candidate.id)
      if (row !== undefined) {
        deps.store.removeSource(row.source)
        sources += 1
        ids.push(candidate.id)
      }
      continue
    }
    if (candidate.kind === 'session_event') {
      const removed = deps.db.deleteEventIds([candidate.id])
      events += removed
      if (removed > 0) ids.push(candidate.id)
    }
  }
  return { total: sources + events, sources, events, ids }
}

/**
 * `ctx_diff` — inspect what changed without returning either whole side.
 *
 * Three modes, because "two sessions", "two pieces of evidence" and "two
 * versions of one source" are different questions that share one answer shape.
 */
export function defineDiffTool(deps: InfrastructureDeps) {
  return defineTool({
    name: `${deps.config.toolPrefix}diff`,
    description:
      'Diff two session snapshots, two evidence records, or two indexed versions of a source, and report a bounded list of additions, removals and changes.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['sessions', 'evidence', 'source'], description: 'What the two sides are.' },
        sessionA: { type: 'string', description: 'First session id, for sessions mode.' },
        sessionB: { type: 'string', description: 'Second session id, for sessions mode.' },
        before: { type: 'string', description: 'Evidence id or source label for the earlier side.' },
        after: { type: 'string', description: 'Evidence id or source label for the later side.' },
        maxEntries: { type: 'integer', description: 'Ceiling on reported diff entries.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
    execute: (async (rawArgs: unknown) => {
      const args = asRecord(rawArgs)
      const mode = args.mode
      const maxEntries = Math.max(1, Math.min(toInt(args.maxEntries, MAX_DIFF_ENTRIES), 100))

      if (mode === 'sessions') {
        const a = typeof args.sessionA === 'string' && args.sessionA !== '' ? args.sessionA : undefined
        const b = typeof args.sessionB === 'string' && args.sessionB !== '' ? args.sessionB : undefined
        if (a === undefined || b === undefined) {
          return failure('sessions mode needs sessionA and sessionB', { mode })
        }
        const textA = snapshotTextOf(deps, a)
        const textB = snapshotTextOf(deps, b)
        return { ok: true, mode, sessionA: a, sessionB: b, ...diffSnapshots(textA, textB, maxEntries) }
      }

      if (mode === 'evidence') {
        const before = typeof args.before === 'string' ? args.before : ''
        const after = typeof args.after === 'string' ? args.after : ''
        const first = deps.store.evidenceOf(before)
        const second = deps.store.evidenceOf(after)
        if (first === undefined) return failure('no evidence with that id', { mode, before })
        if (second === undefined) return failure('no evidence with that id', { mode, after })
        return {
          ok: true,
          mode,
          before: first.evidenceId,
          after: second.evidenceId,
          ...diffSourceVersions(
            toOrdinalRows(first.text),
            toOrdinalRows(second.text),
            maxEntries,
          ),
        }
      }

      if (mode === 'source') {
        const before = typeof args.before === 'string' && args.before !== '' ? args.before : undefined
        const after = typeof args.after === 'string' && args.after !== '' ? args.after : undefined
        if (before === undefined || after === undefined) {
          return failure('source mode needs before and after source labels', { mode })
        }
        const first = deps.store.sourceText(before, MAX_SOURCE_TEXT_CHARS)
        const second = deps.store.sourceText(after, MAX_SOURCE_TEXT_CHARS)
        return {
          ok: true,
          mode,
          before,
          after,
          // The store's own cut flag and the diff's carry different names: the
          // store reports "a side was clipped before diffing", the diff reports
          // "more entries existed than were listed".
          sourceTruncated: first.truncated || second.truncated,
          ...diffSourceVersions(toOrdinalRows(first.text), toOrdinalRows(second.text), maxEntries),
        }
      }

      return failure(`mode must be sessions, evidence or source; got ${JSON.stringify(mode ?? null)}`, { mode })
    }) as never,
  })
}

function snapshotTextOf(deps: InfrastructureDeps, sessionId: string): string {
  return (
    deps.db.snapshot(sessionId) ??
    buildSnapshot(deps.db.events(sessionId), deps.config.session.maxSnapshotChars)
  )
}

/**
 * `ctx_related` — bounded relationship traversal.
 *
 * An entity is an opaque token, never a path, and the walk is depth- and
 * node-bounded with a visited set, so a cyclic graph cannot expand without end.
 */
export function defineRelatedTool(deps: InfrastructureDeps) {
  return defineTool({
    name: `${deps.config.toolPrefix}related`,
    description:
      'Walk the relationship graph from one entity and return the bounded set of related entities with the provenance of the edge that reached each one.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name to start from, for example a function or module name.' },
        depth: { type: 'integer', description: 'Hops to walk. Clamped to the configured maximum.' },
        limit: { type: 'integer', description: 'Ceiling on returned nodes.' },
      },
      required: ['entity'],
      additionalProperties: false,
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
    execute: (async (rawArgs: unknown) => {
      const args = asRecord(rawArgs)
      const entity = normalizeEntity(args.entity)
      if (entity === null) {
        return failure(
          'entity must be a non-empty name of at most 128 characters, with no path separator or parent reference',
          // `nodes: []` and `edges: 0` rather than their absence: a refusal that
          // does not state what it walked leaves the caller to guess whether the
          // traversal ran and found nothing, or never ran at all.
          { related: false, nodes: [], edges: 0, truncated: false },
        )
      }
      const depth = Math.max(
        0,
        Math.min(toInt(args.depth, deps.config.relations.maxDepth), deps.config.relations.maxDepth, MAX_DEPTH),
      )
      const limit = Math.max(
        1,
        Math.min(toInt(args.limit, deps.config.relations.maxNodes), deps.config.relations.maxNodes, MAX_NODES),
      )
      const result = deps.graph.traverse(entity, depth, limit)
      return {
        ok: true,
        related: result.nodes.length > 0,
        entity,
        depth,
        edges: result.edges,
        truncated: result.truncated,
        nodes: result.nodes.map((node) => ({
          entity: node.entity,
          depth: node.depth,
          ...(node.via === undefined ? {} : { via: node.via }),
          ...(node.evidenceId === undefined ? {} : { evidenceId: node.evidenceId }),
        })),
      }
    }) as never,
  })
}

export function defineInfrastructureTools(deps: InfrastructureDeps) {
  return [defineExpandTool(deps), defineGcTool(deps), defineDiffTool(deps), defineRelatedTool(deps)]
}
