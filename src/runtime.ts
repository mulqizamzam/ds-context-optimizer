import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Language, RuntimeSpec } from './types.js'

/**
 * Argv for each supported language. Code always travels on **stdin**: passing it
 * as an argument would expose the whole program in `ps` output, and `sh -c` /
 * `bash -c` would additionally fold the program's own metacharacters into the
 * shell grammar.
 */
const RUNTIMES: Record<Language, RuntimeSpec> = {
  javascript: { program: 'node', args: ['--input-type=module'] },
  // `--input-type=module-typescript`, not `--input-type=module` plus
  // `--experimental-strip-types`: on Node 24 the strip-types flag is a no-op for a
  // program arriving on stdin, so the raw TypeScript was parsed as JavaScript and
  // every typescript run died with `SyntaxError: Missing initializer in const
  // declaration`. Measured before the fix: exit 1. The module-typescript input
  // type both strips the types and loads the result as an ES module: exit 0.
  typescript: { program: 'node', args: ['--input-type=module-typescript'] },
  python: { program: 'python3', args: ['-u', '-'] },
  bash: { program: 'bash', args: ['-s'] },
  ruby: { program: 'ruby', args: ['-'] },
  php: { program: 'php', args: ['-'] },
  perl: { program: 'perl', args: ['-'] },
  r: { program: 'Rscript', args: ['-'] },
  lua: { program: 'lua', args: ['-'] },
  go: { program: 'go', args: ['run', '-'] },
  rust: { program: 'rust-script', args: ['-'] },
  deno: { program: 'deno', args: ['run', '--ext', 'ts', '-'] },
}

export const LANGUAGES: readonly Language[] = Object.keys(RUNTIMES) as Language[]

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(RUNTIMES, value)
}

export function runtimeFor(language: Language): RuntimeSpec {
  return RUNTIMES[language]
}

/**
 * Probe `PATH` for the launcher of `language`.
 *
 * The search is done here rather than by delegating to `which(1)`, because
 * spawning `which` means resolving `which` against the very PATH being probed:
 * a PATH that can run the interpreter but does not itself contain `which` then
 * fails with `ENOENT`, and a runtime that works is reported as not installed.
 * `ctx_doctor` cannot tell that apart from a real absence. Measured before the
 * fix: with `pathValue` set to the directory holding `node`, the probe returned
 * `false` while `node` itself ran the same program fine.
 *
 * The in-process search keeps the property `which` was chosen for: a file that
 * exists but is not executable still counts as missing, because `access(X_OK)`
 * fails on it. A PATH entry that cannot be read at all is not evidence of
 * absence either, so it produces {@link RuntimeProbeStatus} `unprobeable`
 * instead of `missing`.
 */
export type RuntimeProbeStatus = 'available' | 'missing' | 'unprobeable'

export interface RuntimeProbe {
  readonly status: RuntimeProbeStatus
  /** Program that was searched for, for the report that carries this probe. */
  readonly program: string
  /** Where it was found, or why the search could not answer. */
  readonly detail: string
}

/** errno values that mean "not in this entry", not "this entry could not be read". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'])

export function probeRuntime(language: string, pathValue: string): RuntimeProbe {
  const spec = RUNTIMES[language as Language]
  if (spec === undefined) {
    return { status: 'missing', program: String(language), detail: 'unsupported language' }
  }
  const { program } = spec
  let unreadable: string | undefined
  for (const entry of pathValue.split(delimiter)) {
    // An empty PATH component means "the current directory" per POSIX, which
    // would make the answer depend on `process.cwd()` rather than on the PATH.
    if (entry === '') continue
    const candidate = join(entry, program)
    let stats
    try {
      // `statSync` follows the symlink, so a symlink to a real binary counts and
      // a directory named `node` does not — the same test `which(1)` applies.
      stats = statSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== undefined && ABSENT_CODES.has(code)) continue
      // The entry itself could not be read, so nothing follows from it.
      unreadable ??= `${candidate}: ${code ?? String(error)}`
      continue
    }
    if (!stats.isFile()) continue
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      // The file exists, so it is simply not executable here: `which(1)` counts
      // that as not found, and the search carries on to the next entry.
      continue
    }
    return { status: 'available', program, detail: `found at ${candidate}` }
  }
  if (unreadable !== undefined) {
    return { status: 'unprobeable', program, detail: `PATH entry could not be read: ${unreadable}` }
  }
  return { status: 'missing', program, detail: `${program} is not on this PATH` }
}

/**
 * Boolean view of {@link probeRuntime} for callers that only want a display
 * value.
 *
 * Only a search that actually ran may report an absence. A probe that could not
 * run says nothing about the runtime, and returning `false` for it would tell
 * `ctx_doctor` to send the operator hunting for an install that may already be
 * there; `true` merely leaves the claim unverified, which is what the run itself
 * then decides. Callers that can show a third state should use `probeRuntime`.
 */
export function runtimeAvailable(language: string, pathValue: string): boolean {
  return probeRuntime(language, pathValue).status !== 'missing'
}