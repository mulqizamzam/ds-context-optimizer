/**
 * Confinement test.
 *
 * This one goes through the real `bwrap` backend the web profile mounts, because
 * the whole point of the plugin is that model-authored code runs behind the
 * host's file-effect boundary. A fake sandbox would only prove the executor
 * forwards whatever argv it is handed; proving the boundary actually denies a
 * write needs the real wrapper.
 *
 * It writes only inside the process working directory and deletes what it makes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const H = process.env.DSH_HARNESS_HOME ?? '/home/administrator/deepseek-harness'
const N = path.join(H, 'packages/core/tools/node_modules/@deepseek-ai')
const SANDBOX_ENTRY = path.join(H, 'packages/sandbox/sandbox-local/lib/index.js')

const missing = [path.join(N, 'cordis/lib/index.js'), SANDBOX_ENTRY].filter(
  (file) => !fs.existsSync(file),
)
const skip =
  missing.length === 0 ? false : `harness checkout unusable at ${H}; missing ${missing.join(', ')}`

const plugin = await import('../../dist/index.js')

/**
 * The sandbox provider mounts the enclosing filesystem. Under a WSL2 kernel it
 * normally reports `partial`; the assertions below are about the denial, not the
 * completeness label, and say so where they differ.
 */
async function confined(options) {
  const { Context } = await import(path.join(N, 'cordis/lib/index.js'))
  const LocalSandboxProvider = (await import(SANDBOX_ENTRY)).default
  const { SandboxExecutor, DEFAULT_EXECUTOR_OPTIONS } = await import('../../dist/executor.js')
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider)
  const sandbox = ctx.get('sandbox') ?? ctx.sandbox
  assert.equal(typeof sandbox.confine, 'function', 'the host sandbox service is missing')
  const executor = new SandboxExecutor(sandbox, { ...DEFAULT_EXECUTOR_OPTIONS, ...options })
  return executor
}

function probeDir() {
  const dir = path.resolve(process.cwd(), `.tmp-ctxopt-confine-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return { dir, relative: path.relative(process.cwd(), dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A path outside the workspace that is not `/tmp`.
 *
 * `/tmp` is the wrong escape target: `workspace-write` gives the child a private
 * tmpfs there, so a write succeeds while never reaching the host filesystem.
 * Measured: the child reported success with `hostExists=false`. The parent of
 * the working directory is a real read-only bind, so that is where a denial
 * shows.
 */
function escapeTarget() {
  return path.resolve(process.cwd(), `../ctxopt-escape-probe-${process.pid}`)
}

const hostTmpProbe = path.join(os.tmpdir(), `ctxopt-tmp-${process.pid}.txt`)

test.after(() => {
  fs.rmSync(escapeTarget(), { force: true })
  fs.rmSync(hostTmpProbe, { force: true })
})

test('the host wraps the requested argv in a real confinement runner', { skip }, async () => {
  const probe = probeDir()
  const executor = await confined({ sandboxMode: 'workspace-write', allowUnconfined: false })
  try {
    const result = await executor.run({
      language: 'bash',
      code: 'echo wrapped-ok',
      cwd: probe.dir,
    })
    assert.equal(result.unconfined, false)
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /wrapped-ok/)
    // The argv actually spawned is the wrapper's, not the one this plugin asked for.
    assert.notEqual(result.argv[0], 'bash')
    console.log(`    confinement argv[0]: ${result.argv[0]}  enforcement: ${result.enforcement}`)
  } finally {
    probe.cleanup()
  }
})

test('under workspace-write a write inside the workspace succeeds', { skip }, async () => {
  const probe = probeDir()
  const executor = await confined({ sandboxMode: 'workspace-write', allowUnconfined: false })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: "const fs = await import('node:fs'); fs.writeFileSync('inside.txt', 'writable'); console.log('wrote')",
      cwd: probe.dir,
    })
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.match(result.stdout, /wrote/)
    assert.equal(fs.readFileSync(path.join(probe.dir, 'inside.txt'), 'utf8'), 'writable')
  } finally {
    probe.cleanup()
  }
})

test('under workspace-write a write outside the workspace is denied by the real backend', { skip }, async () => {
  const probe = probeDir()
  const executor = await confined({ sandboxMode: 'workspace-write', allowUnconfined: false })
  const target = escapeTarget()
  fs.rmSync(target, { force: true })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(target)}, 'escaped'); console.log('escaped')`,
      cwd: probe.dir,
    })
    assert.notEqual(result.exitCode, 0, `the escape succeeded, stdout: ${result.stdout}`)
    assert.ok(!fs.existsSync(target), `a file was created outside the workspace at ${target}`)
    // The denial arrives as the backend's own read-only signal, not as a crash.
    assert.match(result.stderr, /EROFS|read-only/i)
  } finally {
    fs.rmSync(target, { force: true })
    probe.cleanup()
  }
})

test('a write to /tmp lands in an isolated tmpfs and never reaches the host filesystem', { skip }, async () => {
  // This documents the boundary instead of asserting it away: under
  // `workspace-write` the child gets a private `/tmp`, so the call succeeds while
  // the host path stays untouched. Anyone treating /tmp as a channel between the
  // child and the host would be wrong.
  const probe = probeDir()
  const executor = await confined({ sandboxMode: 'workspace-write', allowUnconfined: false })
  fs.rmSync(hostTmpProbe, { force: true })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(hostTmpProbe)}, 'x'); console.log('wrote')`,
      cwd: probe.dir,
    })
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.equal(fs.existsSync(hostTmpProbe), false, 'the host /tmp was written through the isolation')
  } finally {
    fs.rmSync(hostTmpProbe, { force: true })
    probe.cleanup()
  }
})

test('under read-only a write inside the workspace is denied too', { skip }, async () => {
  const probe = probeDir()
  const executor = await confined({ sandboxMode: 'read-only', allowUnconfined: false })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: "const fs = await import('node:fs'); fs.writeFileSync('nope.txt', 'x'); console.log('wrote')",
      cwd: probe.dir,
    })
    assert.notEqual(result.exitCode, 0, `the read-only write succeeded, stdout: ${result.stdout}`)
    assert.ok(!fs.existsSync(path.join(probe.dir, 'nope.txt')))
  } finally {
    probe.cleanup()
  }
})

test('a caller-supplied HOME never reaches the confined child', { skip }, async () => {
  // `request.env` is merged with the pinned `HOME`, and the pin has to be the
  // one that survives. The unit test asserts the merge order directly; this
  // asserts the consequence through the real runner, where the child's
  // `process.env` is whatever the wrapper actually handed it.
  const probe = probeDir()
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-scratch-'))
  const decoy = path.join(probe.dir, 'decoy-home')
  const executor = await confined({ sandboxMode: 'workspace-write', allowUnconfined: false, scratchDir: scratch })
  try {
    const result = await executor.run({
      language: 'javascript',
      code: 'console.log(process.env.HOME)',
      cwd: probe.dir,
      env: { HOME: decoy },
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), scratch)
    assert.ok(!result.stdout.includes(decoy), 'request.env won over the pinned HOME')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
    probe.cleanup()
  }
})

test('the plugin reports the real enforcement instead of claiming a boundary it cannot prove', { skip }, async () => {
  const probe = probeDir()
  const ctx = { tools: { register: () => () => {} }, get: () => undefined, on: () => () => {}, effect: () => () => {} }
  ctx.inject = (_services, callback) => callback(ctx)
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxopt-confine-view-'))
  try {
    const { Context } = await import(path.join(N, 'cordis/lib/index.js'))
    const LocalSandboxProvider = (await import(SANDBOX_ENTRY)).default
    const host = new Context()
    await host.plugin(LocalSandboxProvider)
    const adapter = {
      tools: { register: () => () => {} },
      get: (name) => host.get(name),
      on: (name, listener, options) => host.on(name, listener, options),
      effect: (body, label) => host.effect(body, label),
      inject: (_services, callback) => callback(adapter),
    }
    const view = plugin.apply(adapter, { stateDir, session: { injectSnapshot: false } })
    assert.equal(view.sandbox.available, true)
    assert.equal(view.sandbox.allowUnconfined, false, 'the default must refuse rather than run unconfined')
    assert.equal(view.errors.length, 0, view.errors.join('; '))
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
    void ctx
    probe.cleanup()
  }
})