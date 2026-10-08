import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ContentStore } from '../../dist/store.js'
import { RetrievalCache } from '../../dist/cache.js'
import { measureContext } from '../../dist/budget.js'
import { retrieve, FRESHNESS_HALF_LIFE_MS } from '../../dist/retrieval.js'

const NOW = Date.now()
const CEILING = 262_144

function newDeps(cacheConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-retrieval-'))
  const store = new ContentStore(path.join(dir, 'index.sqlite'))
  const cacheDb = new DatabaseSync(path.join(dir, 'cache.sqlite'))
  const cache = new RetrievalCache(cacheDb, {
    enabled: true,
    ttlMs: 60_000,
    maxEntries: 100,
    ...cacheConfig,
  })
  return {
    dir,
    store,
    cache,
    // `budget` and `search` are carried for the dep shape: the pipeline bounds
    // itself from the request and the contract ceiling, not from these.
    deps: {
      store,
      cache,
      budget: { totalChars: CEILING, reserveChars: 0, weights: { recent: 40, task: 20, evidence: 30, metadata: 10 } },
      search: {},
      now: () => NOW,
    },
    cleanup() {
      try {
        cacheDb.close()
      } catch {
        /* already closed */
      }
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a retrieval returns provenance-joined hits and a quality block', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    store.indexSource('docs', 'the alpha keyword governs the beta decision\n\nthe gamma clause stands apart')

    const result = retrieve(deps, { query: 'alpha', limit: 5 })

    assert.equal(result.query, 'alpha')
    assert.ok(result.matches.length >= 1, 'the FTS5 hit must survive the join')
    const hit = result.matches[0]
    assert.equal(hit.source, 'docs')
    assert.match(hit.evidenceId, /^ev_[0-9a-f]{16}$/, 'evidence id shape')
    assert.match(hit.sourceId, /^src_[0-9a-f]{16}$/, 'source id shape')
    assert.equal(hit.chunkId, `${hit.sourceId}:${hit.ordinal}`, 'chunk id is source plus ordinal')
    assert.ok(hit.snippet.includes('alpha'), 'the matched term stays in its excerpt')

    for (const name of ['relevance', 'freshness', 'coverage', 'diversity', 'contradictionPenalty', 'overall']) {
      const value = result.quality[name]
      assert.equal(typeof value, 'number', `quality.${name} is a number`)
      assert.ok(value >= 0 && value <= 1, `quality.${name} stays in range`)
    }
    assert.equal(FRESHNESS_HALF_LIFE_MS, 7 * 24 * 60 * 60 * 1000, 'the half-life is one week')
    assert.deepEqual(result.temporal, { mode: 'any' })
    assert.deepEqual(result.contradictions, [])
    assert.equal(result.hints.length, 1)
    assert.ok(result.hints[0].includes(hit.evidenceId), 'the expand hint names the top evidence id')
    assert.ok(result.hints[0].length <= 160)
    assert.equal(result.cache.enabled, true)
    assert.equal(result.cache.hit, false)
    assert.equal(result.cache.stored, true)
    assert.ok(result.cache.key.length > 0)
  } finally {
    cleanup()
  }
})

test('a second identical retrieval is a cache hit with the same matches', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    store.indexSource('docs', 'alpha keyword governs the beta decision')

    const first = retrieve(deps, { query: 'keyword', limit: 5 })
    const second = retrieve(deps, { query: 'keyword', limit: 5 })

    assert.equal(first.cache.hit, false)
    assert.equal(first.cache.stored, true)
    assert.equal(second.cache.hit, true)
    assert.equal(second.cache.stored, false)
    assert.equal(second.cache.key, first.cache.key)
    assert.deepEqual(second.matches, first.matches)
    assert.deepEqual(second.quality, first.quality)
    assert.deepEqual(second.contradictions, first.contradictions)
    assert.deepEqual(second.temporal, first.temporal)
    assert.deepEqual(second.hints, first.hints)
  } finally {
    cleanup()
  }
})

test('re-indexing a source bumps the corpus version and forces a miss', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    // The replacement body deliberately shares one term with the original, so
    // the two assertions below distinguish "the cache answered" from "the
    // corpus answered": a stale entry would still find `appears`, and only a
    // live re-read can find `refreshed`.
    store.indexSource('log', 'the old needle appears once')
    const before = retrieve(deps, { query: 'needle', limit: 5 })
    assert.equal(before.matches.length, 1)
    const versionBefore = store.corpusVersion()

    store.indexSource('log', 'the needle is refreshed and replaced')
    assert.ok(store.corpusVersion() > versionBefore, 're-indexing must move the corpus version')

    const after = retrieve(deps, { query: 'appears', limit: 5 })
    assert.equal(after.cache.hit, false, 'a new corpus version must not answer from the old entry')
    assert.equal(after.matches.length, 0, 'the replaced chunk is gone from the corpus')
    assert.equal(retrieve(deps, { query: 'refreshed', limit: 5 }).matches.length, 1, 'the new chunk is findable')
  } finally {
    cleanup()
  }
})

test('a malformed before value yields a bounded reason, empty matches, and no throw', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    store.indexSource('docs', 'alpha keyword here')

    let result
    assert.doesNotThrow(() => {
      result = retrieve(deps, { query: 'alpha', limit: 5, before: 'last week' })
    })

    assert.deepEqual(result.matches, [])
    assert.deepEqual(result.contradictions, [])
    assert.equal(result.hints.length, 1)
    assert.ok(result.hints[0].includes('before'), 'the reason must name the offending field')
    assert.ok(result.hints[0].length <= 160, 'the reason is bounded')
    assert.equal(result.cache.hit, false)
    assert.equal(result.cache.key, '', 'a rejected window never reaches the cache')
    assert.equal(result.quality.overall, 0, 'no evidence scores zero rather than a fabricated value')
  } finally {
    cleanup()
  }
})

test('conflicting values in two sources surface as contradictions', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    // Clean `key = value` lines on both sides: a value that runs into prose is a
    // phrase, and the contradiction module is deliberately conservative about
    // phrases, so a fixture with prose would assert a confidence the module
    // refuses to claim.
    store.indexSource('cfg-a', 'worker timeout = 30')
    store.indexSource('cfg-b', 'worker timeout = 60')

    const result = retrieve(deps, { query: 'worker', limit: 10 })

    assert.equal(result.contradictions.length, 1)
    const conflict = result.contradictions[0]
    assert.equal(conflict.confidence, 'high')
    assert.equal(conflict.kind, 'key-value')
    assert.match(conflict.evidenceA.evidenceId, /^ev_[0-9a-f]{16}$/)
    assert.match(conflict.evidenceB.evidenceId, /^ev_[0-9a-f]{16}$/)
    assert.notEqual(conflict.evidenceA.evidenceId, conflict.evidenceB.evidenceId)
    assert.ok(String(conflict.subject).includes('timeout'))

    const indexed = new Set(result.matches.map((hit) => hit.evidenceId))
    assert.ok(indexed.has(conflict.evidenceA.evidenceId), 'a contradiction cites evidence the caller can find')
    assert.ok(indexed.has(conflict.evidenceB.evidenceId))

    assert.ok(result.quality.contradictionPenalty > 0, 'the penalty reflects the conflict')
    assert.ok(result.hints.some((hint) => hint.includes('contradictory evidence')), 'the hint names the conflict')
    assert.ok(
      result.hints.some((hint) => hint.includes(conflict.evidenceA.evidenceId) && hint.includes(conflict.evidenceB.evidenceId)),
      'the hint names both evidence ids',
    )
  } finally {
    cleanup()
  }
})

test('temporal historical returns the oldest matching chunk first', async () => {
  const { store, deps, cleanup } = newDeps()
  try {
    const oldest = 1_600_000_000_000
    const middle = 1_700_000_000_000
    const newest = 1_800_000_000_000
    // The option is the exact control; the spacing keeps the ages distinct even
    // where a store ignores it, so the ordering claim is never tested on ties.
    store.indexSource('source-old', 'zeta payload in the oldest source', { updatedAt: oldest })
    await new Promise((resolve) => setTimeout(resolve, 25))
    store.indexSource('source-mid', 'zeta payload in the middle source', { updatedAt: middle })
    await new Promise((resolve) => setTimeout(resolve, 25))
    store.indexSource('source-new', 'zeta payload in the newest source', { updatedAt: newest })

    const result = retrieve(deps, { query: 'zeta', limit: 10, temporal: 'historical' })
    const times = result.matches.map((hit) => hit.updatedAt)

    assert.equal(result.temporal.mode, 'historical')
    assert.ok(result.matches.length >= 3, 'all three chunks match')
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index] >= times[index - 1], 'historical order is oldest first')
    }
    assert.equal(new Set(times).size, times.length, 'the corpus must distinguish chunk ages')
    assert.equal(result.matches[0].source, 'source-old', 'the oldest chunk leads')
    assert.ok(result.hints.some((hint) => hint.includes('oldest matching chunk comes first')))
  } finally {
    cleanup()
  }
})

test('the bounded-output guard holds for the largest legal request', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    for (let index = 0; index < 60; index += 1) {
      store.indexSource(`fill-${index}`, `zeta filler ${index} ${'padding words '.repeat(700)}`)
    }
    // The store itself caps a search at 50 hits of at most 2,000 characters
    // each, so the largest legal request is bounded by arithmetic the plugin
    // already owns: 50 x 2,000 = 100,000 characters, well under the ceiling.
    // The guard is a net for a future store change that raises one of those
    // two caps, not something today's numbers can trigger; this test proves the
    // ceiling holds at the maximum rather than proving the net catches a payload
    // the current caps cannot produce.
    const result = retrieve(deps, { query: 'zeta', limit: 50, snippetChars: 2_000 })
    const raw = store.search('zeta', { limit: 50, snippetChars: 2_000 })

    assert.ok(raw.length === 50, `the fixture must fill the store cap (got ${raw.length})`)
    assert.ok(
      measureContext(result) <= CEILING,
      'a maximum-size retrieval must stay under the ceiling',
    )
    assert.equal(result.matches.length, 50, 'no hit is dropped at the legal maximum')
    assert.ok(result.matches.every((hit) => hit.evidenceId.startsWith('ev_')), 'hits stay whole')
    assert.equal(typeof result.quality.overall, 'number', 'quality is never truncated')
  } finally {
    cleanup()
  }
})

test('two identical no-cache retrievals are deeply equal', () => {
  const { store, deps, cleanup } = newDeps()
  try {
    store.indexSource('docs', 'alpha keyword governs the beta decision')
    store.indexSource('notes', 'alpha keyword guides the beta outcome')

    const request = { query: 'keyword', limit: 5, noCache: true }
    const first = retrieve(deps, request)
    const second = retrieve(deps, request)

    assert.deepEqual(first, second)
    assert.equal(first.cache.key, '')
    assert.equal(first.cache.stored, false)
    assert.equal(first.cache.hit, false)
    assert.equal(deps.cache.stats().entries, 0, 'a no-cache retrieval writes nothing')
  } finally {
    cleanup()
  }
})
