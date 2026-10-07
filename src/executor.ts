import { spawn } from 'node:child_process'
import { runtimeFor } from './runtime.js'
import { createBoundedCollector, truncateStdout } from './truncate.js'
import type { Enforcement, ExecuteResult, Language, SandboxLike, SandboxPolicy } from './types.js'

export interface ExecutorOptions {
  /** Wall-clock budget for one execution before SIGKILL. */
  readonly defaultTimeoutMs: number
  /** Byte budget for stdout before the tail replaces it. */
  readonly maxStdoutBytes: number
  /** Byte budget for stderr; stderr is diagnostics, never a data channel. */
  readonly maxStderrBytes: number
  /** File-effect policy requested from the host sandbox provider. */
  readonly sandboxMode: 'read-only' | 'workspace-write'
  /**
   * Run unconfined when the host has no usable sandbox backend. Default false:
   * a code-execution tool that silently drops its boundary is worse than one
   * that refuses.
   */
  readonly allowUnconfined: boolean
  /** Environment names copied from the host env into the child. */
  readonly envAllowlist: readonly string[]
  /**
   * Scratch directory handed to the child as `HOME`. Runtimes that insist on a
   * writable home fail loudly when there is none, which is why this is a real
   * directory rather than the caller's project.
   */
  readonly scratchDir: string
}

/** Hard memory ceiling per stream: the collector stops here regardless of config. */
const COLLECTOR_CEILING_BYTES = 1 << 20

/**
 * Exit code an abort produces: the child would have been signalled, and a
 * signal is never reported as a success (see the `close` handler below).
 */
const ABORT_EXIT_CODE = 137

export const DEFAULT_EXECUTOR_OPTIONS: ExecutorOptions = {
  defaultTimeoutMs: 30_000,
  maxStdoutBytes: 8_192,
  maxStderrBytes: 4_096,
  sandboxMode: 'workspace-write',
  allowUnconfined: false,
  envAllowlist: ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'PYTHONPATH'],
  scratchDir: '/tmp',
}

export class UnconfinedExecutionError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'UnconfinedExecutionError'
  }
}

export interface RunRequest {
  readonly language: Language
  readonly code: string
  readonly cwd: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly sessionId?: string
  /**
   * Extra child variables. `HOME` and `TARGET_FILE` are pinned by the executor
   * and ignore anything supplied here.
   */
  readonly env?: Record<string, string>
  /** Set by `runWithFile` to expose the confined target as `TARGET_FILE`. */
  readonly targetFile?: string
}

/**
 * Runs model-authored code as a confined subprocess.
 *
 * The confinement boundary is the host's own sandbox provider, not this class:
 * `ctx.sandbox.confine` wraps argv and returns the argv to spawn. That boundary
 * is **file-effect only** — it does not restrict reads and does not carry a
 * network namespace. `README.md` § Security states this in full; callers that
 * need network denial must add their own.
 */
export class SandboxExecutor {
  constructor(
    private readonly sandbox: SandboxLike | undefined,
    private readonly options: ExecutorOptions = DEFAULT_EXECUTOR_OPTIONS,
  ) {}

  get sandboxAvailable(): boolean {
    return this.sandbox !== undefined
  }

  async run(request: RunRequest): Promise<ExecuteResult> {
    const spec = runtimeFor(request.language)
    const requested: string[] = [spec.program, ...spec.args]

    // `addEventListener('abort', …)` never fires for a signal that is ALREADY
    // aborted, so without this check a caller that hands `run()` a dead signal
    // still gets a child, and that child runs to completion with full side
    // effects. Measured: with an aborted signal the program printed and wrote its
    // file, exit 0.
    //
    // Scope, stated precisely: this is a hole in this class's own API, not a
    // host-visible failure — the harness rejects a pre-dispatch abort before a
    // tool executes, so `run()` is never reached in that state through
    // `ctx.tools.execute`. It is still wrong for any direct caller, and any
    // caller that loops with one signal (`ctx_batch_execute`'s worker does) would
    // run every item it queued after the cancellation without this.
    //
    // Nothing is spawned: no child to signal, no wrapper that ran. The result
    // carries the same non-zero code a kill would have produced, empty output,
    // and the argv that was REQUESTED — the confinement wrapper is deliberately
    // absent, because `argv` exists for diagnosing a runner failure and this run
    // never reached a runner.
    //
    // `enforcement` is `'partial'` rather than `'full'` on purpose: no boundary
    // was exercised, so claiming a complete one would say a process that never
    // started ran behind one. `'partial'` is the only value in the enum that
    // does not assert that, and `unconfined` is `false` because nothing ran at
    // all — not without a boundary either.
    if (request.signal?.aborted === true) {
      return {
        stdout: '',
        stderr: '',
        exitCode: ABORT_EXIT_CODE,
        truncated: false,
        enforcement: 'partial',
        unconfined: false,
        argv: requested,
      }
    }

    let argv = requested
    let enforcement: Enforcement = 'full'
    let unconfined = false
    const policy: SandboxPolicy = {
      mode: this.options.sandboxMode,
      workspaceRoot: request.cwd,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    }

    if (this.sandbox !== undefined) {
      const confined = this.sandbox.confine(requested, policy)
      argv = [...confined.argv]
      enforcement = confined.enforcement
    } else if (this.options.allowUnconfined) {
      // Explicitly opted into, and reported as such on every result.
      enforcement = 'partial'
      unconfined = true
    } else {
      throw new UnconfinedExecutionError(
        'no sandbox backend is available on this host and sandbox.allowUnconfined is false; '
          + 'refusing to run model-authored code unconfined',
      )
    }

    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs
    return this.spawn(argv, request, timeoutMs, enforcement, unconfined)
  }

  private spawn(
    argv: readonly string[],
    request: RunRequest,
    timeoutMs: number,
    enforcement: Enforcement,
    unconfined: boolean,
  ): Promise<ExecuteResult> {
    return new Promise<ExecuteResult>((resolve, reject) => {
      // `keepTail` keeps the real end of the stream instead of a prefix of it:
      // truncating a prefix to `maxStdoutBytes` again would split filler, and the
      // last line printed — the part a caller reads — would be gone. The marker
      // rides along so a result that reports `truncated` always shows where the
      // middle was dropped, even when `maxStdoutBytes` is above this ceiling.
      const stdout = createBoundedCollector(COLLECTOR_CEILING_BYTES, { keepTail: true })
      const stderr = createBoundedCollector(COLLECTOR_CEILING_BYTES, { keepTail: true })
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: request.cwd,
        env: this.childEnv(request),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      // Mid-flight abort: the child exists, so it is signalled rather than
      // skipped. SIGTERM is used so a runtime can flush what it has; a child that
      // traps the signal is still bounded by the timer above, and the `close`
      // handler below reports whichever of the two ended the run.
      const onAbort = (): void => {
        child.kill('SIGTERM')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('close', (code, killedBySignal) => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        const out = truncateStdout(stdout.text(), this.options.maxStdoutBytes)
        const err = truncateStdout(stderr.text(), this.options.maxStderrBytes)
        const result: ExecuteResult = {
          stdout: out.text,
          stderr: err.text,
          // A timeout or a signal is a non-zero outcome, never a silent success.
          exitCode: code ?? (timedOut ? 124 : killedBySignal ? ABORT_EXIT_CODE : -1),
          truncated: out.truncated || err.truncated || stdout.truncated() || stderr.truncated(),
          enforcement,
          unconfined,
          argv,
        }
        resolve(result)
      })

      // Close stdin so a runtime waiting on input terminates instead of hanging
      // until the timeout fires.
      child.stdin.on('error', () => {
        /* the child may exit before stdin drains; nothing to report */
      })
      child.stdin.end(request.code)
    })
  }

  /**
   * Build the child environment from an explicit allowlist. The host process
   * environment carries credentials (API keys, bot tokens); a model-authored
   * program that could read them would turn any `printenv` into a secret
   * exfiltration, so nothing outside the allowlist is inherited.
   */
  private childEnv(request: RunRequest): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of this.options.envAllowlist) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    // Caller-supplied variables are applied first and the pins are re-asserted
    // afterwards. Applying them the other way round let `env: { HOME: … }` undo
    // the scratch home — measured before the fix, the child printed the caller's
    // home instead of the scratch directory — which is a confinement property the
    // caller must not be able to switch off.
    for (const [key, value] of Object.entries(request.env ?? {})) {
      if (typeof value === 'string') env[key] = value
    }
    // HOME points at a scratch directory rather than the caller's project: a
    // runtime that insists on a writable home must not litter the workspace.
    env.HOME = this.options.scratchDir
    if (request.targetFile !== undefined) env.TARGET_FILE = request.targetFile
    return env
  }
}