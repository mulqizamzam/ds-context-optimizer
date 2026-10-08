/** Languages `ctx_execute` can dispatch, each backed by an argv the sandbox wraps. */
export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'bash'
  | 'ruby'
  | 'php'
  | 'perl'
  | 'r'
  | 'lua'
  | 'go'
  | 'rust'
  | 'deno'

/** A language the host can actually run, plus how to feed it code on stdin. */
export interface RuntimeSpec {
  /** Program name, resolved from PATH inside the confinement. */
  readonly program: string
  /** Fixed argv. Code is always delivered on stdin, never as an argument. */
  readonly args: readonly string[]
}

/** How completely a backend confines one execution. Mirrors the host's own enum. */
export type Enforcement = 'full' | 'partial'

/** The subset of the host sandbox provider this plugin calls. */
export interface ConfinedArgv {
  readonly argv: readonly string[]
  readonly enforcement: Enforcement
}

export interface SandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write'
  readonly workspaceRoot: string
  readonly sessionId?: string
}

export interface SandboxLike {
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}

/** One execution outcome. `stdout` is already bounded by `truncateStdout`. */
export interface ExecuteResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly truncated: boolean
  /**
   * How completely the sandbox backend enforced the requested file policy.
   *
   * `partial` also covers a run that never started (a signal already aborted):
   * no confinement mode may be claimed for a process that did not exist, so the
   * value must not assert one. Read `unconfined` to tell that case apart.
   */
  readonly enforcement: Enforcement
  /** True only when no backend was available and the argv ran unconfined by choice. */
  readonly unconfined: boolean
  /**
   * Verbatim argv after confinement, for diagnosing a runner failure.
   *
   * On a never-spawned result this is the argv that WOULD have run: the early
   * return precedes the sandbox call, so no wrapper was ever built.
   */
  readonly argv: readonly string[]
}

/** One event captured from the host session stream and stored for resume. */
export interface SessionEvent {
  readonly sessionId: string
  readonly type: string
  readonly category: string
  readonly priority: number
  readonly content: string
  readonly metadata: Record<string, unknown>
  /** Unix epoch ms, taken from the host event's `time`. */
  readonly timestamp: number
  readonly cwd: string
  /**
   * Stable identity of the stored row. Derived by the store when the caller
   * does not supply one, so a reference handed to the model survives a restart.
   */
  readonly eventId?: string
  /** Epoch ms of the first time this row was stored. */
  readonly firstSeenAt?: number
  /** Epoch ms of the last time this row was written. */
  readonly lastSeenAt?: number
}

/** One indexed chunk plus the source it came from. */
export interface IndexedChunk {
  readonly source: string
  readonly ordinal: number
  readonly text: string
}

/**
 * One ranked search hit.
 *
 * The provenance fields were added alongside the original four, never in place
 * of them: a caller that only reads `source`, `ordinal`, `score`, and `snippet`
 * keeps working, and a caller that wants to answer "where did this come from"
 * now can. Every added field is small and fixed-size, so widening a hit does not
 * widen the payload a model sees — the snippet remains the only unbounded field
 * and it is clipped by the store.
 */
export interface SearchHit {
  readonly source: string
  readonly ordinal: number
  readonly score: number
  readonly snippet: string
  /** Stable identity of the source this chunk belongs to. */
  readonly sourceId: string
  /** Stable identity of this chunk within the source. */
  readonly chunkId: string
  /** Stable evidence identity, usable with `ctx_expand`. */
  readonly evidenceId: string
  /** SHA-256 of the chunk text as stored. */
  readonly contentHash: string
  /** Present only when the source was indexed with real line metadata. */
  readonly lineStart?: number
  readonly lineEnd?: number
  /** Epoch ms of the last write that produced this chunk. */
  readonly updatedAt: number
  /** Epoch ms of the first write that produced this chunk. */
  readonly firstSeenAt: number
  /** `'file'`, `'directory'`, `'url'`, `'command'`, `'session'`, or `'index'`. */
  readonly sourceType: string
  readonly pathOrUrl?: string
  /**
   * True when the stored hash no longer matches the text the index holds.
   * Always false for a fresh search: the hash is written in the same
   * transaction as the text, so this only fires on out-of-band damage.
   */
  readonly stale: boolean
}

/**
 * One chunk plus everything known about where it came from.
 *
 * `text` is the whole chunk, which is why this type never appears in a search
 * result: it is the payload `ctx_expand` hands over after a bounded request.
 */
export interface EvidenceRecord {
  readonly evidenceId: string
  readonly sourceId: string
  readonly chunkId: string
  readonly source: string
  readonly ordinal: number
  readonly sourceType: string
  readonly pathOrUrl?: string
  readonly lineStart?: number
  readonly lineEnd?: number
  readonly command?: string
  readonly sessionId?: string
  readonly contentHash: string
  readonly charLen: number
  readonly text: string
  readonly indexedAt: number
  readonly updatedAt: number
  readonly firstSeenAt: number
  readonly stale: boolean
}

/** Lifecycle class a stored record is garbage-collected under. */
export type RetentionClass = 'ephemeral' | 'session' | 'project' | 'persistent'