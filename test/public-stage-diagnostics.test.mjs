import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../scripts/run-repository-verify.mjs', import.meta.url), 'utf8')

test('public verify uses only the canonical public-safe no-network stages', () => {
  for (const command of [
    "['./node_modules/.bin/prettier', '--list-different']",
    "['npm', 'run', 'lint']",
    "['npm', 'run', 'typecheck:public']",
    "['npm', 'run', 'test:public']",
  ]) {
    assert.match(source, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(source, /changedPathsOnly: true/)
  assert.match(source, /changedExportedPaths\(resolved\.changedPaths, exportPlan\.include\)/)
  assert.doesNotMatch(source, /\['npm', 'run', 'format:check'\]/)
  assert.doesNotMatch(source, /\['npm', 'run', 'typecheck'\]/)
  assert.doesNotMatch(source, /\['npm', 'run', 'build'\]/)
})

test('each public stage has a stable non-content diagnostic', () => {
  for (const diagnostic of [
    'PUBLIC_FORMAT_CHECK_FAILED',
    'PUBLIC_LINT_FAILED',
    'PUBLIC_TYPECHECK_FAILED',
    'PUBLIC_TEST_FAILED',
    'GAS_BUILD_FAILED',
  ]) {
    assert.match(source, new RegExp(diagnostic))
  }
  assert.doesNotMatch(source, /PUBLIC_BUILD_FAILED/)
  assert.doesNotMatch(source, /throw new Error\('PUBLIC_VERIFY_FAILED'\)/)
})
