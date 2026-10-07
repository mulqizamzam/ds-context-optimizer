/**
 * Fail-closed gate for the host suite.
 *
 * The host tests skip when no harness checkout is reachable, which is correct
 * for a fresh clone and wrong for a verification run: a run that silently skips
 * every host assertion and reports green is a false pass. `npm run test:host`
 * sets `CTX_REQUIRE_HOST=1`, which turns "the host is unavailable" from a skip
 * into a failure.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const H = process.env.DSH_HARNESS_HOME ?? '/home/administrator/deepseek-harness'
const REQUIRED = [
  path.join(H, 'packages/core/tools/node_modules/@deepseek-ai/cordis/lib/index.js'),
  path.join(H, 'packages/core/tools/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'),
  path.join(H, 'packages/core/tools/node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
  path.join(H, 'packages/core/tools/lib/index.js'),
  path.join(H, 'packages/sandbox/sandbox-local/lib/index.js'),
]
const missing = REQUIRED.filter((file) => !fs.existsSync(file))

test('the harness checkout the host suite depends on is present', { skip: process.env.CTX_REQUIRE_HOST !== '1' ? 'not a required host run' : false }, () => {
  assert.deepEqual(
    missing,
    [],
    'test:host requires a harness checkout; set DSH_HARNESS_HOME or run from a host that has one',
  )
})