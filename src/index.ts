import fs from 'node:fs'
import type { Dirent } from 'node:fs'
import net from 'node:net'
import { lookup } from 'node:dns'
import path from 'node:path'
import {
  DEFAULT_EXECUTOR_OPTIONS,
  SandboxExecutor,
  UnconfinedExecutionError,
  type ExecutorOptions,
} from './executor.js'
import { evaluate, type RoutingConfig } from './routing/engine.js'
import { AdvisoryThrottle } from './routing/throttle.js'
import { LANGUAGES, isLanguage, probeRuntime } from './runtime.js'
import { resolveProjectPath } from './security.js'
import { ContentStore, type LineAnchor, type SearchOptions } from './store.js'
import { SessionDB } from './session/db.js'
import { buildSnapshot, classifyEvent, eventContent, type SnapshotExtras } from './session/snapshot.js'
import { resolveConfig, type ContextOptimizerConfig } from './config.js'
import { RetrievalCache } from './cache.js'
import { planGc } from './gc.js'
import { detectContradictions, type Contradiction } from './contradiction.js'
import { RelationshipGraph } from './graph.js'
import { retrieve, type RetrievalDeps, type RetrievalRequest } from './retrieval.js'
import { budgetReport, measureContext } from './budget.js'
import { defineInfrastructureTools } from './tools/infrastructure.js'
import {
  JSON_OBJECT_OUTPUT,
  JSON_OBJECT_RENDER,
  defineTool,
  cwdOf,
  registerLifecycle,
  registerToolSafe,
  sessionIdOf,
  type AssembleContext,
  type HostContext,
  type HostSession,
  type HostSessionEvent,
  type HostSandboxProvider,
  type PostToolDecision,
  type PreToolDecision,
  type SystemPromptService,
  type ToolRunContext,
} from './host.js'

export const name = 'dsh-context-optimizer'
export const VERSION = '0.1.0'

/**
 * Cordis service deps. `sandbox` is deliberately NOT listed: a profile without a
 * usable sandbox backend must still boot, and the executor reports the missing
 * boundary at call time instead of hanging the plugin in `pending` state.
 */
export const inject = ['tools', 'sandbox']

export interface RegistrationReport {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

export interface RuntimeView {
  readonly name: string
  readonly version: string
  readonly stateDir: string
  readonly toolPrefix: string
  readonly registrations: readonly RegistrationReport[]
  readonly errors: readonly string[]
  readonly sandbox: { readonly available: boolean; readonly allowUnconfined: boolean }
  readonly tools: () => readonly string[]
}

interface EntryArgs {
  readonly cwd: string
  readonly sessionId?: string
}

/** One command's row in `ctx_batch_execute`'s `indexed[]`. */
interface BatchEntry {
  readonly label: string
  readonly source: string
  readonly exitCode: number
  readonly chunks: number
  /** Bytes of this command's output that actually reached the index. */
  readonly bytes: number
  /** True when the executor had already cut the output before it was indexed. */
  readonly truncated: boolean
}

/**
 * Ceiling on the bytes `ctx_index` will read in one call. Without it, a tree of
 * 200 files at the 1 MB per-file cap could materialise 200 MB on the heap in a
 * single call from a host that is also serving the GUI.
 */
const INDEX_BUDGET_BYTES = 32 * 1024 * 1024

/** Upper bound on one caller-supplied execution timeout. */
const MAX_TIMEOUT_MS = 10 * 60 * 1000

/** Distinct warnings kept on the view; beyond this the list stops growing. */
const MAX_RECORDED_ERRORS = 50

/**
 * Plugin entry.
 *
 * P4: `apply` never throws. A throwing `apply` takes the whole profile down with
 * it, so every failure is caught, recorded on the returned view, and reported by
 * `ctx_doctor`. The worst outcome of a bug here is a plugin that does not load.
 */
export function apply(rawContext: unknown, rawConfig: unknown = {}): RuntimeView {
  const errors: string[] = []
  let suppressionReported = false
  /**
   * Record one warning.
   *
   * The same fault is recorded once, no matter how many calls it recurs on, and
   * the list stops growing past {@link MAX_RECORDED_ERRORS} entries. A hook that
   * fires on every matching tool call would otherwise append an identical line
   * per call and turn `view.errors` into an unbounded leak of the very context
   * this plugin exists to save.
   */
  const warn = (message: string): void => {
    if (errors.includes(message)) return
    console.warn(`[${name}] ${message}`)
    if (errors.length >= MAX_RECORDED_ERRORS) {
      if (!suppressionReported) {
        suppressionReported = true
        errors.push(`further warnings suppressed after ${MAX_RECORDED_ERRORS} distinct entries`)
      }
      return
    }
    errors.push(message)
  }

  const ctx = rawContext as Partial<HostContext> | undefined
  if (ctx === undefined || typeof ctx !== 'object' || typeof ctx.tools?.register !== 'function') {
    warn('host did not provide a tools service; nothing registered')
    return emptyView(errors)
  }

  let config: ContextOptimizerConfig
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    warn(`configuration rejected, plugin disabled: ${messageOf(error)}`)
    return emptyView(errors)
  }

  const hostContext = ctx as HostContext
  const executorOptions: ExecutorOptions = { ...DEFAULT_EXECUTOR_OPTIONS, ...config.executor }
  const allowFetchHosts = readFetchAllowHosts(rawConfig, warn)
  const stateDir = config.stateDir
  const indexFile = path.join(stateDir, 'index.sqlite')
  const sessionsFile = path.join(stateDir, 'sessions.sqlite')

  let store: ContentStore
  let db: SessionDB
  try {
    store = new ContentStore(indexFile)
    db = new SessionDB(sessionsFile, config.session.maxEventsPerSession)
  } catch (error) {
    warn(`could not open state at ${stateDir}, plugin disabled: ${messageOf(error)}`)
    return emptyView(errors, {
      stateDir,
      toolPrefix: config.toolPrefix,
      sandboxAvailable: false,
      allowUnconfined: executorOptions.allowUnconfined,
    })
  }

  let sandboxProvider = resolveSandbox(hostContext, warn)
  let executor = new SandboxExecutor(sandboxProvider, executorOptions)
  /**
   * The retrieval cache and the relationship graph share the index store's
   * connection rather than opening a database file each.
   *
   * A third and fourth file would mean a third and fourth write lock over the
   * same state directory for no gain: the store already holds the WAL, the
   * pragmas, and the transaction helper. Neither module is handed a path, only
   * the handle, so neither can be pointed somewhere else by configuration.
   */
  const cache = new RetrievalCache(store.database, config.cache)
  const graph = new RelationshipGraph(store.database)
  const retrieval: RetrievalDeps = {
    store,
    cache,
    budget: config.contextBudget,
    search: config.search,
  }
  /**
   * Feature-detect the sandbox service at call time instead of trusting the
   * snapshot taken during `apply`.
   *
   * A plugin may be applied before the sandbox fiber exists; capturing the
   * provider once would leave `view.sandbox.available === false` and every
   * `ctx_execute` refusing with "no sandbox backend is available" for the rest
   * of the process, so load order would silently decide whether the feature
   * works. Re-resolving on each execution (and each doctor call) means the
   * answer always describes the host as it is now.
   */
  const refreshSandbox = (): HostSandboxProvider | undefined => {
    const provider = resolveSandbox(hostContext, warn)
    if (provider !== sandboxProvider) {
      sandboxProvider = provider
      executor = new SandboxExecutor(provider, executorOptions)
    }
    return provider
  }
  const throttle = new AdvisoryThrottle(config.routing.advisoryThrottle)
  const routing: RoutingConfig = {
    advisory: config.routing.advisory,
    denyPatterns: config.routing.denyPatterns,
  }

  const registrations: RegistrationReport[] = []
  const prefix = config.toolPrefix

  const runConfined = async (
    language: string,
    code: string,
    entry: EntryArgs,
    signal: AbortSignal,
    options: { targetFile?: string; timeoutMs?: number } = {},
  ): Promise<unknown> => {
    // Resolved per call, not per boot: the sandbox fiber may activate after
    // `apply` ran, and a snapshot would refuse every later call forever.
    refreshSandbox()
    const executorNow = executor
    if (!isLanguage(language)) {
      return failure(`unsupported language: ${String(language)}`, { supported: LANGUAGES })
    }
    try {
      const result = await executorNow.run({
        language,
        code,
        cwd: entry.cwd,
        signal,
        ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
        ...(options.targetFile === undefined ? {} : { targetFile: options.targetFile }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        enforcement: result.enforcement,
        unconfined: result.unconfined,
        cwd: entry.cwd,
        language,
      }
    } catch (error) {
      if (error instanceof UnconfinedExecutionError) {
        return failure(error.message, { sandboxAvailable: executorNow.sandboxAvailable })
      }
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return failure(`launcher for ${String(language)} not found on PATH`, { language })
      }
      return failure(messageOf(error), { language })
    }
  }

  const entryFrom = (execution: ToolRunContext): EntryArgs => ({
    cwd: cwdOf(execution),
    ...(sessionIdOf(execution) === undefined ? {} : { sessionId: sessionIdOf(execution) }),
  })

  const definitions = [
    defineTool({
      name: `${prefix}execute`,
      description: 'Execute one program of code in a sandbox-confined subprocess and return bounded stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: [...LANGUAGES], description: 'Language runtime to use.' },
          code: { type: 'string', description: 'Source text, delivered to the runtime on stdin.' },
          timeoutMs: { type: 'integer', description: 'Wall-clock budget in milliseconds.' },
        },
        required: ['language', 'code'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown, execution: ToolRunContext) => {
        const args = asRecord(rawArgs)
        return runConfined(
          String(args.language ?? ''),
          String(args.code ?? ''),
          entryFrom(execution),
          execution.signal,
          {
            ...(typeof args.timeoutMs === 'number'
              ? { timeoutMs: optionalNumber(args.timeoutMs) }
              : {}),
          },
        )
      }) as never,
    }),
    defineTool({
      name: `${prefix}execute_file`,
      description: 'Execute code against one file inside the project, exposing its resolved path as the TARGET_FILE variable.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative path to the target file.' },
          language: { type: 'string', enum: [...LANGUAGES], description: 'Language runtime to use.' },
          code: { type: 'string', description: 'Source text, delivered to the runtime on stdin.' },
        },
        required: ['path', 'language', 'code'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown, execution: ToolRunContext) => {
        const args = asRecord(rawArgs)
        const cwd = cwdOf(execution)
        const relative = String(args.path ?? '')
        let target: string
        try {
          target = resolveProjectPath(cwd, relative)
        } catch (error) {
          return failure(messageOf(error), { path: relative })
        }
        return runConfined(
          String(args.language ?? ''),
          String(args.code ?? ''),
          entryFrom(execution),
          execution.signal,
          { targetFile: target },
        )
      }) as never,
    }),
    defineTool({
      name: `${prefix}batch_execute`,
      description: 'Run several shell commands concurrently, index every output, and return matching excerpts instead of the full bytes.',
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            description: 'Commands to run, each with a label and the shell text.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short name for this command.' },
                command: { type: 'string', description: 'Shell text to run.' },
              },
              required: ['label', 'command'],
              additionalProperties: false,
            },
          },
          queries: { type: 'array', description: 'Queries run against the indexed outputs.', items: { type: 'string' } },
          concurrency: { type: 'integer', description: 'Maximum commands running at once.' },
        },
        required: ['commands', 'queries'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown, execution: ToolRunContext) => {
        const args = asRecord(rawArgs)
        const commands = Array.isArray(args.commands) ? args.commands : []
        const queries = Array.isArray(args.queries) ? args.queries.map((q) => String(q)) : []
        const entry = entryFrom(execution)
        const limit = Math.max(1, Math.min(toInt(args.concurrency, 5), 16))
        const pool = commands.slice(0, 64)

        const entries: Array<BatchEntry | undefined> = new Array(pool.length)
        // The caller's own signal, normalised: it decides whether this batch
        // keeps dispatching commands.
        const signal = executionSignalFrom(execution.signal)
        let cursor = 0
        const worker = async (): Promise<void> => {
          for (;;) {
            // Stop pulling commands once the caller has cancelled the batch.
            //
            // Without this check the loop keeps dispatching the remaining
            // entries, and nothing downstream can stop them: `executor.spawn`
            // registers its abort listener when the child starts, so for a
            // command dispatched AFTER the abort the signal is already aborted
            // and the listener never fires. Measured before the fix: an abort
            // at t=702ms of a 6-command batch still started the side effect of
            // 4 of them, and the call returned 2.1s after the caller gave up.
            // The first iteration is covered too — nothing is dispatched after
            // a cancellation that arrived before this loop started.
            if (signal.aborted) return
            const index = cursor
            cursor += 1
            if (index >= pool.length) return
            const item = asRecord(pool[index])
            const label = String(item.label ?? `command-${index}`)
            const command = String(item.command ?? '')
            const outcome = await runConfined('bash', command, entry, signal)
            const result = outcome as { stdout?: string; exitCode?: number; truncated?: boolean }
            const stdout = typeof result.stdout === 'string' ? result.stdout : ''
            // The label alone is not an identity: two commands may share one,
            // and a shared source name makes the second `indexSource` overwrite
            // the first while both entries still report chunks. The position in
            // this call is part of the key, so every entry owns its source.
            const source = `batch:${index}:${label}`
            const { chunks } = store.indexSource(source, stdout, {
              sourceType: 'command',
              command,
              ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
            })
            entries[index] = {
              label,
              source,
              exitCode: result.exitCode ?? -1,
              chunks,
              bytes: Buffer.byteLength(stdout, 'utf8'),
              truncated: result.truncated === true,
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(limit, Math.max(pool.length, 1)) }, worker))
        // Slots keep the reported order equal to the requested order even though
        // the commands ran concurrently.
        const indexed = entries.filter((entryResult): entryResult is BatchEntry => entryResult !== undefined)

        // Through the same pipeline `ctx_search` uses, so a batch's answers and
        // a search's answers cannot disagree about ranking. It also means a
        // repeated batch query is a cache hit rather than a second BM25 pass
        // over a corpus that has not changed.
        const hits = queries.map((query) => {
          const result = retrieve(retrieval, {
            query,
            limit: config.search.defaultLimit,
            sort: 'relevance',
            snippetChars: config.search.snippetChars,
            // The batch just wrote these sources, so its own generation of the
            // corpus is current by construction; caching it buys nothing and
            // would put command output in a table its retention policy has to
            // reason about.
            noCache: true,
          })
          return {
            query,
            matches: result.matches,
            quality: result.quality,
            contradictions: result.contradictions,
            hints: result.hints,
          }
        })

        return {
          ok: indexed.every((entryResult) => entryResult.exitCode === 0),
          // A batch cut short by the caller is not a batch that ran everything:
          // say so instead of letting a short `indexed[]` read as a full pass.
          aborted: signal.aborted,
          indexed,
          results: hits,
          skipped: commands.length - pool.length,
        }
      }) as never,
    }),
    defineTool({
      name: `${prefix}index`,
      description: 'Index a project-relative file or directory into the persistent full-text store so later searches rank it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file or directory to index.' },
          source: { type: 'string', description: 'Source label stored with the chunks.' },
          sourceType: { type: 'string', description: 'What kind of thing was indexed: file, directory, url, command, or session.' },
          retention: { type: 'string', enum: ['ephemeral', 'session', 'project', 'persistent'], description: 'Lifecycle class the garbage collector treats this source under.' },
          maxFiles: { type: 'integer', description: 'Upper bound on files walked.' },
          maxDepth: { type: 'integer', description: 'Upper bound on directory depth.' },
          exclude: { type: 'array', description: 'Whole path segments to skip, matched segment by segment rather than as substrings.', items: { type: 'string' } },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown, execution: ToolRunContext) => {
        const args = asRecord(rawArgs)
        const cwd = cwdOf(execution)
        const relative = String(args.path ?? '.')
        let base: string
        try {
          base = relative === '.' ? cwd : resolveProjectPath(cwd, relative)
        } catch (error) {
          return failure(messageOf(error), { path: relative })
        }
        const source = typeof args.source === 'string' && args.source !== ''
          ? args.source
          : `project:${path.basename(cwd)}`
        const sourceType = typeof args.sourceType === 'string' && args.sourceType !== ''
          ? args.sourceType
          : (statOrNull(base)?.isFile() === true ? 'file' : 'directory')
        const retention = retentionArg(args.retention)
        const maxFiles = toInt(args.maxFiles, 200)
        const maxDepth = toInt(args.maxDepth, 5)
        const exclude = Array.isArray(args.exclude)
          ? (args.exclude as unknown[]).map((entry) => String(entry))
          : ['node_modules', '.git', 'dist', 'build', '.next', 'coverage']

        // A path that is not there is a different answer from a path that is
        // there and yields nothing, and only the second one is the case where an
        // already-indexed source is about to be left alone.
        if (statOrNull(base) === null) {
          // `resolveProjectPath` already answers that case for a project-
          // relative path; this only covers `.`, the process cwd, which is not
          // project-confined and so never reaches it.
          return failure(`path not found: ${relative}`, emptyIndexReport(relative, source))
        }

        // A path that names a FILE is indexed as that file. `walk` only reads
        // directories, so handing it a file returned no candidates at all and
        // the call came back as "found nothing readable" — while the README has
        // always promised `ctx_index` accepts "berkas atau direktori". The
        // single file is the walk result of one entry.
        const baseStat = statOrNull(base)
        const walkResult =
          baseStat !== null && baseStat.isFile()
            ? { files: [base], excluded: 0 }
            : walk(base, maxDepth, maxFiles, exclude)
        const files = walkResult.files
        const combined: string[] = []
        // Offset of the next byte to be appended, tracked while walking so each
        // chunk can be tied back to a real line in a real file. The separator
        // is part of each piece rather than applied by `join`, because a `join`
        // would shift every offset after the first and turn the line numbers
        // into something approximate.
        const anchors: LineAnchor[] = []
        let offset = 0
        let bytes = 0
        let read = 0
        let skipped = 0
        let failures = 0
        for (const file of files) {
          if (bytes >= INDEX_BUDGET_BYTES) {
            skipped += 1
            continue
          }
          try {
            const stat = statOrNull(file)
            // Only text-sized files are worth reading into the index; a binary
            // pasted in as UTF-8 just pollutes the ranker.
            if (stat === null || stat.size > 1_000_000) {
              skipped += 1
              continue
            }
            const body = readText(file)
            const header = `FILE ${file}\n`
            const from = offset + header.length
            const to = from + body.length
            anchors.push({ path: file, from, to })
            const piece = `${header}${body}\n`
            combined.push(piece)
            offset += piece.length
            bytes += body.length
            read += 1
          } catch {
            failures += 1
          }
        }
        // Nothing readable means nothing to store. Calling `indexSource` here
        // would delete every chunk the source already had and then add none —
        // a nonexistent or fully excluded path silently destroying the corpus it
        // was meant to refresh while reporting ok, files: 0, chunks: 0.
        if (read === 0) {
          const hint = failures > 0
            ? 'every candidate file failed to read'
            : files.length === 0
              ? (walkResult.excluded > 0
                  ? `every file under ${relative} matched an exclude rule`
                  : 'the walk found no files at all')
              : 'every candidate file was skipped'
          return failure(
            `found nothing readable under ${relative}; existing source ${JSON.stringify(source)} left untouched`,
            {
              ...emptyIndexReport(relative, source),
              files: files.length,
              excluded: walkResult.excluded,
              skipped,
              failures,
              hint,
            },
          )
        }
        const { chunks, applied, sourceId, contentHash, firstSeenAt, retention: storedRetention } =
          store.indexSource(
          source,
          combined.join(''),
          {
            sourceType,
            pathOrUrl: base,
            // Recorded so a later snapshot can name what THIS session produced
            // without the snapshot builder having to reconstruct it from the
            // event log, where the same fact is only a command string.
            ...(sessionIdOf(execution) === undefined ? {} : { sessionId: sessionIdOf(execution) }),
            ...(retention === undefined ? {} : { retention }),
            anchors,
          },
        )
        return {
          ok: failures === 0,
          source,
          sourceId,
          sourceType,
          files: files.length,
          indexed: read,
          excluded: walkResult.excluded,
          skipped,
          failures,
          bytes,
          chunks,
          // Same name and meaning as the store's return, and present on every
          // outcome: `applied` says whether the write happened, so an operator
          // need not infer it from `chunks`, which is identical before and after
          // a refusal that deliberately kept the old corpus.
          applied,
          contentHash,
          firstSeenAt,
          // Reported whether the caller named a class or the store derived one
          // from the source type: a caller that has to guess which lifecycle
          // class its corpus landed in cannot reason about `ctx_gc` at all.
          retention: storedRetention ?? 'project',
        }
      }) as never,
    }),
    defineTool({
      name: `${prefix}search`,
      description: 'Rank the indexed corpus against one or more queries and return scored excerpts with provenance, a quality assessment, and any contradictions the evidence carries.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'array', description: 'Queries to run.', items: { type: 'string' } },
          limit: { type: 'integer', description: 'Maximum hits per query.' },
          source: { type: 'string', description: 'Restrict hits to one indexed source.' },
          sort: { type: 'string', enum: ['relevance', 'timeline'], description: 'Ranking order.' },
          temporal: { type: 'string', enum: ['any', 'latest', 'historical'], description: 'Temporal selection: latest puts the newest evidence first, historical the oldest.' },
          before: { type: 'string', description: 'ISO-8601 timestamp or epoch ms; only evidence written at or before it.' },
          after: { type: 'string', description: 'ISO-8601 timestamp or epoch ms; only evidence written at or after it.' },
          sessionId: { type: 'string', description: 'Restrict hits to evidence indexed for one session.' },
          noCache: { type: 'boolean', description: 'Bypass the retrieval cache for this call.' },
        },
        required: ['queries'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown) => {
        const args = asRecord(rawArgs)
        const queries = Array.isArray(args.queries) ? args.queries.map((q) => String(q)) : []
        const base: Omit<RetrievalRequest, 'query'> = {
          limit: Math.max(1, Math.min(toInt(args.limit, config.search.defaultLimit), config.search.maxLimit)),
          ...(typeof args.source === 'string' && args.source !== '' ? { source: args.source } : {}),
          ...(args.sort === 'timeline' ? { sort: 'timeline' as const } : {}),
          snippetChars: config.search.snippetChars,
          ...(args.temporal === 'latest' || args.temporal === 'historical' ? { temporal: args.temporal } : {}),
          ...(args.before === undefined ? {} : { before: args.before }),
          ...(args.after === undefined ? {} : { after: args.after }),
          ...(typeof args.sessionId === 'string' && args.sessionId !== '' ? { sessionId: args.sessionId } : {}),
          ...(args.noCache === true ? { noCache: true } : {}),
        }
        return {
          ok: true,
          results: queries.map((query) => {
            const result = retrieve(retrieval, { ...base, query })
            return {
              query,
              matches: result.matches,
              quality: result.quality,
              contradictions: result.contradictions,
              temporal: result.temporal,
              cache: result.cache,
              hints: result.hints,
            }
          }),
        }
      }) as never,
    }),
    defineTool({
      name: `${prefix}fetch_and_index`,
      description: 'Fetch one URL, index its text so it stays searchable, and return a bounded summary instead of the whole document.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL.' },
          source: { type: 'string', description: 'Source label stored with the chunks.' },
          query: { type: 'string', description: 'Optional query run immediately against the fetched text.' },
          maxBytes: { type: 'integer', description: 'Upper bound on bytes read.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown, execution: ToolRunContext) => {
        const args = asRecord(rawArgs)
        const url = String(args.url ?? '')
        // `file:`, `data:`, `gopher:` and friends stay refused at the scheme.
        if (!/^https?:\/\//i.test(url)) return failure('url must be absolute http or https')
        const maxBytes = Math.min(toInt(args.maxBytes, 1_048_576), 4_194_304)
        // Every other path in this plugin runs against a wall-clock budget, and an
        // undated `fetch` has none: measured still pending past 13s against a
        // socket that never answered.
        //
        // The budget is composed here rather than declared as `timeoutMs` on the
        // definition: a declared number is fixed for every operator, while this
        // is the one budget the rest of the plugin already uses
        // (`executor.defaultTimeoutMs`, clamped), so a fetch cannot outlive the
        // execution the caller configured.
        const timeoutMs = Math.max(1_000, Math.min(executorOptions.defaultTimeoutMs, MAX_TIMEOUT_MS))
        const deadline = AbortSignal.timeout(timeoutMs)
        const signal = AbortSignal.any([executionSignalFrom(execution.signal), deadline])

        const outcome = await fetchBounded(url, maxBytes, signal, deadline, timeoutMs, allowFetchHosts)
        if (outcome.kind !== 'ok') return failure(outcome.reason, { url })
        const body = outcome.body
        const textBody = body.text
        const source = typeof args.source === 'string' && args.source !== '' ? args.source : `url:${url}`
        const { chunks, sourceId } = store.indexSource(source, htmlToText(textBody), {
          sourceType: 'url',
          pathOrUrl: outcome.finalUrl,
        })
        const query = typeof args.query === 'string' ? args.query : ''
        return {
          ok: true,
          url: outcome.finalUrl,
          source,
          chunks,
          bytes: body.bytes,
          truncated: body.truncated,
          summary: summarize(htmlToText(textBody), 1_000),
          ...(query === ''
            ? {}
            : {
                results: [
                  (() => {
                    const result = retrieve(retrieval, {
                      query,
                      limit: config.search.defaultLimit,
                      sort: 'relevance',
                      snippetChars: config.search.snippetChars,
                      source,
                      noCache: true,
                    })
                    return {
                      query,
                      matches: result.matches,
                      quality: result.quality,
                      contradictions: result.contradictions,
                    }
                  })(),
                ],
              }),
        }
      }) as never,
    }),
    defineTool({
      name: `${prefix}resume`,
      description: 'Rebuild and store the resume snapshot for the calling session, then return it.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Session to snapshot; defaults to the calling session.' } },
        required: [],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown, execution: ToolRunContext) => {
        const args = asRecord(rawArgs)
        const target = typeof args.sessionId === 'string' && args.sessionId !== ''
          ? args.sessionId
          : sessionIdOf(execution)
        if (target === undefined) return failure('no session id on the calling agent and none supplied')
        const snapshot = buildSnapshot(
          db.events(target),
          config.session.maxSnapshotChars,
          snapshotExtras(store, target),
        )
        db.saveSnapshot(target, snapshot)
        return { ok: true, sessionId: target, snapshot }
      }) as never,
    }),
    defineTool({
      name: `${prefix}stats`,
      description: 'Report what the index and session store currently hold: sources, chunks, events, cache, relationships, budget utilisation, and reclaimable records.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async () => {
        const indexStats = store.stats()
        return {
          ok: true,
          index: indexStats,
          sessions: { events: db.eventCount(), sessions: db.sessionCount() },
          // Budget utilisation is a configuration fact plus one measurement, so
          // it belongs next to the numbers it constrains rather than in a
          // separate diagnostic a reader has to know to ask for.
          contextBudget: budgetReport(config.contextBudget),
          cache: cache.stats(),
          relations: graph.stats(),
          gc: gcSummary(store, db, config),
          stateDir,
          indexFile,
          sessionsFile,
        }
      }) as never,
    }),
    defineTool({
      name: `${prefix}doctor`,
      description: 'Self-check: sandbox availability, whether each language runtime is installed, missing, or could not be probed on PATH, state store health, schema versions, cache and graph state, and every failure this plugin recorded.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async () => {
        const pathValue = process.env.PATH ?? ''
        // Three states, not two: a probe that could not read a PATH entry says
        // nothing about the runtime, and a boolean would report that silence as
        // "installed" — an unverified runtime a model would then trust. Every key
        // here is a language this plugin supports, so `detail` never carries the
        // `unsupported language` branch that a direct `probeRuntime` call can hit.
        const runtimes = Object.fromEntries(
          LANGUAGES.map((language) => {
            const probe = probeRuntime(language, pathValue)
            return [language, { status: probe.status, program: probe.program, detail: probe.detail }]
          }),
        )
        // Re-detected here, so the report describes the host as it is now rather
        // than as it was when `apply` ran.
        const provider = refreshSandbox()
        return {
          ok: errors.length === 0,
          version: VERSION,
          node: process.version,
          sandbox: {
            available: executor.sandboxAvailable,
            mode: executorOptions.sandboxMode,
            allowUnconfined: executorOptions.allowUnconfined,
            enforced: provider !== undefined,
          },
          runtimes,
          index: store.stats(),
          sessions: { events: db.eventCount(), sessions: db.sessionCount() },
          // Schema state is reported, not assumed: a store that failed to
          // migrate is a store whose provenance answers are meaningless, and the
          // version pair is the only place that is visible.
          schema: schemaReport(store, db),
          cache: cache.stats(),
          relations: graph.stats(),
          contextBudget: budgetReport(config.contextBudget),
          routing: { ...routing, advisoryThrottle: config.routing.advisoryThrottle },
          errors: errors.slice(),
        }
      }) as never,
    }),
    defineTool({
      name: `${prefix}purge`,
      description: 'Permanently clear the index, the session events, or both. Requires an explicit scope of index, sessions or all plus confirm set to true; otherwise nothing is deleted.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Must be true for any deletion to happen.' },
          scope: { type: 'string', enum: ['index', 'sessions', 'all'], description: 'What to clear: index, sessions or all.' },
        },
        required: ['confirm', 'scope'],
        additionalProperties: false,
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: JSON_OBJECT_RENDER },
      execute: (async (rawArgs: unknown) => {
        const args = asRecord(rawArgs)
        // The registry declares `scope` required but the raw `register` path
        // never validates a call, so a missing or unknown scope must be refused
        // here. Normalising it to `index` made `{"confirm": true}` wipe the
        // whole corpus on a call that named nothing.
        const scope = args.scope
        if (scope !== 'index' && scope !== 'sessions' && scope !== 'all') {
          return failure(
            `scope must be one of index, sessions or all; got ${JSON.stringify(scope ?? null)}; nothing was removed`,
            { deleted: false, reason: 'invalid scope; nothing was removed' },
          )
        }
        if (args.confirm !== true) {
          return { ok: false, deleted: false, reason: 'confirm was not true; nothing was removed', scope }
        }
        const deleted: Record<string, unknown> = {}
        if (scope === 'index' || scope === 'all') deleted.index = store.purge()
        if (scope === 'sessions' || scope === 'all') deleted.sessions = db.purgeAll()
        return { ok: true, deleted: true, scope, ...deleted }
      }) as never,
    }),
    ...defineInfrastructureTools({ store, db, graph, config }),
  ]

  for (const definition of definitions) {
    registrations.push(registerToolSafe(hostContext, definition))
  }

  const registeredTools = registrations.filter((entry) => entry.ok).map((entry) => entry.name)
  const failedNames = registrations.filter((entry) => !entry.ok).map((entry) => entry.name)

  // --- routing gate -------------------------------------------------------
  const routingEnabled = config.routing.advisory || config.routing.denyPatterns.length > 0
  if (routingEnabled) {
    try {
      hostContext.on('tools/pre-execute', (async (execution: ToolRunContext, next: () => Promise<PreToolDecision>) => {
        let decision: ReturnType<typeof evaluate>
        try {
          decision = evaluate(execution.name, execution.arguments, routing, prefix)
        } catch (error) {
          warn(`routing rule rejected a call, failing open: ${messageOf(error)}`)
          return next()
        }
        if (decision.action === 'deny') {
          return { kind: 'deny', reason: decision.reason ?? 'blocked by routing rule' }
        }
        return next()
      }) as never, { prepend: false } as never)
    } catch (error) {
      warn(`could not attach the pre-execute routing gate: ${messageOf(error)}`)
    }
  }

  // --- advisory context ---------------------------------------------------
  if (config.routing.advisory) {
    try {
      hostContext.on('tools/post-execute', ((execution: ToolRunContext, _result: unknown, next: () => Promise<PostToolDecision>) => {
        // The advisory is decoration on a call that already succeeded, so it
        // fails open exactly like the pre-execute gate: a throw here would
        // escape into the host waterfall and turn a successful call into
        // `isError: true` because a *hint* could not be evaluated. A malformed
        // `denyPatterns` entry is one such throw inside `evaluate`.
        try {
          if (!throttle.shouldNudge()) return next()
          const decision = evaluate(execution.name, execution.arguments, routing, prefix)
          if (decision.action !== 'advisory' || decision.targetTool === undefined) return next()
          return Promise.resolve({
            kind: 'accept',
            additionalContexts: [{
              role: 'user',
              content: [{ type: 'text', text: `[context-optimizer] ${decision.reason} Consider ${decision.targetTool} instead.` }],
            }],
          })
        } catch (error) {
          warn(`routing rule could not be evaluated for a finished call, failing open: ${messageOf(error)}`)
          return next()
        }
      }) as never, { prepend: false } as never)
    } catch (error) {
      warn(`could not attach the advisory hook: ${messageOf(error)}`)
    }
  }

  // --- session capture ----------------------------------------------------
  if (config.session.recordEvents) {
    try {
      hostContext.on('session/event', ((session: HostSession, event: HostSessionEvent) => {
        try {
          const classified = classifyEvent(event.type)
          if (classified === null) return
          const content = eventContent(event.type, event.data)
          if (content.trim() === '') return
          db.record({
            sessionId: session.id,
            type: event.type,
            category: classified.category,
            priority: classified.priority,
            content: content.slice(0, 4_000),
            metadata: { seq: event.seq },
            timestamp: event.time,
            cwd: session.header?.cwd ?? '',
          })
        } catch (error) {
          // Capture is best-effort: a malformed event must never surface in the
          // tool result path.
          warn(`session capture dropped an event: ${messageOf(error)}`)
        }
      }) as never)
    } catch (error) {
      warn(`could not attach session capture: ${messageOf(error)}`)
    }
  }

  // --- resume snapshot at assembly --------------------------------------
  if (config.session.injectSnapshot) {
    try {
      const systemPrompt = hostContext.get('systemPrompt') as SystemPromptService | undefined
      if (typeof systemPrompt?.context !== 'function') {
        warn('host exposes no systemPrompt.context(); resume snapshots will not be injected')
      } else {
        systemPrompt.context({
          name: `${name}-resume`,
          order: 60,
          text: (assemble) =>
            renderResume({ db, store, maxChars: config.session.maxSnapshotChars }, assemble, warn),
        })
      }
    } catch (error) {
      warn(`could not register the resume snapshot: ${messageOf(error)}`)
    }
  }

  registerLifecycle(
    hostContext,
    async () => {
      store.close()
      db.close()
    },
    `${name}: state`,
    warn,
  )

  return {
    name,
    version: VERSION,
    stateDir,
    toolPrefix: prefix,
    registrations,
    errors,
    // Read through to the live executor so `view.sandbox.available` describes
    // the host now, not the moment `apply` happened to run.
    get sandbox() {
      return { available: executor.sandboxAvailable, allowUnconfined: executorOptions.allowUnconfined }
    },
    tools: () => registeredTools.slice(),
  }
}

function emptyView(
  errors: readonly string[] = [],
  extra: { stateDir?: string; toolPrefix?: string; sandboxAvailable?: boolean; allowUnconfined?: boolean } = {},
): RuntimeView {
  return {
    name,
    version: VERSION,
    stateDir: extra.stateDir ?? '',
    toolPrefix: extra.toolPrefix ?? '',
    registrations: [],
    errors,
    sandbox: { available: extra.sandboxAvailable ?? false, allowUnconfined: extra.allowUnconfined ?? false },
    tools: () => [],
  }
}

/**
 * Feature-detect the host's sandbox provider.
 *
 * `ctx.get` is optional in practice — a reduced host may expose only
 * `tools.register` — so the service lookup is guarded like every other host
 * call here. An unguarded `ctx.get(...)` was the one statement in `apply` that
 * could throw, which defeats the P4 contract that `apply` never throws.
 */
function resolveSandbox(
  ctx: HostContext,
  warn?: (message: string) => void,
): HostSandboxProvider | undefined {
  let viaGet: unknown
  try {
    if (typeof ctx.get === 'function') viaGet = ctx.get('sandbox')
    else warn?.('host exposes no service lookup; sandbox enforcement is unavailable')
  } catch (error) {
    warn?.(`host refused the sandbox lookup, no sandbox backend resolved: ${messageOf(error)}`)
  }
  const viaProperty = (ctx as unknown as { sandbox?: HostSandboxProvider }).sandbox
  const candidate = (viaGet as HostSandboxProvider | undefined) ?? viaProperty
  return candidate !== undefined && typeof candidate?.confine === 'function' ? candidate : undefined
}

/**
 * Text contributed to one prompt assembly. Empty text contributes nothing, which
 * is what makes "no stored session for this agent" free.
 *
 * The label names the plugin and the fact is stated as recovered context, so the
 * model can tell stored history apart from something the operator just typed.
 */
function renderResume(
  deps: { db: SessionDB; store: ContentStore; maxChars: number },
  assemble: AssembleContext,
  warn: (message: string) => void,
): string {
  const agent = assemble.agent
  const sessionId = agent?.session?.header?.id ?? agent?.id
  if (sessionId === undefined) return ''
  try {
    const db = deps.db
    const snapshot =
      db.snapshot(sessionId) ??
      buildSnapshot(db.events(sessionId), deps.maxChars, snapshotExtras(deps.store, sessionId))
    if (EMPTY_SNAPSHOT.test(snapshot)) return ''
    db.saveSnapshot(sessionId, snapshot)
    return `[context-optimizer] Earlier context from this session, recovered from the local event log:\n${snapshot}`
  } catch (error) {
    warn(`resume snapshot failed: ${messageOf(error)}`)
    return ''
  }
}

/**
 * Evidence and contradiction sections for one session's snapshot.
 *
 * Both come from the session's own writes, which is what keeps the snapshot
 * honest: a resumed session is told what IT produced and where that evidence
 * disagreed, not what the whole corpus happens to contain. Every value is
 * produced by the bounded helpers in `contradiction.ts` and clipped again here,
 * because the snapshot's hard ceiling is the promise this plugin makes and a
 * section that ignores it breaks the whole document.
 */
function snapshotExtras(store: ContentStore, sessionId: string): SnapshotExtras {
  // Eight chunks, and only the first 300 characters of each for the claims.
  // Prompt assembly runs on every turn, so this bound is the difference between
  // a snapshot that costs one indexed lookup and one that walks a 32 MB chunk
  // pair on each of them. A contradiction that needs more than the head of a
  // chunk to be visible is not one this path should be deciding anyway.
  const evidence = store.evidenceOfSession(sessionId, 8)
  if (evidence.length === 0) return {}
  const claims = evidence.map((record) => ({
    evidenceId: record.evidenceId,
    source: record.source,
    snippet: record.text.slice(0, 300),
  }))
  const contradictions = detectContradictions(claims, 5).map(
    (contradiction: Contradiction) =>
      `${contradiction.confidence}: ${contradiction.subject} `
      + `(${contradiction.evidenceA.evidenceId} vs ${contradiction.evidenceB.evidenceId}) `
      + `${contradiction.reason}`.slice(0, 400),
  )
  const important = evidence
    .slice(0, 3)
    .map(
      (record) =>
        `${record.evidenceId} ${record.source} `
        + `${record.sourceType} ${record.charLen} characters`
        + (record.lineStart === undefined ? '' : ` lines ${record.lineStart}-${record.lineEnd ?? record.lineStart}`)
        + (record.command === undefined ? '' : ` command ${record.command.slice(0, 120)}`),
    )
  return {
    importantEvidence: important,
    contradictions,
  }
}

/**
 * Reclaimable totals for `ctx_stats`.
 *
 * A bounded sample, and labelled as one: the full answer is `ctx_gc` in dry-run
 * mode, which reads every row. Counting to the cap and reporting the total
 * anyway would be a number that looks complete and is not.
 */
function gcSummary(store: ContentStore, db: SessionDB, config: ContextOptimizerConfig): Record<string, unknown> {
  const limit = 5_000
  const storeRecords = store.gcRecords(limit)
  const eventRecords = db.gcRecords(limit)
  const plan = planGc(
    {
      records: [
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
      ],
      maxDeletes: 10_000,
    },
    Date.now(),
    {
      ephemeralMs: config.retention.ephemeralMs,
      sessionMs: config.retention.sessionMs,
      projectMs: config.retention.projectMs,
      maxEventsPerSession: config.session.maxEventsPerSession,
    },
    true,
  )
  return {
    reclaimableRecords: plan.reclaimable.records,
    reclaimableBytes: plan.reclaimable.bytes,
    protectedRecords: plan.protected.records,
    sampled: storeRecords.length >= limit || eventRecords.length >= limit,
  }
}

/** Schema versions of both stores, so a stale store is visible without opening it. */
function schemaReport(store: ContentStore, db: SessionDB): Record<string, unknown> {
  return {
    index: {
      version: store.report.toVersion,
      applied: store.report.applied.slice(),
      adoptedLegacy: store.report.adoptedLegacy,
    },
    sessions: {
      version: db.report.toVersion,
      applied: db.report.applied.slice(),
      adoptedLegacy: db.report.adoptedLegacy,
    },
  }
}

/** A retention argument that is one of the four classes, or nothing. */
function retentionArg(value: unknown): 'ephemeral' | 'session' | 'project' | 'persistent' | undefined {
  switch (value) {
    case 'ephemeral':
    case 'session':
    case 'project':
    case 'persistent':
      return value
    default:
      return undefined
  }
}

/** Size of one generated payload, in characters of its canonical serial form. */
function payloadSize(value: unknown): number {
  return measureContext(value)
}

const EMPTY_SNAPSHOT = /^<session_snapshot>\s*<\/session_snapshot>$/

function failure(reason: string, detail: Record<string, unknown> = {}): unknown {
  return { ok: false, error: reason, ...detail }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return fallback
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS)
}

function executionSignalFrom(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal
}

/**
 * Race a promise that takes no signal against one that does.
 *
 * `dns.lookup` cannot be cancelled: without this the fetch budget would cover
 * the socket and nothing else, and a resolver that never answers would outlive
 * the deadline the caller was promised. The abort wins, and the fetch reports a
 * budget failure instead of hanging on the resolver.
 */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('the fetch budget expired while resolving the host')
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** What `ctx_index` reports when it stored nothing at all. */
function emptyIndexReport(relative: string, source: string): Record<string, unknown> {
  return {
    source,
    path: relative,
    files: 0,
    indexed: 0,
    excluded: 0,
    skipped: 0,
    failures: 0,
    bytes: 0,
    chunks: 0,
    applied: false,
  }
}

interface WalkResult {
  readonly files: string[]
  /** Entries dropped by an exclude rule, so a silent drop stays countable. */
  readonly excluded: number
}

/**
 * Collect files under `root`.
 *
 * Exclusions match whole path segments. `entry.name.includes(needle)` treated
 * every rule as a substring, so the default `build` dropped `src/build-tools`
 * along with `build` — and the file then went missing from `files` while the
 * tool still counted it as part of the walk. Excluded subtrees are counted but
 * never contribute files, so the report can say how much was dropped.
 */
function walk(root: string, maxDepth: number, maxFiles: number, exclude: readonly string[]): WalkResult {
  const found: string[] = []
  let excluded = 0

  const readEntries = (dir: string): Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }

  /** Files an excluded subtree holds, counted without collecting them. */
  const countExcluded = (dir: string, depth: number): number => {
    if (depth > maxDepth) return 1
    let total = 0
    for (const entry of readEntries(dir)) {
      total += 1
      if (entry.isDirectory()) total += countExcluded(path.join(dir, entry.name), depth + 1)
    }
    return total
  }

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.length >= maxFiles) return
    for (const entry of readEntries(dir)) {
      if (found.length >= maxFiles) return
      const full = path.join(dir, entry.name)
      // One entry is one path segment, so equality is a segment match.
      if (exclude.includes(entry.name)) {
        excluded += entry.isDirectory() ? countExcluded(full, depth + 1) : 1
        continue
      }
      if (entry.isDirectory()) visit(full, depth + 1)
      else if (entry.isFile()) found.push(full)
    }
  }

  visit(root, 0)
  return { files: found, excluded }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarize(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input
  return `${input.slice(0, maxChars - 1)}…`
}

// --- URL guards -----------------------------------------------------------

/** Ceiling on redirects followed by one fetch. */
const MAX_REDIRECTS = 5

interface FetchBody {
  /** Decoded body, cut at `maxBytes`. */
  readonly text: string
  /** Bytes actually read from the socket, which is what `maxBytes` bounds. */
  readonly bytes: number
  /**
   * True when the read stopped at the ceiling. A body that happens to end
   * exactly on it is reported as cut too: the reader cannot tell without
   * waiting for one more chunk, which would hold the socket open.
   */
  readonly truncated: boolean
}

type FetchOutcome =
  | { readonly kind: 'ok'; readonly finalUrl: string; readonly body: FetchBody }
  | { readonly kind: 'error'; readonly reason: string }

/**
 * Hosts the URL guard may reach even though they resolve to a private address.
 *
 * Read straight from the raw configuration rather than from `resolveConfig`: the
 * guard's escape hatch has to be available for a loopback fixture or an internal
 * service an operator actually trusts, and an entry is an explicit opt-in either
 * way. Anything malformed is ignored and the guard decides alone.
 */
function readFetchAllowHosts(rawConfig: unknown, warn: (message: string) => void): readonly string[] {
  if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) return []
  const fetch = (rawConfig as Record<string, unknown>).fetch
  if (typeof fetch !== 'object' || fetch === null || Array.isArray(fetch)) return []
  const hosts = (fetch as Record<string, unknown>).allowHosts
  if (hosts === undefined) return []
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string' || host === '')) {
    warn('fetch.allowHosts must be an array of non-empty strings; the URL guard is unsuppressed')
    return []
  }
  return (hosts as string[]).map((host) => host.toLowerCase())
}

/**
 * Why a URL is refused before a socket is opened.
 *
 * Checking the scheme alone let `http://127.0.0.1:<port>/` through end to end,
 * so anything the host exposes on a private interface — an unauthenticated dev
 * server, a cloud metadata endpoint, a router admin panel — could be read into
 * the index on the model's behalf. The address is resolved here and refused
 * when it lands on loopback, link-local, or any private range, unless the host
 * was explicitly allowlisted.
 */
async function checkUrlGuard(
  raw: string,
  protocol: 'http:' | 'https:',
  allowHosts: readonly string[],
  signal: AbortSignal,
): Promise<{ ok: true; href: string; host: string } | { ok: false; reason: string }> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: `url could not be parsed: ${raw}` }
  }
  if (parsed.protocol !== protocol) {
    return { ok: false, reason: `url scheme must be ${protocol}` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'url must not carry credentials' }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === '') return { ok: false, reason: `url has no host: ${raw}` }
  if (allowHosts.includes(host.toLowerCase())) return { ok: true, href: parsed.href, host }
  // Node resolves through getaddrinfo, so a name pointing at 127.0.0.1 is caught
  // the same way a literal is.
  const addresses = await raceAbort(resolveHostAddresses(host), signal)
  const denied = addresses.find((address) => isPrivateAddress(address))
  if (denied !== undefined) {
    return { ok: false, reason: `url host ${host} resolves to ${denied}, a private or loopback address` }
  }
  return { ok: true, href: parsed.href, host }
}

function resolveHostAddresses(host: string): Promise<string[]> {
  const literal = stripIPv6Brackets(host)
  if (literal !== undefined) return Promise.resolve([literal])
  return new Promise<string[]>((done) => {
    try {
      lookup(host, { all: true, verbatim: true }, (error, entries) => {
        if (error !== null && error !== undefined) {
          // Resolution failing is not a private address; the fetch reports it.
          done([])
          return
        }
        done(Array.isArray(entries) ? entries.map((entry) => entry.address) : [])
      })
    } catch {
      done([])
    }
  })
}

/** IPv6 literals arrive bracketed; normalise them to plain address text. */
function stripIPv6Brackets(host: string): string | undefined {
  if (!host.includes(':')) return undefined
  const inner = host.replace(/^\[|\]$/g, '')
  return net.isIP(inner) === 6 ? inner : undefined
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? numbers
    : undefined
}

/**
 * Loopback, link-local, private and other host-only ranges.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is unwrapped first: it is the spelling
 * a dual-stack host answers with, and it must not slip past the IPv4 table.
 */
function isPrivateAddress(address: string): boolean {
  const bare = address.split('%')[0] ?? address
  const unwrapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)
  const ipv4 = ipv4Parts(unwrapped === null ? bare : unwrapped[1]!)
  if (ipv4 !== undefined) {
    const [a = 0, b = 0] = ipv4
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  const normalized = bare.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('ff')) return true
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true
  return false
}

/**
 * Fetch one URL with a deadline, a byte ceiling, and a per-hop address check.
 *
 * Three bounds the previous version lacked:
 * - `redirect: 'manual'`, because `follow` walks a 302 into an internal address
 *   without ever looking at it again;
 * - the body is streamed and cut at `maxBytes`, because `await response.text()`
 *   then `slice` buffers the whole document first — a 256 MiB response was fully
 *   resident while the tool reported `bytes: 10`;
 * - the call runs against a merged deadline signal.
 */
async function fetchBounded(
  raw: string,
  maxBytes: number,
  signal: AbortSignal,
  deadline: AbortSignal,
  timeoutMs: number,
  allowHosts: readonly string[],
): Promise<FetchOutcome> {
  let current = raw
  let protocol: 'http:' | 'https:' = raw.toLowerCase().startsWith('https:') ? 'https:' : 'http:'
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let guard: Awaited<ReturnType<typeof checkUrlGuard>>
    try {
      guard = await checkUrlGuard(current, protocol, allowHosts, signal)
    } catch (error) {
      // Resolving the host is on the budget too: it is raced against the same
      // signal rather than allowed to outlive it.
      return fetchFailure(error, deadline, signal, timeoutMs)
    }
    if (!guard.ok) return { kind: 'error', reason: guard.reason }
    let response: Response
    try {
      response = await fetch(guard.href, { redirect: 'manual', signal })
    } catch (error) {
      return fetchFailure(error, deadline, signal, timeoutMs)
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      if (location === null || location === '') {
        return { kind: 'error', reason: `redirect without a location header (HTTP ${response.status})` }
      }
      let next: URL
      try {
        next = new URL(location, guard.href)
      } catch {
        return { kind: 'error', reason: `unusable redirect target: ${location}` }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { kind: 'error', reason: `redirect to a ${next.protocol} target is refused` }
      }
      protocol = next.protocol
      current = next.href
      continue
    }

    if (!response.ok) return { kind: 'error', reason: `fetch failed with HTTP ${response.status}` }

    const body = await readBoundedBody(response, maxBytes, signal, deadline, timeoutMs)
    if (body.kind === 'error') return { kind: 'error', reason: body.reason }
    return { kind: 'ok', finalUrl: guard.href, body: body.value }
  }
  return { kind: 'error', reason: `more than ${MAX_REDIRECTS} redirects` }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** One reason for a stopped fetch, whichever of the two stops actually fired. */
function fetchFailure(
  error: unknown,
  deadline: AbortSignal,
  signal: AbortSignal,
  timeoutMs: number,
): { kind: 'error'; reason: string } {
  if (deadline.aborted) return { kind: 'error', reason: `fetch exceeded its ${timeoutMs}ms budget` }
  if (signal.aborted) return { kind: 'error', reason: `fetch aborted: ${messageOf(error)}` }
  return { kind: 'error', reason: messageOf(error) }
}

type BodyOutcome =
  | { readonly kind: 'ok'; readonly value: FetchBody }
  | { readonly kind: 'error'; readonly reason: string }

/**
 * Read at most `maxBytes` from the response, then stop.
 *
 * `maxBytes` is an upper bound on bytes *read*, so the read has to stop there.
 * The size is measured in encoded bytes (the wire form) and the cut lands on a
 * UTF-8 boundary, so a multi-byte character at the edge cannot corrupt the text
 * the index and the summary are built from.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  deadline: AbortSignal,
  timeoutMs: number,
): Promise<BodyOutcome> {
  const parts: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    const cut = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer
    return {
      kind: 'ok',
      value: { text: decodeBody(cut), bytes: cut.byteLength, truncated: cut.byteLength < buffer.byteLength },
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const remaining = maxBytes - bytes
      if (value.byteLength >= remaining) {
        parts.push(value.subarray(0, Math.max(remaining, 0)))
        bytes = maxBytes
        truncated = true
        break
      }
      parts.push(value)
      bytes += value.byteLength
    }
  } catch (error) {
    if (deadline.aborted) return { kind: 'error', reason: `fetch exceeded its ${timeoutMs}ms budget` }
    if (signal.aborted && !deadline.aborted) return { kind: 'error', reason: `fetch aborted: ${messageOf(error)}` }
    return { kind: 'error', reason: messageOf(error) }
  } finally {
    // The connection is closed even when the body was cut short, so a 256 MiB
    // response stops transferring at the ceiling instead of running to the end.
    await reader.cancel().catch(() => {})
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return { kind: 'ok', value: { text: decodeBody(joined), bytes, truncated } }
}

function decodeBody(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

