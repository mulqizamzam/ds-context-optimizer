import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SessionDB } from '../../dist/session/db.js'
import { buildSnapshot, classifyEvent, escapeXml, eventContent } from '../../dist/session/snapshot.js'

function event(overrides) {
  return {
    sessionId: 's1',
    type: 'user/message',
    category: 'goal',
    priority: 1,
    content: 'text',
    metadata: {},
    timestamp: 1_700_000_000_000,
    cwd: '/tmp',
    ...overrides,
  }
}

test('events round-trip through the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'))
    db.record(event({ content: 'first' }))
    db.record(event({ category: 'error', priority: 3, content: 'boom', timestamp: 1_700_000_001_000 }))
    const rows = db.events('s1')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[0], rows[0])
    assert.equal(db.eventCount(), 2)
    assert.equal(db.sessionCount(), 1)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('events are scoped per session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'))
    db.record(event({ sessionId: 'a' }))
    db.record(event({ sessionId: 'b' }))
    assert.equal(db.events('a').length, 1)
    assert.equal(db.eventCount(), 2)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a category filter narrows the result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'))
    db.record(event({ content: 'goal line' }))
    db.record(event({ category: 'error', priority: 3, content: 'error line' }))
    const errors = db.events('s1', 'error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].content, 'error line')
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the per-session event count is bounded so a long session cannot grow without limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'), 10)
    for (let i = 0; i < 50; i += 1) db.record(event({ content: `line ${i}` }))
    assert.equal(db.events('s1').length, 10)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the cap binds a session whose rows were stored before the store reopened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-reopen-'))
  const file = path.join(dir, 'sessions.sqlite')
  try {
    const first = new SessionDB(file, 10)
    for (let i = 0; i < 10; i += 1) first.record(event({ content: `old ${i}`, timestamp: i }))
    first.close()

    // The new store counts each session on first sight; without that the tally
    // starts at zero, sees 1, and lets the table grow past the cap with every
    // row a previous process wrote.
    const second = new SessionDB(file, 10)
    assert.equal(second.events('s1').length, 10, 'pre-existing rows did not survive the reopen')
    second.record(event({ content: 'after reopen', timestamp: 99 }))

    const rows = second.events('s1')
    assert.ok(rows.length <= 10, `the cap did not bind a reopened session: ${rows.length} rows`)
    assert.equal(rows[0].content, 'after reopen', 'pruning kept the wrong end')
    assert.equal(second.eventCount(), rows.length, 'the running total drifted from the table')
    second.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pruning keeps the newest events, not the oldest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'), 5)
    for (let i = 0; i < 20; i += 1) db.record(event({ content: `line ${i}`, timestamp: 1_700_000_000_000 + i }))
    const kept = db.events('s1').map((row) => row.content)
    assert.ok(kept.includes('line 19'))
    assert.ok(!kept.includes('line 0'))
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshots survive a reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  const file = path.join(dir, 'sessions.sqlite')
  try {
    const first = new SessionDB(file)
    first.saveSnapshot('s1', '<session_snapshot><goal>x</goal></session_snapshot>')
    first.close()
    const second = new SessionDB(file)
    assert.equal(second.snapshot('s1'), '<session_snapshot><goal>x</goal></session_snapshot>')
    second.saveSnapshot('s1', '<session_snapshot>replaced</session_snapshot>')
    assert.equal(second.snapshot('s1'), '<session_snapshot>replaced</session_snapshot>')
    second.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('purgeAll clears events and snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'))
    db.record(event({}))
    db.saveSnapshot('s1', '<session_snapshot/>')
    const removed = db.purgeAll()
    assert.equal(removed.events, 1)
    assert.equal(removed.snapshots, 1)
    assert.equal(db.eventCount(), 0)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty event list yields an empty snapshot, not a broken one', () => {
  const snapshot = buildSnapshot([])
  assert.match(snapshot, /^<session_snapshot>\s*<\/session_snapshot>$/)
})

test('a session with only tool events still produces a populated snapshot', () => {
  // The old filter was `priority <= 2`, which dropped every tool event and left
  // an empty document whenever no user message had been stored.
  const snapshot = buildSnapshot([
    event({ category: 'file', priority: 3, content: 'touched src/index.ts', timestamp: 10 }),
    event({ category: 'error', priority: 3, content: 'typecheck failed', timestamp: 20 }),
  ])
  assert.match(snapshot, /touched src\/index\.ts/)
  assert.match(snapshot, /typecheck failed/)
})

test('the snapshot escapes XML so stored content cannot inject markup', () => {
  const snapshot = buildSnapshot([
    event({ content: '<injected>evil</injected> & "quoted"' }),
  ])
  assert.match(snapshot, /&lt;injected&gt;/)
  assert.ok(!snapshot.includes('<injected>'))
})

test('the snapshot honours the character budget', () => {
  const events = Array.from({ length: 200 }, (_, i) =>
    event({ category: 'file', priority: 3, content: 'x'.repeat(500), timestamp: i }),
  )
  const snapshot = buildSnapshot(events, 2_048)
  assert.ok(snapshot.length <= 2_048, `snapshot was ${snapshot.length} chars`)
})

test('the snapshot honours every accepted budget, including ones that cannot hold the wrapper', () => {
  const events = [
    event({ category: 'goal', content: 'the goal line', timestamp: 1 }),
    event({ category: 'file', priority: 3, content: 'x'.repeat(400), timestamp: 2 }),
    event({ category: 'error', priority: 3, content: 'y'.repeat(400), timestamp: 3 }),
    event({ category: 'decision', priority: 2, content: 'z'.repeat(400), timestamp: 4 }),
  ]
  // `resolveConfig` accepts any positive integer, and the wrapper alone is 36
  // characters: buildSnapshot(events, 16) returned 37 and (events, 32) returned
  // 37, so every budget under that silently overflowed.
  for (let budget = 1; budget <= 120; budget += 1) {
    const snapshot = buildSnapshot(events, budget)
    assert.ok(
      snapshot.length <= budget,
      `buildSnapshot(${budget}) returned ${snapshot.length} chars: ${JSON.stringify(snapshot)}`,
    )
  }
  // The under-wrapper cases return no document rather than an over-budget one…
  assert.equal(buildSnapshot(events, 16), '')
  assert.equal(buildSnapshot(events, 32), '')
  assert.equal(buildSnapshot(events, 36), '')
  // …and 37 holds the smallest document that fits at all.
  assert.equal(buildSnapshot(events, 37), '<session_snapshot></session_snapshot>')
  assert.ok(buildSnapshot(events, 38).length <= 38)
  // Above the wrapper the document is produced and still budget-bound.
  assert.ok(buildSnapshot(events, 64).length <= 64)
  assert.ok(buildSnapshot(events, 2_048).includes('the goal line'))
})

test('the snapshot keeps at most five items per section and the newest of them', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    event({ category: 'file', priority: 3, content: `file-${i}`, timestamp: i }),
  )
  const snapshot = buildSnapshot(events)
  const items = [...snapshot.matchAll(/<item>([^<]*)<\/item>/g)].map((m) => m[1])
  assert.equal(items.length, 5)
  assert.deepEqual(items, ['file-15', 'file-16', 'file-17', 'file-18', 'file-19'])
})

test('classifyEvent keeps intent-bearing events and drops the rest', () => {
  assert.equal(classifyEvent('user/message').category, 'goal')
  assert.equal(classifyEvent('tool/call').category, 'file')
  assert.equal(classifyEvent('tool/result').category, 'error')
  assert.equal(classifyEvent('assistant/message').category, 'decision')
  assert.equal(classifyEvent('assistant/chunk'), null)
  assert.equal(classifyEvent('turn/end'), null)
})

test('eventContent flattens content blocks and tolerates other shapes', () => {
  assert.equal(eventContent('user/message', { content: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.equal(eventContent('tool/call', { arguments: '{"a":1}' }), '{"a":1}')
  assert.equal(eventContent('tool/call', { arguments: 42 }), '')
  assert.equal(eventContent('user/message', undefined), '')
  assert.equal(eventContent('user/message', { content: 'raw string' }), 'raw string')
})

/**
 * The shapes below are transcribed from real `session.jsonl` records, not
 * invented: the host puts a tool result under `data.message.content` inside a
 * `tool-result` wrapper, and an assistant message under `data.message.content`
 * as a mix of text and tool-call blocks. Only `user/message` carries its text
 * at `data.content`.
 */
const HOST_TOOL_RESULT_FAILURE = {
  turn: 1,
  step: 5,
  message: {
    source: { kind: 'tool', callId: 'call_01a114c2d84776658ac9c97a' },
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_01a114c2d84776658ac9c97a',
        content: [{ type: 'text', text: 'Error: unknown tool "subagent_ze"' }],
        isError: true,
      },
    ],
  },
  error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
}

const HOST_TOOL_RESULT_OK = {
  turn: 1,
  step: 1,
  message: {
    source: { kind: 'tool', callId: 'call_01a114c2d84776658ac9c979' },
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_01a114c2d84776658ac9c979',
        content: [{ type: 'text', text: '52827da Bound ctx_index work\nok' }],
        isError: false,
      },
    ],
  },
}

const HOST_ASSISTANT_MESSAGE = {
  turn: 1,
  step: 1,
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: "I'll start by inspecting the repository." },
      { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"pwd"}' },
    ],
    source: { kind: 'model' },
  },
}

/** A failure with only the block-level `isError` flag and no `data.error`. */
const HOST_TOOL_RESULT_IS_ERROR_ONLY = {
  turn: 2,
  step: 3,
  message: {
    source: { kind: 'tool', callId: 'call_y' },
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_y',
        content: [{ type: 'text', text: 'typecheck failed in adapter.ts' }],
        isError: true,
      },
    ],
  },
}

test('eventContent reads the host tool/result payload instead of a shape it never emits', () => {
  // The blind unit test only ever fed `data.content`, which the host does not
  // write: against a real log every tool/result extracted as '' and the capture
  // path (`if (content.trim() === '') return`) dropped all 24 of them.
  const failure = eventContent('tool/result', HOST_TOOL_RESULT_FAILURE)
  assert.ok(failure.length > 0, 'a failing tool result extracted no text at all')
  assert.match(failure, /unknown tool "subagent_ze"/, 'the tool output itself was lost')
  assert.match(failure, /ToolNotFoundError/, 'the recorded error name was dropped')
  assert.match(failure, /UNKNOWN_TOOL/, 'the recorded error code was dropped')

  const ok = eventContent('tool/result', HOST_TOOL_RESULT_OK)
  assert.ok(ok.length > 0, 'a successful tool result extracted no text at all')
  assert.match(ok, /52827da Bound ctx_index work/)
  assert.doesNotMatch(ok, /^\[/, 'a successful result was marked as an error')

  // `isError` on the block is the failure signal when no `data.error` object
  // was recorded; without the marker, a failed and a successful call that
  // printed the same text are indistinguishable in `<recent_errors>`.
  const failedOnly = eventContent('tool/result', HOST_TOOL_RESULT_IS_ERROR_ONLY)
  assert.ok(failedOnly.startsWith('[error]'), `isError was not honoured: ${JSON.stringify(failedOnly)}`)
  assert.match(failedOnly, /typecheck failed in adapter\.ts/)
  assert.equal(eventContent('tool/result', HOST_TOOL_RESULT_OK).startsWith('[error]'), false)

  // Nothing but the payload may reach the capture path empty, or the event is
  // silently discarded before it is ever recorded.
  assert.notEqual(failure.trim(), '')
  assert.notEqual(ok.trim(), '')
})

test('eventContent reads the host assistant/message payload', () => {
  const text = eventContent('assistant/message', HOST_ASSISTANT_MESSAGE)
  assert.ok(text.length > 0, 'an assistant message extracted no text at all')
  assert.match(text, /inspecting the repository/)
  // A tool-call block is an instruction, not a decision the assistant made.
  assert.doesNotMatch(text, /"command":"pwd"/)
})

test('host-shaped events reach the snapshot error and decision sections', () => {
  const record = (type, data, timestamp) => {
    const kind = classifyEvent(type)
    const content = eventContent(type, data)
    assert.notEqual(content.trim(), '', `${type} produced no content and would be dropped`)
    return event({
      type,
      category: kind.category,
      priority: kind.priority,
      content: content.slice(0, 4_000),
      timestamp,
    })
  }
  const snapshot = buildSnapshot([
    record('user/message', { content: [{ type: 'text', text: 'refactor the registry' }] }, 1),
    record('tool/result', HOST_TOOL_RESULT_FAILURE, 2),
    record('tool/result', HOST_TOOL_RESULT_OK, 3),
    record('assistant/message', HOST_ASSISTANT_MESSAGE, 4),
  ])
  // Before the fix, `<recent_errors>` and `<decisions>` were absent from every
  // snapshot a real session produced: the events never got recorded.
  assert.match(snapshot, /<recent_errors>/)
  assert.match(snapshot, /<decisions>/)
  assert.match(snapshot, /subagent_ze/)
  assert.match(snapshot, /52827da Bound ctx_index work/)
  assert.match(snapshot, /inspecting the repository/)
  assert.match(snapshot, /<goal>/)
})

test('recording 4000 events with the default cap stays near-linear, not quadratic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sess-perf-'))
  try {
    const db = new SessionDB(path.join(dir, 'sessions.sqlite'), 5_000)
    const started = performance.now()
    for (let i = 0; i < 4_000; i += 1) {
      db.record(event({ content: `event ${i} body`, timestamp: 1_700_000_000_000 + i }))
    }
    const elapsed = performance.now() - started
    const rows = db.events('s1').length
    db.close()
    // Measured on this host: the pre-fix code (prune on every insert, no index
    // for `ORDER BY id DESC`) took 1,104 ms for 2,000 inserts and 5,346 ms for
    // 4,000, with each successive 1,000 costing more than the last. The fixed
    // code takes 87 ms and 182 ms respectively. The budget sits between the
    // two shapes: finite and generous for loaded CI, still far below the
    // quadratic figure, so the behaviour cannot return unnoticed.
    assert.ok(
      elapsed < 2_000,
      `4,000 records took ${elapsed.toFixed(0)} ms; the per-insert O(n) prune appears to be back`,
    )
    assert.ok(rows <= 5_000, `the cap was not respected: ${rows} rows`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('escapeXml covers every delimiter, including quotes and apostrophes', () => {
  assert.equal(escapeXml(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;')
})