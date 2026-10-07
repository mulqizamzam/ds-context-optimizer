import type { SessionEvent } from '../types.js'

/** Categories the snapshot can surface, in the order they appear in the XML. */
const SECTIONS: ReadonlyArray<readonly [tag: string, category: string]> = [
  ['goal', 'goal'],
  ['active_files', 'file'],
  ['pending_tasks', 'task'],
  ['recent_errors', 'error'],
  ['decisions', 'decision'],
]

/**
 * Map a host session event onto a snapshot category plus a priority.
 *
 * The host dispatches `session/event` for every appended event, including
 * assistant chunks that carry no intent at all. Recording all of them equally
 * would drown the signal, so only the few event types that encode intent are
 * kept and the rest report `null` for the caller to skip.
 */
export function classifyEvent(type: string): { category: string; priority: number } | null {
  switch (type) {
    case 'user/message':
      // A user message is the strongest statement of intent in the log.
      return { category: 'goal', priority: 1 }
    case 'tool/call':
      // Arguments name the files and commands the session is touching.
      return { category: 'file', priority: 3 }
    case 'tool/result':
      // Failures are the event a resumed session needs most.
      return { category: 'error', priority: 3 }
    case 'assistant/message':
      return { category: 'decision', priority: 2 }
    default:
      return null
  }
}

/**
 * Pull the human-readable text out of an event payload.
 *
 * The shapes below are the ones the host actually writes, transcribed from real
 * `session.jsonl` records:
 *
 * - `user/message` — `data.content[]`
 * - `tool/call` — `data.arguments` (a JSON string)
 * - `tool/result` — `data.message.content[]`, whose blocks are `tool-result`
 *   wrappers around the text the tool produced
 * - `assistant/message` — `data.message.content[]`, mixing `text` and
 *   `tool-call` blocks
 *
 * `user/message` is the only one whose text sits at the top level. Reading
 * `record.content` for the other two is what made every captured failure and
 * decision come back empty, so the capture path discarded all of them.
 */
export function eventContent(type: string, data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>
  switch (type) {
    case 'user/message':
      return userMessageContent(record.content)
    case 'tool/call':
      return typeof record.arguments === 'string' ? record.arguments : ''
    case 'tool/result':
      return toolResultContent(record)
    case 'assistant/message':
      // Both are `data.message.content`; they differ only in how a tool result
      // nests its text, and how a failure is named.
      return messageText(messageBlocks(record), false)
    default:
      return ''
  }
}

/** `data.message.content` as an array, or [] when the payload has no message. */
function messageBlocks(record: Record<string, unknown>): unknown[] {
  const message = record.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>).content
  return Array.isArray(content) ? content : []
}

/**
 * Text of a `tool/result` event, including what actually went wrong.
 *
 * A failure is the event a resumed session needs most: the host's error object
 * (`data.error`, `{name, code}`) is kept verbatim when present, and the
 * `isError` flag on the `tool-result` block marks the result even when the tool
 * recorded no error object at all. Without the marker, a failed and a
 * successful call with the same output text are indistinguishable in the
 * snapshot's `<recent_errors>` section.
 */
function toolResultContent(record: Record<string, unknown>): string {
  const blocks = messageBlocks(record)
  const failed = blocks.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown; isError?: unknown }).type === 'tool-result' &&
      (block as { isError?: unknown }).isError === true,
  )
  const tag = describeError(record.error) || (failed ? '[error]' : '')
  const text = messageText(blocks, true)
  return [tag, text].filter((part) => part !== '').join('\n')
}

/**
 * Text of a `data.message.content[]` block list.
 *
 * `tool-result` blocks carry their own `content[]`, which can nest further, so
 * they are unwrapped by type rather than by position. A `tool-call` block is an
 * instruction, not an outcome, so an assistant message reports what was said
 * and not what was requested.
 */
function messageText(content: unknown[], unwrapToolResults: boolean): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'tool-result') {
      if (unwrapToolResults) {
        const nested = record.content
        if (Array.isArray(nested)) {
          const text = messageText(nested, true)
          if (text !== '') parts.push(text)
        }
      }
      continue
    }
    if (record.type === 'tool-call') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.filter((part) => part !== '').join('\n')
}

/** `[ToolNotFoundError UNKNOWN_TOOL]`, or '' when the host recorded no error. */
function describeError(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return ''
  const { name, code } = value as { name?: unknown; code?: unknown }
  if (typeof name !== 'string' && typeof code !== 'string') return ''
  return `[${[name, code].filter((part): part is string => typeof part === 'string').join(' ')}]`
}

/**
 * Flatten `data.content` to its text. Accepts a bare string as well as the
 * usual block array — this is the one host payload whose text sits at the top
 * level rather than inside `data.message`.
 */
function userMessageContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** The empty document: the wrapper with nothing inside it. */
const EMPTY_SNAPSHOT = '<session_snapshot></session_snapshot>'

/**
 * Build the resume snapshot handed to the model at the start of a later turn.
 *
 * The original filtered `priority <= 2` before selecting, which excluded every
 * recorded tool event (priority 3) and then fell back to an empty document
 * whenever no user message had been captured — the snapshot was routinely
 * `<session_snapshot></session_snapshot>`. Selection now happens on **order**
 * and only then are the categories picked, so a session with tool activity but
 * no stored goal still gets a useful document.
 *
 * The character budget is a hard ceiling for every accepted value: the empty
 * document (36 chars) is returned when the wrapper cannot fit, and nothing at
 * all when even that exceeds the budget. The section arithmetic below was
 * verified exact for budgets above the wrapper, so no path can overrun.
 */
export function buildSnapshot(events: SessionEvent[], maxChars = 2_048): string {
  if (!Number.isFinite(maxChars) || maxChars < EMPTY_SNAPSHOT.length) return ''
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const lines: string[] = ['<session_snapshot>']
  const used = lines.join('\n').length

  let budget = maxChars - used - '\n</session_snapshot>'.length
  if (budget < 0) return EMPTY_SNAPSHOT

  for (const [tag, category] of SECTIONS) {
    const items = ordered.filter((event) => event.category === category)
    if (items.length === 0) continue
    const picked: string[] = []
    for (let i = items.length - 1; i >= 0 && picked.length < 5; i -= 1) {
      const content = items[i]!.content.trim()
      if (content !== '') picked.push(content.slice(0, 400))
    }
    if (picked.length === 0) continue
    picked.reverse()

    const body = picked.map((item) => `  <item>${escapeXml(item)}</item>`).join('\n')
    const block = `  <${tag}>\n${body}\n  </${tag}>`
    if (block.length + 1 > budget) {
      // Keep the section only if at least one item fits; the next, smaller
      // section may still fit in what is left.
      const oneItem = `  <${tag}>\n  <item>${escapeXml(picked.at(-1)!)}</item>\n  </${tag}>`
      if (oneItem.length + 1 > budget) break
      lines.push(oneItem)
      budget -= oneItem.length + 1
      continue
    }
    lines.push(block)
    budget -= block.length + 1
  }

  lines.push('</session_snapshot>')
  return lines.join('\n')
}