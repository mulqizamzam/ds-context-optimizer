import assert from 'node:assert/strict'
import test from 'node:test'
import { planGc, isReclaimable, reclaimableBytes, classifyRecord } from '../../dist/gc.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const CONFIG = {
  ephemeralMs: DAY,
  sessionMs: 7 * DAY,
  projectMs: 30 * DAY,
  maxEventsPerSession: 3,
}

const NOW = 1_000 * DAY

function record(overrides = {}) {
  return {
    kind: 'source',
    id: 'src_keep',
    class: 'project',
    bytes: 100,
    updatedAt: NOW - 10 * DAY,
    ...overrides,
  }
}

test('classifyRecord returns the record class and never re-classifies by age', () => {
  const ephemeral = record({ class: 'ephemeral', updatedAt: NOW - 1000 * DAY })
  assert.equal(classifyRecord(ephemeral, NOW, CONFIG), 'ephemeral')
})

test('a referenced record survives whatever its age', () => {
  const old = record({ class: 'ephemeral', updatedAt: NOW - 1000 * DAY, referenced: true })
  assert.equal(isReclaimable(old, NOW, CONFIG), false)
  const plan = planGc({ records: [old] }, NOW, CONFIG, false)
  assert.deepEqual(plan.deleted, [])
  assert.equal(plan.protected.records, 1)
})

test('a record named in protectedRefs survives', () => {
  const plan = planGc(
    { records: [record({ class: 'ephemeral', updatedAt: NOW - 100 * DAY })], protectedRefs: ['src_keep'] },
    NOW,
    CONFIG,
    false,
  )
  assert.deepEqual(plan.deleted, [])
  assert.equal(plan.protected.records, 1)
})

test('a persistent-class record survives', () => {
  const plan = planGc(
    { records: [record({ class: 'persistent', updatedAt: 0 })] },
    NOW,
    CONFIG,
    false,
  )
  assert.deepEqual(plan.deleted, [])
})

test('an ephemeral record past its window is reclaimable and one inside it is protected', () => {
  const fresh = record({ class: 'ephemeral', id: 'a', updatedAt: NOW - HOUR })
  const stale = record({ class: 'ephemeral', id: 'b', updatedAt: NOW - 5 * DAY })
  const plan = planGc({ records: [fresh, stale] }, NOW, CONFIG, false)
  assert.equal(plan.deleted.length, 1)
  assert.equal(plan.deleted[0].id, 'b')
  assert.equal(plan.protected.records, 1)
})

test('projectMs of zero protects every project record and a positive value reclaims old ones', () => {
  const never = planGc({ records: [record({ updatedAt: 0 })] }, NOW, { ...CONFIG, projectMs: 0 }, false)
  assert.deepEqual(never.deleted, [])
  const yes = planGc({ records: [record({ updatedAt: NOW - 60 * DAY })] }, NOW, CONFIG, false)
  assert.equal(yes.deleted.length, 1)
})

test('a malformed record is protected and never appears in deleted', () => {
  const bad = record({ bytes: -5, updatedAt: Number.NaN, id: '' })
  const plan = planGc({ records: [bad] }, NOW, CONFIG, false)
  assert.deepEqual(plan.deleted, [])
  assert.equal(plan.protected.records, 1)
  assert.equal(plan.scanned.bytes, 0)
})

test('the per-session row cap trims the oldest rows regardless of age', () => {
  const rows = [0, 1, 2, 3, 4].map((index) =>
    record({
      kind: 'session_event',
      id: `ev_${index}`,
      class: 'session',
      sessionId: 's1',
      updatedAt: NOW - index * HOUR,
      bytes: 10,
    }),
  )
  const plan = planGc({ records: rows }, NOW, CONFIG, false)
  assert.equal(plan.deleted.length, 2)
  // The plan's own order is by id, so the ids read smallest first; which rows
  // were chosen is a question about AGE, asserted separately below.
  assert.deepEqual(plan.deleted.map((entry) => entry.id), ['ev_3', 'ev_4'])
  assert.equal(
    plan.deleted.every((entry) => entry.reason.includes('row cap')),
    true,
    'the cap must be named as the reason, not the age window',
  )
  const droppedAges = plan.deleted.map((entry) => entry.ageMs).sort((a, b) => b - a)
  const keptAges = rows
    .filter((row) => !plan.deleted.some((entry) => entry.id === row.id))
    .map((row) => NOW - row.updatedAt)
  assert.ok(
    droppedAges[0] >= Math.max(...keptAges),
    'the oldest rows are the ones the cap drops',
  )
})

test('maxDeletes bounds deleted and reports truncation', () => {
  const rows = Array.from({ length: 10 }, (_, index) =>
    record({ kind: 'session_event', id: `ev_${index}`, class: 'session', sessionId: 's1', updatedAt: NOW - 100 * DAY }),
  )
  const plan = planGc({ records: rows, maxDeletes: 4 }, NOW, CONFIG, false)
  assert.equal(plan.deleted.length, 4)
  assert.equal(plan.truncated, true)
  assert.equal(plan.reclaimable.records, 10)
})

test('a dry run reports the same candidates as an applying run', () => {
  const rows = [record({ class: 'ephemeral', id: 'a', updatedAt: NOW - 100 * DAY })]
  const dry = planGc({ records: rows }, NOW, CONFIG, true)
  const wet = planGc({ records: rows }, NOW, CONFIG, false)
  assert.equal(dry.dryRun, true)
  assert.equal(wet.dryRun, false)
  assert.deepEqual(dry.deleted, wet.deleted)
})

test('an empty input yields an all-zero plan', () => {
  const plan = planGc({ records: [] }, NOW, CONFIG, false)
  assert.deepEqual(plan.deleted, [])
  assert.equal(plan.scanned.records, 0)
  assert.equal(plan.reclaimable.records, 0)
  assert.equal(plan.protected.records, 0)
})

test('the plan is deterministic and independent of input order', () => {
  const rows = [
    record({ class: 'ephemeral', id: 'a', updatedAt: NOW - 100 * DAY }),
    record({ class: 'ephemeral', id: 'b', updatedAt: NOW - 200 * DAY }),
    record({ kind: 'session_event', id: 'c', class: 'session', sessionId: 's', updatedAt: NOW - 400 * DAY }),
  ]
  const first = planGc({ records: rows }, NOW, CONFIG, false)
  const second = planGc({ records: rows }, NOW, CONFIG, false)
  assert.deepEqual(first, second)
  const reversed = planGc({ records: [...rows].reverse() }, NOW, CONFIG, false)
  assert.deepEqual(reversed.deleted, first.deleted)
})

test('reclaimableBytes never returns a negative total', () => {
  assert.equal(reclaimableBytes([record({ bytes: -5 }), record({ bytes: 10 })]), 10)
  assert.equal(reclaimableBytes([record({ bytes: Number.NaN })]), 0)
})
