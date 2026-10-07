import assert from 'node:assert/strict'
import test from 'node:test'
import { truncateStdout, createBoundedCollector } from '../../dist/truncate.js'

test('short output passes through untouched', () => {
  const out = truncateStdout('hello', 8192)
  assert.equal(out.truncated, false)
  assert.equal(out.text, 'hello')
})

test('truncated output stays within the byte budget', () => {
  const out = truncateStdout('x'.repeat(50_000), 1024)
  assert.equal(out.truncated, true)
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= 1024)
  assert.match(out.text, /\.\.\.\[truncated\]\.\.\./)
})

test('a multi-byte character is never split at a cut boundary', () => {
  // Every offset lands inside a character at some point; none may produce U+FFFD.
  for (let cut = 200; cut <= 260; cut += 1) {
    const original = 'a'.repeat(cut) + 'é'.repeat(40) + 'b'.repeat(400)
    const out = truncateStdout(original, 300)
    assert.equal(out.truncated, true, `budget 300 over ${Buffer.byteLength(original)} bytes`)
    assert.ok(
      !out.text.includes('�'),
      `replacement character at budget 300 (cut ${cut}): ${JSON.stringify(out.text.slice(250, 300))}`,
    )
  }
})

test('four-byte characters survive truncation at their declared length', () => {
  for (let cut = 100; cut <= 140; cut += 1) {
    const original = 'a'.repeat(cut) + '😀'.repeat(30) + 'b'.repeat(400)
    const out = truncateStdout(original, 240)
    assert.equal(out.truncated, true)
    assert.ok(!out.text.includes('�'), `replacement character at cut ${cut}`)
  }
})

test('the tail survives so the last line of a failure is still readable', () => {
  const out = truncateStdout(`${'y'.repeat(40_000)}FINAL-ERROR-LINE`, 1024)
  assert.equal(out.truncated, true)
  assert.ok(out.text.endsWith('FINAL-ERROR-LINE'))
})

test('a budget smaller than the marker yields marker-only output, not a negative slice', () => {
  const out = truncateStdout('z'.repeat(5000), 8)
  assert.equal(out.truncated, true)
  assert.equal(out.text, '\n...[truncated]...\n')
})

test('collector caps memory and reports the overflow', () => {
  const collector = createBoundedCollector(16)
  collector.push(Buffer.from('abcdefgh'))
  collector.push(Buffer.from('ijklmnopqrstuvwxyz'))
  assert.equal(collector.truncated(), true)
  assert.equal(collector.text(), 'abcdefghijklmnop')
})

test('collector under budget is not marked truncated', () => {
  const collector = createBoundedCollector(64)
  collector.push(Buffer.from('abc'))
  collector.push(Buffer.from('def'))
  assert.equal(collector.truncated(), false)
  assert.equal(collector.text(), 'abcdef')
})