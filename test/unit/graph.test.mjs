import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  MAX_DEPTH,
  MAX_ENTITY_CHARS,
  MAX_NODES,
  RelationshipGraph,
  normalizeEntity,
} from '../../dist/graph.js'

/**
 * A fresh graph on a temp file. `open()` hands out another handle over the SAME
 * file so a test can reopen the store and prove it read rows from disk rather
 * than from memory; `cleanup()` closes every handle it made.
 */
function newGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-graph-'))
  const file = path.join(dir, 'graph.sqlite')
  const handles = []
  const open = () => {
    const db = new DatabaseSync(file)
    handles.push(db)
    return { db, graph: new RelationshipGraph(db) }
  }
  const first = open()
  return {
    dir,
    file,
    db: first.db,
    graph: first.graph,
    open,
    cleanup: () => {
      for (const db of handles) {
        try {
          db.close()
        } catch {
          /* already closed */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const chain = [
  { from: 'a', type: 'defines', to: 'b', evidenceId: 'ev_1' },
  { from: 'b', type: 'calls', to: 'c', evidenceId: 'ev_2' },
  { from: 'c', type: 'imports', to: 'd', evidenceId: 'ev_3' },
  { from: 'd', type: 'references', to: 'e', evidenceId: 'ev_4' },
]

test('a direct relationship is traversable at depth 1 and reported with its provenance', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'src_index', type: 'defines', to: 'chunk_1', evidenceId: 'ev_1' })
    const result = graph.traverse('src_index', 1)
    assert.equal(result.edges, 1)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.nodes[0], { entity: 'src_index', depth: 0 })
    assert.deepEqual(result.nodes[1], {
      entity: 'chunk_1',
      depth: 1,
      via: { from: 'src_index', type: 'defines' },
      evidenceId: 'ev_1',
    })
  } finally {
    cleanup()
  }
})

test('multi-hop traversal reaches a node at depth 2 and does not report it at depth 1', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges(chain)
    const depth1 = graph.traverse('a', 1)
    assert.deepEqual(depth1.nodes.map((n) => n.entity), ['a', 'b'])
    assert.equal(depth1.nodes.some((n) => n.entity === 'c'), false)

    const depth2 = graph.traverse('a', 2)
    assert.deepEqual(depth2.nodes.map((n) => n.entity), ['a', 'b', 'c'])
    assert.deepEqual(depth2.nodes[2], {
      entity: 'c',
      depth: 2,
      via: { from: 'b', type: 'calls' },
      evidenceId: 'ev_2',
    })
    assert.equal(depth2.truncated, false)
  } finally {
    cleanup()
  }
})

test('a cycle terminates, visits each entity once, and stays inside the node budget', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges([
      { from: 'a', type: 'calls', to: 'b' },
      { from: 'b', type: 'calls', to: 'a' },
    ])
    const result = graph.traverse('a')
    const entities = result.nodes.map((n) => n.entity)
    assert.deepEqual(entities, ['a', 'b'])
    assert.equal(new Set(entities).size, entities.length)
    assert.equal(result.truncated, false)
    assert.ok(result.nodes.length < MAX_NODES)
    // Both edges of the cycle are examined even though only one entity is added.
    assert.equal(result.edges, 2)
  } finally {
    cleanup()
  }
})

test('a self-loop terminates and leaves the start node alone', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges([
      { from: 'a', type: 'calls', to: 'a' },
      { from: 'a', type: 'calls', to: 'b' },
    ])
    const result = graph.traverse('a', 1)
    assert.deepEqual(result.nodes.map((n) => n.entity), ['a', 'b'])
    assert.equal(new Set(result.nodes.map((n) => n.entity)).size, 2)
  } finally {
    cleanup()
  }
})

test('a missing entity returns an empty result without throwing', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'a', type: 'calls', to: 'b' })
    assert.deepEqual(graph.traverse('ghost'), { nodes: [], edges: 0, truncated: false })
    assert.deepEqual(graph.traverse('../../etc/passwd'), { nodes: [], edges: 0, truncated: false })
  } finally {
    cleanup()
  }
})

test('a known entity with no outgoing edges reports itself rather than nothing', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'a', type: 'calls', to: 'b' })
    const result = graph.traverse('b', 1)
    assert.deepEqual(result.nodes, [{ entity: 'b', depth: 0 }])
    assert.equal(result.edges, 0)
    assert.equal(result.truncated, false)
  } finally {
    cleanup()
  }
})

test('depth 0 returns the start node only, with no via', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges(chain)
    const result = graph.traverse('a', 0)
    assert.deepEqual(result.nodes, [{ entity: 'a', depth: 0 }])
    assert.equal(result.edges, 0)
    assert.equal(result.truncated, false)
  } finally {
    cleanup()
  }
})

test('depth is clamped: 99 behaves as MAX_DEPTH and a negative depth is 0', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges(chain)
    const deep = graph.traverse('a', 99)
    assert.deepEqual(deep.nodes.map((n) => n.entity), ['a', 'b', 'c', 'd'])
    assert.equal(deep.nodes.some((n) => n.entity === 'e'), false)
    assert.deepEqual(
      deep.nodes.map((n) => n.entity),
      graph.traverse('a', MAX_DEPTH).nodes.map((n) => n.entity),
    )
    assert.deepEqual(graph.traverse('a', -5).nodes, [{ entity: 'a', depth: 0 }])
  } finally {
    cleanup()
  }
})

test('the node limit is clamped into [1, MAX_NODES]', () => {
  const { graph, cleanup } = newGraph()
  try {
    for (let i = 0; i < MAX_NODES + 50; i += 1) {
      graph.addEdge({ from: 'hub', type: 'calls', to: `node-${String(i).padStart(3, '0')}` })
    }
    const over = graph.traverse('hub', 1, 500)
    assert.equal(over.nodes.length, MAX_NODES)
    assert.equal(over.truncated, true)
    assert.equal(over.nodes[0].entity, 'hub')
    // The budget is filled from the sorted head of the level, not from
    // insertion order.
    assert.equal(over.nodes[MAX_NODES - 1].entity, `node-${String(MAX_NODES - 2).padStart(3, '0')}`)

    const floor = graph.traverse('hub', 1, 0)
    assert.deepEqual(floor.nodes, [{ entity: 'hub', depth: 0 }])
    assert.equal(floor.truncated, true)
    assert.deepEqual(graph.traverse('hub', 1, -7).nodes, [{ entity: 'hub', depth: 0 }])
  } finally {
    cleanup()
  }
})

test('a node-limit hit reports truncated', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges([
      { from: 'hub', type: 'calls', to: 'a' },
      { from: 'hub', type: 'calls', to: 'b' },
      { from: 'hub', type: 'calls', to: 'c' },
    ])
    const capped = graph.traverse('hub', 1, 2)
    assert.deepEqual(capped.nodes.map((n) => n.entity), ['hub', 'a'])
    assert.equal(capped.truncated, true)
    assert.equal(capped.edges, 3)
    const exact = graph.traverse('hub', 1, 4)
    assert.equal(exact.truncated, false)
    assert.equal(exact.nodes.length, 4)
  } finally {
    cleanup()
  }
})

test('normalizeEntity rejects paths, NUL, over-long tokens and non-strings', () => {
  assert.equal(normalizeEntity('entity-1'), 'entity-1')
  assert.equal(normalizeEntity('  entity-1  '), 'entity-1')
  assert.equal(normalizeEntity('x'.repeat(MAX_ENTITY_CHARS)), 'x'.repeat(MAX_ENTITY_CHARS))
  assert.equal(normalizeEntity(''), null)
  assert.equal(normalizeEntity('   '), null)
  assert.equal(normalizeEntity('../../etc/passwd'), null)
  assert.equal(normalizeEntity('/etc/passwd'), null)
  assert.equal(normalizeEntity('a\\b'), null)
  assert.equal(normalizeEntity('..'), null)
  assert.equal(normalizeEntity('a\0b'), null)
  assert.equal(normalizeEntity('x'.repeat(MAX_ENTITY_CHARS + 1)), null)
  assert.equal(normalizeEntity(42), null)
  assert.equal(normalizeEntity(null), null)
  assert.equal(normalizeEntity(undefined), null)
})

test('addEdge is idempotent on the same triple', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'a', type: 'calls', to: 'b', evidenceId: 'ev_1' })
    graph.addEdge({ from: 'a', type: 'calls', to: 'b', evidenceId: 'ev_2' })
    graph.addEdges([
      { from: 'a', type: 'calls', to: 'b', evidenceId: 'ev_3' },
      { from: 'a', type: 'calls', to: 'b' },
    ])
    assert.deepEqual(graph.stats(), { relations: 1, entities: 2 })
    // First writer's provenance is the one that survives.
    assert.deepEqual(graph.neighbors('a'), [
      { from: 'a', type: 'calls', to: 'b', evidenceId: 'ev_1' },
    ])
    // A different relation between the same pair is a second row.
    graph.addEdge({ from: 'a', type: 'imports', to: 'b' })
    assert.equal(graph.stats().relations, 2)
  } finally {
    cleanup()
  }
})

test('addEdge drops edges whose endpoints do not normalise', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdge({ from: '../../etc/passwd', type: 'calls', to: 'x' })
    graph.addEdge({ from: 'x', type: 'calls', to: '' })
    graph.addEdges([
      { from: 'ok1', type: 'calls', to: '../ok2' },
      { from: 'ok1', type: 'calls', to: 'ok2' },
    ])
    assert.deepEqual(graph.stats(), { relations: 1, entities: 2 })
    assert.deepEqual(graph.neighbors('ok1').map((r) => r.to), ['ok2'])
  } finally {
    cleanup()
  }
})

test('a failing addEdges batch rolls back every row of the batch', () => {
  const { graph, db, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'pre', type: 'calls', to: 'row' })
    // A test-local trigger makes the second row of the batch fail inside the
    // transaction; only the module's rollback can hide the first row too.
    db.exec(`CREATE TRIGGER graph_test_boom BEFORE INSERT ON relationships
             WHEN NEW.to_entity = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    assert.throws(() => {
      graph.addEdges([
        { from: 'a', type: 'calls', to: 'b' },
        { from: 'b', type: 'calls', to: 'BOOM' },
        { from: 'c', type: 'calls', to: 'd' },
      ])
    })
    assert.deepEqual(graph.neighbors('a'), [])
    assert.deepEqual(graph.neighbors('c'), [])
    assert.deepEqual(graph.stats(), { relations: 1, entities: 2 })
    // The failed transaction released the lock: the store is still writable.
    graph.addEdge({ from: 'after', type: 'calls', to: 'row' })
    assert.equal(graph.stats().relations, 2)
  } finally {
    cleanup()
  }
})

test('removeEvidence removes every edge carrying that evidence id and counts them', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges([
      { from: 'a', type: 'calls', to: 'b', evidenceId: 'ev_gone' },
      { from: 'b', type: 'calls', to: 'c', evidenceId: 'ev_gone' },
      { from: 'c', type: 'calls', to: 'd', evidenceId: 'ev_keep' },
      { from: 'd', type: 'calls', to: 'e' },
    ])
    assert.equal(graph.removeEvidence('ev_gone'), 2)
    assert.equal(graph.removeEvidence('ev_gone'), 0)
    assert.equal(graph.removeEvidence('ev_absent'), 0)
    // The evidence-less edge stays, so 'd' still reaches 'e'.
    assert.deepEqual(graph.traverse('d', 1).nodes.map((n) => n.entity), ['d', 'e'])
    // The removed entities are gone entirely.
    assert.deepEqual(graph.traverse('a'), { nodes: [], edges: 0, truncated: false })
    assert.deepEqual(graph.stats(), { relations: 2, entities: 3 })
  } finally {
    cleanup()
  }
})

test('stats counts rows from the table, not from memory', () => {
  const { graph, open, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'a', type: 'calls', to: 'b' })
    graph.addEdge({ from: 'b', type: 'calls', to: 'c' })
    assert.deepEqual(graph.stats(), { relations: 2, entities: 3 })
    graph.addEdge({ from: 'a', type: 'calls', to: 'c' })
    assert.deepEqual(graph.stats(), { relations: 3, entities: 3 })
    // A second handle over the same file sees the same rows.
    const { graph: reopened } = open()
    assert.deepEqual(reopened.stats(), { relations: 3, entities: 3 })
    assert.deepEqual(reopened.traverse('a', 2).nodes.map((n) => n.entity), ['a', 'b', 'c'])
  } finally {
    cleanup()
  }
})

test('the constructor is idempotent over the same handle and the same file', () => {
  const { graph, db, open, cleanup } = newGraph()
  try {
    graph.addEdge({ from: 'a', type: 'calls', to: 'b' })
    const sameHandle = new RelationshipGraph(db)
    const { graph: reopened } = open()
    assert.deepEqual(sameHandle.stats(), { relations: 1, entities: 2 })
    assert.deepEqual(reopened.stats(), { relations: 1, entities: 2 })
    assert.deepEqual(graph.traverse('a', 1).nodes.map((n) => n.entity), ['a', 'b'])
  } finally {
    cleanup()
  }
})

test('neighbors is ordered by (relation, to_entity) and bounded by limit', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges([
      { from: 'a', type: 'imports', to: 'zeta' },
      { from: 'a', type: 'calls', to: 'mid' },
      { from: 'a', type: 'calls', to: 'beta' },
      // Duplicate inside one batch: the unique triple absorbs it.
      { from: 'a', type: 'calls', to: 'beta' },
    ])
    assert.deepEqual(
      graph.neighbors('a').map((r) => `${r.type}:${r.to}`),
      ['calls:beta', 'calls:mid', 'imports:zeta'],
    )
    assert.equal(graph.neighbors('a', 2).length, 2)
    assert.deepEqual(graph.neighbors('missing'), [])
    assert.deepEqual(graph.neighbors('../../etc/passwd'), [])
  } finally {
    cleanup()
  }
})

test('deterministic: two identical traverse calls return deeply equal results', () => {
  const { graph, cleanup } = newGraph()
  try {
    graph.addEdges([
      { from: 'hub', type: 'calls', to: 'beta' },
      { from: 'hub', type: 'imports', to: 'beta' },
      { from: 'hub', type: 'calls', to: 'alpha' },
      { from: 'hub', type: 'calls', to: 'zeta' },
      { from: 'beta', type: 'calls', to: 'alpha', evidenceId: 'ev_x' },
    ])
    const first = graph.traverse('hub', 2)
    const second = graph.traverse('hub', 2)
    assert.deepEqual(first, second)
    // Depth asc, then entity asc within a level.
    assert.deepEqual(first.nodes.map((n) => n.entity), ['hub', 'alpha', 'beta', 'zeta'])
    // Two relations to 'beta': the lower via type wins, deterministically.
    assert.deepEqual(first.nodes[2], {
      entity: 'beta',
      depth: 1,
      via: { from: 'hub', type: 'calls' },
    })
    // The cycle-closing beta->alpha row is examined but adds no node.
    assert.equal(first.edges, 5)
    assert.equal(first.truncated, false)
  } finally {
    cleanup()
  }
})
