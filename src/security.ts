import fs from 'node:fs'
import path from 'node:path'

/**
 * A path that may be handed to a project-confined tool call.
 *
 * The original check was purely textual (`path.resolve` plus a `startsWith`
 * prefix test), which a symlink inside the project defeats: `link/../../../etc`
 * resolves to the project directory as a string while the kernel follows it
 * outside. Every component is therefore resolved through `realpath` first and
 * the canonical paths are compared, so both spellings and symlinks must stay
 * inside `projectRoot`.
 *
 * ## Why the path must already exist
 *
 * `realpath` cannot canonicalise a name that is not there, so a missing tail has
 * to be joined back on textually — and a textually joined tail is exactly the
 * unverified string the old check trusted. Returning it as if it had been
 * verified hands the callee a promise about the filesystem *at check time* while
 * the callee is free to change it: `ctx_execute_file` receives `<root>/g`, then
 * the child runs `rm -f ./g; ln -s /outside/secret.txt ./g; cat "$TARGET_FILE"`
 * across the `await` and the `spawn`, and reads a file outside the project with
 * `enforcement: full`. With the symlink already planted the same call is
 * refused, so the only variable is whether the tail existed when we looked.
 *
 * A path that is not there yet is therefore refused with a message that names
 * the problem instead of pretending the check passed. The returned path is one
 * `realpath` succeeded on, so every component — tail included — has been
 * canonical and inside `projectRoot` when the answer was produced.
 */
export function resolveProjectPath(projectRoot: string, relativePath: string): string {
  if (relativePath === '') throw new Error('Path must not be empty')
  if (path.isAbsolute(relativePath)) throw new Error('Absolute paths are not allowed')
  if (relativePath.includes('\0')) throw new Error('Path must not contain a NUL byte')

  const rootSpelling = path.resolve(projectRoot)
  let root: string
  try {
    root = fs.realpathSync.native(rootSpelling)
  } catch (error) {
    // Without a canonical root there is nothing to be contained in, so a root we
    // cannot resolve must not be answered with a path that inherits its spelling.
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Project root does not exist: ${rootSpelling}`)
    }
    throw new Error(`Project root cannot be resolved: ${rootSpelling}: ${describe(error)}`)
  }
  const candidate = path.resolve(root, relativePath)

  let canonical: string
  try {
    canonical = fs.realpathSync.native(candidate)
  } catch (error) {
    throw resolutionFailure(error, root, candidate, relativePath)
  }

  if (!within(root, canonical)) {
    throw new Error(`Path escapes project boundary: ${relativePath}`)
  }
  return canonical
}

/** Canonical containment: `target` is `base` itself or underneath it. */
function within(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}

/**
 * Turn a `realpath` failure into the error that actually describes it.
 *
 * A traversal or a symlinked ancestor that leaves the project is a boundary
 * violation even when the last component does not exist — `../escape.txt` must
 * not start reporting `ENOENT` just because nobody created the file — so the
 * boundary is re-checked on both the lexical spelling and the deepest existing
 * ancestor before any existence message is produced. Anything still inside the
 * project is missing, not escaping.
 */
function resolutionFailure(
  error: unknown,
  root: string,
  candidate: string,
  display: string,
): Error {
  if (!within(root, candidate) || !within(root, realpathNearest(candidate))) {
    return new Error(`Path escapes project boundary: ${display}`)
  }
  const code = errnoCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new Error(`Path does not exist: ${display}`)
  }
  return new Error(`Path cannot be resolved: ${display}: ${describe(error)}`)
}

/** The `errno` code of a filesystem failure, when the error carries one. */
function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** A readable one-token reason for a filesystem failure. */
function describe(error: unknown): string {
  return errnoCode(error) ?? (error as Error | undefined)?.message ?? String(error)
}

/**
 * `realpath` the deepest existing ancestor of `target`, leaving the rest joined.
 *
 * The joined tail is *not* verified, so this is only ever a diagnostic input:
 * {@link resolutionFailure} uses it to tell an escaping path from a missing one.
 * It must never become the answer a tool call is handed — that answer is always
 * the output of a `realpath` that succeeded on the whole path.
 */
function realpathNearest(target: string): string {
  let current = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      const resolved = fs.realpathSync.native(current)
      return tail.length === 0 ? resolved : path.join(resolved, ...tail)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}
