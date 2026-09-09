import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('missing credentials fail closed before private API access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'npr-runner-test-'))
  const output = join(dir, 'output.txt')
  await writeFile(output, '')
  const child = spawnSync(process.execPath, ['scripts/run-repository-verify.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      REQUEST_JSON: JSON.stringify({ task: 'repository-verify', source: 'pull_request', pull_request: 245, target: null }),
      GITHUB_OUTPUT: output,
      NPR_APP_ID: '', NPR_APP_PRIVATE_KEY: '', NPR_APP_INSTALLATION_ID: '',
    },
    encoding: 'utf8',
  })
  assert.equal(child.status, 3)
  assert.match(child.stdout, /^repository-verify HOLD EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE/m)
  assert.doesNotMatch(child.stdout + child.stderr, /https:\/\/api\.github\.com/)
  const emitted = await readFile(output, 'utf8')
  assert.match(emitted, /"status":"HOLD"/)
  assert.match(emitted, /EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE/)
})

test('request shape mismatch fails without echoing request body', () => {
  const sentinel = 'PRIVATE_ARTICLE_SENTINEL'
  const child = spawnSync(process.execPath, ['scripts/run-repository-verify.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, REQUEST_JSON: JSON.stringify({ task: sentinel }) },
    encoding: 'utf8',
  })
  assert.equal(child.status, 1)
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(sentinel))
  assert.match(child.stdout, /REQUEST_TASK_MISMATCH/)
})
