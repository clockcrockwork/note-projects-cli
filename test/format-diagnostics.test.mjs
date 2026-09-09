import test from 'node:test'
import assert from 'node:assert/strict'

import {
  changedExportedPaths,
  parseDifferentPaths,
  safeFormatChangedSpans,
  safeFormatFailureDetails,
  safeLineChangeSpan,
  safeLineChangeSpans,
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

test('line change spans keep separated formatting edits as separate numeric hunks', () => {
  assert.deepEqual(
    safeLineChangeSpans(
      'same-1\nold-a\nsame-2\nold-b\nold-c\nsame-3\n',
      'same-1\nnew-a\nnew-a-2\nsame-2\nnew-b\nsame-3\n',
    ),
    [
      { start_line: 2, old_line_count: 1, new_line_count: 2 },
      { start_line: 4, old_line_count: 2, new_line_count: 1 },
    ],
  )
})

test('format change spans use changed-path indices instead of file names', () => {
  const changedPaths = ['private/a.mjs', 'private/b.mjs', 'private/c.mjs']
  assert.deepEqual(
    safeFormatChangedSpans(
      [
        {
          path: 'private/c.mjs',
          before: 'same\nold-1\nanchor\nold-2\n',
          after: 'same\nnew-1\nanchor\nnew-2\n',
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
        old_line_count: 1,
        new_line_count: 1,
      },
      {
        changed_path_index: 2,
        start_line: 4,
        old_line_count: 1,
        new_line_count: 1,
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
