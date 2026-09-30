import test from 'node:test'
import assert from 'node:assert/strict'

import {
  changedExportedPaths,
  parseDifferentPaths,
  safeFormatChangedSpans,
  safeFormatFailureDetails,
  safeLineChangeSpan,
  safeLineChangeSpans,
  safeTypecheckFailureDetails,
  safePlaywrightFailureDetails,
  typecheckFailureIsBaselineOnly,
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


test('typecheck diagnostics expose only changed-path indices and numeric TypeScript locations', () => {
  const changedPaths = ['private/a.mjs', 'src/public.mjs', 'tools/other.mjs']
  const output = [
    'src/public.mjs(12,7): error TS2322: PRIVATE_SENTINEL',
    'private/not-changed.mjs(4,2): error TS7006: PRIVATE_SENTINEL',
    'src/public.mjs(12,7): error TS2322: PRIVATE_SENTINEL',
    'not a diagnostic',
  ].join('\n')

  assert.deepEqual(
    safeTypecheckFailureDetails(output, changedPaths, [
      'package.json',
      'private/not-changed.mjs',
      'src/public.mjs',
    ]),
    {
      typecheck_diagnostics: [{ changed_path_index: 1, line: 12, column: 7, code: 2322 }],
      typecheck_unrelated_diagnostics: [
        { exported_path_index: 1, line: 4, column: 2, code: 7006 },
      ],
      typecheck_unrelated_count: 1,
    },
  )
})


test('baseline-only parsed TypeScript diagnostics do not block an unrelated PR', () => {
  const output = [
    'src/preexisting-a.mjs(4,2): error TS7006: PRIVATE_SENTINEL',
    'tools/preexisting-b.mjs(8,3): error TS2322: PRIVATE_SENTINEL',
  ].join('\n')
  const details = safeTypecheckFailureDetails(output, ['infra/new-change.mjs'], [
    'src/preexisting-a.mjs',
    'tools/preexisting-b.mjs',
  ])

  assert.equal(typecheckFailureIsBaselineOnly(output, details), true)
})

test('changed-path TypeScript diagnostics still block the PR', () => {
  const output = 'infra/new-change.mjs(4,2): error TS7006: PRIVATE_SENTINEL'
  const details = safeTypecheckFailureDetails(output, ['infra/new-change.mjs'], [
    'infra/new-change.mjs',
  ])

  assert.equal(typecheckFailureIsBaselineOnly(output, details), false)
})

test('unparsed TypeScript errors fail closed instead of being called baseline debt', () => {
  const output = [
    'src/preexisting.mjs(4,2): error TS7006: PRIVATE_SENTINEL',
    'error TS6053: File PRIVATE_SENTINEL not found.',
  ].join('\n')
  const details = safeTypecheckFailureDetails(output, ['infra/new-change.mjs'], [
    'src/preexisting.mjs',
  ])

  assert.equal(typecheckFailureIsBaselineOnly(output, details), false)
})


test('playwright diagnostics expose only numeric changed/exported path locations', () => {
  const output = [
    '  1) tests/changed.spec.mjs:12:7 › private title',
    '  2) tests/existing.spec.mjs:44:3 › another private title',
    '  2) tests/existing.spec.mjs:44:3 › duplicate',
  ].join('\n')

  assert.deepEqual(
    safePlaywrightFailureDetails(
      output,
      ['tools/change.mjs', 'tests/changed.spec.mjs'],
      ['package.json', 'tests/changed.spec.mjs', 'tests/existing.spec.mjs'],
    ),
    {
      test_diagnostics: [{ changed_path_index: 1, line: 12, column: 7 }],
      test_unrelated_diagnostics: [{ exported_path_index: 2, line: 44, column: 3 }],
      test_unrelated_count: 1,
    },
  )
})

test('playwright diagnostics ignore arbitrary output and test titles', () => {
  assert.deepEqual(
    safePlaywrightFailureDetails(
      'Error: PRIVATE_SENTINEL\nnot a location\n',
      ['tests/changed.spec.mjs'],
      ['tests/changed.spec.mjs'],
    ),
    {
      test_diagnostics: [],
      test_unrelated_diagnostics: [],
      test_unrelated_count: 0,
    },
  )
})
