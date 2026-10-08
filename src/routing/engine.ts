/** What the routing engine decided about one tool call. */
export type RoutingAction = 'allow' | 'advisory' | 'deny'

/**
 * Which context workflow a steered call should use.
 *
 * Only two of the five are properties of a call's shape. Whether a query was
 * already answered, whether the evidence contradicts itself, and whether a
 * symbol is related to another are properties of what the retrieval layer
 * returned, so they are reported on the result as hints rather than guessed at
 * from the arguments. Claiming otherwise here would be a rule that fires on the
 * wrong calls and stays silent on the right ones.
 */
export type ContextWorkflow =
  | 'index-search'
  | 'retrieval-cache'
  | 'temporal'
  | 'contradiction'
  | 'relationship'

export interface RoutingDecision {
  readonly action: RoutingAction
  /** Why the call was steered or blocked; absent for `allow`. */
  readonly reason?: string
  /** Tool the model should reach for instead. */
  readonly targetTool?: string
  /** Workflow the steer points at, when the steer names one. */
  readonly workflow?: ContextWorkflow
}

export interface RoutingConfig {
  /**
   * Command patterns the engine denies outright. Empty by default: a plugin that
   * silently blocks a call the host's own policy already allows is a footgun, so
   * denial is opt-in and every pattern must be listed explicitly.
   */
  readonly denyPatterns: readonly string[]
  /** Whether to attach a throttled hint pointing large reads at the index tools. */
  readonly advisory: boolean
}

/**
 * Steer calls whose output would be large back into the indexing path.
 *
 * Pure by construction — it reads the call and returns a decision, nothing else
 * — so the rules are testable without a host, an agent, or a clock.
 */
export function evaluate(
  toolName: string,
  args: unknown,
  config: RoutingConfig,
  prefix: string,
): RoutingDecision {
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const command = typeof record.command === 'string' ? record.command.trim() : ''

  if (command !== '' && config.denyPatterns.length > 0) {
    for (const pattern of config.denyPatterns) {
      if (safeMatch(pattern, command)) {
        return {
          action: 'deny',
          reason: `command matches a configured deny pattern: ${pattern}`,
        }
      }
    }
  }

  if (!config.advisory) return { action: 'allow' }

  // A direct fetch returns raw page bytes to the model; the indexed path
  // returns a summary and keeps the full text searchable.
  if (toolName === 'web_fetch' || toolName === 'read_page') {
    return {
      action: 'advisory',
      targetTool: `${prefix}fetch_and_index`,
      reason: 'this tool returns the whole page inline; the indexed path keeps the text searchable and returns a summary',
      workflow: 'index-search',
    }
  }

  // A whole-file read is the shape this plugin was built for: the host caps it
  // at `caps.limit` lines, so a small file is genuinely cheap and stays
  // allowed. Only a read with no offset and no limit asks for the entire body,
  // and that is the one the index answers better, because the file stays
  // searchable afterwards and the answer stays a snippet.
  if (toolName === 'read') {
    const path = typeof record.file_path === 'string' ? record.file_path.trim() : ''
    if (path !== '' && record.offset === undefined && record.limit === undefined) {
      return {
        action: 'advisory',
        targetTool: `${prefix}index`,
        reason: 'reading a whole file puts its entire body into the tool result; the indexed path keeps it searchable and answers with excerpts',
        workflow: 'index-search',
      }
    }
  }

  if (toolName === 'bash' || toolName === 'shell') {
    if (/^(curl|wget)\b/.test(command)) {
      return {
        action: 'advisory',
        targetTool: `${prefix}fetch_and_index`,
        reason: 'fetching through the shell puts the entire response into the tool result',
        workflow: 'index-search',
      }
    }
    if (/^cat\s+.*\.(log|json|csv|jsonl)$/.test(command)) {
      return {
        action: 'advisory',
        targetTool: `${prefix}batch_execute`,
        reason: 'this looks like a large data file; the batch path indexes it and returns only matching excerpts',
        workflow: 'index-search',
      }
    }
  }

  if (toolName === 'grep') {
    return {
      action: 'advisory',
      targetTool: `${prefix}search`,
      reason: 'if the corpus was indexed earlier, the search tool ranks it instead of returning raw matching lines',
      workflow: 'index-search',
    }
  }

  return { action: 'allow' }
}

/**
 * Compile a configured pattern on use. `denyPatterns` is operator-authored
 * configuration, so a malformed regex is reported as a configuration error
 * instead of being silently skipped.
 */
function safeMatch(pattern: string, command: string): boolean {
  try {
    return new RegExp(pattern).test(command)
  } catch {
    throw new Error(`routing.denyPatterns entry is not a valid regular expression: ${pattern}`)
  }
}