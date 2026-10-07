import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ContentStore, toMatchExpression } from '../../dist/store.js'

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-store-'))
  const store = new ContentStore(path.join(dir, 'index.sqlite'))
  return { dir, store, file: path.join(dir, 'index.sqlite'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

test('FTS5 ranking returns the chunk containing the term', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('docs', 'alpha beta gamma\n\ndelta epsilon zeta')
    const hits = store.search('epsilon', { limit: 5 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].source, 'docs')
    assert.ok(hits[0].snippet.includes('epsilon'))
  } finally {
    cleanup()
  }
})

test('a query matching nothing returns no hits rather than every chunk', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('docs', 'alpha beta gamma')
    assert.deepEqual(store.search('nonexistentterm', { limit: 5 }), [])
  } finally {
    cleanup()
  }
})

test('reindexing a source replaces its old chunks', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('log', 'the old needle appears once')
    store.indexSource('log', 'fresh content only')
    assert.deepEqual(store.search('needle', { limit: 5 }), [])
    assert.equal(store.search('fresh', { limit: 5 }).length, 1)
  } finally {
    cleanup()
  }
})

test('source scoping excludes hits from other sources', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('a', 'shared keyword here')
    store.indexSource('b', 'shared keyword there')
    const all = store.search('keyword', { limit: 10 })
    const scoped = store.search('keyword', { limit: 10, source: 'b' })
    assert.equal(all.length, 2)
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].source, 'b')
  } finally {
    cleanup()
  }
})

test('the corpus survives reopening the store from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-persist-'))
  const file = path.join(dir, 'index.sqlite')
  try {
    const first = new ContentStore(file)
    first.indexSource('docs', 'persistent needle content')
    first.close()

    const second = new ContentStore(file)
    const hits = second.search('needle', { limit: 5 })
    assert.equal(hits.length, 1)
    assert.ok(second.stats().chunks >= 1)
    second.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('FTS5 syntax in the query is neutralised instead of raising a parse error', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('docs', 'path/to/file and foo-bar and a quote " inside')
    // Each of these is an FTS5 operator in raw form and would raise
    // "fts5: syntax error" if it reached MATCH unquoted.
    for (const query of ['path/to/file', 'foo-bar', 'NEAR(a b)', 'a "quoted" phrase', '*', 'x AND']) {
      assert.doesNotThrow(() => store.search(query, { limit: 5 }), `query ${JSON.stringify(query)} threw`)
    }
  } finally {
    cleanup()
  }
})

test('a query with no usable terms yields no MATCH expression', () => {
  assert.equal(toMatchExpression('   '), null)
  assert.equal(toMatchExpression('!!! ///'), null)
  assert.equal(toMatchExpression('root cause'), '"root" OR "cause"')
})

test('purge clears chunks and sources', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('a', 'one two three')
    store.indexSource('b', 'four five six')
    const before = store.purge()
    assert.ok(before.chunks >= 2)
    assert.equal(before.sources, 2)
    assert.equal(store.stats().chunks, 0)
    assert.equal(store.stats().sources, 0)
  } finally {
    cleanup()
  }
})

test('empty text indexes nothing instead of creating a phantom chunk', () => {
  const { store, cleanup } = newStore()
  try {
    const result = store.indexSource('empty', '')
    assert.equal(result.chunks, 0)
    // A source that captured nothing is not reported as a source.
    assert.equal(store.stats().chunks, 0)
    assert.equal(store.stats().sources, 0)
  } finally {
    cleanup()
  }
})

test('an empty replace cannot destroy the previous index for the same source', () => {
  const { store, cleanup } = newStore()
  try {
    const first = store.indexSource('log', 'the old needle appears once')
    assert.deepEqual({ chunks: first.chunks, applied: first.applied }, { chunks: 1, applied: true })

    // An empty body is what a walk that found nothing hands over: a path that
    // does not exist, a tree whose files are all excluded, or one re-pointing
    // an existing `source` label at a different directory. It must be refused
    // before the delete, not become a committed delete of healthy content.
    const refused = store.indexSource('log', '')
    assert.equal(refused.applied, false, 'an empty body claimed to have written something')
    assert.equal(refused.chunks, 1, 'the refused call did not report the retained corpus')

    // The invariant itself: the old content is still searchable afterwards.
    const hits = store.search('needle', { limit: 5 })
    assert.equal(hits.length, 1, 'an empty replace deleted the previous index')
    assert.equal(hits[0].source, 'log')
    const stats = store.stats()
    assert.equal(stats.sources, 1, 'an empty replace dropped the source row')
    assert.equal(stats.chunks, 1, 'an empty replace dropped the stored chunks')

    // And a real body still replaces it — the guard is not a lock-in.
    store.indexSource('log', 'fresh content only')
    assert.equal(store.search('needle', { limit: 5 }).length, 0)
    assert.equal(store.search('fresh', { limit: 5 }).length, 1)
  } finally {
    cleanup()
  }
})

test('limit is clamped so a caller cannot ask for the whole corpus', () => {
  const { store, cleanup } = newStore()
  try {
    for (let i = 0; i < 80; i += 1) store.indexSource(`src-${i}`, `common token in source ${i}`)
    assert.ok(store.search('common', { limit: 10_000 }).length <= 50)
  } finally {
    cleanup()
  }
})

test('the reported disk size tracks the database file, not an in-memory tally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-store-'))
  const file = path.join(dir, 'index.sqlite')
  try {
    const store = new ContentStore(file)
    store.indexSource('docs', 'body text '.repeat(5_000))
    const stats = store.stats()
    assert.ok(stats.bytes > 0, 'a store with content reported zero bytes on disk')
    assert.equal(stats.sources, 1)
    assert.ok(stats.chunks >= 1)
    store.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the reported disk size includes the write-ahead log, not only the main file', () => {
  const { file, store, cleanup } = newStore()
  try {
    store.indexSource('docs', 'wal filler text '.repeat(12_000))
    const main = sizeOf(file)
    const wal = sizeOf(`${file}-wal`)
    assert.ok(wal > 0, 'WAL mode must leave an uncheckpointed log behind a write')

    const live = store.stats()
    // The assertion is an equality with the measured files, not "> 0": an empty
    // 4,096-byte database satisfies "> 0" while still ignoring the log that
    // holds every committed page.
    assert.equal(live.disk.file, main)
    assert.equal(live.disk.wal, wal)
    assert.equal(live.bytes, main + wal + live.disk.shm)
    assert.ok(live.bytes >= main + wal, 'the reported size ignored the WAL')
    assert.ok(live.bytes >= main, 'the reported size is smaller than the main file')
    store.close()

    // After close the log is checkpointed away; the figure must stay at least
    // as honest as the file that now holds the same content.
    const reopened = new ContentStore(file)
    const after = reopened.stats()
    assert.equal(after.bytes, after.disk.file + after.disk.wal + after.disk.shm)
    assert.ok(after.bytes >= sizeOf(file))
    assert.ok(
      live.bytes > after.bytes,
      `the pre-close total (${live.bytes}) should exceed the post-checkpoint total (${after.bytes})`,
    )
    reopened.close()
  } finally {
    cleanup()
  }
})

test('a write that fails part way through is rolled back whole, and the lock race cannot win', () => {
  const { file, store, cleanup } = newStore()
  const rival = new DatabaseSync(file)
  try {
    store.indexSource('log', 'the old needle appears once')

    // Two failures, because there are two ways for a replace to go wrong.
    //
    // 1. Forced inside the transaction: the same step order `indexSource` uses,
    //    with a throw after the delete. Before the fix the delete and the
    //    insert were separate autocommitted statements, so this state — old
    //    chunks gone, new ones written, source row never upserted — is exactly
    //    what a mid-replace failure left behind.
    const staged = (() => {
      try {
        store.transaction(() => {
          store.removeSource('log')
          store.add('log', 'the new body that must not land')
          throw new Error('forced failure between delete and insert')
        })
        return undefined
      } catch (error) {
        return error
      }
    })()

    assert.match(String(staged), /forced failure between delete and insert/)
    assert.equal(store.search('needle', { limit: 5 }).length, 1, 'the previous index did not survive')
    assert.equal(store.search('body', { limit: 5 }).length, 0, 'the aborted write stayed')
    assert.equal(store.stats().sources, 1)
    assert.equal(store.stats().chunks, 1)

    // 2. A competing writer holding the write lock, as the bug report measured
    //    (`indexSource threw: Error: database is locked`). The replace must be
    //    refused without touching anything: with the delete committed as its
    //    own statement before the insert's transaction, a lock landing in
    //    between stranded the source with `sources: 0, chunks: 0`.
    rival.exec('BEGIN IMMEDIATE')
    assert.throws(() => store.indexSource('log', 'raced away by another writer'), /locked/)
    assert.equal(store.search('needle', { limit: 5 }).length, 1, 'the old content was lost to the lock race')
    assert.equal(store.search('body', { limit: 5 }).length, 0, 'the refused replace half-landed')
    assert.equal(store.stats().sources, 1)
    assert.equal(store.stats().chunks, 1)
    rival.exec('ROLLBACK')

    // The failed attempts must not leave the store locked out of the next one.
    assert.equal(store.indexSource('log', 'fresh content only').chunks, 1)
    assert.equal(store.search('needle', { limit: 5 }).length, 0)
    assert.equal(store.search('fresh', { limit: 5 }).length, 1)
  } finally {
    try {
      rival.exec('ROLLBACK')
    } catch {
      /* the rival never took the lock, or it is already gone */
    }
    rival.close()
    cleanup()
  }
})

test('a replace that fails after deleting the old chunks still restores them', () => {
  const { file, store, cleanup } = newStore()
  const rival = new DatabaseSync(file)
  try {
    store.indexSource('log', 'the old needle appears once')

    // Force the last statement of the replace — the `sources` upsert — to
    // abort, i.e. a failure inside the transaction after the delete and the
    // insert have both executed. With the two steps committed separately
    // (removeSource, then add's own BEGIN), this left `sources: 0, chunks: 0`
    // with the old content permanently gone.
    rival.exec(`
      CREATE TRIGGER fail_replace BEFORE INSERT ON sources
      BEGIN SELECT RAISE(ABORT, 'forced failure inside the replace'); END;
    `)
    assert.throws(() => store.indexSource('log', 'the new body that must not land'), /forced failure/)

    assert.equal(store.search('needle', { limit: 5 }).length, 1, 'the old content was not rolled back')
    assert.equal(store.search('body', { limit: 5 }).length, 0, 'the new content survived a failed replace')
    const stats = store.stats()
    assert.equal(stats.sources, 1, 'the source row survived the failed replace')
    assert.equal(stats.chunks, 1)

    // The failed attempt must not leave the store locked out of the next one.
    rival.exec('DROP TRIGGER fail_replace')
    const replaced = store.indexSource('log', 'fresh content only')
    assert.equal(replaced.chunks, 1)
    assert.equal(store.search('needle', { limit: 5 }).length, 0)
    assert.equal(store.search('fresh', { limit: 5 }).length, 1)
  } finally {
    rival.close()
    cleanup()
  }
})

test('the snippet budget is a character count, not an FTS5 token count', () => {
  const { store, cleanup } = newStore()
  try {
    // ~5,000 characters of one-word tokens. `snippet()` counts its budget in
    // tokens, so passing `snippetChars` straight through returned 324
    // characters when the caller asked for 64.
    store.indexSource('docs', `needle ${Array.from({ length: 600 }, (_, i) => `token${i}`).join(' ')}`)
    for (const chars of [64, 120, 240, 500]) {
      const hits = store.search('needle', { limit: 1, snippetChars: chars })
      assert.equal(hits.length, 1)
      const snippet = hits[0].snippet
      assert.ok(snippet.length <= chars, `snippetChars=${chars} returned ${snippet.length} chars`)
      assert.ok(snippet.includes('needle'), 'the matched term dropped out of its own excerpt')
      const opens = snippet.split('»').length - 1
      const closes = snippet.split('«').length - 1
      assert.equal(opens, closes, `highlight markers unbalanced after clipping: ${snippet}`)
    }
  } finally {
    cleanup()
  }
})

test('a zero or negative snippet budget falls back instead of returning everything', () => {
  const { store, cleanup } = newStore()
  try {
    store.indexSource('docs', `needle ${Array.from({ length: 900 }, (_, i) => `token${i}`).join(' ')}`)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const hits = store.search('needle', { limit: 1, snippetChars: bad })
      assert.equal(hits.length, 1, `snippetChars=${bad} returned no hit`)
      assert.ok(
        hits[0].snippet.length <= 240,
        `snippetChars=${bad} produced ${hits[0].snippet.length} chars; 0/negative must not mean "unlimited"`,
      )
      assert.ok(hits[0].snippet.length > 0)
    }
  } finally {
    cleanup()
  }
})