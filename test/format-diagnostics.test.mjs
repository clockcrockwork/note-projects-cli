import test from 'node:test'
import assert from 'node:assert/strict'

import {
  changedExportedPaths,
  parseDifferentPaths,
  safeFormatFailureDetails,
} from '../scripts/run-repository-verify.mjs'

test('prettier list-different output is normalized without exposing content', () => {
  assert.deepEqual(parseDifferentPaths('./b.mjs\na.mjs\na.mjs\n'), ['a.mjs', 'b.mjs'])
})

test('format diagnostics expose only changed-path indices and unrelated count', () => {
  const changedPaths = [
    'docs/private.md',
    'package.json',
    'tests/example.spec.mjs',
    'tools/example.mjs',
  ]

  assert.deepEqual(
    safeFormatFailureDetails('tools/example.mjs\npackage.json\nsrc/unrelated.mjs\n', changedPaths),
    {
      format_changed_path_indices: [1, 3],
      format_unrelated_count: 1,
    },
  )
})

test('format gate targets only changed files that crossed the public export boundary', () => {
  const changedPaths = [
    'docs/private.md',
    'package.json',
    'tests/example.spec.mjs',
    'articles/private/body.note.md',
  ]
  const exportedPaths = [
    'package.json',
    'tests/example.spec.mjs',
    'src/preexisting-unformatted.mjs',
  ]

  assert.deepEqual(changedExportedPaths(changedPaths, exportedPaths), [
    'package.json',
    'tests/example.spec.mjs',
  ])
})
