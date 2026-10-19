import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../scripts/run-bosho0l-publication-console.mjs', import.meta.url),
  'utf8',
)

test('bosho0l no-cap private source container runs as the host uid/gid', () => {
  assert.match(source, /function hostDockerUser\(\)/)
  assert.match(source, /process\.getuid\(\)/)
  assert.match(source, /process\.getgid\(\)/)
  assert.match(source, /'--cap-drop',\s*'ALL'/)
  assert.match(source, /'--user',\s*hostDockerUser\(\)/)
})

test('bosho0l keeps network isolation and fails closed without host identity', () => {
  assert.match(source, /'--network',\s*'none'/)
  assert.match(source, /'--security-opt',\s*'no-new-privileges'/)
  assert.match(source, /typeof process\.getuid !== 'function' \|\| typeof process\.getgid !== 'function'/)
  assert.match(source, /throw new Error\('HOST_UID_GID_UNAVAILABLE'\)/)
  assert.doesNotMatch(source, /'--privileged'|'--cap-add'/)
})
