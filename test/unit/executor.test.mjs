import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SandboxExecutor, UnconfinedExecutionError, DEFAULT_EXECUTOR_OPTIONS } from '../../dist/executor.js'
import { probeRuntime, runtimeAvailable } from '../../dist/runtime.js'

/**
 * Minimal stand-in for the host sandbox: records the argv it was asked to wrap.
 *
 * By default it returns the argv unchanged, because the executor spawns whatever
 * comes back and a fabricated wrapper path would only fail with ENOENT. Pass
 * `prefix` to model a backend that really does prepend something.
 */
function fakeSandbox({ enforcement = 'full', prefix = [] } = {}) {
  const calls = []
  return {
    calls,
    confine(argv, receivedPolicy) {
      calls.push({ argv: [...argv], policy: receivedPolicy })
      return {
        argv: [...prefix, ...argv],
        enforcement,
        denialSignatures: [],
        runnerFailureRules: [],
      }
    },
    lastPolicy: () => calls.at(-1)?.policy,
  }
}

function newWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-exec-'))
  fs.writeFileSync(path.join(dir, 'input.txt'), 'payload-from-file')
  return dir
}

/**
 * A PATH entry the probe cannot even stat.
 *
 * A symlink that points at itself makes `stat` fail with ELOOP rather than
 * ENOENT, which is the shape of a real failure: the entry exists, the probe
 * could not read it, so it must not conclude that the runtime is absent.
 */
function selfReferencingDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-path-loop-'))
  fs.symlinkSync('loop', path.join(dir, 'loop'))
  return path.join(dir, 'loop')
}

const baseOptions = { ...DEFAULT_EXECUTOR_OPTIONS, allowUnconfined: true, scratchDir: '/tmp' }

test('code reaches the runtime on stdin and stdout comes back', async () => {
  const dir = newWorkspace()
  const sandbox = fakeSandbox()
  const executor = new SandboxExecutor(sandbox, { ...baseOptions, sandboxMode: 'workspace-write' })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log("from-node")',
      cwd: dir,
    })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /from-node/)
    assert.equal(result.enforcement, 'full')
    assert.equal(result.unconfined, false)
    // The code must never appear as an argv element.
    assert.ok(!sandbox.calls[0].argv.includes('console.log("from-node")'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-zero exit is reported as a non-zero exit, not as success', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  try {
    const result = await executor.run({ language: 'javascript', code: 'process.exit(3)', cwd: dir })
    assert.equal(result.exitCode, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a program that never exits is killed and reported as a timeout', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), { ...baseOptions, defaultTimeoutMs: 700 })
  try {
    const result = await executor.run({ language: 'javascript', code: 'setInterval(() => {}, 1000)', cwd: dir })
    assert.equal(result.exitCode, 124)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an abort signal stops the child', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const controller = new AbortController()
  try {
    const pending = executor.run({
      language: 'javascript',
      code: 'setInterval(() => {}, 1000)',
      cwd: dir,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await pending
    assert.notEqual(result.exitCode, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a signal that fires mid-run kills the child before its delayed side effect', async () => {
  // The mid-run half of the abort contract: the kill has to land while the
  // program is still running, not after it has finished what it wanted to do.
  // The follow-up waits past the timer, so a late write would be observed here.
  const dir = newWorkspace()
  const sideEffect = path.join(dir, 'after-abort.txt')
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const controller = new AbortController()
  try {
    const pending = executor.run({
      language: 'javascript',
      code: `const fs = await import('node:fs')
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(sideEffect)}, 'ran-after-abort')
  console.log('RAN-AFTER-ABORT')
}, 400)`,
      cwd: dir,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 150)
    const result = await pending
    assert.notEqual(result.exitCode, 0, `the abort did not stop the child: ${JSON.stringify(result)}`)
    assert.ok(!result.stdout.includes('RAN-AFTER-ABORT'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(fs.existsSync(sideEffect), false, 'the child kept running after the abort')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an abort mid-flight is reported as the kill code, with what it captured', async () => {
  // The in-flight half of the abort contract: the child exists, so it is
  // signalled rather than skipped. What must survive that is the accounting —
  // a signalled child is never a success, whatever it printed before it died is
  // still returned, and `truncated` keeps agreeing with the text it returned.
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const controller = new AbortController()
  try {
    const pending = executor.run({
      language: 'javascript',
      code: `console.log('printed-before-the-abort')
setInterval(() => {}, 1000)`,
      cwd: dir,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    assert.equal(result.exitCode, 137, `a signalled child was not reported as killed: ${JSON.stringify(result)}`)
    assert.match(result.stdout, /printed-before-the-abort/, 'output captured before the kill was thrown away')
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= baseOptions.maxStdoutBytes)
    assert.equal(
      result.truncated,
      result.stdout.includes('[truncated]') || result.stderr.includes('[truncated]'),
      'truncated disagreed with the marker in the returned text',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the abort listener never outlives the run it was attached to', async () => {
  // A caller that reuses one signal across many runs — `ctx_batch_execute`'s
  // worker is exactly that shape — would otherwise accumulate one listener per
  // run, and a later abort would reach runs that had already settled.
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const controller = new AbortController()
  const listeners = () => getEventListeners(controller.signal, 'abort').length
  try {
    const completed = await executor.run({ language: 'bash', code: 'true', cwd: dir, signal: controller.signal })
    assert.equal(completed.exitCode, 0)
    assert.equal(listeners(), 0, 'a completed run left an abort listener attached')

    const timedOut = await executor.run({
      language: 'javascript',
      code: 'setInterval(() => {}, 1000)',
      cwd: dir,
      signal: controller.signal,
      timeoutMs: 300,
    })
    assert.equal(timedOut.exitCode, 124)
    assert.equal(listeners(), 0, 'a timed-out run left an abort listener attached')

    const pending = executor.run({
      language: 'javascript',
      code: 'setInterval(() => {}, 1000)',
      cwd: dir,
      signal: controller.signal,
    })
    assert.equal(listeners(), 1, 'an in-flight run must be listening for the abort it cannot act on by itself')
    controller.abort()
    assert.notEqual((await pending).exitCode, 0)
    assert.equal(listeners(), 0, 'an aborted run left an abort listener attached')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a signal that is already aborted on entry runs nothing at all', async () => {
  // This is the executor's own API contract, exercised where it is reachable: a
  // direct `run()` handed a signal that aborted before the call. The host does
  // not reach this state — it rejects a pre-dispatch abort before a tool
  // executes — so nothing here is a claim about `ctx_execute`; it is the hole a
  // direct caller, or any loop that reuses one signal, would walk into.
  // `addEventListener('abort', …)` never fires for an already-aborted signal, so
  // before the guard the child was spawned, printed, and wrote its file.
  const dir = newWorkspace()
  const sideEffect = path.join(dir, 'pre-aborted.txt')
  // The prefix models a backend that really would have wrapped the argv. It must
  // appear nowhere in the result: the wrapper was never executed, and `argv`
  // exists for diagnosing a runner failure, so reporting one that never ran is a
  // lie in exactly the field a caller would read it in.
  const sandbox = fakeSandbox({ prefix: ['/fake/bwrap'] })
  const executor = new SandboxExecutor(sandbox, baseOptions)
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await executor.run({
      language: 'javascript',
      code: `const fs = await import('node:fs')
console.log('PRE-ABORTED-CHILD-RAN')
fs.writeFileSync(${JSON.stringify(sideEffect)}, 'ran-anyway')`,
      cwd: dir,
      signal: controller.signal,
    })
    assert.equal(sandbox.calls.length, 0, 'the sandbox was consulted even though nothing would be spawned')
    assert.deepEqual(result.argv, ['node', '--input-type=module'], 'argv must be the requested command, not a wrapper')
    assert.notEqual(result.argv[0], '/fake/bwrap')
    assert.notEqual(result.exitCode, 0, 'an aborted request was reported as a success')
    assert.ok(!result.stdout.includes('PRE-ABORTED-CHILD-RAN'))
    assert.equal(result.truncated, false)
    // No process started, so no confinement mode may be claimed either: the
    // boundary was never exercised, and nothing ran unconfined because nothing ran.
    assert.equal(result.enforcement, 'partial', 'a run that never started claimed a complete boundary')
    assert.equal(result.unconfined, false, 'nothing ran, so nothing ran unconfined')
    assert.equal(fs.existsSync(sideEffect), false, 'an aborted request still ran its side effect')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a caller that loops with one signal gets nothing from it after it aborts', async () => {
  // What a loop is entitled to expect from the executor, verified against the
  // executor alone: after the signal aborts, every further `run()` on it is a
  // no-op result. The batch worker's own mid-flight handling lives in
  // `src/index.ts` and is out of this file's hands; this is the floor under it.
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const controller = new AbortController()
  const run = (code) => executor.run({ language: 'bash', code, cwd: dir, signal: controller.signal })
  try {
    const first = await run('echo FIRST-COMMAND')
    assert.match(first.stdout, /FIRST-COMMAND/, 'the first command should have run')
    controller.abort()
    for (const code of ['echo SECOND-COMMAND', 'echo THIRD-COMMAND']) {
      const result = await run(code)
      assert.notEqual(result.exitCode, 0, `${code} ran after the signal aborted`)
      assert.equal(result.stdout, '')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses to run unconfined when no backend exists and the operator did not opt in', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(undefined, { ...DEFAULT_EXECUTOR_OPTIONS, allowUnconfined: false })
  try {
    await assert.rejects(
      () => executor.run({ language: 'javascript', code: 'console.log(1)', cwd: dir }),
      UnconfinedExecutionError,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runs unconfined only when explicitly allowed, and says so on the result', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(undefined, { ...DEFAULT_EXECUTOR_OPTIONS, allowUnconfined: true })
  try {
    const result = await executor.run({ language: 'javascript', code: 'console.log(1)', cwd: dir })
    assert.equal(result.unconfined, true)
    assert.equal(result.enforcement, 'partial')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the requested policy carries the mode, workspace root, and session id', async () => {
  const dir = newWorkspace()
  const sandbox = fakeSandbox()
  const executor = new SandboxExecutor(sandbox, { ...baseOptions, sandboxMode: 'read-only' })
  try {
    await executor.run({ language: 'bash', code: 'true', cwd: dir, sessionId: 'sess-42' })
    assert.deepEqual(sandbox.lastPolicy(), { mode: 'read-only', workspaceRoot: dir, sessionId: 'sess-42' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a session id is omitted from the policy rather than sent as undefined', async () => {
  const dir = newWorkspace()
  const sandbox = fakeSandbox()
  const executor = new SandboxExecutor(sandbox, baseOptions)
  try {
    await executor.run({ language: 'bash', code: 'true', cwd: dir })
    assert.ok(!('sessionId' in sandbox.lastPolicy()))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the host environment is not inherited, so a secret cannot be read out of it', async () => {
  const dir = newWorkspace()
  process.env.CTXOPT_SECRET_CANARY = 'super-secret-value'
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log(process.env.CTXOPT_SECRET_CANARY ?? "absent")',
      cwd: dir,
    })
    assert.match(result.stdout, /absent/)
    assert.ok(!result.stdout.includes('super-secret-value'))
  } finally {
    delete process.env.CTXOPT_SECRET_CANARY
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an allowlisted variable does reach the child', async () => {
  const dir = newWorkspace()
  process.env.CTXOPT_ALLOWED = 'visible'
  const executor = new SandboxExecutor(fakeSandbox(), { ...baseOptions, envAllowlist: ['PATH', 'CTXOPT_ALLOWED'] })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log(process.env.CTXOPT_ALLOWED)',
      cwd: dir,
    })
    assert.match(result.stdout, /visible/)
  } finally {
    delete process.env.CTXOPT_ALLOWED
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('HOME points at the scratch directory, not at the caller project', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), { ...baseOptions, scratchDir: '/tmp' })
  try {
    const result = await executor.run({ language: 'javascript', code: 'console.log(process.env.HOME)', cwd: dir })
    assert.match(result.stdout, /\/tmp/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a caller cannot undo the pinned HOME by supplying its own', async () => {
  // The merge order is the whole contract: caller variables are applied and the
  // pins are re-asserted afterwards, so `env.HOME` cannot move the child's home
  // back to a real one and litter it.
  const dir = newWorkspace()
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-scratch-'))
  const executor = new SandboxExecutor(fakeSandbox(), { ...baseOptions, scratchDir: scratch })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log(JSON.stringify([process.env.HOME, process.env.MY_VAR]))',
      cwd: dir,
      env: { HOME: process.env.HOME ?? '/home/administrator', MY_VAR: 'kept' },
    })
    assert.equal(result.exitCode, 0, result.stderr)
    const [home, mine] = JSON.parse(result.stdout)
    assert.equal(home, scratch, 'request.env overwrote the pinned HOME')
    assert.equal(mine, 'kept', 'a non-colliding caller variable must still reach the child')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a caller cannot substitute the confined TARGET_FILE either', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const target = path.join(dir, 'input.txt')
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log(process.env.TARGET_FILE)',
      cwd: dir,
      targetFile: target,
      env: { TARGET_FILE: '/etc/passwd' },
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), target)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a type-annotated program runs as typescript, not as broken javascript', async () => {
  // The `typescript` runtime advertised by the tool enum used to be
  // `--input-type=module --experimental-strip-types`, and on Node 24 the strip
  // flag does nothing for a program on stdin: the raw TypeScript was parsed as
  // JavaScript and every run failed. Nothing executed a TypeScript program, so
  // nothing noticed.
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  try {
    const result = await executor.run({
      language: 'typescript',
      code: 'interface P { n: number }\nconst value: P = { n: 41 }\nconsole.log("ts-ok", value.n + 1)',
      cwd: dir,
    })
    assert.equal(result.exitCode, 0, `the typescript runtime did not run: ${result.stderr}`)
    assert.equal(result.stdout.trim(), 'ts-ok 42')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('typescript is asked to parse types, and javascript is not', async () => {
  // Pins the fix where it lives: in the argv. The execution test above proves the
  // program runs; this says why, so a future flag reshuffle fails here with the
  // argv in the message instead of surfacing as a mysterious syntax error.
  const sandbox = fakeSandbox()
  const executor = new SandboxExecutor(sandbox, baseOptions)
  const dir = newWorkspace()
  try {
    await executor.run({ language: 'typescript', code: 'const n: number = 1', cwd: dir })
    await executor.run({ language: 'javascript', code: 'const n = 1', cwd: dir })
    const [typescriptArgv, javascriptArgv] = sandbox.calls.map((call) => call.argv)
    assert.ok(
      typescriptArgv.includes('--input-type=module-typescript'),
      `unexpected typescript argv: ${JSON.stringify(typescriptArgv)}`,
    )
    assert.ok(!javascriptArgv.includes('--input-type=module-typescript'))
    assert.ok(!typescriptArgv.includes('--experimental-strip-types'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the target file is exposed as TARGET_FILE and stays project-confined', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log(process.env.TARGET_FILE)',
      cwd: dir,
      targetFile: path.join(dir, 'input.txt'),
    })
    assert.equal(result.exitCode, 0)
    assert.ok(!result.stdout.trim().includes('\n'))
    assert.ok(result.stdout.trim().endsWith('input.txt'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stdout is bounded and marked truncated when the program floods it', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), { ...baseOptions, maxStdoutBytes: 2_048 })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'for (let i = 0; i < 200000; i++) process.stdout.write("abcdefgh")',
      cwd: dir,
    })
    assert.equal(result.truncated, true)
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 2_048)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a payload above the collector ceiling still ends with its real last line', async () => {
  // The collector used to keep only the first 1 MiB, so `truncateStdout` split
  // filler: the head and tail it handed back were both from the middle of the
  // stream and the real last line was gone, while output under the ceiling
  // survived because nothing was dropped. Only head + tail retention makes the
  // sentinel below reachable.
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  const payload = 4_000_000
  try {
    const result = await executor.run({
      language: 'javascript',
      code: `process.stdout.write('a'.repeat(${payload}))
process.stdout.write('FINAL-ERROR-LINE\\n')`,
      cwd: dir,
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.truncated, true)
    assert.ok(
      result.stdout.endsWith('FINAL-ERROR-LINE\n'),
      `the real tail of ${payload} bytes was lost; stdout ends: ${JSON.stringify(result.stdout.slice(-40))}`,
    )
    assert.match(result.stdout, /\.\.\.\[truncated\]\.\.\./)
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= baseOptions.maxStdoutBytes)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a truncated result always shows the marker, even above the collector ceiling', async () => {
  // `maxStdoutBytes` above the 1 MiB collector ceiling used to yield
  // `truncated: true` with a full 1 MiB of output and no marker anywhere: the
  // truncation happened inside the collector, where nothing recorded it in the
  // text, so the head/tail split in `truncateStdout` never ran. Measured before
  // the fix: 1048576 bytes, `truncated: true`, no `[truncated]` substring.
  const dir = newWorkspace()
  const maxStdoutBytes = 2 * 1024 * 1024
  const executor = new SandboxExecutor(fakeSandbox(), { ...baseOptions, maxStdoutBytes })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: `process.stdout.write('b'.repeat(${maxStdoutBytes}))
process.stdout.write('LAST-B-LINE\\n')`,
      cwd: dir,
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.truncated, true)
    assert.match(result.stdout, /\.\.\.\[truncated\]\.\.\./, 'a truncated result must say where bytes were dropped')
    assert.ok(
      result.stdout.endsWith('LAST-B-LINE\n'),
      `the tail was lost above the ceiling; stdout ends: ${JSON.stringify(result.stdout.slice(-40))}`,
    )
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= maxStdoutBytes)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing launcher surfaces the spawn error instead of hanging', async () => {
  const dir = newWorkspace()
  const executor = new SandboxExecutor(fakeSandbox(), baseOptions)
  try {
    await assert.rejects(
      () => executor.run({ language: 'rust', code: 'fn main(){}', cwd: dir }),
      (error) => error.code === 'ENOENT',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the argv actually spawned is the one the sandbox returned', async () => {
  const dir = newWorkspace()
  // `env` is a real launcher, so the wrapped argv genuinely runs while still
  // proving the executor used the sandbox's return value rather than its own.
  const sandbox = fakeSandbox({ enforcement: 'partial', prefix: ['/usr/bin/env'] })
  const executor = new SandboxExecutor(sandbox, baseOptions)
  try {
    const result = await executor.run({ language: 'bash', code: 'echo wrapped', cwd: dir })
    assert.equal(result.exitCode, 0)
    assert.equal(result.enforcement, 'partial')
    assert.equal(result.argv[0], '/usr/bin/env')
    assert.match(result.stdout, /wrapped/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a PATH that holds the interpreter but not which still reports it available', () => {
  // The probe used to spawn `which`, which is itself resolved through the PATH
  // being probed. A PATH carrying `node` and no `which` made the probe die with
  // ENOENT and `runtimeAvailable` answer `false` — indistinguishable from a
  // runtime that is not installed, so `ctx_doctor` told the operator to install
  // something that already worked. Measured before the fix: `false`, while the
  // executor ran that very interpreter with exit 0.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-probe-bin-'))
  const launcher = path.join(binDir, 'node')
  try {
    fs.symlinkSync(process.execPath, launcher)
    assert.equal(fs.existsSync(path.join(binDir, 'which')), false, 'the fixture must not contain which')
    assert.equal(probeRuntime('javascript', binDir).status, 'available')
    assert.equal(runtimeAvailable('javascript', binDir), true)
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true })
  }
})

test('a probe that cannot read the PATH reports unprobeable instead of absent', () => {
  // The distinction `ctx_doctor` needs: "not installed" sends someone to install
  // a runtime, while "could not check" does not. A PATH entry the probe cannot
  // stat answers neither, and must never collapse into the first.
  const looped = selfReferencingDir()
  try {
    const probe = probeRuntime('javascript', looped)
    assert.equal(probe.status, 'unprobeable', `expected an unreadable PATH entry, got ${JSON.stringify(probe)}`)
    assert.match(probe.detail, /could not be read/)
    // The boolean view cannot show the third state, so it must not report an
    // absence it never established.
    assert.notEqual(runtimeAvailable('javascript', looped), false)
  } finally {
    fs.rmSync(path.dirname(looped), { recursive: true, force: true })
  }
})

test('a runtime that really is absent is still reported as missing', () => {
  // The guard on the other side: a probe that could not read anything must not
  // turn into "everything is installed".
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-probe-empty-'))
  try {
    const probe = probeRuntime('javascript', emptyDir)
    assert.equal(probe.status, 'missing', JSON.stringify(probe))
    assert.equal(probe.program, 'node')
    assert.equal(runtimeAvailable('javascript', emptyDir), false)
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('a non-executable file in a PATH entry counts as missing, as which(1) counted it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-probe-noexec-'))
  try {
    fs.writeFileSync(path.join(dir, 'node'), 'not a launcher', { mode: 0o644 })
    fs.chmodSync(path.join(dir, 'node'), 0o644)
    assert.equal(probeRuntime('javascript', dir).status, 'missing')
    assert.equal(runtimeAvailable('javascript', dir), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})