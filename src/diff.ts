/**
 * Compact context / evidence diffing. Every entry point reduces its two sides
 * to a Map<path, text> and reports only the semantic delta between them. The
 * module never materialises the whole of either side again — every returned
 * string is clipped to MAX_DIFF_ENTRY_CHARS — so a diff can never become a
 * channel that echoes a full snapshot or evidence body.
 */
export const MAX_DIFF_ENTRY_CHARS = 160

export type DiffOp = 'added' | 'removed' | 'changed' | 'unchanged'

export interface DiffEntry {
  readonly op: DiffOp
  readonly key: string
  readonly before?: string
  readonly after?: string
}

export interface ContextDiff {
  readonly additions: number
  readonly removals: number
  readonly changes: number
  readonly unchanged: number
  readonly entries: readonly DiffEntry[]
  readonly truncated: boolean
}

/**
 * Canonical form for both comparison and the value an entry carries: trailing
 * whitespace is trimmed per line and empty lines are dropped. The comparison is
 * deliberately literal — a paraphrase detector would be a semantic guess this
 * bounded, offline module cannot justify, so "changed" means the literal
 * characters moved, never that the meaning moved.
 */
function normalize(text: string): string {
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/[ \t\r]+$/, '')
    if (trimmed.length > 0) kept.push(trimmed)
  }
  return kept.join('\n')
}

function clip(s: string): string {
  return s.length > MAX_DIFF_ENTRY_CHARS ? s.slice(0, MAX_DIFF_ENTRY_CHARS) : s
}

/** Entry cap: default 20, clamped into [0, 100]; NaN/undefined fall back to 20. */
function clampMax(max: number | undefined): number {
  if (max === undefined || Number.isNaN(max)) return 20
  if (max === Infinity) return 100
  if (max === -Infinity) return 0
  return Math.max(0, Math.min(100, Math.floor(max)))
}

interface XmlNode {
  readonly tag: string
  readonly children: XmlNode[]
  text: string
}

/** Index of the next '>' not inside a quoted attribute value, or -1. */
function findTagEnd(s: string, from: number): number {
  let quote = ''
  for (let j = from; j < s.length; j++) {
    const ch = s[j]
    if (quote !== '') { if (ch === quote) quote = '' }
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return j
  }
  return -1
}

/**
 * Tolerant XML scan into a tree. Never throws: unbalanced or unterminated tags,
 * stray close tags, comments, CDATA, processing instructions and declarations
 * all degrade to the closest safe interpretation. Attributes are ignored, so a
 * key is always a tag path, never an attribute value.
 */
function parseXml(s: string): { root: XmlNode; sawTag: boolean } {
  const root: XmlNode = { tag: '', children: [], text: '' }
  const stack: XmlNode[] = [root]
  const top = (): XmlNode => stack[stack.length - 1]
  let sawTag = false
  const n = s.length
  let i = 0
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt === -1) { top().text += s.slice(i); break }
    if (lt > i) top().text += s.slice(i, lt)
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
    } else if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9)
      top().text += s.slice(lt + 9, end === -1 ? n : end)
      i = end === -1 ? n : end + 3
    } else if (s[lt + 1] === '?' || s[lt + 1] === '!') {
      const end = findTagEnd(s, lt + 2)
      i = end === -1 ? n : end + 1
    } else {
      const gt = findTagEnd(s, lt + 1)
      if (gt === -1) { top().text += s.slice(lt); break }
      if (s[lt + 1] === '/') {
        const name = s.slice(lt + 2, gt).trim()
        for (let k = stack.length - 1; k >= 1; k--) if (stack[k].tag === name) { stack.length = k; break }
      } else {
        const match = /^[A-Za-z_][\w.:-]*/.exec(s.slice(lt + 1, gt))
        if (match === null) {
          top().text += s.slice(lt, gt + 1)
        } else {
          sawTag = true
          const node: XmlNode = { tag: match[0], children: [], text: '' }
          top().children.push(node)
          if (s[gt - 1] !== '/') stack.push(node)
        }
      }
      i = gt + 1
    }
  }
  return { root, sawTag }
}

/** Reduce a document to leaf elements keyed by tag path: a single top-level
 * element is the document root whose own name is dropped so its children key
 * off their own tag (e.g. `decisions`); repeated same-named siblings are
 * disambiguated by a trailing /index (e.g. `decisions/0`). Containers are not
 * emitted on their own — their child leaves carry the content, so a change
 * inside a container surfaces as that leaf changing, not a whole block moving. */
function collectLeaves(root: XmlNode): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  const emit = (parent: XmlNode, parentKey: string): void => {
    const counts = new Map<string, number>()
    for (const c of parent.children) counts.set(c.tag, (counts.get(c.tag) ?? 0) + 1)
    const seen = new Map<string, number>()
    for (const c of parent.children) {
      const total = counts.get(c.tag) ?? 1
      const idx = seen.get(c.tag) ?? 0
      seen.set(c.tag, idx + 1)
      const base = parentKey === '' ? c.tag : parentKey + '/' + c.tag
      const key = total > 1 ? base + '/' + idx : base
      if (c.children.length === 0) out.push({ key, value: normalize(c.text) })
      else emit(c, key)
    }
  }
  const tops = root.children
  if (tops.length === 1) {
    if (tops[0].children.length === 0) out.push({ key: tops[0].tag, value: normalize(tops[0].text) })
    else emit(tops[0], '')
  } else {
    emit(root, '')
  }
  return out
}

/**
 * Reduce a snapshot to a Map<tagPath, text>. A document with no element tags
 * at all is reduced to one opaque leaf keyed by the empty path, so a plain-text
 * snapshot still diffs instead of silently comparing equal; any parse failure
 * degrades to that same fallback rather than throwing (fail-closed, bounded).
 */
function snapshotMap(s: string): Map<string, string> {
  const map = new Map<string, string>()
  const fallback = (): void => {
    const whole = normalize(s)
    if (whole.length > 0) map.set('', whole)
  }
  try {
    const { root, sawTag } = parseXml(s)
    if (sawTag) for (const leaf of collectLeaves(root)) map.set(leaf.key, leaf.value)
    else fallback()
  } catch {
    fallback()
  }
  return map
}

function toMap<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  valOf: (item: T) => string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) map.set(keyOf(item), normalize(valOf(item)))
  return map
}

/**
 * Diff two maps into a ContextDiff.
 *
 * The four counters are always the TRUE totals across the whole surface; the
 * entries list is separately bounded by the clamped cap and ordered removed →
 * changed → added → unchanged, each group ascending by key. When the ordered
 * list is longer than the cap the remainder is dropped and truncated: true,
 * yet still counted — a caller never loses the totals and never gets more than
 * the cap. `unchanged` entries carry neither before nor after: replaying an
 * unchanged value is exactly the "return the whole side" cost this module avoids.
 */
function diffMaps(
  before: Map<string, string>,
  after: Map<string, string>,
  maxEntries: number | undefined,
): ContextDiff {
  let removals = 0
  let changes = 0
  let additions = 0
  let unchanged = 0
  const removed: DiffEntry[] = []
  const changed: DiffEntry[] = []
  const added: DiffEntry[] = []
  const same: DiffEntry[] = []
  for (const key of Array.from(before.keys()).sort()) {
    const b = before.get(key) ?? ''
    const a = after.get(key)
    if (a === undefined) {
      removals++
      removed.push({ op: 'removed', key: clip(key), before: clip(b) })
    } else if (a === b) {
      unchanged++
      same.push({ op: 'unchanged', key: clip(key) })
    } else {
      changes++
      changed.push({ op: 'changed', key: clip(key), before: clip(b), after: clip(a) })
    }
  }
  for (const key of Array.from(after.keys()).sort()) {
    if (!before.has(key)) {
      additions++
      added.push({ op: 'added', key: clip(key), after: clip(after.get(key) ?? '') })
    }
  }
  const ordered = [...removed, ...changed, ...added, ...same]
  const cap = clampMax(maxEntries)
  return { additions, removals, changes, unchanged, entries: ordered.slice(0, cap), truncated: ordered.length > cap }
}

export function diffSnapshots(before: string, after: string, maxEntries?: number): ContextDiff {
  return diffMaps(snapshotMap(before), snapshotMap(after), maxEntries)
}

export function diffEvidenceStates(
  before: readonly { readonly evidenceId: string; readonly text: string }[],
  after: readonly { readonly evidenceId: string; readonly text: string }[],
  maxEntries?: number,
): ContextDiff {
  const toM = (xs: readonly { readonly evidenceId: string; readonly text: string }[]) =>
    toMap(xs, (x) => x.evidenceId, (x) => x.text)
  return diffMaps(toM(before), toM(after), maxEntries)
}

export function diffSourceVersions(
  before: readonly { readonly ordinal: number; readonly text: string }[],
  after: readonly { readonly ordinal: number; readonly text: string }[],
  maxEntries?: number,
): ContextDiff {
  const toM = (xs: readonly { readonly ordinal: number; readonly text: string }[]) =>
    toMap(xs, (x) => String(x.ordinal), (x) => x.text)
  return diffMaps(toM(before), toM(after), maxEntries)
}
