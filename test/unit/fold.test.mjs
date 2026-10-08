import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_EXPANSION_CHARS,
  clipToBudget,
  foldToLevel,
  parseExpansionRef,
  selectExcerpts,
  semanticSummary,
  structuralSummary,
} from '../../dist/fold.js'

const META = {
  sourceId: 'src_0123456789abcdef',
  source: 'notes.md',
  sourceType: 'file',
  sourceName: 'notes.md',
  chunks: 3,
  charLen: 120,
  indexedAt: 1700000000000,
  updatedAt: 1700000000001,
  pathOrUrl: '/repo/notes.md',
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u

function bigBody(lines, width) {
  return Array.from({ length: lines }, (_, index) => `line ${index} ${'x'.repeat(width)}`).join('\n')
}

test('parseExpansionRef accepts only the two exact id shapes', () => {
  assert.deepEqual(parseExpansionRef('ev_0123456789abcdef'), {
    kind: 'evidence',
    id: 'ev_0123456789abcdef',
  })
  assert.deepEqual(parseExpansionRef('src_0123456789abcdef'), {
    kind: 'source',
    id: 'src_0123456789abcdef',
  })
  const rejected = [
    '../../etc/passwd',
    '/etc/passwd',
    'C:\\Windows\\x',
    'https://example.com',
    '',
    'ev_',
    'ev_abc',
    'ev_0123456789abcdefa',
    'ev_0123456789ABCDEF',
    'EV_0123456789abcdef',
    'SRC_0123456789abcdef',
    'src_0123456789abcde',
    'ev_0123456789abcdef ',
    ' ev_0123456789abcdef',
    'ev_0123456789abcdeg',
    42,
    null,
    undefined,
    {},
    ['ev_0123456789abcdef'],
  ]
  for (const raw of rejected) {
    assert.equal(parseExpansionRef(raw), null, `expected null for ${JSON.stringify(raw)}`)
  }
})

test('clipToBudget is bounded, surrogate-safe and total', () => {
  assert.equal(clipToBudget('hello world', 5).text, 'hello')
  assert.equal(clipToBudget('hello world', 5).truncated, true)
  assert.equal(clipToBudget('hello', 99).text, 'hello')
  assert.equal(clipToBudget('hello', 99).truncated, false)
  for (const budget of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(clipToBudget('hello', budget).text, '')
    assert.equal(clipToBudget('hello', budget).truncated, true)
  }
  const marked = 'a\uD83D\uDE00b'
  assert.equal(clipToBudget(marked, 2).text, 'a')
  assert.equal(clipToBudget(marked, 3).text, 'a\uD83D\uDE00')
  assert.equal(clipToBudget(marked, 9).text, marked)
  assert.equal(clipToBudget('\uD83D\uDE00\uD83D\uDE00\uD83D\uDE00', 3).text, '\uD83D\uDE00')
  for (const budget of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(LONE_SURROGATE.test(clipToBudget('\uD83D\uDE00\uD83D\uDE00', budget).text), false)
  }
  for (const budget of [0, 1, 2, 3, 40]) {
    assert.equal(clipToBudget('', budget).text, '')
  }
})

test('L0 carries identity only and never body bytes', () => {
  const body = 'ZZMARKERZZ\nsecret body line\nsecond body line'
  const payload = foldToLevel(META, body, 0, 4096)
  assert.equal(payload.level, 0)
  assert.equal(payload.charLen, body.length)
  assert.equal(payload.truncated, false)
  assert.equal(payload.text.includes('ZZMARKERZZ'), false)
  assert.equal(payload.text.includes('secret body'), false)
  assert.ok(payload.text.includes('src_0123456789abcdef'))
  assert.ok(payload.text.includes('chunks 3'))
  assert.ok(payload.text.includes('indexed 1700000000000'))
  assert.ok(payload.text.includes('at /repo/notes.md'))
  assert.ok(payload.text.length <= MAX_EXPANSION_CHARS)
})

test('L1 is a bounded structural inventory', () => {
  const body = bigBody(5000, 100)
  const payload = foldToLevel(META, body, 1, 4096)
  assert.equal(payload.level, 1)
  assert.equal(payload.charLen, body.length)
  assert.ok(payload.text.startsWith('lines 5000 '))
  assert.ok(payload.text.includes('1|line 0 '))
  assert.ok(payload.text.includes('+4976 more lines'))
  assert.ok(payload.text.length < MAX_EXPANSION_CHARS)
  assert.ok(payload.text.length < body.length)
  assert.ok(structuralSummary(body, 200).length <= 200)
  const clamped = structuralSummary(body, 10)
  assert.equal(clamped.length, 10)
  assert.ok(clamped.startsWith('lines 5000'))
  assert.equal(structuralSummary('', 4096).startsWith('lines 0 '), true)
})

test('L2 is a deterministic extractive summary', () => {
  const body = [
    '# Release notes',
    'Fixed the fold budget clamp so a caller cannot ask for the whole corpus.',
    'ok',
    'plain words with signal carried but no marker at all in this line',
    '',
    'TODO: revisit the surrogate clip rule',
  ].join('\n')
  const first = semanticSummary(body, 4096)
  assert.equal(first, semanticSummary(body, 4096))
  assert.ok(first.includes('Release notes'))
  assert.ok(first.includes('TODO: revisit the surrogate clip rule'))
  assert.equal(first.includes('|ok'), false)
  assert.ok(semanticSummary(body, 40).length <= 40)
  const payload = foldToLevel(META, body, 2, 4096)
  assert.equal(payload.level, 2)
  assert.equal(payload.text, first)
  assert.equal(semanticSummary('', 4096), '')
  const hundred = 'y'.repeat(10000)
  assert.ok(semanticSummary(hundred, 4096).length <= 4096)
})

test('L3 returns term excerpts, never the whole body', () => {
  const body = bigBody(4000, 60)
  const payload = foldToLevel(META, body, 3, 4096)
  assert.equal(payload.level, 3)
  assert.equal(payload.charLen, body.length)
  assert.equal(payload.truncated, true)
  assert.ok(payload.text.length <= MAX_EXPANSION_CHARS)
  assert.ok(payload.text.length < body.length)
  const hit = selectExcerpts(body, ['line 3999'], 300)
  assert.equal(hit.length, 1)
  assert.ok(hit[0].includes('line 3999'))
  for (const excerpt of hit) assert.ok(excerpt.length <= 300)
  const head = selectExcerpts(body, [], 500)
  assert.ok(head.length > 0)
  assert.ok(head.length <= 40)
  for (const excerpt of head) assert.ok(excerpt.length <= 500)
  assert.equal(selectExcerpts(body, ['no such term here'], 500).length, 0)
})

test('L4 raw stays clipped to the budget and the ceiling', () => {
  const body = 'x'.repeat(10000)
  const full = foldToLevel(META, body, 4, MAX_EXPANSION_CHARS)
  assert.equal(full.text.length, MAX_EXPANSION_CHARS)
  assert.equal(full.text, 'x'.repeat(MAX_EXPANSION_CHARS))
  assert.equal(full.truncated, true)
  assert.equal(full.charLen, 10000)
  const small = foldToLevel(META, body, 4, 100)
  assert.equal(small.text.length, 100)
  assert.equal(small.truncated, true)
  const greedy = foldToLevel(META, body, 4, 1000000)
  assert.equal(greedy.text.length, MAX_EXPANSION_CHARS)
  assert.equal(greedy.truncated, true)
  const short = foldToLevel(META, 'tiny body', 4, 4096)
  assert.equal(short.text, 'tiny body')
  assert.equal(short.truncated, false)
})

test('selectExcerpts is empty for empty input and bounded per item', () => {
  assert.deepEqual(selectExcerpts('', ['anything'], 100), [])
  assert.deepEqual(selectExcerpts('', [], 100), [])
  assert.deepEqual(selectExcerpts('body text', ['term'], 0), [])
  const one = selectExcerpts('single line body', [], 4)
  assert.equal(one.length, 1)
  assert.equal(one[0], 'sing')
  const many = selectExcerpts(['alpha term beta', 'gamma term delta', 'epsilon'].join('\n'), ['term'], 30)
  assert.equal(many.length, 2)
  assert.ok(many[0].includes('term'))
  assert.ok(many[1].includes('term'))
  for (const excerpt of many) assert.ok(excerpt.length <= 30)
  assert.equal(many.join('\n').length, 30)
})

test('every entry point is pure over repeated calls', () => {
  const body = bigBody(50, 40)
  for (const level of [0, 1, 2, 3, 4]) {
    assert.deepEqual(foldToLevel(META, body, level, 4096), foldToLevel(META, body, level, 4096))
  }
  assert.deepEqual(selectExcerpts(body, ['line 7'], 200), selectExcerpts(body, ['line 7'], 200))
  assert.equal(structuralSummary(body, 300), structuralSummary(body, 300))
  assert.equal(semanticSummary(body, 300), semanticSummary(body, 300))
})

test('every level is total on hostile text and hostile budgets', () => {
  const hostile = [
    '',
    'x'.repeat(10000),
    '\u0000\u0001\u0002 control \u007f \r\n',
    'héllo → 世界 😀 mix',
    '\uD83D\uDE00'.repeat(3000),
  ]
  const budgets = [0, 1, 7, 4096, NaN, -3, Infinity]
  for (const text of hostile) {
    for (const level of [0, 1, 2, 3, 4]) {
      for (const budget of budgets) {
        const payload = foldToLevel(META, text, level, budget)
        assert.ok(payload.text.length <= MAX_EXPANSION_CHARS, `level ${level} over ceiling`)
        if (Number.isFinite(budget) && budget >= 1) {
          assert.ok(payload.text.length <= budget, `level ${level} over budget ${budget}`)
        } else if (Number.isFinite(budget)) {
          assert.equal(payload.text, '', `budget ${budget} should yield nothing`)
        }
        assert.equal(payload.charLen, text.length)
        assert.equal(payload.level, level)
        assert.equal(LONE_SURROGATE.test(payload.text), false)
      }
    }
  }
})
