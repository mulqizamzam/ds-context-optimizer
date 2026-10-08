import test from 'node:test'
import assert from 'node:assert/strict'

import { extractClaims, detectContradictions } from '../../dist/contradiction.js'

/** The compiled module takes plain contract objects; keep the fixtures minimal. */
const ev = (evidenceId, snippet, source = 'test-source') => ({ evidenceId, source, snippet })

const HIGH_CONFIDENCE = new Set(['high'])

test('a key/value conflict is reported once as high-confidence key-value', () => {
  const results = detectContradictions([ev('ev_a', 'port = 8080'), ev('ev_b', 'port = 3000')])

  assert.equal(results.length, 1)
  const [only] = results
  assert.equal(only.confidence, 'high')
  assert.equal(only.kind, 'key-value')
  assert.equal(only.subject, 'port')
  assert.equal(only.valueA, '8080')
  assert.equal(only.valueB, '3000')
  assert.equal(only.evidenceA.evidenceId, 'ev_a')
  assert.equal(only.evidenceB.evidenceId, 'ev_b')
  assert.ok(only.reason.includes('port'))
})

test('boolean polarity flips are high-confidence boolean', () => {
  const flag = detectContradictions([
    ev('ev_a', 'cacheEnabled = true'),
    ev('ev_b', 'cacheEnabled = false'),
  ])
  assert.equal(flag.length, 1)
  assert.equal(flag[0].confidence, 'high')
  assert.equal(flag[0].kind, 'boolean')
  assert.equal(flag[0].valueA, 'true')
  assert.equal(flag[0].valueB, 'false')

  const prose = detectContradictions([
    ev('ev_a', 'feature X is enabled'),
    ev('ev_b', 'feature X is disabled'),
  ])
  assert.equal(prose.length, 1)
  assert.equal(prose[0].confidence, 'high')
  assert.equal(prose[0].kind, 'boolean')

  const colon = detectContradictions([ev('ev_a', 'verbose: on'), ev('ev_b', 'verbose: off')])
  assert.equal(colon.length, 1)
  assert.equal(colon[0].kind, 'boolean')
  assert.equal(colon[0].confidence, 'high')
})

test('two version literals for one subject are high-confidence version', () => {
  const prefixed = detectContradictions([ev('ev_a', 'api: v1.2.3'), ev('ev_b', 'api: v4.0.0')])
  assert.equal(prefixed.length, 1)
  assert.equal(prefixed[0].confidence, 'high')
  assert.equal(prefixed[0].kind, 'version')
  assert.equal(prefixed[0].subject, 'api')
  assert.equal(prefixed[0].valueA, 'v1.2.3')
  assert.equal(prefixed[0].valueB, 'v4.0.0')

  const bare = detectContradictions([ev('ev_a', 'schema: 1.2'), ev('ev_b', 'schema: 1.3')])
  assert.equal(bare.length, 1)
  assert.equal(bare[0].confidence, 'high')
  assert.equal(bare[0].kind, 'version')
  assert.equal(bare[0].valueA, '1.2')
  assert.equal(bare[0].valueB, '1.3')
})

test('a tabulated exclusive alternative is only likely, never high', () => {
  const auth = detectContradictions([
    ev('ev_a', 'authentication: jwt'),
    ev('ev_b', 'authentication: session-cookie'),
  ])
  assert.equal(auth.length, 1)
  assert.equal(auth[0].confidence, 'likely')
  assert.equal(auth[0].kind, 'exclusive')
  assert.equal(auth[0].subject, 'authentication')
  assert.equal(auth[0].valueA, 'jwt')
  assert.equal(auth[0].valueB, 'session-cookie')
  assert.ok(!HIGH_CONFIDENCE.has(auth[0].confidence))

  const transport = detectContradictions([ev('ev_a', 'transport: tcp'), ev('ev_b', 'transport: udp')])
  assert.equal(transport.length, 1)
  assert.equal(transport[0].confidence, 'likely')
  assert.equal(transport[0].kind, 'exclusive')
})

test('identical claims produce no contradiction', () => {
  const flag = detectContradictions([
    ev('ev_a', 'cacheEnabled = true'),
    ev('ev_b', 'cacheEnabled = true'),
  ])
  assert.deepEqual(flag, [])

  const version = detectContradictions([ev('ev_a', 'api: v1.2.3'), ev('ev_b', 'api: v1.2.3')])
  assert.deepEqual(version, [])
})

test('spacing and quoting differences are not conflicts', () => {
  const cases = [
    ['port = 8080', 'port="8080"'],
    ['port = 8080', 'port = "8080"'],
    ['port = 8080', '  port   =   8080  '],
    ['PORT = 8080', 'port: 8080'],
    ['port = 8080', 'port = 8080.'],
    ['port =', 'port = 8080'],
  ]
  for (const [left, right] of cases) {
    const results = detectContradictions([ev('ev_a', left), ev('ev_b', right)])
    assert.deepEqual(results, [], `${left} versus ${right}`)
  }
})

test('a quoted value against a number is possible, never high', () => {
  const results = detectContradictions([
    ev('ev_a', 'port = 8080'),
    ev('ev_b', 'port = "all interfaces"'),
  ])
  assert.equal(results.length, 1)
  assert.equal(results[0].confidence, 'possible')
  assert.equal(results[0].kind, 'key-value')
  assert.ok(!HIGH_CONFIDENCE.has(results[0].confidence))
})

test('the same noun with no structured claim never reaches high confidence', () => {
  const results = detectContradictions([
    ev('ev_a', 'authentication uses JWT tokens'),
    ev('ev_b', 'the auth module handles sessions'),
  ])
  for (const result of results) {
    assert.ok(!HIGH_CONFIDENCE.has(result.confidence), JSON.stringify(result))
    assert.notEqual(result.kind, 'exclusive')
  }
  assert.ok(results.every((result) => result.confidence === 'none' || result.confidence === 'possible'))
})

test('unrelated texts report nothing', () => {
  const results = detectContradictions([
    ev('ev_a', 'the quick brown fox'),
    ev('ev_b', 'a lazy dog sleeps'),
    ev('ev_c', 'nothing here overlaps at all'),
  ])
  assert.deepEqual(results, [])
})

test('limit bounds the result set and keeps the documented order', () => {
  const items = [
    ev('ev_a', 'host: alpha\nmode: fast\nport: 8080\ntimeout: 30'),
    ev('ev_b', 'host: beta\nmode: slow\nport: 3000\ntimeout: 90'),
  ]
  const all = detectContradictions(items, 10)
  assert.equal(all.length, 4)
  assert.deepEqual(
    all.map((result) => result.subject),
    ['host', 'mode', 'port', 'timeout'],
  )

  const bounded = detectContradictions(items, 2)
  assert.equal(bounded.length, 2)
  assert.deepEqual(
    bounded.map((result) => result.subject),
    ['host', 'mode'],
  )
  for (const result of bounded) {
    assert.ok(result.evidenceA.evidenceId < result.evidenceB.evidenceId)
  }

  assert.deepEqual(detectContradictions(items, 0), [])
  assert.deepEqual(detectContradictions(items, -5), [])
  // Above the ceiling the cap is applied, not the request.
  const wide = detectContradictions(items, 5000)
  assert.equal(wide.length, 4)
})

test('a request above the ceiling is clamped to 100', () => {
  const subjects = Array.from({ length: 101 }, (_, index) => `k${index}`)
  const items = [
    ev('ev_a', `${subjects.map((key) => `${key} = 1`).join('\n')}`),
    ev('ev_b', `${subjects.map((key) => `${key} = 2`).join('\n')}`),
  ]
  const results = detectContradictions(items, 100000)
  assert.equal(results.length, 100)
  // Order is lexicographic on the normalised subject, so the cap keeps the
  // sorted prefix rather than the input prefix.
  assert.deepEqual(
    results.map((result) => result.subject),
    [...subjects].sort().slice(0, 100),
  )
  assert.equal(results[0].subject, 'k0')
})

test('reversing the input order yields deeply equal results', () => {
  const items = [
    ev('ev_z', 'transport: udp'),
    ev('ev_a', 'transport: tcp'),
    ev('ev_m', 'port = 3000\nstorage: postgres'),
    ev('ev_b', 'port = 8080\nstorage: sqlite'),
  ]
  const forward = detectContradictions(items)
  const reversed = detectContradictions([...items].reverse())
  assert.ok(forward.length > 1)
  assert.deepEqual(reversed, forward)
})

test('empty and single-item inputs report nothing', () => {
  assert.deepEqual(detectContradictions([]), [])
  assert.deepEqual(detectContradictions([ev('ev_a', 'port = 8080')]), [])
  assert.deepEqual(detectContradictions([], 50), [])
})

test('malformed items are skipped without throwing', () => {
  const malformed = [
    null,
    undefined,
    'port = 8080',
    42,
    { evidenceId: 'ev_x' },
    { evidenceId: 'ev_y', source: 'docs' },
    { evidenceId: 'ev_z', snippet: 'port = 8080' },
    { evidenceId: 'ev_w', source: 'docs', snippet: 7 },
  ]
  assert.doesNotThrow(() => detectContradictions(malformed))
  assert.deepEqual(detectContradictions(malformed), [])

  const mixed = [
    { evidenceId: 'ev_a', source: 'docs', snippet: 'port = 8080' },
    null,
    { evidenceId: 'ev_b', source: 'docs', snippet: 'port = 3000' },
    { evidenceId: 'ev_c', source: 12, snippet: 'port = 9999' },
  ]
  const results = detectContradictions(mixed)
  assert.equal(results.length, 1)
  assert.equal(results[0].evidenceB.evidenceId, 'ev_b')
  assert.equal(results[0].confidence, 'high')
})

test('a repeated key inside one snippet cannot double-report', () => {
  const results = detectContradictions([
    ev('ev_a', 'port = 8080\nport = 8080'),
    ev('ev_b', 'port = 3000'),
  ])
  assert.equal(results.length, 1)
})

test('extractClaims only returns recognised structured claims', () => {
  assert.deepEqual(extractClaims(''), [])
  assert.deepEqual(extractClaims('   '), [])

  const claims = extractClaims('port = 8080\ncacheEnabled = true\napi: v1.2.3\nfree prose here')
  // Subjects are normalised (lower-cased, collapsed) because that is the key the
  // comparer joins on; values keep their original case.
  assert.deepEqual(claims, [
    { subject: 'port', value: '8080' },
    { subject: 'cacheenabled', value: 'true' },
    { subject: 'api', value: 'v1.2.3' },
  ])

  assert.deepEqual(extractClaims('authentication uses JWT tokens'), [])
  assert.deepEqual(extractClaims('notes:'), [])
})
