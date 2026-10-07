import path from 'node:path'
import type { SandboxMode } from './host.js'

export interface ExecutorConfig {
  readonly defaultTimeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly sandboxMode: Exclude<SandboxMode, 'danger-full-access'>
  readonly allowUnconfined: boolean
  readonly envAllowlist: readonly string[]
  readonly scratchDir: string
}

export interface SearchConfig {
  readonly defaultLimit: number
  readonly maxLimit: number
  readonly snippetChars: number
}

export interface RoutingSettings {
  readonly advisory: boolean
  readonly advisoryThrottle: number
  readonly denyPatterns: readonly string[]
}

export interface SessionConfig {
  readonly recordEvents: boolean
  readonly maxEventsPerSession: number
  readonly maxSnapshotChars: number
  readonly injectSnapshot: boolean
}

export interface ContextOptimizerConfig {
  /** Directory holding the index and session databases. */
  readonly stateDir: string
  /** Prefix for every registered tool name. */
  readonly toolPrefix: string
  readonly executor: ExecutorConfig
  readonly search: SearchConfig
  readonly routing: RoutingSettings
  readonly session: SessionConfig
}

export const DEFAULT_CONFIG: ContextOptimizerConfig = {
  stateDir: path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? '.dsh'), 'dsh-context-optimizer'),
  toolPrefix: 'ctx_',
  executor: {
    defaultTimeoutMs: 30_000,
    maxStdoutBytes: 8_192,
    maxStderrBytes: 4_096,
    sandboxMode: 'workspace-write',
    allowUnconfined: false,
    envAllowlist: ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'PYTHONPATH'],
    scratchDir: '/tmp',
  },
  search: { defaultLimit: 5, maxLimit: 50, snippetChars: 240 },
  routing: { advisory: true, advisoryThrottle: 10, denyPatterns: [] },
  session: { recordEvents: true, maxEventsPerSession: 5_000, maxSnapshotChars: 2_048, injectSnapshot: true },
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Merge operator configuration over the defaults, rejecting anything the plugin
 * would otherwise silently coerce. The caller catches and degrades: a bad
 * config disables the plugin, it does not crash the host.
 */
export function resolveConfig(raw: unknown): ContextOptimizerConfig {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config must be a mapping')
  }
  const input = raw as Record<string, unknown>

  const executorInput = mapping(input.executor, 'executor')
  const searchInput = mapping(input.search, 'search')
  const routingInput = mapping(input.routing, 'routing')
  const sessionInput = mapping(input.session, 'session')

  const stateDir = optionalString(input.stateDir, 'stateDir') ?? DEFAULT_CONFIG.stateDir
  const toolPrefix = optionalString(input.toolPrefix, 'toolPrefix') ?? DEFAULT_CONFIG.toolPrefix
  if (!/^[a-z][a-z0-9_]*_$/.test(toolPrefix)) {
    throw new ConfigError(`toolPrefix must be a lowercase identifier ending in "_"; got ${JSON.stringify(toolPrefix)}`)
  }

  const sandboxMode = optionalString(executorInput.sandboxMode, 'executor.sandboxMode')
  if (sandboxMode !== undefined && sandboxMode !== 'read-only' && sandboxMode !== 'workspace-write') {
    throw new ConfigError(
      `executor.sandboxMode must be "read-only" or "workspace-write"; got ${JSON.stringify(sandboxMode)}`,
    )
  }

  return {
    stateDir: path.resolve(stateDir),
    toolPrefix,
    executor: {
      defaultTimeoutMs: positiveInt(executorInput.defaultTimeoutMs, 'executor.defaultTimeoutMs', DEFAULT_CONFIG.executor.defaultTimeoutMs),
      maxStdoutBytes: positiveInt(executorInput.maxStdoutBytes, 'executor.maxStdoutBytes', DEFAULT_CONFIG.executor.maxStdoutBytes),
      maxStderrBytes: positiveInt(executorInput.maxStderrBytes, 'executor.maxStderrBytes', DEFAULT_CONFIG.executor.maxStderrBytes),
      sandboxMode: (sandboxMode as ContextOptimizerConfig['executor']['sandboxMode'] | undefined) ?? DEFAULT_CONFIG.executor.sandboxMode,
      allowUnconfined: optionalBool(executorInput.allowUnconfined, 'executor.allowUnconfined') ?? DEFAULT_CONFIG.executor.allowUnconfined,
      envAllowlist: optionalStringArray(executorInput.envAllowlist, 'executor.envAllowlist') ?? DEFAULT_CONFIG.executor.envAllowlist,
      scratchDir: optionalString(executorInput.scratchDir, 'executor.scratchDir') ?? DEFAULT_CONFIG.executor.scratchDir,
    },
    search: {
      defaultLimit: positiveInt(searchInput.defaultLimit, 'search.defaultLimit', DEFAULT_CONFIG.search.defaultLimit),
      maxLimit: positiveInt(searchInput.maxLimit, 'search.maxLimit', DEFAULT_CONFIG.search.maxLimit),
      snippetChars: positiveInt(searchInput.snippetChars, 'search.snippetChars', DEFAULT_CONFIG.search.snippetChars),
    },
    routing: {
      advisory: optionalBool(routingInput.advisory, 'routing.advisory') ?? DEFAULT_CONFIG.routing.advisory,
      advisoryThrottle: nonNegativeInt(routingInput.advisoryThrottle, 'routing.advisoryThrottle', DEFAULT_CONFIG.routing.advisoryThrottle),
      denyPatterns: denyPatterns(routingInput.denyPatterns),
    },
    session: {
      recordEvents: optionalBool(sessionInput.recordEvents, 'session.recordEvents') ?? DEFAULT_CONFIG.session.recordEvents,
      maxEventsPerSession: nonNegativeInt(sessionInput.maxEventsPerSession, 'session.maxEventsPerSession', DEFAULT_CONFIG.session.maxEventsPerSession),
      maxSnapshotChars: positiveInt(sessionInput.maxSnapshotChars, 'session.maxSnapshotChars', DEFAULT_CONFIG.session.maxSnapshotChars),
      injectSnapshot: optionalBool(sessionInput.injectSnapshot, 'session.injectSnapshot') ?? DEFAULT_CONFIG.session.injectSnapshot,
    },
  }
}

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value) || value === null) {
    throw new ConfigError(`${field} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ConfigError(`${field} must be a boolean`)
  return value
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`${field} must be an array of strings`)
  }
  return [...(value as string[])]
}

/**
 * Validate `routing.denyPatterns` by compiling every entry right here.
 *
 * These are stored as plain strings and compiled once per command inside
 * `routing.evaluate`, so an uncompiled gate lets a malformed regex boot clean —
 * `view.errors` empty, operator convinced the rule is live — and then throw at
 * run time, where the pre-execute listener fails open (the deny rule silently
 * never denies) and the post-execute listener lets the throw escape. Compiling
 * here means `apply` degrades to "plugin disabled, and here is why" instead,
 * which is the promise the README makes about malformed patterns.
 *
 * The compile target is exactly the string `apply` forwards to `evaluate` as
 * `routing.denyPatterns`, so this validates what actually runs.
 */
function denyPatterns(value: unknown): string[] {
  const patterns = optionalStringArray(value, 'routing.denyPatterns') ?? []
  for (const pattern of patterns) {
    try {
      new RegExp(pattern)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ConfigError(
        `routing.denyPatterns entry is not a valid regular expression: ${JSON.stringify(pattern)} (${reason})`,
      )
    }
  }
  return patterns
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${field} must be a positive integer`)
  }
  return value
}

function nonNegativeInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${field} must be a non-negative integer`)
  }
  return value
}