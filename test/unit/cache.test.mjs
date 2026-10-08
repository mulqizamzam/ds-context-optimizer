import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { RetrievalCache, cacheKey, canonicalize, MAX_PAYLOAD_CHARS } from '../../dist/cache.js'

function newCache(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-cache-'))
  const file = path.join(dir, 'cache.sqlite')
  const db = new DatabaseSync(file)
  const cache = new RetrievalCache(db, {
    enabled: true,
    ttlMs: 60_000,
    maxEntries: 100,
    ...config,
  })
  return {
    dir,
    file,
    db,
    cache,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function rawInsert(db, key, payload, expiresAt) {
  db
    .prepare(
      `INSERT INTO retrieval_cache(key, corpus_version, payload, created_at, expires_at, hits)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(key, 1, payload, 1_700_000_000_000, expiresAt, 0)
}

test('a stored value is served back by get', () => {
  const { cache, cleanup } = newCache()
  try {
    const key = cacheKey({ query: 'wal pragma', corpusVersion: 3, limit: 5, ranking: 'bm25' })
    assert.equal(cache.set(key, { hits: [{ source: 'docs', ordinal: 2 }] }, 3), true)
    const stored = cache.get(key)
    assert.equal(stored.hit, true)
    assert.deepEqual(stored.value, { hits: [{ source: 'docs', ordinal: 2 }] })
    const stats = cache.stats()
    assert.equal(stats.hits, 1)
    assert.equal(stats.misses, 0)
    assert.equal(stats.entries, 1)
  } finally {
    cleanup()
  }
})

test('an unknown key is a miss', () => {
  const { cache, cleanup } = newCache()
  try {
    const miss = cache.get('never-written')
    assert.equal(miss.hit, false)
    assert.equal(cache.stats().misses, 1)
    assert.equal(cache.stats().hits, 0)
  } finally {
    cleanup()
  }
})

test('a row whose TTL has passed is a miss', () => {
  const { cache, cleanup } = newCache({ ttlMs: 1_000 })
  try {
    cache.set('k', { v: 1 }, 1)
    assert.equal(cache.prune(Date.now() + 1_001), 1)
    assert.equal(cache.get('k').hit, false)
    assert.equal(cache.get('k').hit, false)
  } finally {
    cleanup()
  }
})

test('a non-positive ttlMs never expires', () => {
  const { cache, cleanup } = newCache({ ttlMs: 0 })
  try {
    cache.set('forever', { v: 1 }, 1)
    assert.equal(cache.prune(Date.now() + 10 ** 15), 0)
    assert.equal(cache.get('forever').hit, true)
  } finally {
    cleanup()
  }
})

test('canonicalize is key-order independent and never runs a method on the input', () => {
  assert.equal(
    canonicalize({ b: 1, a: { d: 4, c: [3, 1, 2] } }),
    canonicalize({ a: { c: [3, 1, 2], d: 4 }, b: 1 }),
  )
  assert.equal(canonicalize({}), '{}')
  assert.equal(canonicalize(null), 'null')
  assert.equal(canonicalize(undefined), 'null')
  assert.equal(canonicalize([undefined, 1, 'a']), '[null,1,"a"]')

  const hostile = {
    toJSON() {
      throw new Error('must not run')
    },
    deep: { z: 1, a: [3, { q: 1, p: 2 }] },
  }
  assert.equal(
    canonicalize(hostile),
    '{"deep":{"a":[3,{"p":2,"q":1}],"z":1},"toJSON":null}',
  )

  const cyclic = { self: null }
  cyclic.self = cyclic
  assert.doesNotThrow(() => canonicalize(cyclic))
})

test('cacheKey is stable and changes when limit, sort, source, ranking or filters change', () => {
  const base = { query: 'alpha', corpusVersion: 7, limit: 10, ranking: 'bm25' }
  const key = cacheKey(base)
  assert.match(key, /^q_[0-9a-f]{32}$/)
  assert.equal(key, cacheKey(base))
  assert.equal(key, cacheKey({ ...base }))

  assert.notEqual(key, cacheKey({ ...base, limit: 11 }))
  assert.notEqual(key, cacheKey({ ...base, sort: 'timeline' }))
  assert.notEqual(key, cacheKey({ ...base, source: 'docs' }))
  assert.notEqual(key, cacheKey({ ...base, ranking: 'recency' }))
  assert.notEqual(key, cacheKey({ ...base, corpusVersion: 8 }))
  assert.notEqual(key, cacheKey({ ...base, filters: { source: 'docs', tags: ['a', 'b'] } }))
  assert.notEqual(
    cacheKey({ ...base, filters: { source: 'docs', tags: ['a', 'b'] } }),
    cacheKey({ ...base, filters: { source: 'docs', tags: ['a', 'c'] } }),
  )
  // Filter key order carries no meaning, so it must not change the key.
  assert.equal(
    cacheKey({ ...base, filters: { source: 'docs', tags: ['a', 'b'] } }),
    cacheKey({ ...base, filters: { tags: ['a', 'b'], source: 'docs' } }),
  )
})

test('cacheKey is byte-identical across repeated calls in one run', () => {
  const parts = { query: 'alpha', corpusVersion: 7, limit: 10, ranking: 'bm25', source: 'docs' }
  const first = cacheKey(parts)
  for (let i = 0; i < 5; i += 1) {
    assert.equal(cacheKey(parts), first)
  }
  assert.equal(cacheKey(parts), cacheKey(parts))
})

test('invalidateCorpus drops every row of another corpus version', () => {
  const { cache, cleanup } = newCache()
  try {
    const v1 = cacheKey({ query: 'q', corpusVersion: 1, limit: 5, ranking: 'bm25' })
    const v2 = cacheKey({ query: 'q', corpusVersion: 2, limit: 5, ranking: 'bm25' })
    assert.equal(cache.set(v1, { v: 1 }, 1), true)
    assert.equal(cache.set(v2, { v: 2 }, 2), true)
    assert.equal(cache.invalidateCorpus(2), 1)
    assert.equal(cache.get(v1).hit, false)
    assert.equal(cache.get(v2).hit, true)
    assert.equal(cache.stats().entries, 1)
  } finally {
    cleanup()
  }
})

test('the row cap evicts the oldest rows and counts each eviction', () => {
  const { cache, cleanup } = newCache({ maxEntries: 3 })
  try {
    const extra = 5
    for (let i = 0; i < 3 + extra; i += 1) {
      assert.equal(cache.set(`k${i}`, { i }, 1), true)
    }
    const stats = cache.stats()
    assert.ok(stats.entries <= 3)
    assert.ok(stats.evictions >= extra)
    // created_at ties fall to key order, so which rows survive is deterministic.
    assert.equal(cache.get('k7').hit, true)
    assert.equal(cache.get('k5').hit, true)
    assert.equal(cache.get('k4').hit, false)
    assert.equal(cache.get('k0').hit, false)
  } finally {
    cleanup()
  }
})

test('a non-positive maxEntries stores nothing', () => {
  const { cache, cleanup } = newCache({ maxEntries: 0 })
  try {
    assert.equal(cache.set('k', { v: 1 }, 1), false)
    assert.equal(cache.stats().entries, 0)
  } finally {
    cleanup()
  }
})

test('a disabled cache reads as a miss and writes nothing', () => {
  const { cache, cleanup } = newCache({ enabled: false })
  try {
    assert.equal(cache.set('k', { v: 1 }, 1), false)
    assert.equal(cache.get('k').hit, false)
    assert.equal(cache.stats().entries, 0)
  } finally {
    cleanup()
  }
})

test('a payload past MAX_PAYLOAD_CHARS is refused', () => {
  const { cache, cleanup } = newCache()
  try {
    assert.equal(cache.set('big', { pad: 'x'.repeat(MAX_PAYLOAD_CHARS) }, 1), false)
    assert.equal(cache.stats().entries, 0)
    // The ceiling must not be a blanket refusal of every sizeable value.
    assert.equal(cache.set('small', { pad: 'x'.repeat(64) }, 1), true)
    assert.equal(cache.get('small').hit, true)
  } finally {
    cleanup()
  }
})

test('a corrupted payload row is a miss, is deleted, and does not throw', () => {
  const { db, cache, cleanup } = newCache()
  try {
    rawInsert(db, 'k-corrupt', '{"v":1,"d":', Number.MAX_SAFE_INTEGER)
    // entries comes from the table: the row is there before the read.
    assert.equal(cache.stats().entries, 1)
    assert.doesNotThrow(() => cache.get('k-corrupt'))
    assert.equal(cache.get('k-corrupt').hit, false)
    assert.equal(cache.stats().entries, 0)
  } finally {
    cleanup()
  }
})

test('valid JSON of the wrong shape is a miss, not a hit', () => {
  const { db, cache, cleanup } = newCache()
  try {
    rawInsert(db, 'k-array', '[1,2,3]', Number.MAX_SAFE_INTEGER)
    rawInsert(db, 'k-string', '"just a string"', Number.MAX_SAFE_INTEGER)
    rawInsert(db, 'k-old', '{"version":1,"value":1}', Number.MAX_SAFE_INTEGER)
    assert.equal(cache.get('k-array').hit, false)
    assert.equal(cache.get('k-string').hit, false)
    assert.equal(cache.get('k-old').hit, false)
    assert.equal(cache.stats().entries, 0)
  } finally {
    cleanup()
  }
})

test('a stored null value is served as a hit', () => {
  const { cache, cleanup } = newCache()
  try {
    assert.equal(cache.set('k-null', null, 1), true)
    const stored = cache.get('k-null')
    assert.equal(stored.hit, true)
    assert.equal(stored.value, null)
  } finally {
    cleanup()
  }
})

test('prune reports how many expired rows it removed', () => {
  const { cache, cleanup } = newCache({ ttlMs: 1_000 })
  try {
    cache.set('a', 1, 1)
    cache.set('b', 2, 1)
    const now = Date.now() + 5_000
    assert.equal(cache.prune(now), 2)
    assert.equal(cache.stats().entries, 0)
    assert.equal(cache.stats().expirations, 2)
    assert.equal(cache.prune(now), 0)
  } finally {
    cleanup()
  }
})

test('re-setting a key refreshes its expiry instead of leaving the old one', async () => {
  const { db, cache, cleanup } = newCache({ ttlMs: 60_000 })
  try {
    const rowOf = () =>
      db.prepare('SELECT created_at, expires_at FROM retrieval_cache WHERE key = ?').get('k')
    cache.set('k', { v: 1 }, 1)
    const first = rowOf()
    // Back-to-back sets land in the same millisecond, so a refresh is only
    // observable once real time has passed; 40 ms of margin is far outside the
    // 1 ms clock resolution.
    await new Promise((resolve) => setTimeout(resolve, 40))
    cache.set('k', { v: 2 }, 1)
    const second = rowOf()
    assert.ok(second.created_at > first.created_at)
    // The expiry is recomputed from the new write, not carried over, and the
    // row is upserted rather than duplicated.
    assert.ok(second.expires_at > first.expires_at)
    assert.equal(second.expires_at - second.created_at, 60_000)
    assert.equal(cache.stats().entries, 1)
    assert.deepEqual(cache.get('k').value, { v: 2 })
  } finally {
    cleanup()
  }
})

test('a hit bumps the stored hit counter', () => {
  const { db, cache, cleanup } = newCache()
  try {
    cache.set('k', { v: 1 }, 1)
    cache.get('k')
    cache.get('k')
    const row = db.prepare('SELECT hits FROM retrieval_cache WHERE key = ?').get('k')
    assert.equal(row.hits, 2)
  } finally {
    cleanup()
  }
})

test('reset drops every row and zeroes every counter', () => {
  const { cache, cleanup } = newCache()
  try {
    cache.set('a', 1, 1)
    cache.get('a')
    cache.get('zzz')
    assert.ok(cache.stats().entries > 0)
    cache.reset()
    const stats = cache.stats()
    assert.equal(stats.entries, 0)
    assert.equal(stats.hits, 0)
    assert.equal(stats.misses, 0)
    assert.equal(stats.evictions, 0)
    assert.equal(stats.expirations, 0)
  } finally {
    cleanup()
  }
})

test('stats().entries is read from the table, not from a maintainer tally', () => {
  const { db, cache, cleanup } = newCache()
  try {
    rawInsert(db, 'k-outside', '{"v":1,"d":41}', Number.MAX_SAFE_INTEGER)
    assert.equal(cache.stats().entries, 1)
    db.prepare('DELETE FROM retrieval_cache WHERE key = ?').run('k-outside')
    assert.equal(cache.stats().entries, 0)
  } finally {
    cleanup()
  }
})

test('a database the caller damaged degrades instead of throwing', () => {
  const { db, cache, cleanup } = newCache()
  try {
    db.exec('DROP TABLE retrieval_cache')
    db.exec('CREATE VIEW retrieval_cache AS SELECT 1 AS key')
    assert.doesNotThrow(() => {
      assert.equal(cache.get('anything').hit, false)
      assert.equal(cache.set('anything', { a: 1 }, 1), false)
      assert.equal(cache.invalidateCorpus(1), 0)
      assert.equal(cache.prune(Date.now()), 0)
      cache.reset()
      const entries = cache.stats().entries
      // COUNT(*) is answerable against a view, so the count is the one thing
      // that still reports honestly; it must at least never throw and never go
      // negative, and the cache must not pretend to serve hits from it.
      assert.ok(Number.isFinite(entries))
      assert.ok(entries >= 0)
      assert.equal(cache.get('anything').hit, false)
    })
  } finally {
    cleanup()
  }
})
