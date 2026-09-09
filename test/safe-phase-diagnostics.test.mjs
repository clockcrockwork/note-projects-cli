import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../scripts/run-repository-verify.mjs', import.meta.url), 'utf8')

test('unclassified runner errors become a stable phase diagnostic', () => {
  assert.match(source, /rawDiagnostic === 'UNCLASSIFIED_FAILURE'/)
  assert.match(source, /`RUNNER_\$\{phase\}_FAILED`/)
  assert.match(source, /diagnostic,\n\s*phase,/)
})

test('phase taxonomy is coarse and never carries private content', () => {
  for (const phase of [
    'REQUEST',
    'SOURCE_RESOLVE',
    'DEPENDENCY_INSTALL',
    'RUNTIME_PREPARE',
    'TREE_LIST',
    'EXPORT_PLAN',
    'EXPORT_FETCH',
    'PUBLIC_EXECUTION',
  ]) {
    assert.match(source, new RegExp(`'${phase}'`))
  }
  assert.doesNotMatch(source, /error\.stack/)
  assert.doesNotMatch(source, /error\.message.*emit/)
})
