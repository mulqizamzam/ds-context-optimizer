import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as provenance from '../../dist/provenance.js'

const {
  boundedEvidenceView,
  buildProvenance,
  clipSnippet,
  contentHash,
  deriveChunkId,
  deriveEvidenceId,
  deriveSourceId,
  isProvenanceStale,
} = provenance

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Emoji as a surrogate pair: two UTF-16 code units, one code point. */
const EMOJI = '\u{1F600}'

const baseRecord = () => ({
  source: 'docs/readme.md',
  sourceType: 'file',
  ordinal: 4,
  contentHash: sha256('beta gamma'),
  indexedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})

test('derived ids follow the documented formulas', () => {
  assert.equal(deriveSourceId('a'), `src_${sha256('a').slice(0, 16)}`)
  assert.equal(deriveSourceId('docs'), `src_${sha256('docs').slice(0, 16)}`)
  assert.equal(deriveChunkId('src_x', 3), 'src_x:3')
  assert.equal(deriveEvidenceId('src_x', 3), `ev_${sha256('src_x|3').slice(0, 16)}`)
})

test('derived ids are stable across repeated calls', () => {
  assert.equal(deriveSourceId('docs'), deriveSourceId('docs'))
  assert.equal(deriveChunkId(deriveSourceId('docs'), 7), deriveChunkId(deriveSourceId('docs'), 7))
  assert.equal(deriveEvidenceId(deriveSourceId('docs'), 7), deriveEvidenceId(deriveSourceId('docs'), 7))
})

test('derived ids are stable across separate module instances', async () => {
  const second = await import('../../dist/provenance.js?instance=second')
  assert.notEqual(second, provenance)
  assert.equal(second.deriveSourceId('docs'), deriveSourceId('docs'))
  assert.equal(second.deriveChunkId('src_x', 3), 'src_x:3')
  assert.equal(
    second.deriveEvidenceId(deriveSourceId('docs'), 4),
    deriveEvidenceId(deriveSourceId('docs'), 4),
  )
  assert.equal(second.contentHash('alpha'), contentHash('alpha'))
})

test('an empty source name still yields a well-formed id', () => {
  const sourceId = deriveSourceId('')
  assert.match(sourceId, /^src_[0-9a-f]{16}$/)
  assert.equal(sourceId, `src_${sha256('').slice(0, 16)}`)
  assert.equal(deriveChunkId(sourceId, 0), `${sourceId}:0`)
  assert.match(deriveEvidenceId(sourceId, 0), /^ev_[0-9a-f]{16}$/)
})

test('evidence identity is source plus ordinal and does not move when the text changes', () => {
  const sourceId = deriveSourceId(baseRecord().source)
  const evidenceId = deriveEvidenceId(sourceId, 4)

  assert.equal(evidenceId, deriveEvidenceId(sourceId, 4))
  assert.notEqual(evidenceId, deriveEvidenceId(sourceId, 5))
  assert.notEqual(evidenceId, deriveEvidenceId(deriveSourceId('docs/other.md'), 4))

  // Re-indexed under the same boundaries with different content: same address,
  // new digest. Only the digest, which is what staleness is read from, moves.
  const reindexed = { ...baseRecord(), contentHash: sha256('delta epsilon') }
  assert.equal(deriveEvidenceId(deriveSourceId(reindexed.source), reindexed.ordinal), evidenceId)
  assert.equal(deriveChunkId(deriveSourceId(reindexed.source), reindexed.ordinal), `${sourceId}:4`)
  assert.notEqual(reindexed.contentHash, baseRecord().contentHash)
})

test('contentHash is a stable lowercase sha256 hex digest of the utf8 bytes', () => {
  const digest = contentHash('alpha beta')
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(digest, sha256('alpha beta'))
  assert.equal(digest, contentHash('alpha beta'))
  assert.equal(contentHash(''), sha256(''))
})

test('contentHash changes when a single character changes', () => {
  assert.notEqual(contentHash('alpha'), contentHash('alphb'))
  assert.notEqual(contentHash('alpha'), contentHash('alpha '))
})

test('isProvenanceStale compares hashes only and treats a missing live hash as unknown', () => {
  const record = { contentHash: sha256('alpha') }
  assert.equal(isProvenanceStale(record, record.contentHash), false)
  assert.equal(isProvenanceStale(record, sha256('beta')), true)
  assert.equal(isProvenanceStale(record, ''), false)
  assert.equal(isProvenanceStale(record, undefined), false)
})

test('buildProvenance copies the required fields verbatim', () => {
  const record = baseRecord()
  const built = buildProvenance(record)
  assert.equal(built.source, record.source)
  assert.equal(built.sourceType, record.sourceType)
  assert.equal(built.contentHash, record.contentHash)
  assert.equal(built.indexedAt, record.indexedAt)
  assert.equal(built.updatedAt, record.updatedAt)
})

test('buildProvenance omits every optional field it was not given', () => {
  const built = buildProvenance(baseRecord())
  for (const key of ['pathOrUrl', 'lineStart', 'lineEnd', 'command', 'sessionId', 'eventId']) {
    assert.equal(key in built, false, `unexpected key ${key}`)
  }
  assert.deepEqual(Object.keys(built).sort(), [
    'contentHash',
    'indexedAt',
    'source',
    'sourceType',
    'updatedAt',
  ])
})

test('buildProvenance keeps optional metadata it was given and invents nothing else', () => {
  const built = buildProvenance({
    ...baseRecord(),
    pathOrUrl: 'docs/readme.md',
    lineStart: 12,
    lineEnd: 40,
    command: 'git log --oneline',
    sessionId: 'sess-1',
    eventId: 'evt-9',
  })
  assert.deepEqual(Object.keys(built).sort(), [
    'command',
    'contentHash',
    'eventId',
    'indexedAt',
    'lineEnd',
    'lineStart',
    'pathOrUrl',
    'sessionId',
    'source',
    'sourceType',
    'updatedAt',
  ])
  assert.equal(built.pathOrUrl, 'docs/readme.md')
  assert.equal(built.lineStart, 12)
  assert.equal(built.lineEnd, 40)
  assert.equal(built.command, 'git log --oneline')
  assert.equal(built.sessionId, 'sess-1')
  assert.equal(built.eventId, 'evt-9')
})

test('buildProvenance drops line numbers it cannot trust', () => {
  for (const bad of [-1, -40, Number.NaN, Number.POSITIVE_INFINITY, '12', null]) {
    assert.equal('lineStart' in buildProvenance({ ...baseRecord(), lineStart: bad }), false,
      `lineStart=${String(bad)} must not be emitted`)
    assert.equal('lineEnd' in buildProvenance({ ...baseRecord(), lineEnd: bad }), false,
      `lineEnd=${String(bad)} must not be emitted`)
  }
  // Zero is a measurement, not a missing value, so it survives.
  const zero = buildProvenance({ ...baseRecord(), lineStart: 0 })
  assert.equal('lineStart' in zero, true)
  assert.equal(zero.lineStart, 0)
})

test('clipSnippet never exceeds the budget', () => {
  assert.equal(clipSnippet('', 10), '')
  assert.equal(clipSnippet('abcdef', 3), 'abc')
  assert.equal(clipSnippet('abcdef', 6), 'abcdef')
  assert.equal(clipSnippet('abcdef', 99), 'abcdef')
  for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(clipSnippet('abcdef', budget), '', `budget ${budget} must clip to nothing`)
  }
})

test('clipSnippet does not split a surrogate pair', () => {
  assert.equal(EMOJI.length, 2)
  assert.equal(clipSnippet(EMOJI, 2), EMOJI)
  // 'a😀b' is four UTF-16 units, so the cut at three lands after the pair.
  assert.equal(clipSnippet(`a${EMOJI}b`, 3), `a${EMOJI}`)
  // A cut that lands inside the pair drops the lead half instead of keeping it.
  assert.equal(clipSnippet(`a${EMOJI}b`, 2), 'a')
  assert.equal(clipSnippet(`a${EMOJI}b`, 1), 'a')
  assert.equal(clipSnippet(EMOJI, 1), '')
  assert.equal(clipSnippet(`${EMOJI}z`, 1), '')
  for (const budget of [1, 2, 3, 4, 5]) {
    const clipped = clipSnippet(`a${EMOJI}b`, budget)
    assert.ok(clipped.length <= budget)
    // Re-encoding must be lossless: a lone lead surrogate would come back as
    // U+FFFD, which changes bytes and therefore would change any hash taken of
    // the clipped text.
    assert.equal(Buffer.from(clipped, 'utf8').toString('utf8'), clipped,
      `budget ${budget} produced an unencodable clip`)
  }
})

test('boundedEvidenceView bounds the snippet and keeps the provenance answers', () => {
  const record = { ...baseRecord(), pathOrUrl: 'docs/readme.md', lineStart: 3, lineEnd: 9 }
  const text = 'needle '.repeat(200)
  const view = boundedEvidenceView(record, text, 25)

  assert.ok(view.snippet.length <= 25)
  assert.equal(view.snippet, clipSnippet(text, 25))

  const sourceId = deriveSourceId(record.source)
  assert.equal(view.sourceId, sourceId)
  assert.equal(view.chunkId, `${sourceId}:${record.ordinal}`)
  assert.equal(view.evidenceId, deriveEvidenceId(sourceId, record.ordinal))
  assert.equal(view.source, record.source)
  assert.equal(view.ordinal, record.ordinal)

  assert.equal(view.provenance.source, record.source)
  assert.equal(view.provenance.sourceType, record.sourceType)
  assert.equal(view.provenance.pathOrUrl, 'docs/readme.md')
  assert.equal(view.provenance.lineStart, 3)
  assert.equal(view.provenance.lineEnd, 9)
  assert.equal(view.provenance.contentHash, record.contentHash)
  assert.equal(view.provenance.indexedAt, record.indexedAt)
  assert.equal(view.provenance.updatedAt, record.updatedAt)

  // No live digest is supplied, so staleness is unknown — never asserted.
  assert.equal(view.stale, false)
})

test('the module imports nothing but node:crypto', () => {
  const compiled = fs.readFileSync(new URL('../../dist/provenance.js', import.meta.url), 'utf8')
  const imports = compiled.match(/^import\s.*$/gm) ?? []
  assert.ok(imports.length >= 1, 'expected at least one import statement')
  for (const statement of imports) {
    const source = /from\s+["']([^"']+)["']/.exec(statement)
    assert.ok(source !== null, `cannot read module source from: ${statement}`)
    assert.equal(source[1], 'node:crypto')
  }
})
