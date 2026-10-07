/**
 * Configuration-file gate.
 *
 * A `cordis.patch.yml` that the host parser cannot read is a plugin that either
 * refuses to boot or, worse, silently loses its configuration. This asserts the
 * shipped file parses with the same `yaml` version the host uses, and that the
 * uncommented example in the README is a complete, valid config that resolves.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { resolveConfig } from '../../dist/config.js'

const root = path.resolve(import.meta.dirname, '../..')
const patchFile = path.join(root, 'cordis.patch.yml')
const readmeFile = path.join(root, 'README.md')

test('the shipped patch parses with the host yaml parser', () => {
  const doc = YAML.parse(fs.readFileSync(patchFile, 'utf8'))
  assert.ok(Array.isArray(doc), 'the patch root must be a list of patch entries')
  assert.equal(doc.length, 1)
  assert.ok(Array.isArray(doc[0].insert), 'the entry must use `insert`')
  const row = doc[0].insert[0]
  assert.equal(row.id, 'context-optimizer')
  assert.equal(row.name, 'dsh-context-optimizer', 'the row must name this package, not a different one')
  assert.ok(!('config' in row), 'the shipped row ships no config; the README documents the example')
})

test('the patch name matches the package name in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const doc = YAML.parse(fs.readFileSync(patchFile, 'utf8'))
  assert.equal(doc[0].insert[0].name, pkg.name)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('the main entry named in package.json exists after a build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(root, pkg.main)), `${pkg.main} is missing; run npm run build`)
})

test('the config example in the README is complete and resolves', () => {
  const readme = fs.readFileSync(readmeFile, 'utf8')
  const block = /```yaml\n- insert:[\s\S]*?\n```/.exec(readme)
  assert.ok(block, 'the README lost its install row example')

  const doc = YAML.parse(block[0].slice('```yaml'.length, -3))
  const row = doc[0].insert[0]
  assert.equal(row.id, 'context-optimizer')

  // Every key the resolver knows must be documented, or an operator reading the
  // README cannot discover it.
  const documented = Object.keys(row.config ?? {}).sort()
  const resolved = Object.keys(resolveConfig({})).sort()
  assert.deepEqual(documented, resolved, 'the README config block and the resolver disagree on the key set')

  const config = resolveConfig(row.config)
  assert.equal(config.toolPrefix, 'ctx_')
  assert.equal(config.executor.sandboxMode, 'workspace-write')
  assert.equal(config.executor.allowUnconfined, false, 'the documented default must be fail-closed')
})

test('the commented example in the patch file matches the README config', () => {
  // Uncomment only from the row onward: the header prose above it is not YAML,
  // and turning it into text would fail for a reason unrelated to the example.
  const patch = fs.readFileSync(patchFile, 'utf8')
  const body = patch.slice(patch.indexOf('- insert:'))
  const uncommented = body
    .split('\n')
    .map((line) => line.replace(/^(\s*)#\s?/, '$1'))
    .join('\n')
  const doc = YAML.parse(uncommented)
  const row = doc[0].insert[0]
  assert.ok(row.config, 'the commented example did not uncomment into a config block')
  const config = resolveConfig(row.config)
  assert.equal(config.toolPrefix, 'ctx_')
  assert.equal(config.session.injectSnapshot, true)
  assert.deepEqual(config.routing.denyPatterns, [])
})