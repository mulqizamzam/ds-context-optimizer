import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveProjectPath } from '../../dist/security.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-sec-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-out-'))
fs.writeFileSync(path.join(outside, 'secret.txt'), 'classified')
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'hello')

test('a plain relative path resolves inside the project', () => {
  const resolved = resolveProjectPath(root, 'sub/a.txt')
  assert.equal(resolved, fs.realpathSync(path.join(root, 'sub/a.txt')))
})

test('the project root itself is allowed', () => {
  assert.equal(resolveProjectPath(root, '.'), fs.realpathSync(root))
})

test('an absolute path is refused', () => {
  assert.throws(() => resolveProjectPath(root, '/etc/passwd'), /Absolute paths are not allowed/)
})

test('a traversal out of the project is refused', () => {
  assert.throws(() => resolveProjectPath(root, '../escape.txt'), /escapes project boundary/)
})

test('a deep traversal that lands back inside is still allowed', () => {
  const resolved = resolveProjectPath(root, 'sub/../sub/a.txt')
  assert.equal(resolved, fs.realpathSync(path.join(root, 'sub/a.txt')))
})

test('a NUL byte in the path is refused before any filesystem call', () => {
  assert.throws(() => resolveProjectPath(root, 'a\u0000b'), /NUL byte/)
})

test('an empty path is refused', () => {
  assert.throws(() => resolveProjectPath(root, ''), /must not be empty/)
})

test('a symlink pointing outside the project is refused even though the literal path is inside', () => {
  const link = path.join(root, 'escape')
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), link)
  } catch {
    return // symlinks unavailable on this filesystem; the textual checks still ran above
  }
  // The literal spelling `escape` is inside the project, so only a canonical
  // comparison can catch this one.
  assert.throws(() => resolveProjectPath(root, 'escape'), /escapes project boundary/)
})

test('a symlinked directory inside the project stays usable', () => {
  const link = path.join(root, 'link')
  try {
    fs.symlinkSync(path.join(root, 'sub'), link)
  } catch {
    return
  }
  const resolved = resolveProjectPath(root, 'link/a.txt')
  assert.equal(resolved, fs.realpathSync(path.join(root, 'sub/a.txt')))
})

test('a symlinked project root is resolved before the comparison', () => {
  // The root the caller passes may itself be a link into the tree; comparing the
  // candidate against the *spelling* would then reject every in-project path.
  let spelling
  try {
    spelling = path.join(root, 'root-link')
    fs.symlinkSync(root, spelling)
  } catch {
    return // symlinks unavailable on this filesystem
  }
  assert.equal(resolveProjectPath(spelling, 'sub/a.txt'), fs.realpathSync(path.join(root, 'sub/a.txt')))
  assert.equal(resolveProjectPath(spelling, '.'), fs.realpathSync(root))
  // ...and the existence rule applies to an aliased root too: the link is
  // resolved, the missing tail is not guessed at.
  assert.throws(() => resolveProjectPath(spelling, 'g'), /does not exist/)
})

test('a path that does not exist is refused instead of returned as verified', () => {
  // The bug this locks: the answer is a promise about the filesystem at check
  // time, and the child that receives it is free to plant `<root>/g` as a
  // symlink to a file outside the project before opening it. So `resolveProjectPath`
  // must never answer for a name that was not there when it looked.
  const missing = path.join(root, 'g')
  assert.ok(!fs.existsSync(missing), `fixture precondition: ${missing} must not exist`)
  assert.throws(() => resolveProjectPath(root, 'g'), /does not exist/)
})

test('no missing path is ever answered, whatever the missing tail looks like', () => {
  for (const relative of [
    'g', // a bare name that does not exist
    'g/secret.txt', // a missing name under a directory that does exist
    'sub/missing/a.txt', // the deepest existing ancestor exists, the tail does not
    path.join('sub', '..', 'g'), // spellings that normalise to the same missing name
  ]) {
    assert.ok(!fs.existsSync(path.resolve(root, relative)), `fixture precondition: ${relative} must not exist`)
    assert.throws(
      () => resolveProjectPath(root, relative),
      /does not exist/,
      `${JSON.stringify(relative)} must be reported as missing, not answered`,
    )
  }
})

test('an escaping link whose target does not exist is refused, not answered', () => {
  // The link is present at check time but dangling, so `realpath` cannot tell
  // where it will point once its target appears — which makes it exactly as
  // unanswerable as a bare missing name. The old code joined the tail back on
  // textually and returned `<root>/escape-missing`.
  const link = path.join(root, 'escape-missing')
  try {
    fs.symlinkSync(path.join(outside, 'not-created-yet.txt'), link)
  } catch {
    return // symlinks unavailable on this filesystem
  }
  assert.throws(() => resolveProjectPath(root, 'escape-missing'), /does not exist/)
  assert.throws(() => resolveProjectPath(root, 'escape-missing/missing.txt'), /does not exist/)
})

test('an escaping link reached through a missing ancestor is refused as an escape', () => {
  // `realpathNearest` cannot canonicalise `escape-dir/g`, and the textually
  // joined tail looks perfectly in-bounds, so this is precisely the case where a
  // missing tail must not be mistaken for a verified path: the deepest existing
  // ancestor here is a symlink pointing outside the project.
  const link = path.join(root, 'escape-dir')
  try {
    fs.symlinkSync(outside, link)
  } catch {
    return // symlinks unavailable on this filesystem
  }
  assert.throws(() => resolveProjectPath(root, 'escape-dir/g'), /escapes project boundary/)
})

test('a missing path under a symlinked directory inside the project is merely missing', () => {
  // The in-project link is legitimate, so the honest answer is "not there" — and
  // the same wording is what tells the two cases apart for a caller deciding
  // whether to create the file.
  const link = path.join(root, 'link')
  try {
    // Reuse the fixture an earlier test created: `symlinkSync` on an existing
    // name throws EEXIST, and swallowing that would skip the test silently.
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, 'sub'), link)
  } catch {
    return // symlinks unavailable on this filesystem
  }
  assert.throws(() => resolveProjectPath(root, 'link/missing.txt'), /does not exist/)
  assert.throws(() => resolveProjectPath(root, 'link/deeper/missing.txt'), /does not exist/)
})

test('a file component that is not a directory is missing, not an escape', () => {
  assert.throws(() => resolveProjectPath(root, 'sub/a.txt/inner.txt'), /does not exist/)
})

test('a traversal to a non-existent path outside the project is still an escape', () => {
  // The existence check must not take over the boundary message: `ENOENT` here
  // is the absence of the target, not a licence to hand the path back.
  assert.throws(() => resolveProjectPath(root, '../escape.txt'), /escapes project boundary/)
  assert.throws(() => resolveProjectPath(root, '../nowhere/deeper.txt'), /escapes project boundary/)
  assert.throws(() => resolveProjectPath(root, 'sub/../../../nowhere/deeper.txt'), /escapes project boundary/)
})

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})