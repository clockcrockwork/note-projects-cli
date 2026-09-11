import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../scripts/run-threads-affiliates-verify.mjs', import.meta.url),
  'utf8',
)

test('no-cap private source container runs as the host uid/gid', () => {
  assert.match(source, /function hostDockerUser\(\)/)
  assert.match(source, /process\.getuid\(\)/)
  assert.match(source, /process\.getgid\(\)/)
  assert.match(source, /'--cap-drop',\s*'ALL'/)
  assert.match(source, /'--user',\s*hostDockerUser\(\)/)
})

test('does not run dependency lifecycle rebuilds before private source export', () => {
  assert.match(source, /\['npm', 'ci', '--ignore-scripts'/)
  assert.doesNotMatch(source, /npm', 'rebuild'/)
  assert.doesNotMatch(source, /ESBUILD_PREPARE_FAILED/)
})
