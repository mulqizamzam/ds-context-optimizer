import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from '../../dist/routing/engine.js'
import { AdvisoryThrottle } from '../../dist/routing/throttle.js'

const OFF = { advisory: false, denyPatterns: [] }
const ON = { advisory: true, denyPatterns: [] }

test('an unrelated call is allowed with no target', () => {
  const decision = evaluate('read', { path: 'a.ts' }, ON, 'ctx_')
  assert.equal(decision.action, 'allow')
  assert.equal(decision.targetTool, undefined)
})

test('a whole-page fetch is steered to the indexing path', () => {
  const decision = evaluate('web_fetch', { url: 'https://example.com' }, ON, 'ctx_')
  assert.equal(decision.action, 'advisory')
  assert.equal(decision.targetTool, 'ctx_fetch_and_index')
})

test('a shell fetch is steered to the indexing path', () => {
  for (const command of ['curl https://x.test', 'wget https://x.test', '  curl https://x.test  ']) {
    const decision = evaluate('bash', { command }, ON, 'ctx_')
    assert.equal(decision.action, 'advisory', `command ${command}`)
    assert.equal(decision.targetTool, 'ctx_fetch_and_index')
  }
})

test('a large data file read is steered to the batch path', () => {
  const decision = evaluate('bash', { command: 'cat server.log' }, ON, 'ctx_')
  assert.equal(decision.action, 'advisory')
  assert.equal(decision.targetTool, 'ctx_batch_execute')
})

test('a grep is steered to the search path', () => {
  const decision = evaluate('grep', { pattern: 'needle' }, ON, 'ctx_')
  assert.equal(decision.action, 'advisory')
  assert.equal(decision.targetTool, 'ctx_search')
})

test('the advisory is off by configuration', () => {
  assert.equal(evaluate('web_fetch', { url: 'https://x.test' }, OFF, 'ctx_').action, 'allow')
})

test('no call is denied while the deny list is empty', () => {
  const decision = evaluate('bash', { command: 'rm -rf /' }, ON, 'ctx_')
  assert.notEqual(decision.action, 'deny')
})

test('a configured deny pattern blocks the matching command', () => {
  const config = { advisory: true, denyPatterns: ['^git\\s+push'] }
  const decision = evaluate('bash', { command: 'git push origin main' }, config, 'ctx_')
  assert.equal(decision.action, 'deny')
  assert.match(decision.reason, /deny pattern/)
})

test('a non-matching command passes a deny list untouched', () => {
  const config = { advisory: true, denyPatterns: ['^git\\s+push'] }
  assert.equal(evaluate('bash', { command: 'git status' }, config, 'ctx_').action, 'allow')
})

test('a malformed deny pattern is reported rather than silently skipped', () => {
  const config = { advisory: true, denyPatterns: ['([unclosed'] }
  assert.throws(
    () => evaluate('bash', { command: 'anything' }, config, 'ctx_'),
    /not a valid regular expression/,
  )
})

test('a non-string command argument is treated as no command', () => {
  assert.equal(evaluate('bash', { command: 42 }, ON, 'ctx_').action, 'allow')
  assert.equal(evaluate('bash', null, ON, 'ctx_').action, 'allow')
  assert.equal(evaluate('bash', undefined, ON, 'ctx_').action, 'allow')
})

test('the target tool name follows the configured prefix', () => {
  const decision = evaluate('grep', { pattern: 'x' }, ON, 'ctxopt_')
  assert.equal(decision.targetTool, 'ctxopt_search')
})

test('the throttle nudges the first matching call and then every Nth', () => {
  const throttle = new AdvisoryThrottle(3)
  const fired = Array.from({ length: 7 }, () => throttle.shouldNudge())
  // Fires on the first call and on multiples of N, matching the original
  // `n === 1 || n % every === 0` contract.
  assert.deepEqual(fired, [true, false, true, false, false, true, false])
})

test('a throttle of zero never nudges', () => {
  const throttle = new AdvisoryThrottle(0)
  assert.equal(throttle.shouldNudge(), false)
  assert.equal(throttle.shouldNudge(), false)
})

test('reset returns the throttle to its first-call behaviour', () => {
  const throttle = new AdvisoryThrottle(5)
  throttle.shouldNudge()
  throttle.reset()
  assert.equal(throttle.shouldNudge(), true)
})