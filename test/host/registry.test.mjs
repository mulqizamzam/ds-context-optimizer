/**
 * Host-pipeline tests.
 *
 * These do not assert against a mock. They boot the real `@deepseek-ai/cordis`
 * Context from the harness checkout, mount the real `SystemPrompt`, `ToolRuntime`
 * and `LocalSandboxProvider` services, install this plugin against that Context,
 * and drive `ctx.tools.execute(...)` end to end — the same registration,
 * serialization and execution path a model tool call takes.
 *
 * `DSH_HARNESS_HOME` selects the checkout (default
 * `/home/administrator/deepseek-harness`). When it is absent the whole file
 * skips rather than reporting a green run it never performed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const H = process.env.DSH_HARNESS_HOME ?? '/home/administrator/deepseek-harness'
const N = path.join(H, 'packages/core/tools/node_modules/@deepseek-ai')
const TOOLS_ENTRY = path.join(H, 'packages/core/tools/lib/index.js')
const SANDBOX_ENTRY = path.join(H, 'packages/sandbox/sandbox-local/lib/index.js')

const REQUIRED = [
  path.join(N, 'cordis/lib/index.js'),
  path.join(N, 'dsh-system-prompt/lib/index.js'),
  path.join(N, 'dsh-llm/lib/index.js'),
  TOOLS_ENTRY,
  SANDBOX_ENTRY,
]
const missing = REQUIRED.filter((file) => !fs.existsSync(file))
const skip =
  missing.length === 0 ? false : `harness checkout unusable at ${H}; missing ${missing.join(', ')}`

const plugin = await import('../../dist/index.js')
const toolsModule = skip ? undefined : await import(TOOLS_ENTRY)
const harness = skip
  ? undefined
  : {
      Context: (await import(path.join(N, 'cordis/lib/index.js'))).Context,
      SystemPrompt: (await import(path.join(N, 'dsh-system-prompt/lib/index.js'))).default,
      ToolRuntime: toolsModule.default,
      CallId: (await import(path.join(N, 'dsh-llm/lib/index.js'))).CallId,
      LocalSandboxProvider: (await import(SANDBOX_ENTRY)).default,
    }

const EXPECTED_TOOLS = [
  'ctx_batch_execute',
  'ctx_doctor',
  'ctx_execute',
  'ctx_execute_file',
  'ctx_fetch_and_index',
  'ctx_index',
  'ctx_purge',
  'ctx_resume',
  'ctx_search',
  'ctx_stats',
]

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

/**
 * A fixture tree inside the host process working directory.
 *
 * `ctx_index` and `ctx_execute_file` are project-confined by design, and the
 * host pipeline calls them with no agent attached, so the project root is the
 * process cwd. The fixture therefore has to live under it and be named
 * relatively — which is exactly the contract the tools promise.
 */
function workFixture(label) {
  const root = path.resolve(process.cwd(), `.tmp-ctxopt-${label}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  return { root, relative: path.relative(process.cwd(), root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/**
 * Boot one real host Context and install the plugin against it.
 *
 * The plugin receives a thin adapter rather than the Context itself, so a member
 * the plugin expects but the host lacks shows up here as a `undefined is not a
 * function` instead of being absorbed by the plugin's feature detection.
 */
async function boot(config = {}) {
  const stateDir = tempDir('ctxopt-host-')
  const ctx = new harness.Context()
  await ctx.plugin(harness.SystemPrompt)
  await ctx.plugin(harness.ToolRuntime)
  await ctx.plugin(harness.LocalSandboxProvider)

  const adapter = {
    tools: ctx.tools,
    get: (name) => ctx.get(name),
    on: (name, listener, options) => ctx.on(name, listener, options),
    effect: (body, label) => ctx.effect(body, label),
    inject: (_services, callback) => callback(adapter),
  }
  const view = plugin.apply(adapter, { stateDir, ...config })
  let seq = 0
  return {
    ctx,
    view,
    stateDir,
    call: (name, args, options = {}) => {
      seq += 1
      return ctx.tools.execute({
        signal: options.signal ?? new AbortController().signal,
        callId: harness.CallId(`call-${seq}`),
        name,
        arguments: args,
      })
    },
    cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
  }
}

/** A bare Context with only the two services a negative-path test needs. */
async function bareContext() {
  const ctx = new harness.Context()
  await ctx.plugin(harness.SystemPrompt)
  await ctx.plugin(harness.ToolRuntime)
  return ctx
}

/** The default adapter shape, factored out so a test can drop one member. */
function hostAdapter(ctx, overrides = {}) {
  const adapter = {
    tools: ctx.tools,
    get: (name) => ctx.get(name),
    on: (name, listener, options) => ctx.on(name, listener, options),
    effect: (body, label) => ctx.effect(body, label),
    inject: (_services, callback) => callback(adapter),
    ...overrides,
  }
  return adapter
}

/** A tool whose `execute` payload exists nowhere in its arguments. */
function bashProbe() {
  return {
    name: 'bash',
    description: 'probe shell tool carrying a command argument',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell text.' } },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ ok: true, ran: true, probeOutcomeToken: 'probe-outcome-token' }),
  }
}

let probeCallSeq = 0
function caller(ctx, name, args) {
  probeCallSeq += 1
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: harness.CallId(`probe-call-${probeCallSeq}`),
    name,
    arguments: args,
  })
}

/**
 * A loopback HTTP server the test owns.
 *
 * `ctx_fetch_and_index` refuses private and loopback addresses unless the host is
 * allowlisted, so a test that wants to exercise the real socket path configures
 * `fetch.allowHosts` for exactly this server.
 */
async function loopbackServer(route) {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    route(req, res, { close: () => { res.destroy() } })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: (requestPath) => `http://127.0.0.1:${server.address().port}${requestPath}`,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(done)
      }),
  }
}

/**
 * Fail a promise that never settles instead of hanging the suite.
 *
 * A regression that drops the fetch deadline leaves a call pending forever, so
 * the assertion has to be able to fail rather than time out silently.
 */
function settleWithin(promise, ms, what) {
  let timer
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/** Write a large body and report how many bytes the socket actually took. */
function floodingRoute(totalBytes) {
  const sent = { bytes: 0 }
  return {
    sent,
    route(req, res, helpers) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.on('error', () => {})
      let written = 0
      const chunk = Buffer.alloc(65_536, 0x61)
      const pump = () => {
        while (written < totalBytes) {
          written += chunk.length
          sent.bytes = written
          try {
            if (!res.write(chunk)) {
              res.once('drain', pump)
              return
            }
          } catch {
            helpers.close()
            return
          }
        }
        try {
          res.end()
        } catch {
          /* the client is already gone */
        }
      }
      pump()
    },
  }
}

test('host versions are reported so a version skew is visible, not assumed', { skip }, () => {
  const hostPkg = path.join(H, 'packages/core/tools/package.json')
  const profilePkg =
    '/home/administrator/agent-workspace/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tools/package.json'
  assert.ok(fs.existsSync(hostPkg), 'harness tools package.json missing')
  console.log(`    harness packages/core/tools: ${JSON.parse(fs.readFileSync(hostPkg, 'utf8')).version}`)
  if (fs.existsSync(profilePkg)) {
    console.log(`    web profile dsh-tools:       ${JSON.parse(fs.readFileSync(profilePkg, 'utf8')).version}`)
  }
})

test('every tool registers against the real registry with no error', { skip }, async () => {
  const host = await boot()
  try {
    const registered = host.ctx.tools.schemas().map((schema) => schema.name).sort()
    for (const name of EXPECTED_TOOLS) {
      assert.ok(registered.includes(name), `${name} missing from the real registry`)
    }
    assert.deepEqual(host.view.registrations.filter((entry) => !entry.ok), [])
    assert.deepEqual(host.view.errors, [])
    assert.equal(host.view.sandbox.available, true, 'the host sandbox service was not resolved')
  } finally {
    host.cleanup()
  }
})

test('the real registry refuses a definition without output, so the plugin declarations are load-bearing', { skip }, async () => {
  const ctx = await bareContext()
  const broken = {
    name: 'broken_probe_tool',
    description: 'a definition with no output declaration',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({}),
  }
  assert.throws(
    () => ctx.tools.register(broken),
    (error) => error.name === 'TypeError' && /must declare output/.test(error.message),
  )
})

test('the real registry refuses a duplicate tool name', { skip }, async () => {
  const host = await boot()
  const stateDir = tempDir('ctxopt-dupe2-')
  try {
    // `schemas()` projects only the model-facing schema, so re-registering it
    // would fail on the missing output rather than on the duplicate. Capture a
    // real definition instead.
    const captured = []
    const recorder = {
      tools: { register: (definition) => { captured.push(definition); return () => {} } },
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
      inject: (_services, callback) => callback(recorder),
    }
    plugin.apply(recorder, { stateDir, session: { injectSnapshot: false } })
    const stats = captured.find((definition) => definition.name === 'ctx_stats')
    assert.ok(stats, 'ctx_stats was not captured')
    assert.throws(() => host.ctx.tools.register(stats), /already registered/)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
    host.cleanup()
  }
})

test('every declared schema is inside the host-supported subset', { skip }, async () => {
  const assertSupportedJsonSchema = toolsModule.assertSupportedJsonSchema
  assert.equal(typeof assertSupportedJsonSchema, 'function', 'host no longer exports the subset checker')

  const stateDir = tempDir('ctxopt-schema-')
  const captured = []
  const recorder = {
    tools: { register: (definition) => { captured.push(definition); return () => {} } },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
    inject: (_services, callback) => callback(recorder),
  }
  try {
    plugin.apply(recorder, { stateDir, session: { injectSnapshot: false } })
    assert.equal(captured.length, EXPECTED_TOOLS.length)
    for (const definition of captured) {
      // `parameters` is NOT checked by the raw-register path, so an unsupported
      // keyword there would surface only as a broken model-facing schema.
      assert.doesNotThrow(
        () => assertSupportedJsonSchema(definition.parameters),
        `parameters outside the host subset for ${definition.name}: ${JSON.stringify(definition.parameters)}`,
      )
      assert.doesNotThrow(
        () => assertSupportedJsonSchema(definition.output.schema),
        `output schema outside the host subset for ${definition.name}`,
      )
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the real pipeline indexes a file and then finds it again', { skip }, async () => {
  const host = await boot()
  const work = workFixture('index')
  try {
    fs.mkdirSync(path.join(work.root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(work.root, 'src', 'index.ts'), 'export const marker = "unique-marker-token"\n')

    const indexed = await host.call('ctx_index', { path: work.relative, source: 'host-test' })
    assert.equal(indexed.isError, false, JSON.stringify(indexed.content))
    assert.equal(indexed.value.ok, true)
    assert.ok(indexed.value.chunks > 0, 'nothing was indexed')

    const found = await host.call('ctx_search', { queries: ['unique-marker-token'], limit: 5 })
    assert.equal(found.isError, false, JSON.stringify(found.content))
    assert.equal(found.value.results[0].matches.length, 1)
    // FTS5 highlights each matched term, so a hyphenated query arrives as
    // `»unique«-»marker«-»token«`. Stripping the markers must recover the text.
    const snippet = found.value.results[0].matches[0].snippet
    assert.ok(
      snippet.replaceAll('»', '').replaceAll('«', '').includes('unique-marker-token'),
      `stripping the FTS5 highlight markers did not recover the source text: ${snippet}`,
    )
    assert.ok(snippet.includes('»unique«'), 'no term was highlighted')

    const missing = await host.call('ctx_search', { queries: ['nothing-matches-this-xyz'], limit: 5 })
    assert.deepEqual(missing.value.results[0].matches, [])
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

test('the real pipeline runs code confined and reports the backend enforcement', { skip }, async () => {
  const host = await boot({ executor: { sandboxMode: 'workspace-write' } })
  try {
    const result = await host.call('ctx_execute', {
      language: 'javascript',
      code: 'console.log("sum=" + (6 * 7))',
    })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, true)
    assert.match(result.value.stdout, /sum=42/)
    assert.equal(result.value.unconfined, false)
    assert.ok(['full', 'partial'].includes(result.value.enforcement))
    // The model-facing content is real text produced by output.render. The
    // assertion uses `sum=42`, which exists ONLY in the result: the argument
    // carries `6 * 7`, so an echo of the arguments cannot satisfy it.
    assert.match(result.content[0].text, /sum=42/)
    assert.ok(
      !result.content[0].text.includes('"code"'),
      `the rendered content echoed the arguments instead of the result: ${result.content[0].text}`,
    )
  } finally {
    host.cleanup()
  }
})

test('rendered content carries the RESULT and never the arguments', { skip }, async () => {
  const host = await boot()
  try {
    // `ctx_stats` takes no arguments at all, so its arguments render as `{}`.
    // A `"{}"` here can only mean render received them instead of the value.
    const stats = await host.call('ctx_stats', {})
    assert.equal(stats.isError, false, JSON.stringify(stats.content))
    assert.notEqual(stats.content[0].text, '{}', 'ctx_stats rendered its arguments, not its result')
    const renderedStats = JSON.parse(stats.content[0].text)
    assert.equal(renderedStats.ok, true)
    assert.equal(typeof renderedStats.index.chunks, 'number')
    assert.equal(typeof renderedStats.sessions.events, 'number')

    // Same for the diagnostics: without them the model cannot see any failure.
    const doctor = await host.call('ctx_doctor', {})
    assert.equal(doctor.isError, false, JSON.stringify(doctor.content))
    assert.notEqual(doctor.content[0].text, '{}', 'ctx_doctor rendered its arguments, not its result')
    const renderedDoctor = JSON.parse(doctor.content[0].text)
    assert.equal(renderedDoctor.node, process.version)
    assert.equal(typeof renderedDoctor.sandbox.available, 'boolean')
    assert.ok(Array.isArray(renderedDoctor.errors))
    assert.ok(['available', 'missing', 'unprobeable'].includes(renderedDoctor.runtimes.javascript.status))

    // A refusal has to reach the model as well, or refusals are invisible.
    const refused = await host.call('ctx_purge', { confirm: false, scope: 'index' })
    assert.equal(refused.isError, false, JSON.stringify(refused.content))
    assert.equal(refused.value.ok, false)
    assert.match(refused.content[0].text, /confirm was not true; nothing was removed/)
    assert.ok(
      !refused.content[0].text.includes('"confirm"'),
      `the rendered content is the argument echo: ${refused.content[0].text}`,
    )
  } finally {
    host.cleanup()
  }
})

test('the host environment does not reach the child process', { skip }, async () => {
  const host = await boot()
  const canary = 'host-env-canary-value'
  process.env.CTXOPT_HOST_CANARY = canary
  try {
    const result = await host.call('ctx_execute', {
      language: 'javascript',
      code: 'console.log(process.env.CTXOPT_HOST_CANARY ?? "absent")',
    })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.match(result.value.stdout, /absent/)
    assert.ok(!result.value.stdout.includes(canary))
  } finally {
    delete process.env.CTXOPT_HOST_CANARY
    host.cleanup()
  }
})

test('a path outside the workspace is refused before anything is read', { skip }, async () => {
  const host = await boot()
  const outside = tempDir('ctxopt-outside-')
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'classified')
    const result = await host.call('ctx_execute_file', {
      path: path.join(outside, 'secret.txt'),
      language: 'javascript',
      code: 'console.log(1)',
    })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, false)
    assert.match(result.value.error, /Absolute paths are not allowed|escapes project boundary/)
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
    host.cleanup()
  }
})

test('a target file that does not exist is refused instead of handed to the child', { skip }, async () => {
  const host = await boot({ executor: { sandboxMode: 'workspace-write' } })
  const work = workFixture('execute-file-missing')
  try {
    const target = path.join(work.relative, 'not-created-yet.txt')
    const result = await settleWithin(
      host.call('ctx_execute_file', {
        path: target,
        language: 'javascript',
        code: 'console.log(process.env.TARGET_FILE ?? "absent")',
      }),
      15_000,
      'the call for a missing target file',
    )
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, false, `a missing target ran anyway: ${JSON.stringify(result.value)}`)
    assert.match(result.value.error, /does not exist/)
    // The refusal is a decision the model can act on, so it has to survive
    // output.render rather than being replaced by the arguments.
    assert.match(result.content[0].text, /does not exist/)

    // The shape of the hole this closes: a verified path is refused, an
    // unverified one used to be returned as if it had been checked, which left a
    // window between the check and the spawn for a symlink to be planted there.
    fs.mkdirSync(path.join(work.root, 'deep'), { recursive: true })
    const nested = await settleWithin(
      host.call('ctx_execute_file', {
        path: path.join(work.relative, 'deep', 'also-missing.txt'),
        language: 'javascript',
        code: 'console.log(1)',
      }),
      15_000,
      'the call for a missing nested target',
    )
    assert.equal(nested.value.ok, false, JSON.stringify(nested.value))
    assert.match(nested.value.error, /does not exist/)
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

test('an existing target file still executes, so the existence check is not a blanket refusal', { skip }, async () => {
  const host = await boot({ executor: { sandboxMode: 'workspace-write' } })
  const work = workFixture('execute-file-ok')
  try {
    fs.writeFileSync(path.join(work.root, 'target.txt'), 'present-target-token\n')
    const result = await settleWithin(
      host.call('ctx_execute_file', {
        path: path.join(work.relative, 'target.txt'),
        language: 'javascript',
        code: 'console.log(process.env.TARGET_FILE)',
      }),
      15_000,
      'the call for an existing target file',
    )
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, true, JSON.stringify(result.value))
    const targetFile = result.value.stdout.trim()
    assert.ok(path.isAbsolute(targetFile), `TARGET_FILE is not a resolved path: ${JSON.stringify(targetFile)}`)
    assert.ok(
      targetFile.endsWith(path.join('target.txt')),
      `TARGET_FILE does not name the requested file: ${JSON.stringify(targetFile)}`,
    )
    assert.equal(result.value.unconfined, false)
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

test('a configured deny pattern really blocks a call through the real waterfall', { skip }, async () => {
  const host = await boot({ routing: { denyPatterns: ['^echo\\s+forbidden'] } })
  try {
    const decision = await host.ctx.waterfall(
      'tools/pre-execute',
      {
        name: 'bash',
        arguments: { command: 'echo forbidden-value' },
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: 'allow' }),
    )
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /deny pattern/)
  } finally {
    host.cleanup()
  }
})

test('without a configured deny pattern the same call is allowed', { skip }, async () => {
  const host = await boot()
  try {
    const decision = await host.ctx.waterfall(
      'tools/pre-execute',
      { name: 'bash', arguments: { command: 'echo forbidden-value' }, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'allow' }),
    )
    assert.equal(decision.kind, 'allow')
  } finally {
    host.cleanup()
  }
})

test('session events emitted by the host build a resume snapshot', { skip }, async () => {
  const host = await boot({ session: { recordEvents: true } })
  try {
    const session = { id: 'sess-host-1', header: { id: 'sess-host-1', cwd: process.cwd() } }
    await host.ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_000,
      data: { content: [{ type: 'text', text: 'refactor the registry' }] },
    })
    await host.ctx.emit('session/event', session, {
      // The real host nests a tool result: `data.message.content`, wrapped in a
      // `tool-result` block. A flat `data.content` fixture is a shape the host
      // never emits, and asserting against it is exactly what let this path stay
      // green while every real `<recent_errors>` section came out empty.
      type: 'tool/result',
      seq: 2,
      time: 1_700_000_001_000,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: 'typecheck failed in adapter.ts' }],
              isError: true,
            },
          ],
        },
        meta: {},
      },
    })

    const resumed = await host.call('ctx_resume', { sessionId: 'sess-host-1' })
    assert.equal(resumed.isError, false, JSON.stringify(resumed.content))
    assert.match(resumed.value.snapshot, /refactor the registry/)
    assert.match(resumed.value.snapshot, /typecheck failed in adapter\.ts/)
  } finally {
    host.cleanup()
  }
})

test('the prompt-time resume block contributes text through the real assembly', { skip }, async () => {
  const host = await boot({ session: { recordEvents: true, injectSnapshot: true } })
  try {
    const session = { id: 'sess-host-2', header: { id: 'sess-host-2', cwd: process.cwd() } }
    await host.ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_000,
      data: { content: [{ type: 'text', text: 'stored intent marker' }] },
    })

    const agent = { id: 'sess-host-2', session: { header: { id: 'sess-host-2', cwd: process.cwd() } } }
    const assembly = await host.ctx.get('systemPrompt').assemble({ agent })
    const contribution = assembly.contexts.find((entry) => entry.name === 'dsh-context-optimizer-resume')
    assert.ok(contribution, 'the resume context did not reach the host assembly')
    assert.match(contribution.text, /stored intent marker/)
    assert.match(contribution.text, /context-optimizer/)

    // An agent with no stored session must contribute nothing at all.
    const stranger = { id: 'unknown-session', session: { header: { id: 'unknown-session' } } }
    const other = await host.ctx.get('systemPrompt').assemble({ agent: stranger })
    const empty = other.contexts.find((entry) => entry.name === 'dsh-context-optimizer-resume')
    assert.equal(empty.text, '', 'a session with no history still contributed text')
  } finally {
    host.cleanup()
  }
})

test('the post-execute advisory attaches real context to a matching call', { skip }, async () => {
  const host = await boot({ routing: { advisory: true, advisoryThrottle: 1 } })
  try {
    host.ctx.tools.register({
      name: 'bash',
      description: 'probe shell tool carrying a command argument',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell text.' } },
        required: ['command'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true, ran: true }),
    })

    const steered = await host.call('bash', { command: 'curl https://example.test' })
    assert.equal(steered.isError, false, JSON.stringify(steered.content))
    assert.ok(Array.isArray(steered.additionalContexts), 'the host result carries no additionalContexts')
    assert.equal(steered.additionalContexts.length, 1)
    const text = steered.additionalContexts[0].content[0].text
    assert.match(text, /context-optimizer/)
    assert.match(text, /ctx_fetch_and_index/)

    // An unrelated call gets no hint at all, and the result itself is untouched.
    const plain = await host.call('bash', { command: 'ls -la' })
    // The host omits the key entirely when nothing was attached.
    assert.equal((plain.additionalContexts ?? []).length, 0)
    assert.equal(plain.value.ran, true)
  } finally {
    host.cleanup()
  }
})

test('the throttle keeps advisory noise down on a busy session', { skip }, async () => {
  const host = await boot({ routing: { advisory: true, advisoryThrottle: 3 } })
  try {
    host.ctx.tools.register({
      name: 'bash',
      description: 'probe shell tool carrying a command argument',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell text.' } },
        required: ['command'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ ok: true }),
    })

    const hinted = []
    for (let i = 0; i < 7; i += 1) {
      const result = await host.call('bash', { command: 'curl https://example.test' })
      hinted.push((result.additionalContexts ?? []).length > 0)
    }
    // Fires on the first matching call and every third after it: 1, 3, 6.
    assert.deepEqual(hinted, [true, false, true, false, false, true, false])
  } finally {
    host.cleanup()
  }
})

test('an invalid configuration disables the plugin instead of throwing', { skip }, async () => {
  const ctx = await bareContext()
  const adapter = {
    tools: ctx.tools,
    get: (name) => ctx.get(name),
    on: (name, listener, options) => ctx.on(name, listener, options),
    effect: (body, label) => ctx.effect(body, label),
    inject: (_services, callback) => callback(adapter),
  }
  let view
  assert.doesNotThrow(() => {
    view = plugin.apply(adapter, { toolPrefix: 'NOT VALID' })
  })
  assert.equal(view.registrations.length, 0)
  assert.equal(view.errors.length, 1)
  assert.match(view.errors[0], /configuration rejected/)
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), [])
})

test('a second mount reports the collision instead of breaking the first one', { skip }, async () => {
  const ctx = new harness.Context()
  await ctx.plugin(harness.SystemPrompt)
  await ctx.plugin(harness.ToolRuntime)
  await ctx.plugin(harness.LocalSandboxProvider)
  const adapter = {
    tools: ctx.tools,
    get: (name) => ctx.get(name),
    on: (name, listener, options) => ctx.on(name, listener, options),
    effect: (body, label) => ctx.effect(body, label),
    inject: (_services, callback) => callback(adapter),
  }
  const stateDir = tempDir('ctxopt-dupe-')
  try {
    const first = plugin.apply(adapter, { stateDir })
    assert.equal(first.registrations.filter((entry) => entry.ok).length, EXPECTED_TOOLS.length)

    const second = plugin.apply(adapter, { stateDir })
    const failed = second.registrations.filter((entry) => !entry.ok)
    assert.equal(failed.length, EXPECTED_TOOLS.length, 'the second mount should collide on every name')
    assert.match(failed[0].error, /already registered/)
    // The host stays usable and the first mount is untouched.
    assert.equal(ctx.tools.schemas().filter((schema) => schema.name === 'ctx_stats').length, 1)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('ctx_doctor reports real sandbox and runtime state through the real pipeline', { skip }, async () => {
  const host = await boot()
  try {
    const result = await host.call('ctx_doctor', {})
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.node, process.version)
    assert.equal(result.value.sandbox.available, true, 'the host sandbox service was not resolved')
    // The doctor reports three states, so a runtime nobody could probe reads as
    // `unprobeable` instead of quietly reporting installed.
    for (const [language, probe] of Object.entries(result.value.runtimes)) {
      assert.ok(
        ['available', 'missing', 'unprobeable'].includes(probe.status),
        `${language}: ${JSON.stringify(probe)}`,
      )
      assert.equal(typeof probe.program, 'string')
      assert.ok(probe.detail.length > 0, `${language} probe has no detail`)
    }
    assert.equal(result.value.runtimes.bash.status, 'available', JSON.stringify(result.value.runtimes.bash))
    assert.equal(typeof result.value.index.chunks, 'number')
  } finally {
    host.cleanup()
  }
})

test('ctx_purge refuses to delete without an explicit confirm, and deletes with it', { skip }, async () => {
  const host = await boot()
  const work = workFixture('purge')
  try {
    fs.writeFileSync(path.join(work.root, 'a.md'), 'purge-target-token\n')
    await host.call('ctx_index', { path: work.relative, source: 'purge-test' })
    const before = await host.call('ctx_stats', {})
    assert.ok(before.value.index.chunks > 0)

    const refused = await host.call('ctx_purge', { confirm: false, scope: 'index' })
    assert.equal(refused.value.deleted, false)
    const afterRefused = await host.call('ctx_stats', {})
    assert.equal(afterRefused.value.index.chunks, before.value.index.chunks)

    const confirmed = await host.call('ctx_purge', { confirm: true, scope: 'index' })
    assert.equal(confirmed.value.deleted, true)
    const afterPurge = await host.call('ctx_stats', {})
    assert.equal(afterPurge.value.index.chunks, 0)
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

test('a real tool call carrying a matched command is denied by the installed gate', { skip }, async () => {
  const host = await boot({ routing: { denyPatterns: ['^echo\\s+forbidden$'] } })
  try {
    // A fixture whose argument shape actually carries `command`, so the call
    // travels the full host path: registry -> pre-execute waterfall -> gate.
    host.ctx.tools.register({
      name: 'probe_bash',
      description: 'fixture exposing a command argument for the routing gate',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell text.' } },
        required: ['command'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => ({ ok: true, ran: true }),
    })

    const blocked = await host.call('probe_bash', { command: 'echo forbidden' })
    assert.equal(blocked.isError, true, 'the deny gate did not stop the call')
    assert.match(blocked.content[0].text, /deny pattern/)

    const allowed = await host.call('probe_bash', { command: 'echo permitted' })
    assert.equal(allowed.isError, false, JSON.stringify(allowed.content))
    assert.equal(allowed.value.ran, true)
  } finally {
    host.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F10 — `apply` must not depend on `ctx.get`, and the sandbox must be resolved
// at call time rather than frozen at boot.
// ---------------------------------------------------------------------------

test('apply does not throw when the host exposes no service lookup', { skip }, async () => {
  const stateDir = tempDir('ctxopt-nogetsvc-')
  const registered = []
  // Exactly the surface the defect was measured on: a host that offers
  // `tools.register` and nothing else.
  const hostWithoutGet = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
  }
  let view
  try {
    assert.doesNotThrow(
      () => { view = plugin.apply(hostWithoutGet, { stateDir, session: { injectSnapshot: false } }) },
      'apply threw instead of degrading',
    )
    assert.equal(registered.length, EXPECTED_TOOLS.length, 'the tools did not register')
    assert.equal(view.tools().length, EXPECTED_TOOLS.length)
    // Degrading is silent only for a privileged host; here the missing lookup
    // is reported so ctx_doctor can show why the boundary is absent.
    assert.ok(
      /service lookup/.test(view.errors.join('\n')),
      `the missing lookup was not reported: ${JSON.stringify(view.errors)}`,
    )
    assert.equal(view.sandbox.available, false)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the sandbox is resolved per call, so mounting it late still works', { skip }, async () => {
  const stateDir = tempDir('ctxopt-latesandbox-')
  const ctx = new harness.Context()
  await ctx.plugin(harness.SystemPrompt)
  await ctx.plugin(harness.ToolRuntime)
  // Deliberately no LocalSandboxProvider yet: this is the load order the
  // defect made permanently broken.
  const adapter = hostAdapter(ctx)
  try {
    const view = plugin.apply(adapter, { stateDir, session: { injectSnapshot: false } })
    assert.equal(view.sandbox.available, false, 'no sandbox service exists yet')

    const before = await caller(ctx, 'ctx_execute', { language: 'javascript', code: 'console.log(1)' })
    assert.equal(before.isError, false, JSON.stringify(before.content))
    assert.equal(before.value.ok, false, 'code ran with no boundary in place')
    assert.match(before.value.error, /no sandbox backend/)

    const doctorBefore = await caller(ctx, 'ctx_doctor', {})
    assert.equal(doctorBefore.value.sandbox.available, false, 'doctor reported a sandbox that is not there')

    // The fiber activates after `apply`; nothing may be frozen from boot.
    await ctx.plugin(harness.LocalSandboxProvider)

    const after = await caller(ctx, 'ctx_execute', {
      language: 'javascript',
      code: 'console.log("sum=" + (6 * 7))',
    })
    assert.equal(after.isError, false, JSON.stringify(after.content))
    assert.equal(after.value.ok, true, JSON.stringify(after.value))
    assert.match(after.value.stdout, /sum=42/)
    assert.equal(after.value.unconfined, false)
    assert.ok(['full', 'partial'].includes(after.value.enforcement))
    assert.equal(view.sandbox.available, true, 'the view kept a boot-time snapshot')

    const doctorAfter = await caller(ctx, 'ctx_doctor', {})
    assert.equal(doctorAfter.value.sandbox.available, true, 'doctor still reported the boot-time snapshot')
    assert.equal(doctorAfter.value.sandbox.enforced, true)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// F9 — the post-execute advisory hook is decoration on a call that already
// succeeded; it must fail open and must not append one warning per call.
// ---------------------------------------------------------------------------

test('a fault inside the advisory listener cannot fail a finished call', { skip }, async () => {
  const host = await boot({ routing: { advisory: true, advisoryThrottle: 1 } })
  try {
    // The host JSON-snapshots `exec.arguments` before dispatch, so the only way
    // to reach the listener with a faulting input is to drive the same waterfall
    // the host drives. `evaluate` reading `execution.arguments` throws here,
    // which is what a malformed `denyPatterns` entry used to do from inside.
    // The host's own dispatch passes the settled result as the second payload, so
    // the waterfall signature here is (execution, result, next).
    const execution = {
      name: 'bash',
      get arguments() { throw new Error('routing input is unreadable') },
      signal: new AbortController().signal,
    }
    const settled = { isError: false, content: [{ type: 'text', text: 'original' }] }
    const next = () => Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'kept-result' }] })

    const decision = await host.ctx.waterfall('tools/post-execute', execution, settled, next)
    assert.equal(decision.kind, 'accept', 'the hook turned a finished call into a failure')
    assert.equal(decision.content[0].text, 'kept-result')

    // Repeated faults must not grow the recorded errors without bound.
    for (let i = 0; i < 8; i += 1) {
      const again = await host.ctx.waterfall('tools/post-execute', execution, settled, next)
      assert.equal(again.kind, 'accept')
    }
    const recorded = host.view.errors.filter((line) => /failing open/.test(line))
    assert.equal(
      recorded.length,
      1,
      `the same fault was appended ${recorded.length} times: ${JSON.stringify(host.view.errors)}`,
    )
    assert.equal(host.view.errors.length, 1, `view.errors grew: ${JSON.stringify(host.view.errors)}`)
  } finally {
    host.cleanup()
  }
})

test('a fault inside the pre-execute gate fails open instead of denying or throwing', { skip }, async () => {
  // `resolveConfig` now compiles every pattern at boot, so this is the same
  // guard as the advisory one below, kept for the half of the routing that runs
  // BEFORE the tool: a throw there would either escape the waterfall or turn
  // into a deny, and a routing fault must do neither.
  const host = await boot({ routing: { advisory: false, denyPatterns: ['^echo\\s+forbidden$'] } })
  try {
    const execution = {
      name: 'bash',
      get arguments() { throw new Error('routing input is unreadable') },
      signal: new AbortController().signal,
    }
    const decision = await settleWithin(
      host.ctx.waterfall('tools/pre-execute', execution, () => Promise.resolve({ kind: 'allow' })),
      10_000,
      'the pre-execute gate under a faulting input',
    )
    assert.equal(decision.kind, 'allow', `a routing fault became ${JSON.stringify(decision)}`)
    assert.ok(
      /routing rule rejected a call, failing open/.test(host.view.errors.join('\n')),
      `the fault was not reported: ${JSON.stringify(host.view.errors)}`,
    )
    assert.equal(host.view.errors.filter((line) => /failing open/.test(line)).length, 1)
  } finally {
    host.cleanup()
  }
})

test('a successful call stays successful while a deny pattern is malformed', { skip }, async () => {
  const host = await boot({ routing: { advisory: true, advisoryThrottle: 1, denyPatterns: ['[unclosed'] } })
  try {
    if (host.view.registrations.length === 0) {
      // The configuration half of this fix compiles every pattern at load time,
      // so a malformed one is reported as a configuration error and never
      // reaches a hook. The listener-level contract is pinned separately, by
      // the advisory test above, which injects the fault the hook cannot see
      // coming.
      assert.match(host.view.errors.join('\n'), /configuration rejected/)
      assert.match(host.view.errors.join('\n'), /denyPatterns/)
      assert.deepEqual(host.view.tools(), [])
      return
    }
    host.ctx.tools.register(bashProbe())
    const result = await settleWithin(
      host.call('bash', { command: 'echo for-everyone' }),
      15_000,
      'a call under a malformed deny pattern',
    )
    assert.equal(result.isError, false, `the advisory hook failed the call: ${JSON.stringify(result.content)}`)
    assert.equal(result.value.ran, true)
    assert.match(result.value.probeOutcomeToken, /probe-outcome-token/)
    assert.match(result.content[0].text, /probe-outcome-token/)
    assert.ok(/failing open/.test(host.view.errors.join('\n')), 'the malformed pattern was never reported')
  } finally {
    host.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F6 — a walk that yields nothing must not replace the source it walks over.
// ---------------------------------------------------------------------------

test('an index call that reads nothing refuses instead of wiping the source', { skip }, async () => {
  const host = await boot()
  const work = workFixture('index-empty')
  try {
    fs.mkdirSync(path.join(work.root, 'keep'), { recursive: true })
    fs.writeFileSync(path.join(work.root, 'keep', 'a.txt'), 'index-keep-token\n')
    const seeded = await host.call('ctx_index', { path: work.relative, source: 'kept-source' })
    assert.equal(seeded.value.ok, true, JSON.stringify(seeded.value))
    assert.ok(seeded.value.chunks > 0)
    // `applied` is reported on BOTH outcomes: a write that happened, and a
    // refusal that deliberately kept the old corpus. Inferring it from `chunks`
    // is what made the two indistinguishable before.
    assert.equal(seeded.value.applied, true, 'a successful index did not report applied:true')

    // (a) a path that does not exist.
    const missing = await host.call('ctx_index', {
      path: path.join(work.relative, 'nothing-here-at-all'),
      source: 'kept-source',
    })
    assert.equal(missing.isError, false, JSON.stringify(missing.content))
    assert.equal(missing.value.ok, false, 'a missing path was reported as a successful index')
    assert.match(missing.value.error, /does not exist|path not found/i)
    assert.doesNotMatch(missing.value.error, /nothing readable/)

    const afterMissing = await host.call('ctx_stats', {})
    assert.equal(afterMissing.value.index.chunks, seeded.value.chunks, 'a missing path emptied the corpus')
    const searchMissing = await host.call('ctx_search', { queries: ['index-keep-token'], limit: 5 })
    assert.equal(searchMissing.value.results[0].matches.length, 1)

    // (b) a path that exists but contributes no readable file.
    fs.mkdirSync(path.join(work.root, 'nothing'), { recursive: true })
    fs.writeFileSync(path.join(work.root, 'nothing', 'x.txt'), 'wiped-away\n')
    const emptied = await host.call('ctx_index', {
      path: path.join(work.relative, 'nothing'),
      source: 'kept-source',
      exclude: ['x.txt'],
    })
    assert.equal(emptied.isError, false, JSON.stringify(emptied.content))
    assert.equal(emptied.value.ok, false, 'an empty walk reported ok')
    assert.match(emptied.value.error, /nothing readable/)
    assert.equal(emptied.value.applied, false)
    assert.equal(emptied.value.indexed, 0)
    assert.ok(emptied.value.excluded >= 1, `the excluded file was invisible: ${JSON.stringify(emptied.value)}`)

    const afterEmptied = await host.call('ctx_stats', {})
    assert.equal(
      afterEmptied.value.index.chunks,
      seeded.value.chunks,
      'an empty walk destroyed the previously indexed source',
    )
    const searchAfter = await host.call('ctx_search', { queries: ['index-keep-token'], limit: 5 })
    assert.equal(searchAfter.value.results[0].matches.length, 1, 'the kept token is gone from the index')
    const searchWiped = await host.call('ctx_search', { queries: ['wiped-away'], limit: 5 })
    assert.deepEqual(searchWiped.value.results[0].matches, [])
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F17 — exclude rules match whole path segments and report what they dropped.
// ---------------------------------------------------------------------------

test('an exclude rule matches whole path segments and reports what it dropped', { skip }, async () => {
  const host = await boot()
  const work = workFixture('excludes')
  try {
    fs.mkdirSync(path.join(work.root, 'src', 'build-tools'), { recursive: true })
    fs.mkdirSync(path.join(work.root, 'build'), { recursive: true })
    fs.writeFileSync(path.join(work.root, 'src', 'build-tools', 'x.txt'), 'buildtoolonly\n')
    fs.writeFileSync(path.join(work.root, 'build', 'y.txt'), 'excludednotthis\n')

    // Default excludes carry `build`; `src/build-tools` is not that segment.
    const indexed = await host.call('ctx_index', { path: work.relative, source: 'excludes' })
    assert.equal(indexed.isError, false, JSON.stringify(indexed.content))
    assert.equal(indexed.value.ok, true, JSON.stringify(indexed.value))
    assert.equal(indexed.value.files, 1, `walk result: ${JSON.stringify(indexed.value)}`)
    assert.ok(
      indexed.value.excluded >= 1,
      `a dropped directory left no trace: ${JSON.stringify(indexed.value)}`,
    )

    // Each query is one term, so a match can only come from that one file.
    const kept = await host.call('ctx_search', { queries: ['buildtoolonly'], limit: 5 })
    assert.equal(kept.value.results[0].matches.length, 1, 'a real directory was dropped by a substring match')
    const dropped = await host.call('ctx_search', { queries: ['excludednotthis'], limit: 5 })
    assert.deepEqual(dropped.value.results[0].matches, [], 'the excluded directory was indexed anyway')
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F11 — each batch entry owns its source and reports the bytes it indexed.
// ---------------------------------------------------------------------------

test('batch entries keep distinct sources and report truncation', { skip }, async () => {
  const host = await boot({ executor: { maxStdoutBytes: 64 } })
  try {
    const result = await host.call('ctx_batch_execute', {
      commands: [
        { label: 'dup', command: 'printf "%s" alphaonly' },
        { label: 'dup', command: 'printf "%s" betaonly' },
        { label: 'dup', command: 'printf "%s" $(head -c 4096 /dev/zero | tr "\\0" z)' },
      ],
      queries: ['alphaonly', 'betaonly', 'gammaonly'],
      concurrency: 3,
    })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.indexed.length, 3)

    const [first, second, third] = result.value.indexed
    assert.notEqual(first.source, second.source, `two entries share one source: ${first.source}`)
    assert.notEqual(first.source, third.source)
    assert.equal(first.chunks, 1, JSON.stringify(first))
    assert.equal(second.chunks, 1, JSON.stringify(second))
    assert.ok(first.bytes > 0 && second.bytes > 0, JSON.stringify(result.value.indexed))

    // A cut output must be distinguishable from a full one.
    assert.equal(third.truncated, true, `truncation was discarded: ${JSON.stringify(third)}`)
    assert.ok(third.bytes > 0)
    assert.ok(third.bytes <= 64, `indexed ${third.bytes} bytes although the budget is 64`)
    assert.equal(first.truncated, false)
    assert.equal(second.truncated, false)

    // Both outputs are still reachable, which is what a shared source broke.
    const alpha = await host.call('ctx_search', { queries: ['alphaonly'], limit: 5 })
    assert.equal(alpha.value.results[0].matches.length, 1, 'the first command output was overwritten')
    const beta = await host.call('ctx_search', { queries: ['betaonly'], limit: 5 })
    assert.equal(beta.value.results[0].matches.length, 1, 'the second command output was overwritten')
  } finally {
    host.cleanup()
  }
})

// ---------------------------------------------------------------------------
// A3 — a cancelled batch must stop pulling commands. The executor's own
// pre-spawn check belongs to another file; the loop that decides whether to
// dispatch the next command is here.
// ---------------------------------------------------------------------------

// The side-effect count above is enforced twice, because the host ends an
// aborted call before the batch value exists — measured: the caller gets an
// error 18ms after the abort, `post-execute` sees `isError:true` with no value,
// and the queued commands are still running behind it. So the end-to-end count
// cannot tell a stopping loop from an executor that refuses to spawn, and this
// second path drives the SAME `ctx_batch_execute` through a host tool
// definition where the value does reach the caller. Reverting the loop check
// makes both fail.
const BATCH_ABORT_WORK = 'batch-guard'

function batchAbortCommands(marker) {
  // Each command records that it STARTED before it blocks, so the marker file
  // counts dispatches rather than completions.
  return Array.from({ length: 6 }, (_unused, index) => ({
    label: `step-${index}`,
    command: `printf 'ran\\n' >> "${marker}"; sleep 0.4`,
  }))
}

test('a cancelled batch stops dispatching commands', { skip }, async () => {
  const host = await boot()
  const work = workFixture('batch-abort')
  const marker = path.join(work.root, 'ran.txt')
  try {
    const controller = new AbortController()
    const started = Date.now()
    const pending = host.call(
      'ctx_batch_execute',
      { commands: batchAbortCommands(marker), queries: ['nothing'], concurrency: 1 },
      { signal: controller.signal },
    )
    // Fire while command 0 is inside its sleep, so commands 1..5 have not been
    // reached yet.
    await new Promise((done) => setTimeout(done, 200))
    controller.abort()
    const result = await settleWithin(pending, 20_000, 'the aborted batch')
    const elapsed = Date.now() - started

    const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : []
    assert.equal(
      ran.length,
      1,
      `a cancelled batch dispatched ${ran.length} of 6 commands: ${JSON.stringify(ran)}`,
    )

    // What the caller is told is the host's decision: at the time of writing it
    // turns an in-flight abort into an error before the value is materialized.
    // Both surfaces are accepted so this pins the behaviour, not one moment of
    // it — an error must name the abort, and a value must admit the batch was
    // cut short rather than read as a full pass.
    const outcome = result.isError ? result.content[0].text : JSON.stringify(result.value)
    assert.match(outcome, /abort/i, `the cancellation was not reported: ${outcome}`)
    if (!result.isError) {
      assert.equal(result.value.aborted, true, JSON.stringify(result.value))
      assert.equal(result.value.indexed.length, 1, `indexed ${result.value.indexed.length} commands`)
    }

    // Six commands at 0.4s is ~2.4s of work; a caller that cancelled at 200ms
    // must not be held for it.
    assert.ok(elapsed < 1_800, `the call returned ${elapsed}ms after the caller gave up on it`)
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

test('the batch worker itself stops on a cancelled signal, and its value says so', { skip }, async () => {
  // Measured: 18ms after the abort the host settles the call with an error and
  // `post-execute` sees no value at all, so `indexed.length` — the only thing
  // that distinguishes a worker that stopped from a worker that kept pulling
  // commands the executor then refused — is unreachable through
  // `ctx.tools.execute`. This applies the plugin against a real Context (real
  // sandbox service, real store) but captures its registrations instead of
  // mounting them, which exposes the same entry point the registry calls.
  const ctx = new harness.Context()
  await ctx.plugin(harness.SystemPrompt)
  await ctx.plugin(harness.ToolRuntime)
  await ctx.plugin(harness.LocalSandboxProvider)
  const captured = []
  const adapter = {
    tools: { register: (definition) => { captured.push(definition); return () => {} } },
    get: (name) => ctx.get(name),
    on: (name, listener, options) => ctx.on(name, listener, options),
    effect: (body, label) => ctx.effect(body, label),
    inject: (_services, callback) => callback(adapter),
  }
  const stateDir = tempDir('ctxopt-batchguard-')
  const work = workFixture('batch-guard')
  const marker = path.join(work.root, 'ran.txt')
  try {
    plugin.apply(adapter, { stateDir, session: { injectSnapshot: false } })
    const batch = captured.find((entry) => entry.name === 'ctx_batch_execute')
    assert.ok(batch, 'ctx_batch_execute was not captured')

    const execution = {
      name: 'ctx_batch_execute',
      arguments: { commands: batchAbortCommands(marker), queries: [], concurrency: 1 },
      callId: 'call-batch-guard',
      signal: new AbortController().signal,
    }
    const controller = new AbortController()
    execution.signal = controller.signal
    const started = Date.now()
    const pending = batch.execute(execution.arguments, execution)
    // Cancel while command 0 is inside its sleep, with 5 commands still queued.
    await new Promise((done) => setTimeout(done, 200))
    controller.abort()
    const value = await settleWithin(pending, 20_000, 'the cancelled batch body')
    const elapsed = Date.now() - started

    assert.equal(value.aborted, true, `the batch did not report the cancellation: ${JSON.stringify(value)}`)
    assert.equal(
      value.indexed.length,
      1,
      `the worker queued ${value.indexed.length} of 6 commands after the cancellation`,
    )
    const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : []
    assert.ok(ran.length <= 1, `the worker started ${ran.length} commands after the cancellation`)
    assert.ok(elapsed < 1_800, `the batch body settled ${elapsed}ms after the cancellation`)
  } finally {
    work.cleanup()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// F19 — an absent or unrecognised `scope` must not delete anything.
// ---------------------------------------------------------------------------

test('ctx_purge refuses an absent or unrecognised scope', { skip }, async () => {
  const host = await boot()
  const work = workFixture('purge-scope')
  try {
    fs.writeFileSync(path.join(work.root, 'keep.md'), 'purge-scope-token\n')
    const seeded = await host.call('ctx_index', { path: work.relative, source: 'purge-scope' })
    assert.ok(seeded.value.chunks > 0)
    const before = await host.call('ctx_stats', {})

    for (const args of [{ confirm: true }, { confirm: true, scope: 'everything' }, { confirm: true, scope: '' }]) {
      const refused = await host.call('ctx_purge', args)
      assert.equal(refused.isError, false, JSON.stringify(refused.content))
      assert.equal(refused.value.deleted, false, `scope ${JSON.stringify(args.scope)} deleted the store`)
      assert.equal(refused.value.ok, false)
      assert.match(refused.value.error, /scope must be one of index, sessions or all/)
    }

    const after = await host.call('ctx_stats', {})
    assert.equal(after.value.index.chunks, before.value.index.chunks, 'a scopeless purge emptied the index')

    // The refusal reaches the model, and the documented call still works.
    const refused = await host.call('ctx_purge', { confirm: true })
    assert.match(refused.content[0].text, /scope must be one of index, sessions or all/)
    const confirmed = await host.call('ctx_purge', { confirm: true, scope: 'index' })
    assert.equal(confirmed.value.deleted, true, JSON.stringify(confirmed.value))
    const emptied = await host.call('ctx_stats', {})
    assert.equal(emptied.value.index.chunks, 0)
  } finally {
    work.cleanup()
    host.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F8 — the fetch path gets a deadline, a byte ceiling applied while reading,
// and an address guard on every hop.
// ---------------------------------------------------------------------------

test('a loopback URL is refused before any byte is read', { skip }, async () => {
  const host = await boot()
  let requests = 0
  const server = await loopbackServer((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('internal-only-body')
  })
  try {
    const started = Date.now()
    const result = await settleWithin(
      host.call('ctx_fetch_and_index', { url: server.url('/internal'), maxBytes: 64 }),
      15_000,
      'the guarded fetch',
    )
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, false, 'a loopback URL was fetched end to end')
    assert.match(result.value.error, /private or loopback/)
    assert.equal(result.value.chunks, undefined, 'a refused fetch still produced an index entry')

    const stats = await host.call('ctx_stats', {})
    assert.equal(stats.value.index.chunks, 0, 'the refused body was persisted into the index')
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(requests, 0, 'the guard let the request reach the socket')
    assert.ok(Date.now() - started < 15_000)
  } finally {
    await server.close()
    host.cleanup()
  }
})

test('ctx_fetch_and_index stops reading at maxBytes instead of buffering the body', { skip }, async () => {
  const totalBytes = 64 * 1024 * 1024
  const flood = floodingRoute(totalBytes)
  const server = await loopbackServer(flood.route)
  const host = await boot({ fetch: { allowHosts: ['127.0.0.1'] } })
  try {
    const result = await settleWithin(
      host.call('ctx_fetch_and_index', { url: server.url('/large'), maxBytes: 64 }),
      30_000,
      'the bounded fetch',
    )
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, true, JSON.stringify(result.value))
    assert.equal(result.value.bytes, 64, `reported ${result.value.bytes} bytes for a 64 byte ceiling`)
    assert.equal(result.value.truncated, true, 'the cut was not reported')
    assert.ok(result.value.summary.length <= 64, `summary is ${result.value.summary.length} characters`)
    assert.ok(result.value.chunks > 0, 'nothing was indexed')
    // The bound is what the socket transferred, not what the tool reported.
    // Measured on the baseline (`await response.text()` + slice): the server
    // wrote 67,108,864 bytes for `maxBytes: 64` — a 1,048,576x over-read —
    // while the result claimed `"bytes": 64`. Streaming stops the transfer at
    // the first read past the ceiling, so this lands in the low hundreds of KB
    // (socket and kernel buffering), nowhere near the whole document.
    await new Promise((done) => setTimeout(done, 300))
    assert.ok(
      flood.sent.bytes < 4 * 1024 * 1024,
      `the server pushed ${flood.sent.bytes} bytes for a 64 byte request (baseline: 67108864)`,
    )
    assert.ok(
      flood.sent.bytes < totalBytes,
      `the server pushed the whole ${totalBytes} byte document`,
    )
  } finally {
    await server.close()
    host.cleanup()
  }
})

test('every redirect hop is re-checked and a followed redirect is indexed', { skip }, async () => {
  const host = await boot({ fetch: { allowHosts: ['127.0.0.1'] } })
  let targetHits = 0
  const server = await loopbackServer((req, res) => {
    if (req.url === '/hop') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
      return
    }
    if (req.url === '/jump') {
      res.writeHead(302, { location: '/landing' })
      res.end()
      return
    }
    targetHits += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<p>followed-body-token</p>')
  })
  try {
    const guarded = await settleWithin(
      host.call('ctx_fetch_and_index', { url: server.url('/hop') }),
      15_000,
      'the redirecting fetch',
    )
    assert.equal(guarded.isError, false, JSON.stringify(guarded.content))
    assert.equal(guarded.value.ok, false, 'a redirect walked into an internal address')
    assert.match(guarded.value.error, /169\.254\.169\.254/)
    assert.equal(targetHits, 0, 'an internal hop was followed')

    const followed = await settleWithin(
      host.call('ctx_fetch_and_index', { url: server.url('/jump'), query: 'followed-body-token' }),
      15_000,
      'the followed redirect',
    )
    assert.equal(followed.isError, false, JSON.stringify(followed.content))
    assert.equal(followed.value.ok, true, JSON.stringify(followed.value))
    assert.match(followed.value.url, /\/landing$/)
    assert.match(followed.value.summary, /followed-body-token/)
    assert.ok(targetHits >= 1, 'the allowed redirect was never followed')
  } finally {
    await server.close()
    host.cleanup()
  }
})

test('an unresolvable host is reported inside the budget', { skip }, async () => {
  // `.invalid` is reserved (RFC 6761) and must never resolve, so this needs no
  // egress: it exercises the DNS step the address guard depends on, and the
  // race that keeps a slow resolver inside the fetch deadline.
  const host = await boot({ executor: { defaultTimeoutMs: 2_000 } })
  try {
    const started = Date.now()
    const result = await settleWithin(
      host.call('ctx_fetch_and_index', { url: 'http://ctxopt-no-such-host.invalid/page', maxBytes: 64 }),
      10_000,
      'the fetch against an unresolvable host',
    )
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, false, 'an unresolvable host reported success')
    assert.equal(typeof result.value.error, 'string')
    const elapsed = Date.now() - started
    assert.ok(elapsed < 8_000, `resolution took ${elapsed}ms, past the fetch budget`)
  } finally {
    host.cleanup()
  }
})

test('a fetch against a silent server is bounded by a deadline', { skip }, async () => {
  const host = await boot({ fetch: { allowHosts: ['127.0.0.1'] }, executor: { defaultTimeoutMs: 1500 } })
  const server = await loopbackServer(() => {
    /* accept the connection and never answer */
  })
  try {
    const result = await settleWithin(
      host.call('ctx_fetch_and_index', { url: server.url('/silent'), maxBytes: 64 }),
      12_000,
      'the undated fetch',
    )
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.equal(result.value.ok, false, 'a silent server left the call pending with no outcome')
    assert.match(result.value.error, /budget|abort|timeout/i, JSON.stringify(result.value))
  } finally {
    await server.close()
    host.cleanup()
  }
})