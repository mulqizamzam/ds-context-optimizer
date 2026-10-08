import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreRetrieval, qualitySummary, QUALITY_WEIGHTS } from '../../dist/quality.js'

/** Decimal places in the shortest representation of a value. */
function decimals(value) {
  const text = String(value)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/** Every invariant the contract puts on a score, whichever input produced it. */
function assertWellFormed(score, label) {
  const components = ['relevance', 'freshness', 'coverage', 'diversity', 'contradictionPenalty', 'overall']
  for (const name of components) {
    const value = score[name]
    assert.equal(typeof value, 'number', `${label}.${name} is a number`)
    assert.ok(Number.isFinite(value), `${label}.${name} is finite, got ${value}`)
    assert.ok(value >= 0, `${label}.${name} >= 0, got ${value}`)
    assert.ok(value <= 1, `${label}.${name} <= 1, got ${value}`)
    assert.ok(decimals(value) <= 2, `${label}.${name} has at most 2 decimals, got ${value}`)
  }
}

test('stale evidence scores lower freshness and lower overall', () => {
  const fresh = scoreRetrieval({
    relevance: [3, 2],
    freshness: [0.9, 0.9],
    distinctSources: 2,
    totalHits: 2,
    contradictionPenalty: 0,
    coverageTarget: 2,
  })
  const stale = scoreRetrieval({
    relevance: [3, 2],
    freshness: [0.2, 0.2],
    distinctSources: 2,
    totalHits: 2,
    contradictionPenalty: 0,
    coverageTarget: 2,
  })
  assert.ok(stale.freshness < fresh.freshness, 'freshness must drop')
  assert.ok(stale.overall < fresh.overall, 'overall must drop with it')
})

test('duplicate chunks dominating the result score lower diversity and overall', () => {
  const base = {
    relevance: [4, 3, 2, 1],
    freshness: [0.5, 0.5, 0.5, 0.5],
    totalHits: 4,
    contradictionPenalty: 0,
    coverageTarget: 4,
  }
  const spread = scoreRetrieval({ ...base, distinctSources: 4 })
  const duplicated = scoreRetrieval({ ...base, distinctSources: 1 })
  assert.equal(spread.diversity, 1)
  assert.equal(duplicated.diversity, 0.25)
  assert.ok(duplicated.diversity < spread.diversity, 'diversity must drop')
  assert.ok(duplicated.overall < spread.overall, 'overall must drop with it')
})

test('contradiction penalty lowers overall by exactly half the penalty', () => {
  const base = {
    relevance: [3, 1],
    freshness: [0.6, 0.4],
    distinctSources: 2,
    totalHits: 2,
    coverageTarget: 2,
  }
  const clean = scoreRetrieval({ ...base, contradictionPenalty: 0 })
  const penalty = 0.6
  const contradicted = scoreRetrieval({ ...base, contradictionPenalty: penalty })
  assert.equal(contradicted.contradictionPenalty, 0.6)
  // round2 on both sides leaves at most one cent of slack either way.
  assert.ok(
    Math.abs((contradicted.overall - clean.overall) + 0.5 * penalty) <= 0.011,
    `expected a drop of ${0.5 * penalty}, got ${clean.overall - contradicted.overall}`,
  )
})

test('a dominant top hit scores relevance 1.0', () => {
  const single = scoreRetrieval({
    relevance: [12],
    freshness: [1],
    distinctSources: 1,
    totalHits: 1,
    contradictionPenalty: 0,
    coverageTarget: 1,
  })
  assert.equal(single.relevance, 1)
  const tied = scoreRetrieval({
    relevance: [8, 8],
    freshness: [1, 1],
    distinctSources: 2,
    totalHits: 2,
    contradictionPenalty: 0,
    coverageTarget: 2,
  })
  assert.equal(tied.relevance, 1)
})

test('relevance rescales weaker hits against the top hit', () => {
  const score = scoreRetrieval({
    relevance: [4, 2, 1],
    freshness: [0, 0, 0],
    distinctSources: 3,
    totalHits: 3,
    contradictionPenalty: 0,
    coverageTarget: 3,
  })
  // mean(1, 0.5, 0.25) = 0.5833... -> 0.58
  assert.equal(score.relevance, 0.58)
})

test('an empty retrieval scores 0 on every component', () => {
  const score = scoreRetrieval({
    relevance: [],
    freshness: [],
    distinctSources: 0,
    totalHits: 0,
    contradictionPenalty: 0,
    coverageTarget: 4,
  })
  assertWellFormed(score, 'empty')
  assert.deepEqual({ ...score }, {
    relevance: 0,
    freshness: 0,
    coverage: 0,
    diversity: 0,
    contradictionPenalty: 0,
    overall: 0,
  })
})

test('an all-zero relevance set scores 0 rather than dividing by zero', () => {
  const score = scoreRetrieval({
    relevance: [0, 0, 0],
    freshness: [0.5, 0.5, 0.5],
    distinctSources: 1,
    totalHits: 3,
    contradictionPenalty: 0,
    coverageTarget: 3,
  })
  assert.equal(score.relevance, 0)
  assertWellFormed(score, 'all-zero relevance')
})

test('NaN, negative and Infinity inputs never escape [0,1] or produce NaN', () => {
  const inputs = [
    ['NaN scores', {
      relevance: [Number.NaN, 3, Number.NaN],
      freshness: [Number.NaN, 0.5, Number.NaN],
      distinctSources: 2,
      totalHits: 3,
      contradictionPenalty: Number.NaN,
      coverageTarget: 2,
    }],
    ['negative scores', {
      relevance: [-5, -1, -9],
      freshness: [-0.4, -1, -0.2],
      distinctSources: 2,
      totalHits: 3,
      contradictionPenalty: -0.7,
      coverageTarget: 2,
    }],
    ['Infinity scores', {
      relevance: [Number.POSITIVE_INFINITY, 2, Number.NEGATIVE_INFINITY],
      freshness: [Number.POSITIVE_INFINITY, Number.NaN, 0.3],
      distinctSources: 2,
      totalHits: 3,
      contradictionPenalty: Number.POSITIVE_INFINITY,
      coverageTarget: 2,
    }],
    ['non-finite sizing', {
      relevance: [1, 1],
      freshness: [0.2, 0.2],
      distinctSources: Number.NaN,
      totalHits: Number.POSITIVE_INFINITY,
      contradictionPenalty: 0.2,
      coverageTarget: Number.NaN,
    }],
    ['inconsistent counts', {
      relevance: [1],
      freshness: [1],
      distinctSources: 9,
      totalHits: 2,
      contradictionPenalty: 0.2,
      coverageTarget: -3,
    }],
    ['empty arrays with non-zero hits', {
      relevance: [],
      freshness: [],
      distinctSources: 0,
      totalHits: 5,
      contradictionPenalty: 0.5,
      coverageTarget: 0,
    }],
  ]
  for (const [label, input] of inputs) {
    const score = scoreRetrieval(input)
    assertWellFormed(score, label)
    assert.doesNotThrow(() => qualitySummary(score), `${label} summary`)
  }
})

test('every component carries at most 2 decimal places', () => {
  const inputs = [
    { relevance: [1, 2, 3], freshness: [0.1, 0.2, 0.3], distinctSources: 3, totalHits: 3, contradictionPenalty: 0, coverageTarget: 3 },
    { relevance: [7], freshness: [0.33], distinctSources: 1, totalHits: 1, contradictionPenalty: 0.33, coverageTarget: 1 },
    { relevance: [5, 4, 3, 2, 1], freshness: [0.07, 0.11, 0.19, 0.23], distinctSources: 2, totalHits: 5, contradictionPenalty: 0.77, coverageTarget: 7 },
  ]
  for (const [index, input] of inputs.entries()) {
    assertWellFormed(scoreRetrieval(input), `rounding[${index}]`)
  }
})

test('coverage saturates at 1 and a zero target is 0', () => {
  const saturated = scoreRetrieval({
    relevance: [1],
    freshness: [1],
    distinctSources: 6,
    totalHits: 6,
    contradictionPenalty: 0,
    coverageTarget: 4,
  })
  assert.equal(saturated.coverage, 1)
  const noTarget = scoreRetrieval({
    relevance: [1],
    freshness: [1],
    distinctSources: 6,
    totalHits: 6,
    contradictionPenalty: 0,
    coverageTarget: 0,
  })
  assert.equal(noTarget.coverage, 0)
})

test('QUALITY_WEIGHTS sum to 1 so the mixture stays in range', () => {
  const sum = QUALITY_WEIGHTS.relevance + QUALITY_WEIGHTS.freshness
    + QUALITY_WEIGHTS.coverage + QUALITY_WEIGHTS.diversity
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to 1, got ${sum}`)
})

test('qualitySummary is one bounded line naming every component', () => {
  const score = scoreRetrieval({
    relevance: [10, 4, 1],
    freshness: [0.8, 0.4, 0.1],
    distinctSources: 3,
    totalHits: 3,
    contradictionPenalty: 0.25,
    coverageTarget: 3,
  })
  const summary = qualitySummary(score)
  assert.ok(!summary.includes('\n') && !summary.includes('\r'), 'single line')
  assert.ok(summary.length <= 120, `summary is bounded, got ${summary.length} chars`)
  for (const name of ['relevance', 'freshness', 'coverage', 'diversity', 'penalty', 'overall']) {
    assert.ok(summary.includes(name), `summary names ${name}`)
  }
  for (const component of ['relevance', 'freshness', 'coverage', 'diversity', 'contradictionPenalty']) {
    assert.ok(
      summary.includes(score[component].toFixed(2)),
      `summary reports ${component}=${score[component].toFixed(2)}`,
    )
  }
})

test('qualitySummary stays bounded even for a hand-built out-of-range score', () => {
  const summary = qualitySummary({
    relevance: Number.NaN,
    freshness: 5,
    coverage: -2,
    diversity: Number.POSITIVE_INFINITY,
    contradictionPenalty: Number.NaN,
    overall: 3,
  })
  assert.ok(summary.length <= 120, `bounded, got ${summary.length}`)
  assert.ok(!/[^\x20-\x7e]/.test(summary), 'printable ASCII only')
})
