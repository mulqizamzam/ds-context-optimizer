import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TemporalFilterError,
  applyTemporal,
  compareByRecency,
  historicalOnly,
  isRecent,
  parseTemporal,
  recencyScore,
  selectLatest,
} from '../../dist/temporal.js'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const T1 = Date.parse('2026-01-02T00:00:00.000Z')
const T2 = Date.parse('2026-01-03T00:00:00.000Z')

const item = (updatedAt, sessionId) => ({ updatedAt, sessionId })

/** Assert a malformed field is refused with the field named in the message. */
function assertFieldError(call, field) {
  assert.throws(
    call,
    (error) =>
      error instanceof TemporalFilterError &&
      error.message.includes(field) &&
      error.name === 'TemporalFilterError',
    `expected a TemporalFilterError naming ${field}`,
  )
}

test('an ISO string and an epoch number produce the same filter', () => {
  const fromIso = parseTemporal({
    temporal: 'latest',
    before: '2026-01-03T00:00:00.000Z',
    after: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
  })
  const fromEpoch = parseTemporal({
    temporal: 'latest',
    before: T2,
    after: T0,
    sessionId: 's1',
  })
  assert.deepEqual(fromIso, fromEpoch)
  assert.deepEqual(fromIso, { mode: 'latest', before: T2, after: T0, sessionId: 's1' })
})

test('a filter with no arguments defaults to mode any with no other keys', () => {
  // deepStrictEqual distinguishes an absent key from one holding undefined,
  // so this also pins down that absent fields stay absent.
  assert.deepEqual(parseTemporal({}), { mode: 'any' })
  assert.deepEqual(parseTemporal({ temporal: undefined }), { mode: 'any' })
})

test('each of the three modes parses', () => {
  assert.equal(parseTemporal({ temporal: 'any' }).mode, 'any')
  assert.equal(parseTemporal({ temporal: 'latest' }).mode, 'latest')
  assert.equal(parseTemporal({ temporal: 'historical' }).mode, 'historical')
})

test('temporal rejects anything that is not one of the three modes', () => {
  for (const bad of [true, false, 1, 0, 'Recent', '', 'ANY', null, [], {}]) {
    assertFieldError(() => parseTemporal({ temporal: bad }), 'temporal')
  }
})

test('sessionId rejects a non-string and the empty string', () => {
  assertFieldError(() => parseTemporal({ sessionId: 42 }), 'sessionId')
  assertFieldError(() => parseTemporal({ sessionId: true }), 'sessionId')
  assertFieldError(() => parseTemporal({ sessionId: null }), 'sessionId')
  assertFieldError(() => parseTemporal({ sessionId: '' }), 'sessionId')
})

test('before rejects anything that is not a finite epoch number or ISO string', () => {
  for (const bad of ['last week', 'yesterday', '', 'not a timestamp', '2026-13-45T99:99:99Z']) {
    assertFieldError(() => parseTemporal({ before: bad }), 'before')
  }
  for (const bad of [true, false, NaN, Infinity, -Infinity, {}, [], null]) {
    assertFieldError(() => parseTemporal({ before: bad }), 'before')
  }
})

test('after rejects anything that is not a finite epoch number or ISO string', () => {
  assertFieldError(() => parseTemporal({ after: 'last week' }), 'after')
  assertFieldError(() => parseTemporal({ after: 'yesterday' }), 'after')
  assertFieldError(() => parseTemporal({ after: false }), 'after')
  assertFieldError(() => parseTemporal({ after: NaN }), 'after')
  assertFieldError(() => parseTemporal({ after: Infinity }), 'after')
  assertFieldError(() => parseTemporal({ after: { epoch: T0 } }), 'after')
})

test('the rejected value appears in the error message', () => {
  assert.throws(
    () => parseTemporal({ before: 'last week' }),
    (error) => error instanceof TemporalFilterError && error.message.includes('"last week"'),
  )
  assert.throws(
    () => parseTemporal({ after: NaN }),
    (error) => error instanceof TemporalFilterError && error.message.includes('NaN'),
  )
})

test('after later than before throws instead of returning nothing', () => {
  assertFieldError(() => parseTemporal({ before: T0, after: T1 }), 'after')
  assert.throws(
    () => parseTemporal({ before: T0, after: T1 }),
    (error) => error instanceof TemporalFilterError && error.message.includes('before'),
  )
})

test('equal bounds are a valid single-instant interval', () => {
  assert.deepEqual(parseTemporal({ before: T1, after: T1 }), {
    mode: 'any',
    before: T1,
    after: T1,
  })
})

test('bounds are inclusive on both ends', () => {
  const items = [item(T0 - 1), item(T0), item(T0 + 500), item(T1), item(T1 + 1)]
  const kept = applyTemporal(items, parseTemporal({ before: T1, after: T0 }))
  assert.deepEqual(
    kept.map((entry) => entry.updatedAt),
    [T0, T0 + 500, T1],
  )
})

test('sessionId filters on exact equality', () => {
  const items = [item(T0, 's1'), item(T0, 's2'), item(T1, 'S1'), item(T1, 's1')]
  const kept = applyTemporal(items, parseTemporal({ sessionId: 's1' }))
  assert.deepEqual(kept, [items[0], items[3]])
  // A different id is a different session, not a prefix or case-insensitive match.
  assert.deepEqual(applyTemporal(items, parseTemporal({ sessionId: 's' })), [])
})

test('mode latest keeps exactly one item, the newest', () => {
  const items = [item(T0), item(T1), item(T0 + 10)]
  const kept = applyTemporal(items, parseTemporal({ temporal: 'latest' }))
  assert.equal(kept.length, 1)
  assert.equal(kept[0].updatedAt, T1)
  // Bounds still apply inside latest: the newest survivor of the window wins.
  const windowed = applyTemporal(items, parseTemporal({ temporal: 'latest', after: T0 + 10, before: T1 }))
  assert.deepEqual(windowed.map((entry) => entry.updatedAt), [T1])
})

test('mode latest breaks ties by the first item in input order', () => {
  const items = [item(T1), item(T1), item(T1)]
  const kept = applyTemporal(items, parseTemporal({ temporal: 'latest' }))
  assert.equal(kept.length, 1)
  assert.equal(kept[0], items[0])
})

test('mode latest on an empty or fully-filtered list returns nothing', () => {
  assert.deepEqual(applyTemporal([], parseTemporal({ temporal: 'latest' })), [])
  const items = [item(T0)]
  assert.deepEqual(applyTemporal(items, parseTemporal({ temporal: 'latest', before: T0 - 1 })), [])
})

test('mode historical drops the newest and keeps the rest in input order', () => {
  const items = [item(T1), item(T0), item(T2), item(T1)]
  const kept = applyTemporal(items, parseTemporal({ temporal: 'historical' }))
  assert.deepEqual(
    kept.map((entry) => entry.updatedAt),
    [T1, T0, T1],
  )
  assert.equal(kept[0], items[0])
})

test('mode historical keeps nothing when a single item ties with the newest', () => {
  assert.deepEqual(applyTemporal([item(T1)], parseTemporal({ temporal: 'historical' })), [])
  const tied = [item(T1), item(T1)]
  assert.deepEqual(applyTemporal(tied, parseTemporal({ temporal: 'historical' })), [])
})

test('mode any keeps everything inside the window, newest included', () => {
  const items = [item(T0), item(T1), item(T2)]
  const kept = applyTemporal(items, parseTemporal({ temporal: 'any' }))
  assert.deepEqual(kept, items)
  assert.deepEqual(applyTemporal(items, parseTemporal({ temporal: 'any', after: T1 })).length, 2)
})

test('applyTemporal never mutates its input', () => {
  const items = Object.freeze([
    Object.freeze(item(T0, 's1')),
    Object.freeze(item(T1, 's2')),
    Object.freeze(item(T2, 's1')),
  ])
  const before = JSON.stringify(items)
  applyTemporal(items, parseTemporal({ temporal: 'latest' }))
  applyTemporal(items, parseTemporal({ temporal: 'historical' }))
  applyTemporal(items, parseTemporal({ temporal: 'any', sessionId: 's1' }))
  assert.equal(JSON.stringify(items), before)
})

test('selectLatest returns undefined for an empty list', () => {
  assert.equal(selectLatest([], T2), undefined)
})

test('selectLatest returns the newest item, ties to the first in input order', () => {
  const items = [item(T0), item(T2), item(T1)]
  assert.equal(selectLatest(items, T2), items[1])
  const tied = [item(T1), item(T1)]
  assert.equal(selectLatest(tied, T2), tied[0])
})

test('historicalOnly keeps items older than the staleness threshold', () => {
  const now = 10_000
  const items = [item(8_998), item(8_999), item(9_000), item(9_001), item(9_499)]
  const kept = historicalOnly(items, now, 1_000)
  assert.deepEqual(
    kept.map((entry) => entry.updatedAt),
    [8_998, 8_999],
  )
  // An item exactly at the threshold (age 1000) is still current: the cutoff is
  // strict, and the item one millisecond older is the first to be historical.
  assert.ok(!kept.some((entry) => entry.updatedAt === 9_000))
  assert.ok(kept.includes(items[1]))
})

test('historicalOnly is total for non-finite inputs', () => {
  const items = [item(NaN), item(1), item(2)]
  assert.deepEqual(historicalOnly(items, NaN, 1_000), [])
  assert.deepEqual(historicalOnly(items, 10_000, NaN), [])
  assert.deepEqual(historicalOnly(items, 10_000, Infinity), [])
  assert.deepEqual(historicalOnly(items, 10_000, 1_000), [item(1), item(2)])
})

test('recencyScore is 1.0 at now and for anything newer', () => {
  assert.equal(recencyScore(T1, T1, 1_000), 1)
  assert.equal(recencyScore(T2, T1, 1_000), 1)
})

test('recencyScore is exactly 0.5 at one half-life', () => {
  assert.equal(recencyScore(T1 - 1_000, T1, 1_000), 0.5)
  assert.equal(recencyScore(T1 - 100, T1, 100), 0.5)
})

test('recencyScore stays above zero far in the past and never leaves [0, 1]', () => {
  const halfLife = 1_000
  assert.ok(recencyScore(T1 - 10 * halfLife, T1, halfLife) > 0)
  let previous = Number.POSITIVE_INFINITY
  for (let age = 0; age <= 40 * halfLife; age += halfLife / 4) {
    const score = recencyScore(T1 - age, T1, halfLife)
    assert.ok(score >= 0 && score <= 1, `score ${score} outside [0, 1] at age ${age}`)
    assert.ok(score <= previous, `score ${score} increased at age ${age}`)
    previous = score
  }
})

test('recencyScore yields 0, never NaN, for a non-finite or non-positive half-life', () => {
  for (const halfLife of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(recencyScore(T1 - 5_000, T1, halfLife), 0)
  }
})

test('recencyScore yields 0 for a non-finite timestamp', () => {
  assert.equal(recencyScore(NaN, T1, 1_000), 0)
  assert.equal(recencyScore(Infinity, T1, 1_000), 0)
  assert.equal(recencyScore(T1, NaN, 1_000), 0)
  assert.equal(recencyScore(T1, Infinity, 1_000), 0)
})

test('recencyScore is rounded to at most 4 decimal places', () => {
  const halfLife = 333
  for (let age = 0; age < 5_000; age += 37) {
    const score = recencyScore(T1 - age, T1, halfLife)
    assert.equal(Math.round(score * 10_000) / 10_000, score)
  }
})

test('compareByRecency orders newest first and reports ties as 0', () => {
  // Negative means "a sorts before b", so a newer `a` must compare negative.
  assert.ok(compareByRecency({ updatedAt: T1 }, { updatedAt: T0 }) < 0)
  assert.ok(compareByRecency({ updatedAt: T0 }, { updatedAt: T1 }) > 0)
  assert.equal(compareByRecency({ updatedAt: T1 }, { updatedAt: T1 }), 0)
  const sorted = [item(T0), item(T2), item(T1)].sort(compareByRecency)
  assert.deepEqual(
    sorted.map((entry) => entry.updatedAt),
    [T2, T1, T0],
  )
})

test('compareByRecency sorting is stable for equal timestamps', () => {
  const items = [item(T1), item(T0), item(T1), item(T0), item(T1)]
  const sorted = [...items].sort(compareByRecency)
  assert.deepEqual(
    sorted.map((entry) => entry.updatedAt),
    [T1, T1, T1, T0, T0],
  )
  // Position, not identity, is what stability guarantees: equal timestamps keep
  // their relative input order.
  assert.equal(sorted[0], items[0])
  assert.equal(sorted[1], items[2])
  assert.equal(sorted[2], items[4])
})

test('isRecent is inclusive at the threshold boundary', () => {
  const now = 10_000
  assert.equal(isRecent(now - 1_000, now, 1_000), true)
  assert.equal(isRecent(now - 1_001, now, 1_000), false)
  assert.equal(isRecent(now, now, 0), true)
  assert.equal(isRecent(now - 1, now, 0), false)
  assert.equal(isRecent(now + 5_000, now, 1_000), true)
})

test('repeated identical calls return deeply equal results', () => {
  const args = { temporal: 'latest', before: T1, after: T0, sessionId: 's1' }
  assert.deepEqual(parseTemporal(args), parseTemporal(args))
  const items = [item(T0, 's1'), item(T1, 's1'), item(T2, 's2')]
  const filter = parseTemporal({ temporal: 'historical', after: T0 - 1 })
  assert.deepEqual(applyTemporal(items, filter), applyTemporal(items, filter))
  assert.deepEqual([...items].sort(compareByRecency), [...items].sort(compareByRecency))
  assert.equal(recencyScore(T1 - 777, T1, 1_000), recencyScore(T1 - 777, T1, 1_000))
})
