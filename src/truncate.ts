const MARKER = '\n...[truncated]...\n'

/** Share of the byte budget that stays with the head; the rest is the tail. */
const HEAD_FRACTION = 0.6

/**
 * Re-encode `bytes[start,end)` without splitting a UTF-8 sequence.
 *
 * A naive `subarray().toString()` on an arbitrary byte offset emits U+FFFD for
 * the partial sequence at each cut, which then poisons whatever hashes or parses
 * the returned text downstream. The `start` boundary is fixed by skipping any
 * leading continuation bytes; the `end` boundary needs the lead byte's declared
 * length, so a continuation run is walked back to its lead and kept only if every
 * continuation it claims is actually present.
 */
function sliceUtf8(bytes: Buffer, start: number, end: number): string {
  let from = start
  let to = end

  while (from < to && (bytes[from]! & 0xc0) === 0x80) from += 1

  let lead = to
  let continuations = 0
  while (lead > from && (bytes[lead - 1]! & 0xc0) === 0x80) {
    lead -= 1
    continuations += 1
  }
  if (to > from && lead > from) {
    const byte = bytes[lead - 1]!
    if ((byte & 0x80) !== 0) {
      const declared = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : byte < 0xf8 ? 3 : 0
      if (continuations < declared) to = lead - 1
    }
  }

  return from >= to ? '' : bytes.toString('utf8', from, to)
}

/**
 * Split `maxBytes` between the head and the tail of a marked truncation. The
 * marker is charged to the budget, so head + marker + tail never exceeds it.
 */
function splitAt(maxBytes: number): { headBytes: number; tailBytes: number } {
  const budget = Math.max(0, maxBytes - Buffer.byteLength(MARKER, 'utf8'))
  const headBytes = Math.ceil(budget * HEAD_FRACTION)
  return { headBytes, tailBytes: budget - headBytes }
}

/**
 * Bound stdout to `maxBytes` UTF-8 bytes, keeping the head and the tail. The
 * tail matters more than the head for command output: the error a caller needs
 * is usually the last line printed.
 */
export function truncateStdout(
  stdout: string,
  maxBytes = 8192,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(stdout, 'utf8')
  if (bytes.length <= maxBytes) return { text: stdout, truncated: false }

  const { headBytes, tailBytes } = splitAt(maxBytes)
  const head = sliceUtf8(bytes, 0, headBytes)
  const tail = tailBytes > 0 ? sliceUtf8(bytes, bytes.length - tailBytes, bytes.length) : ''
  const text = tail ? `${head}${MARKER}${tail}` : `${head}${MARKER}`
  return { text, truncated: true }
}

export interface BoundedCollectorOptions {
  /**
   * Reserve part of the budget for the END of the stream and splice {@link MARKER}
   * at the gap where the middle was dropped, so `text()` carries the real last
   * line of the output plus a visible truncation marker.
   *
   * Default false: head-only capture, whose contract is that `text()` returns
   * exactly the first `maxBytes` bytes and that truncation is reported through
   * `truncated()` alone. A caller that only wants a prefix has no interior gap
   * to mark.
   */
  readonly keepTail?: boolean
}

/**
 * Bound a stream while it is still arriving. Returns the collector that owns the
 * partial buffer so a caller can read `text` without a second copy.
 */
export function createBoundedCollector(
  maxBytes: number,
  options: BoundedCollectorOptions = {},
): {
  push(chunk: Buffer): void
  text(): string
  truncated(): boolean
} {
  const keepTail = options.keepTail === true
  const { headBytes: headRoom, tailBytes: tailRoom } = keepTail
    ? splitAt(maxBytes)
    : { headBytes: Math.max(0, maxBytes), tailBytes: 0 }

  const head: Buffer[] = []
  let headSize = 0
  let seen = 0
  // Tail ring, allocated only once the head is full: a short run never pays for
  // it. Bytes occupy [ringStart, ringStart + ringSize) modulo the buffer length.
  let ring: Buffer | null = null
  let ringSize = 0
  let ringStart = 0

  const pushTail = (chunk: Buffer): void => {
    if (tailRoom === 0) return
    if (ring === null) ring = Buffer.allocUnsafe(tailRoom)
    if (chunk.length >= tailRoom) {
      // The chunk already carries a whole tail; the oldest bytes it replaces are
      // exactly the ones this write evicts.
      ring.set(chunk.subarray(chunk.length - tailRoom), 0)
      ringSize = tailRoom
      ringStart = 0
      return
    }
    const end = (ringStart + ringSize) % tailRoom
    const first = Math.min(chunk.length, tailRoom - end)
    ring.set(chunk.subarray(0, first), end)
    if (first < chunk.length) ring.set(chunk.subarray(first), 0)
    const grown = ringSize + chunk.length
    if (grown > tailRoom) {
      ringStart = (ringStart + (grown - tailRoom)) % tailRoom
      ringSize = tailRoom
    } else {
      ringSize = grown
    }
  }

  const tailBuffer = (): Buffer => {
    if (ring === null || ringSize === 0) return Buffer.alloc(0)
    if (ringStart + ringSize <= tailRoom) return ring.subarray(ringStart, ringStart + ringSize)
    return Buffer.concat([ring.subarray(ringStart), ring.subarray(0, ringStart + ringSize - tailRoom)])
  }

  const dropped = (): boolean => seen > headSize + ringSize

  return {
    push(chunk) {
      seen += chunk.length
      if (headSize < headRoom && chunk.length > 0) {
        const room = headRoom - headSize
        const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
        head.push(take)
        headSize += take.length
        chunk = chunk.subarray(take.length)
      }
      if (chunk.length > 0) pushTail(chunk)
    },
    text() {
      const headText = sliceUtf8(Buffer.concat(head), 0, headSize)
      if (!keepTail || !dropped()) return headText
      const tailText = sliceUtf8(tailBuffer(), 0, ringSize)
      return tailText ? `${headText}${MARKER}${tailText}` : `${headText}${MARKER}`
    },
    truncated() {
      return dropped()
    },
  }
}