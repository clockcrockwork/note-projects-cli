import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../scripts/run-threads-affiliates-verify.mjs', import.meta.url),
  'utf8',
)

test('prepares only esbuild before exporting private source', () => {
  const installAt = source.indexOf("['npm', 'ci', '--ignore-scripts'")
  const rebuildAt = source.indexOf("['npm', 'rebuild', 'esbuild'")
  const exportAt = source.indexOf('const listing = await listCompleteTree')

  assert.ok(installAt >= 0)
  assert.ok(rebuildAt > installAt)
  assert.ok(exportAt > rebuildAt)
  assert.match(source, /ESBUILD_PREPARE_FAILED/)
})
