import test from 'node:test'
import assert from 'node:assert/strict'

import {
  changedExportedPaths,
  parseDifferentPaths,
  safeFormatChangedSpans,
  safeFormatFailureDetails,
  safeLineChangeSpan,
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

test('line change span reports only numeric shape, never changed content', () => {
  assert.deepEqual(safeLineChangeSpan('a\nb\nc\nd\n', 'a\nb\nx\ny\nd\n'), {
    start_line: 3,
    old_line_count: 1,
    new_line_count: 2,
  })
  assert.equal(safeLineChangeSpan('same\n', 'same\n'), null)
})

test('format change spans use changed-path indices instead of file names', () => {
  const changedPaths = ['private/a.mjs', 'private/b.mjs', 'private/c.mjs']
  assert.deepEqual(
    safeFormatChangedSpans(
      [
        {
          path: 'private/c.mjs',
          before: 'one\ntwo\nthree\n',
          after: 'one\nTWO\nTHREE\n',
        },
        {
          path: 'unrelated.mjs',
          before: 'a\n',
          after: 'b\n',
        },
      ],
      changedPaths,
    ),
    [
      {
        changed_path_index: 2,
        start_line: 2,
        old_line_count: 2,
        new_line_count: 2,
      },
    ],
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
