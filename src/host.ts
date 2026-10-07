/**
 * Typed model of the host surface this plugin touches.
 *
 * Transcribed from the host source rather than imported: the harness resolves a
 * plugin's bare `@deepseek-ai/*` specifiers against the plugin's own
 * `node_modules` tree, not the host's, so importing the real packages would
 * force every consumer to install a matching copy. Everything optional in the
 * host is optional here, so a reduced profile type-checks and degrades instead
 * of crashing.
 *
 * Citations (host v0.1.1-rc.2):
 * - `packages/core/tools/src/index.ts:1037` — `register` requires
 *   `output: { schema, render }` and throws `TypeError` without it.
 * - `packages/core/tools/src/index.ts:588` — `PreToolDecision` is
 *   `{ kind: 'allow' } | { kind: 'deny', reason } | { kind: 'ask', reason? }`.
 * - `packages/core/tools/src/index.ts:379` — `ToolExecution` carries `name`,
 *   `arguments` (not `args`), `callId`, `signal`, `agent`.
 * - `packages/core/sandbox/sandbox/src/index.ts:176` — `confine(argv, policy)`.
 * - `packages/core/session/src/index.ts:54` — `session/created`, not
 *   `session/start`.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** Host `packages/sandbox/sandbox/src/index.ts:29`. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface HostSessionHeader {
  readonly id?: string
  readonly cwd?: string
}

export interface HostAgent {
  readonly id: string
  readonly status?: string
  readonly options?: { provider?: string; model?: string }
  readonly session?: { readonly header?: HostSessionHeader }
}

export interface HostUserMessage {
  readonly role: 'user'
  readonly content: Array<{ readonly type: string; readonly text?: string }>
}

/** Host `packages/core/tools/src/index.ts:379,404`. */
export interface ToolRunContext {
  readonly name: string
  /** Parsed arguments. The field is `arguments`; there is no `args` alias. */
  readonly arguments: unknown
  readonly callId: string
  readonly signal: AbortSignal
  readonly agent?: HostAgent
}

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** Host `packages/core/tools/src/index.ts:595`. */
export type PostToolDecision =
  | { kind: 'accept'; content?: Array<{ type: 'text'; text: string }>; additionalContexts?: HostUserMessage[] }
  | { kind: 'block'; feedback: Array<{ type: 'text'; text: string }>; additionalContexts?: HostUserMessage[] }

/** Host `packages/core/tools/src/index.ts:212`. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>
    readonly presentationMeta?: (args: unknown, value: unknown) => JsonValue
  }
  readonly execute: (args: never, execution: ToolRunContext) => Promise<unknown>
}

/** Host `packages/core/system-prompt/src/index.ts:42,78`. */
export interface AssembleContext {
  readonly scope?: unknown
  readonly signal?: AbortSignal
  /** Present at runtime even though the public type does not declare it. */
  readonly agent?: HostAgent
}

export interface PromptContextRegistration {
  name: string
  order: number
  text: string | ((context: AssembleContext) => string)
}

export interface SystemPromptService {
  context(context: PromptContextRegistration): () => void
}

export interface HostSandboxPolicy {
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly sessionId?: string
}

export interface HostSandboxProvider {
  confine(argv: readonly string[], policy: HostSandboxPolicy): {
    argv: readonly string[]
    enforcement: 'full' | 'partial'
  }
}

/** Host `packages/core/session/src/index.ts:76` — `(session, event)`. */
export interface HostSessionEvent {
  readonly type: string
  readonly seq: number
  /** Unix epoch ms. There is no `timestamp` field. */
  readonly time: number
  readonly data?: unknown
}

export interface HostSession {
  readonly id: string
  readonly header?: HostSessionHeader
}

export interface HostContext {
  readonly tools: {
    register(definition: ToolDefinition): unknown
    get?(name: string): unknown
  }
  /** Service lookup; `sandbox` and `systemPrompt` are resolved through it. */
  get(name: string): unknown
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown
  effect(callback: () => (() => unknown) | void, label?: string): () => unknown
}

/**
 * Identity helper. It exists so the tool literals are checked against
 * `ToolDefinition` at compile time; the host registry is what enforces the
 * schema rules at runtime.
 *
 * Host issue-class #53: a tool or parameter description containing a brace pair
 * can throw in the host prompt renderer and deadlock every turn. No description
 * in this plugin interpolates user data, so no braces reach a description.
 */
export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition
}

/** Model-facing text block for one already-stringified payload. */
export function text(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * Canonical output schema for a tool returning a JSON object. `additionalProperties`
 * is explicit because the host's schema subset requires an author to state
 * object openness rather than inheriting a default.
 */
export const JSON_OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const

/**
 * The shared `output.render` for every JSON-returning tool.
 *
 * The host calls `render(exec.arguments, value)`
 * (`packages/core/tools/src/index.ts:1800`), so this must take `(args, value)`.
 * A one-parameter renderer silently binds `args` as its only argument and never
 * sees `value`: the model then receives a pretty-printed copy of the call it
 * just made, and every result — statistics, diagnostics, execution output, even
 * a refusal — is replaced by its own arguments (`{}` for a parameterless tool).
 *
 * `value` is therefore authoritative. `args` is consulted only when the host
 * produced no value at all, which never happens for a successful execution, so
 * the fallback cannot turn a real result into an echo of the request.
 */
export function renderToolResult(
  args: Record<string, unknown>,
  value: unknown,
): Array<{ type: 'text'; text: string }> {
  return text(value === undefined ? args : value)
}

/** Alias kept for the `output.render` contract every tool declaration uses. */
export const JSON_OBJECT_RENDER = renderToolResult

/**
 * Register a tool without letting one failure break the boot: the host registry
 * throws on a duplicate name, and a plugin that throws from `apply` takes the
 * whole profile down with it.
 */
export function registerToolSafe(
  ctx: HostContext,
  definition: ToolDefinition,
): { name: string; ok: boolean; error?: string } {
  try {
    ctx.tools.register(definition)
    return { name: definition.name, ok: true }
  } catch (error) {
    return {
      name: definition.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Hand teardown to the host's own ownership so it unwinds with the plugin's
 * fiber instead of leaking until process exit.
 */
export function registerLifecycle(
  ctx: HostContext,
  release: () => void,
  label: string,
  warn: (message: string) => void,
): void {
  try {
    const effect = ctx.effect
    if (typeof effect !== 'function') {
      warn(`${label}: host has no effect(), resources will not be released on teardown`)
      return
    }
    effect.call(ctx, () => release, label)
  } catch (error) {
    warn(`${label}: lifecycle registration refused: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Working directory of the calling agent, falling back to the host process cwd. */
export function cwdOf(execution: ToolRunContext): string {
  return execution.agent?.session?.header?.cwd ?? process.cwd()
}

/** Session id of the calling agent, when the host reports one. */
export function sessionIdOf(execution: ToolRunContext): string | undefined {
  return execution.agent?.session?.header?.id ?? execution.agent?.id
}