import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allocateContextBudget,
  allocationTotal,
  budgetReport,
  fitToBudget,
  measureContext,
} from '../../dist/budget.js'

const FOUR_SECTIONS = ['recent', 'task', 'evidence', 'metadata']

test('a four-section budget splits into the weighted shares and spends it all', () => {
  const allocation = allocateContextBudget(
    { totalChars: 1000, reserveChars: 200, weights: { recent: 40, task: 20, evidence: 30, metadata: 10 } },
    FOUR_SECTIONS,
  )
  assert.deepEqual(allocation, { recent: 320, task: 160, evidence: 240, metadata: 80 })
  assert.equal(allocationTotal(allocation), 800)
  assert.equal(Object.keys(allocation).join(','), 'recent,task,evidence,metadata')
})

test('the largest-remainder split is exact and identical on every call', () => {
  const budget = { totalChars: 10, reserveChars: 0, weights: { recent: 1, task: 1, evidence: 1, metadata: 1 } }
  // 10 characters over four equal shares floors to 2 each; the two leftover
  // characters go to the two largest remainders, and every remainder ties, so
  // the declared order decides.
  const first = allocateContextBudget(budget, FOUR_SECTIONS)
  const second = allocateContextBudget(budget, FOUR_SECTIONS)
  assert.deepEqual(first, { recent: 3, task: 3, evidence: 2, metadata: 2 })
  assert.equal(first.task - first.evidence, 1)
  assert.deepEqual(first, second)
})

test('weights that sum to nothing split the budget equally', () => {
  const zero = allocateContextBudget(
    { totalChars: 12, reserveChars: 0, weights: { recent: 0, task: 0, evidence: 0, metadata: 0 } },
    FOUR_SECTIONS,
  )
  assert.deepEqual(zero, { recent: 3, task: 3, evidence: 3, metadata: 3 })

  // Negative weights are not "a smaller share", they are no share at all, so
  // they fall into the same equal split rather than stealing from the others.
  const negative = allocateContextBudget(
    { totalChars: 12, reserveChars: 0, weights: { recent: -5, task: -1, evidence: -2, metadata: -1 } },
    FOUR_SECTIONS,
  )
  assert.deepEqual(negative, { recent: 3, task: 3, evidence: 3, metadata: 3 })

  const uneven = allocateContextBudget(
    { totalChars: 12, reserveChars: 0, weights: { recent: 0, task: 0, evidence: 0, metadata: 0 } },
    ['recent', 'task', 'evidence'],
  )
  assert.deepEqual(uneven, { recent: 4, task: 4, evidence: 4 })
})

test('a zero-weight section receives nothing while another carries the weight', () => {
  const allocation = allocateContextBudget(
    { totalChars: 100, reserveChars: 0, weights: { recent: 5, task: 0, evidence: 5, metadata: -3 } },
    FOUR_SECTIONS,
  )
  assert.deepEqual(allocation, { recent: 50, task: 0, evidence: 50, metadata: 0 })
  assert.equal(allocationTotal(allocation), 100)
})

test('a reserve larger than the total spends nothing', () => {
  const budget = { totalChars: 100, reserveChars: 500, weights: { recent: 1, task: 1, evidence: 1, metadata: 1 } }
  const report = budgetReport(budget)
  assert.equal(report.totalChars, 100)
  assert.equal(report.reserveChars, 100)
  assert.equal(report.usableChars, 0)
  assert.deepEqual(allocateContextBudget(budget, FOUR_SECTIONS), {
    recent: 0,
    task: 0,
    evidence: 0,
    metadata: 0,
  })
})

test('a one-character budget over four sections stays non-negative and inside it', () => {
  const allocation = allocateContextBudget(
    { totalChars: 1, reserveChars: 0, weights: { recent: 1, task: 2, evidence: 3, metadata: 4 } },
    FOUR_SECTIONS,
  )
  for (const value of Object.values(allocation)) {
    assert.ok(Number.isInteger(value))
    assert.ok(value >= 0)
  }
  assert.ok(allocationTotal(allocation) <= 1)
  // Every share floors to 0, so the single character goes to the largest
  // remainder — metadata, whose quarter of the budget is the biggest share.
  assert.deepEqual(allocation, { recent: 0, task: 0, evidence: 0, metadata: 1 })
})

test('a duplicate section name is counted once, at its first position', () => {
  const allocation = allocateContextBudget(
    { totalChars: 100, reserveChars: 0, weights: { recent: 1, task: 1, evidence: 1, metadata: 1 } },
    ['recent', 'task', 'recent'],
  )
  assert.deepEqual(allocation, { recent: 50, task: 50 })
  assert.equal(Object.keys(allocation).length, 2)
})

test('a section the weights never named falls back to the equal-share rule', () => {
  const alone = allocateContextBudget(
    { totalChars: 40, reserveChars: 0, weights: { recent: 9, task: 0, evidence: 0, metadata: 0 } },
    ['snapshot'],
  )
  assert.deepEqual(alone, { snapshot: 40 })

  const beside = allocateContextBudget(
    { totalChars: 40, reserveChars: 0, weights: { recent: 9, task: 0, evidence: 0, metadata: 0 } },
    ['recent', 'snapshot'],
  )
  assert.deepEqual(beside, { recent: 40, snapshot: 0 })
})

test('an allocation never returns a fractional character count', () => {
  // 97 characters over 1:2:3:4 floors to 9/19/29/38 and hands the two leftover
  // characters to the two largest remainders (metadata, then recent).
  const allocation = allocateContextBudget(
    { totalChars: 97, reserveChars: 0, weights: { recent: 1, task: 2, evidence: 3, metadata: 4 } },
    FOUR_SECTIONS,
  )
  assert.deepEqual(allocation, { recent: 10, task: 19, evidence: 29, metadata: 39 })
  for (const value of Object.values(allocation)) assert.ok(Number.isInteger(value))
  assert.equal(allocationTotal(allocation), 97)
})

test('a section named like an Object.prototype member still gets its characters', () => {
  // All three names are unknown to the weights, so the split is equal: 10
  // characters over three sections floors to 3 each and hands the leftover one
  // to the first declared section.
  const allocation = allocateContextBudget(
    { totalChars: 10, reserveChars: 0, weights: { recent: 1, task: 1, evidence: 1, metadata: 1 } },
    ['snapshot', '__proto__', 'constructor'],
  )
  assert.deepEqual(Object.keys(allocation), ['snapshot', '__proto__', 'constructor'])
  assert.equal(allocation.snapshot, 4)
  // Read by key rather than through a literal: `{ __proto__: 3 }` would set the
  // prototype instead of creating the key, which is the very hazard
  // defineOwn exists to close, so a literal cannot express the expectation.
  assert.equal(allocation['__proto__'], 3)
  assert.equal(allocation['constructor'], 3)
  assert.equal(allocationTotal(allocation), 10)
})

test('an empty section list and a zero budget both allocate nothing', () => {
  assert.deepEqual(
    allocateContextBudget(
      { totalChars: 90, reserveChars: 0, weights: { recent: 1, task: 1, evidence: 1, metadata: 1 } },
      [],
    ),
    {},
  )
  assert.deepEqual(
    allocateContextBudget(
      { totalChars: 0, reserveChars: 0, weights: { recent: 1, task: 1, evidence: 1, metadata: 1 } },
      FOUR_SECTIONS,
    ),
    { recent: 0, task: 0, evidence: 0, metadata: 0 },
  )
})

test('fitToBudget drops an item larger than the whole budget', () => {
  const items = [
    { id: 'huge', chars: 500 },
    { id: 'small', chars: 10 },
  ]
  assert.deepEqual(fitToBudget(items, 100), [])
  assert.deepEqual(items, [
    { id: 'huge', chars: 500 },
    { id: 'small', chars: 10 },
  ])
})

test('fitToBudget keeps the fitting prefix in order and never clips an item', () => {
  const items = [
    { id: 'a', chars: 30 },
    { id: 'b', chars: 40 },
    { id: 'c', chars: 50 },
  ]
  const kept = fitToBudget(items, 100)
  assert.deepEqual(kept.map((item) => item.id), ['a', 'b'])
  assert.equal(kept.reduce((sum, item) => sum + item.chars, 0), 70)

  const everything = fitToBudget(items, 120)
  assert.deepEqual(everything, items)
  assert.equal(everything.length, 3)
})

test('fitToBudget refuses a budget with no room and does not touch its input', () => {
  const items = [{ id: 'a', chars: 10 }]
  assert.deepEqual(fitToBudget(items, 0), [])
  assert.deepEqual(fitToBudget(items, -50), [])
  // A non-finite budget is not a budget; it allocates nothing rather than
  // admitting every item, which is what a NaN comparison would otherwise do.
  assert.deepEqual(fitToBudget(items, Number.NaN), [])
  assert.deepEqual(fitToBudget(items, Number.POSITIVE_INFINITY), [])

  const before = structuredClone(items)
  fitToBudget(items, 5)
  assert.deepEqual(items, before)
  assert.equal(items.length, 1)
})

test('a report clamps its inputs and normalises its weights to exactly 1', () => {
  const report = budgetReport({
    totalChars: 500.9,
    reserveChars: -10,
    weights: { recent: 0.3, task: 0.3, evidence: 0.3, metadata: 0.1 },
  })
  assert.equal(report.totalChars, 500)
  assert.equal(report.reserveChars, 0)
  assert.equal(report.usableChars, 500)
  assert.equal(report.requestedWeights.metadata, 0.1)

  const normalized = report.normalizedWeights
  const sum = normalized.recent + normalized.task + normalized.evidence + normalized.metadata
  assert.equal(sum, 1)
  assert.equal(normalized.recent, normalized.task)
  assert.equal(normalized.evidence, normalized.recent)

  const silent = budgetReport({
    totalChars: 80,
    reserveChars: 20,
    weights: { recent: Number.NaN, task: Number.POSITIVE_INFINITY, evidence: -4, metadata: 0 },
  })
  assert.equal(silent.normalizedWeights.recent, 0.25)
  assert.equal(silent.normalizedWeights.task, 0.25)
  assert.equal(silent.normalizedWeights.evidence, 0.25)
  assert.equal(silent.normalizedWeights.metadata, 0.25)
})

test('measureContext returns the exact length of a known string', () => {
  assert.equal(measureContext('context budget'), 14)
  assert.equal(measureContext(''), 0)
  assert.equal(measureContext('a'), 1)
})

test('measureContext does not depend on the order the keys were written in', () => {
  const one = measureContext({ recent: 'a', task: 'b', evidence: 1, metadata: null })
  const other = measureContext({ metadata: null, evidence: 1, task: 'b', recent: 'a' })
  assert.equal(one, other)
  // {"evidence":1,"metadata":null,"recent":"a","task":"b"}
  assert.equal(one, 54)

  const nested = measureContext({ a: 1, b: { d: 1, c: 2 } })
  assert.equal(nested, measureContext({ b: { c: 2, d: 1 }, a: 1 }))
  // {"a":1,"b":{"c":2,"d":1}}
  assert.equal(nested, 25)
})

test('measureContext measures scalars by their literal text', () => {
  assert.equal(measureContext(undefined), 0)
  assert.equal(measureContext(null), 4)
  assert.equal(measureContext(42), 2)
  assert.equal(measureContext(true), 4)
  assert.equal(measureContext([1, 'two', null]), 14)
  assert.equal(measureContext({ u: undefined, s: 'x' }), 9)
  assert.equal(measureContext({ sym: Symbol('s'), fn: () => undefined }), 2)
})

test('measureContext calls no method the value could use to lie about its size', () => {
  const hostile = {
    toString() {
      throw new Error('toString must not be called')
    },
    toJSON() {
      throw new Error('toJSON must not be called')
    },
    valueOf() {
      throw new Error('valueOf must not be called')
    },
    a: 1,
  }
  assert.equal(measureContext(hostile), 7)

  // The liar is a function, so it has no canonical text and contributes
  // nothing: the answer is the empty mapping, not the 'tiny' it would have
  // answered with. Had the module asked `JSON.stringify` it would have thrown.
  assert.equal(measureContext({ toString: () => 'tiny' }), 2)
  // {"poisoned":{}}
  assert.equal(measureContext({ poisoned: { toString: () => 'tiny' } }), 15)
})

test('measureContext answers a bounded number for a value that contains itself', () => {
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  const measured = measureContext(cyclic)
  assert.ok(Number.isInteger(measured))
  assert.ok(measured >= 0)

  // A shared subtree is not a cycle, so it is measured once per reference.
  const shared = { x: 1 }
  assert.equal(measureContext({ one: shared, two: shared }), measureContext({ one: { x: 1 }, two: { x: 1 } }))
})
