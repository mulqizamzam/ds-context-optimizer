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
}

/** One indexed chunk plus the source it came from. */
export interface IndexedChunk {
  readonly source: string
  readonly ordinal: number
  readonly text: string
}

/** One ranked search hit. */
export interface SearchHit {
  readonly source: string
  readonly ordinal: number
  readonly score: number
  readonly snippet: string
}