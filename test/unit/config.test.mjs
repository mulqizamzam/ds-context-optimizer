import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../../dist/config.js'
import { evaluate } from '../../dist/routing/engine.js'

test('an absent config yields the defaults', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
})

test('an empty object yields the defaults', () => {
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
})

test('a partial config keeps the untouched defaults', () => {
  const config = resolveConfig({ toolPrefix: 'opt_' })
  assert.equal(config.toolPrefix, 'opt_')
  assert.equal(config.executor.defaultTimeoutMs, DEFAULT_CONFIG.executor.defaultTimeoutMs)
})

test('nested overrides are applied', () => {
  const config = resolveConfig({
    executor: { defaultTimeoutMs: 1234, sandboxMode: 'read-only' },
    routing: { denyPatterns: ['^sudo '], advisoryThrottle: 4 },
  })
  assert.equal(config.executor.defaultTimeoutMs, 1234)
  assert.equal(config.executor.sandboxMode, 'read-only')
  assert.deepEqual(config.routing.denyPatterns, ['^sudo '])
  assert.equal(config.routing.advisoryThrottle, 4)
})

test('a bad tool prefix is rejected instead of producing unaddressable tool names', () => {
  // The rule is: start with a letter, contain only lowercase letters/digits/
  // underscores, and end in exactly one separator so tool names stay namespaced.
  for (const prefix of ['ctx', 'CTX_', '1ctx_', 'ctx-x_', '', 'ctx x_']) {
    assert.throws(() => resolveConfig({ toolPrefix: prefix }), ConfigError, `prefix ${JSON.stringify(prefix)}`)
  }
  assert.equal(resolveConfig({ toolPrefix: 'ctxopt_' }).toolPrefix, 'ctxopt_')
  assert.equal(resolveConfig({ toolPrefix: 'ctx_2_' }).toolPrefix, 'ctx_2_')
})

test('a non-mapping config is rejected', () => {
  assert.throws(() => resolveConfig('nope'), ConfigError)
  assert.throws(() => resolveConfig([1, 2]), ConfigError)
  assert.throws(() => resolveConfig({ executor: 5 }), ConfigError)
})

test('numeric fields reject zero, negatives, fractions and non-numbers', () => {
  assert.throws(() => resolveConfig({ executor: { defaultTimeoutMs: 0 } }), ConfigError)
  assert.throws(() => resolveConfig({ executor: { defaultTimeoutMs: -1 } }), ConfigError)
  assert.throws(() => resolveConfig({ executor: { defaultTimeoutMs: 1.5 } }), ConfigError)
  assert.throws(() => resolveConfig({ executor: { defaultTimeoutMs: '30000' } }), ConfigError)
})

test('advisoryThrottle accepts zero but not a negative', () => {
  assert.equal(resolveConfig({ routing: { advisoryThrottle: 0 } }).routing.advisoryThrottle, 0)
  assert.throws(() => resolveConfig({ routing: { advisoryThrottle: -1 } }), ConfigError)
})

test('sandboxMode only accepts the two confined modes', () => {
  // `danger-full-access` is deliberately not offered: this plugin exists to keep
  // model-authored code behind a boundary.
  assert.throws(() => resolveConfig({ executor: { sandboxMode: 'danger-full-access' } }), ConfigError)
  assert.throws(() => resolveConfig({ executor: { sandboxMode: 'yolo' } }), ConfigError)
})

test('boolean fields reject non-booleans', () => {
  assert.throws(() => resolveConfig({ executor: { allowUnconfined: 'yes' } }), ConfigError)
  assert.throws(() => resolveConfig({ routing: { advisory: 1 } }), ConfigError)
  assert.throws(() => resolveConfig({ session: { recordEvents: 'true' } }), ConfigError)
})

test('string arrays reject mixed content', () => {
  assert.deepEqual(resolveConfig({ routing: { denyPatterns: ['a', 'b'] } }).routing.denyPatterns, ['a', 'b'])
  assert.throws(() => resolveConfig({ routing: { denyPatterns: ['a', 2] } }), ConfigError)
  assert.throws(() => resolveConfig({ routing: { denyPatterns: 'a' } }), ConfigError)
})

test('a malformed deny pattern is a configuration error, not a rule that boots and fails later', () => {
  // The bug this locks: `denyPatterns` was stored uncompiled, so boot reported
  // `view.errors === []` and the operator believed the rule was live. The RegExp
  // then threw inside the tool listeners, where pre-execute fails open (the deny
  // rule never denies) and post-execute has no guard.
  assert.throws(() => resolveConfig({ routing: { denyPatterns: ['('] } }), ConfigError)
  for (const pattern of ['(', '[a-', 'a{2,1}', '*', '(?<x>a)(?<x>b)']) {
    assert.throws(
      () => resolveConfig({ routing: { denyPatterns: [pattern] } }),
      (error) =>
        error instanceof ConfigError &&
        /routing\.denyPatterns entry is not a valid regular expression/.test(error.message),
      `${JSON.stringify(pattern)} must be rejected with a ConfigError`,
    )
  }
  // One bad entry invalidates the whole block: half a deny list is not a
  // configuration the operator wrote.
  assert.throws(() => resolveConfig({ routing: { denyPatterns: ['^sudo ', '(', '^rm '] } }), ConfigError)
})

test('a bad deny pattern is rejected when it is the only key supplied', () => {
  // Guards the exact `resolveConfig` entry point `apply` calls with a patch row
  // config, with nothing else to fall through to.
  assert.throws(() => resolveConfig({ routing: { denyPatterns: ['('] } }), ConfigError)
  // Defaults cannot smuggle one past the gate either.
  assert.throws(() => resolveConfig({ ...DEFAULT_CONFIG, routing: { denyPatterns: ['('] } }), ConfigError)
})

test('the compiled deny patterns are the strings the routing engine evaluates', () => {
  // `resolveConfig` must validate the very array `apply` forwards to `evaluate`
  // — if it validated a different copy, the gate would pass while the engine
  // still compiled a broken pattern at command time.
  const config = resolveConfig({ routing: { advisory: false, denyPatterns: ['^sudo ', 'rm\\s+-rf\\s+/'] } })
  assert.deepEqual(config.routing.denyPatterns, ['^sudo ', 'rm\\s+-rf\\s+/'])
  assert.equal(evaluate('bash', { command: 'sudo rm -rf /' }, config.routing, config.toolPrefix).action, 'deny')
  assert.equal(evaluate('bash', { command: 'ls -la' }, config.routing, config.toolPrefix).action, 'allow')
  // Every entry the resolver accepted compiles.
  for (const pattern of config.routing.denyPatterns) assert.doesNotThrow(() => new RegExp(pattern))
})

test('the shipped default deny list is a valid pattern list', () => {
  assert.deepEqual(resolveConfig(undefined).routing.denyPatterns, DEFAULT_CONFIG.routing.denyPatterns)
  for (const pattern of DEFAULT_CONFIG.routing.denyPatterns) assert.doesNotThrow(() => new RegExp(pattern))
})

test('the state directory is resolved to an absolute path', () => {
  const config = resolveConfig({ stateDir: 'relative/state' })
  assert.ok(config.stateDir.startsWith('/'), config.stateDir)
})