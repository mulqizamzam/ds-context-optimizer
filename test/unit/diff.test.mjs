import test from 'node:test'
import assert from 'node:assert/strict'
import { diffSnapshots, diffEvidenceStates, diffSourceVersions, MAX_DIFF_ENTRY_CHARS } from '../../dist/diff.js'

const byKey = (d) => new Map(d.entries.map((e) => [e.key, e]))
const opsOf = (d) => d.entries.map((e) => e.op)

test('added, removed, changed and unchanged get the right op and the counters add up', () => {
  const before = [{ evidenceId: 'ev_a', text: 'x' }, { evidenceId: 'ev_b', text: 'y' }, { evidenceId: 'ev_c', text: 'z' }]
  const after = [{ evidenceId: 'ev_b', text: 'y' }, { evidenceId: 'ev_c', text: 'z-changed' }, { evidenceId: 'ev_d', text: 'w' }]
  const d = diffEvidenceStates(before, after)
  assert.equal(d.additions, 1)
  assert.equal(d.removals, 1)
  assert.equal(d.changes, 1)
  assert.equal(d.unchanged, 1)
  assert.equal(d.truncated, false)
  const m = byKey(d)
  assert.equal(m.get('ev_a').op, 'removed')
  assert.equal(m.get('ev_b').op, 'unchanged')
  assert.equal(m.get('ev_c').op, 'changed')
  assert.equal(m.get('ev_d').op, 'added')
  assert.equal(m.get('ev_c').before, 'z')
  assert.equal(m.get('ev_c').after, 'z-changed')
  assert.equal(m.get('ev_a').before, 'x')
  assert.equal(m.get('ev_a').after, undefined)
  assert.equal(m.get('ev_d').after, 'w')
  assert.equal(m.get('ev_d').before, undefined)
  assert.equal(m.get('ev_b').before, undefined)
  assert.equal(m.get('ev_b').after, undefined)
  assert.deepEqual(opsOf(d), ['removed', 'changed', 'added', 'unchanged'])
})

test('identical inputs produce only unchanged, no adds/removes/changes', () => {
  const ev = [{ evidenceId: 'ev_a', text: 'same' }]
  const de = diffEvidenceStates(ev, ev)
  assert.equal(de.additions, 0)
  assert.equal(de.removals, 0)
  assert.equal(de.changes, 0)
  assert.ok(de.unchanged >= 1)
  assert.equal(de.truncated, false)
  const snap = '<context>\n<alpha>one</alpha>\n<beta>two</beta>\n</context>\n'
  const ds = diffSnapshots(snap, snap)
  assert.equal(ds.additions, 0)
  assert.equal(ds.removals, 0)
  assert.equal(ds.changes, 0)
  assert.ok(ds.unchanged >= 1)
  assert.equal(ds.truncated, false)
})

test('both sides empty and one side empty', () => {
  const empty = diffEvidenceStates([], [])
  assert.deepEqual([empty.additions, empty.removals, empty.changes, empty.unchanged], [0, 0, 0, 0])
  assert.deepEqual(empty.entries, [])
  assert.equal(empty.truncated, false)
  const nobodySnap = diffSnapshots('', '')
  assert.deepEqual(nobodySnap.entries, [])
  assert.equal(nobodySnap.unchanged, 0)
  const some = [{ evidenceId: 'ev_a', text: 'x' }, { evidenceId: 'ev_b', text: 'y' }]
  const added = diffEvidenceStates([], some)
  assert.equal(added.additions, 2)
  assert.equal(added.removals, 0)
  assert.ok(added.entries.every((e) => e.op === 'added'))
  const removed = diffEvidenceStates(some, [])
  assert.equal(removed.removals, 2)
  assert.ok(removed.entries.every((e) => e.op === 'removed'))
})

test('a 500-change diff is capped, flagged truncated, and still counts all 500', () => {
  const before = []
  const after = []
  for (let i = 0; i < 500; i++) {
    const id = 'ev_' + String(i).padStart(4, '0')
    before.push({ evidenceId: id, text: 'old-' + id })
    after.push({ evidenceId: id, text: 'new-' + id })
  }
  const def = diffEvidenceStates(before, after)
  assert.equal(def.changes, 500)
  assert.equal(def.entries.length, 20)
  assert.equal(def.truncated, true)
  const small = diffEvidenceStates(before, after, 5)
  assert.equal(small.changes, 500)
  assert.equal(small.entries.length, 5)
  assert.equal(small.truncated, true)
})

test('maxEntries defaults to 20 and clamps into [0, 100]', () => {
  const mk = (v) => Array.from({ length: 150 }, (_, i) => ({ evidenceId: 'e' + String(i).padStart(4, '0'), text: v }))
  const before = mk('a')
  const after = mk('b')
  assert.equal(diffEvidenceStates(before, after).entries.length, 20)
  assert.equal(diffEvidenceStates(before, after, 1000).entries.length, 100)
  assert.equal(diffEvidenceStates(before, after, 0).entries.length, 0)
  assert.equal(diffEvidenceStates(before, after, 0).truncated, true)
  assert.equal(diffEvidenceStates(before, after, -5).entries.length, 0)
})

test('an over-long value is clipped to MAX_DIFF_ENTRY_CHARS in the output', () => {
  assert.equal(MAX_DIFF_ENTRY_CHARS, 160)
  const longText = 'q'.repeat(400)
  const d = diffEvidenceStates([{ evidenceId: 'ev_x', text: 'a' }], [{ evidenceId: 'ev_x', text: longText }])
  const changed = d.entries.find((e) => e.op === 'changed')
  assert.equal(changed.after.length, MAX_DIFF_ENTRY_CHARS)
  assert.ok(changed.after.length <= MAX_DIFF_ENTRY_CHARS)
  const longKey = 'k'.repeat(400)
  const dk = diffEvidenceStates([{ evidenceId: longKey, text: 'a' }], [{ evidenceId: longKey, text: 'b' }])
  assert.ok(dk.entries.every((e) => e.key.length <= MAX_DIFF_ENTRY_CHARS))
})

test('a snapshot diff never returns the whole snapshot (over-160-char marker)', () => {
  const marker = 'MARK-' + 'z'.repeat(500) + '-END'
  assert.ok(marker.length > MAX_DIFF_ENTRY_CHARS)
  const before = '<context>\n<decisions>old value</decisions>\n</context>\n'
  const after = '<context>\n<decisions>' + marker + '</decisions>\n</context>\n'
  const d = diffSnapshots(before, after)
  assert.equal(d.changes, 1)
  assert.ok(!JSON.stringify(d).includes(marker), 'returned diff leaked the whole snapshot body')
})

test('evidence diff keys by evidenceId; source-version diff keys by ordinal', () => {
  const de = diffEvidenceStates([{ evidenceId: 'ev_a', text: '1' }], [
    { evidenceId: 'ev_a', text: '2' },
    { evidenceId: 'ev_b', text: 'n' },
  ])
  assert.equal(de.changes, 1)
  assert.equal(de.additions, 1)
  const me = byKey(de)
  assert.equal(me.get('ev_a').op, 'changed')
  assert.equal(me.get('ev_b').op, 'added')
  const vb = [{ ordinal: 1, text: 'a' }, { ordinal: 2, text: 'b' }]
  const va = [{ ordinal: 1, text: 'a' }, { ordinal: 2, text: 'B' }, { ordinal: 3, text: 'c' }]
  const dv = diffSourceVersions(vb, va)
  assert.equal(dv.changes, 1)
  assert.equal(dv.additions, 1)
  assert.equal(dv.unchanged, 1)
  const mv = byKey(dv)
  assert.equal(mv.get('1').op, 'unchanged')
  assert.equal(mv.get('2').op, 'changed')
  assert.equal(mv.get('2').before, 'b')
  assert.equal(mv.get('2').after, 'B')
  assert.equal(mv.get('3').op, 'added')
})

test('snapshot keys are tag paths with /index for repeated siblings', () => {
  const mk = (f2) => '<context>\n<decisions>keep</decisions>\n<files>\n<f>a</f>\n<f>' + f2 + '</f>\n</files>\n</context>\n'
  const d = diffSnapshots(mk('b'), mk('c'))
  const m = byKey(d)
  assert.equal(d.changes, 1)
  assert.ok(d.unchanged >= 2)
  assert.equal(m.get('decisions').op, 'unchanged')
  assert.ok(m.has('files/f/0'))
  assert.ok(m.has('files/f/1'))
  assert.equal(m.get('files/f/0').op, 'unchanged')
  assert.equal(m.get('files/f/1').op, 'changed')
  assert.equal(m.get('files/f/1').before, 'b')
  assert.equal(m.get('files/f/1').after, 'c')
  const lone = diffSnapshots('<decisions>keep</decisions>', '<decisions>drop</decisions>')
  const ml = byKey(lone)
  assert.equal(ml.get('decisions').op, 'changed')
  assert.equal(ml.get('decisions').before, 'keep')
  assert.equal(ml.get('decisions').after, 'drop')
})

test('reversing the two sides swaps added and removed over the same keys', () => {
  const before = [
    { evidenceId: 'ev_a', text: 'x' },
    { evidenceId: 'ev_c', text: 'z' },
    { evidenceId: 'ev_keep', text: 'k' },
  ]
  const after = [
    { evidenceId: 'ev_b', text: 'y' },
    { evidenceId: 'ev_c', text: 'z2' },
    { evidenceId: 'ev_keep', text: 'k' },
  ]
  const f = diffEvidenceStates(before, after)
  const r = diffEvidenceStates(after, before)
  assert.equal(f.additions, r.removals)
  assert.equal(f.removals, r.additions)
  assert.equal(f.changes, r.changes)
  assert.equal(f.unchanged, r.unchanged)
  const fk = byKey(f)
  const rk = byKey(r)
  const keys = (map, op) => [...map].filter(([, e]) => e.op === op).map(([k]) => k).sort()
  assert.deepEqual(keys(fk, 'added'), keys(rk, 'removed'))
  assert.deepEqual(keys(fk, 'removed'), keys(rk, 'added'))
  assert.deepEqual(keys(fk, 'changed'), keys(rk, 'changed'))
  const ck = keys(fk, 'changed')[0]
  assert.equal(fk.get(ck).before, rk.get(ck).after)
  assert.equal(fk.get(ck).after, rk.get(ck).before)
})

test('two identical calls return deeply equal results', () => {
  const b = [{ evidenceId: 'ev_a', text: 'x' }, { evidenceId: 'ev_b', text: 'y' }]
  const a = [{ evidenceId: 'ev_b', text: 'y2' }, { evidenceId: 'ev_c', text: 'z' }]
  assert.deepStrictEqual(diffEvidenceStates(b, a), diffEvidenceStates(b, a))
  const sb = '<context>\n<decisions>one</decisions>\n</context>\n'
  const sa = '<context>\n<decisions>two</decisions>\n</context>\n'
  assert.deepStrictEqual(diffSnapshots(sb, sa), diffSnapshots(sb, sa))
})

test('nothing throws on empty, non-XML, unbalanced or non-ASCII input', () => {
  const cases = [
    ['', ''],
    ['', 'some plain text'],
    ['plain text one', 'plain text two'],
    ['<a><b>unbalanced', 'closing only </a>'],
    ['<a>héllo wörld</a>', '<a>你好世界</a>'],
    ['<!-- c --><x>1</x>', '<x>2</x>'],
    ['<a b="x>y">t</a>', '<a>t2</a>'],
  ]
  for (const [before, after] of cases) {
    const d = diffSnapshots(before, after)
    assert.equal(typeof d.additions, 'number')
    assert.ok(Array.isArray(d.entries))
    assert.equal(typeof d.truncated, 'boolean')
  }
})
