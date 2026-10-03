import test from 'node:test'
import assert from 'node:assert/strict'
import { safePlaywrightFailureDetails } from '../scripts/run-repository-verify.mjs'

const changed = ['tests/changed.spec.mjs']
const exported = ['tests/changed.spec.mjs', 'tests/existing.spec.mjs']
const empty = {
  test_diagnostics: [],
  test_unrelated_diagnostics: [],
  test_unrelated_count: 0,
}

test('list reporter passing, skipped, running and step rows are not failures', () => {
  const output = [
    '  ✓ 1 tests/changed.spec.mjs:10:1 › PRIVATE_TITLE (3ms)',
    '  ok 2 tests/existing.spec.mjs:20:1 › PRIVATE_TITLE (3ms)',
    '  - 3 tests/existing.spec.mjs:30:1 › PRIVATE_TITLE',
    '    4 tests/existing.spec.mjs:40:1 › PRIVATE_TITLE',
    '    4.1 tests/existing.spec.mjs:40:1 › PRIVATE_TITLE › step (3ms)',
    'Error: tests/existing.spec.mjs:50:1 › PRIVATE_OUTPUT',
    'tests/existing.spec.mjs:60:1 › PRIVATE_OUTPUT',
  ].join('\n')
  assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), empty)
})

for (const marker of ['✘', 'x']) {
  test(`list reporter ${marker} failure rows keep only numeric locations`, () => {
    const output = [
      `  ${marker} 1 tests/changed.spec.mjs:12:7 › PRIVATE_TITLE (3ms)`,
      `  ${marker} 2 [project name] › tests/existing.spec.mjs:44:3 › PRIVATE_TITLE (3ms)`,
    ].join('\n')
    assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), {
      test_diagnostics: [{ changed_path_index: 0, line: 12, column: 7 }],
      test_unrelated_diagnostics: [{ exported_path_index: 1, line: 44, column: 3 }],
      test_unrelated_count: 1,
    })
  })
}

test('ANSI controls, CRLF and relative prefixes are normalized before parsing', () => {
  const output = [
    '\u001b[32m  ✓ \u001b[0m1 tests/existing.spec.mjs:10:1 › PRIVATE_TITLE (3ms)',
    '\u001b[2K\u001b[31m  ✘ \u001b[0m\u001b[2m2 \u001b[22m[project] › ./tests/changed.spec.mjs:12:7 › PRIVATE_TITLE (3ms)',
    '\u001b[31m  1) [project] › ./tests/changed.spec.mjs:12:7 › PRIVATE_TITLE ───\u001b[0m',
  ].join('\r\n')
  assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), {
    ...empty,
    test_diagnostics: [{ changed_path_index: 0, line: 12, column: 7 }],
  })
})

test('project labels can contain brackets and reporter separators', () => {
  for (const prefix of ['  x 1 ', '  1) ', '  1 failed\n    ']) {
    const output = `${prefix}[Chrome [small] › desktop] › tests/changed.spec.mjs:12:7 › PRIVATE_TITLE`
    assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), {
      ...empty,
      test_diagnostics: [{ changed_path_index: 0, line: 12, column: 7 }],
    })
  }
})

test('final failed summary excludes passing retries, expected failures and flaky details', () => {
  const output = [
    '  ✘ 1 tests/changed.spec.mjs:10:1 › flaky title (3ms)',
    '  ✓ 2 tests/changed.spec.mjs:10:1 › flaky title (retry #1) (3ms)',
    '  ✘ 3 tests/changed.spec.mjs:20:1 › expected failure (3ms)',
    '  ✓ 4 tests/existing.spec.mjs:30:1 › unexpected pass (3ms)',
    '  ✘ 5 tests/existing.spec.mjs:40:1 › failed title (3ms)',
    '  x 6 tests/existing.spec.mjs:40:1 › failed title (retry #1) (3ms)',
    '  1) tests/existing.spec.mjs:30:1 › unexpected pass ───',
    '  2) tests/existing.spec.mjs:40:1 › failed title ───',
    '    Retry #1 ───',
    '  3) tests/changed.spec.mjs:10:1 › flaky title ───',
    '  2 failed',
    '    tests/existing.spec.mjs:30:1 › unexpected pass ───',
    '    tests/existing.spec.mjs:40:1 › failed title ───',
    '  1 flaky',
    '    tests/changed.spec.mjs:10:1 › flaky title ───',
    '  1 passed (1.0s)',
  ].join('\n')
  assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), {
    ...empty,
    test_unrelated_diagnostics: [
      { exported_path_index: 1, line: 30, column: 1 },
      { exported_path_index: 1, line: 40, column: 1 },
    ],
    test_unrelated_count: 2,
  })
})

test('a completed summary with no failed tests overrides earlier failed attempts', () => {
  const output = [
    '  x 1 tests/changed.spec.mjs:10:1 › expected failure (3ms)',
    '  x 2 tests/existing.spec.mjs:20:1 › flaky title (3ms)',
    '  ok 3 tests/existing.spec.mjs:20:1 › flaky title (retry #1) (3ms)',
    '  1) tests/existing.spec.mjs:20:1 › flaky title ───',
    '  1 flaky',
    '    tests/existing.spec.mjs:20:1 › flaky title ───',
    '  1 skipped',
    '  1 passed (1.0s)',
  ].join('\n')
  assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), empty)
})

test('summary failure locations are deduplicated without consuming later arbitrary output', () => {
  const output = [
    '  2 failed',
    '    [first] › tests/changed.spec.mjs:12:7 › PRIVATE_TITLE ───',
    '    [second] › tests/changed.spec.mjs:12:7 › PRIVATE_TITLE ───',
    '',
    'tests/existing.spec.mjs:44:3 › PRIVATE_OUTPUT',
  ].join('\n')
  assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), {
    ...empty,
    test_diagnostics: [{ changed_path_index: 0, line: 12, column: 7 }],
  })
})

test('unsupported summary paths and multiline titles do not hide later supported failures', () => {
  const output = [
    '  4 failed',
    '    tests/other.spec.ts:2:1 › unsupported extension ───',
    '    tests/with spaces.spec.mjs:3:1 › unsupported path ───',
    '    tests/existing.spec.mjs:4:1 › multiline title',
    '',
    'title continuation ───',
    '    tests/changed.spec.mjs:12:7 › PRIVATE_TITLE ───',
    '',
    '    tests/existing.spec.mjs:99:1 › unrelated output after the summary',
  ].join('\n')
  assert.deepEqual(safePlaywrightFailureDetails(output, changed, exported), {
    test_diagnostics: [{ changed_path_index: 0, line: 12, column: 7 }],
    test_unrelated_diagnostics: [{ exported_path_index: 1, line: 4, column: 1 }],
    test_unrelated_count: 1,
  })
})

test('failure diagnostics remain sorted, bounded and free of paths, titles and raw output', () => {
  const output = [
    ...Array.from({ length: 25 }, (_, index) =>
      `  x ${index + 1} tests/changed.spec.mjs:${25 - index}:1 › PRIVATE_TITLE (3ms)`),
    ...Array.from({ length: 25 }, (_, index) =>
      `  x ${index + 26} tests/existing.spec.mjs:${25 - index}:2 › PRIVATE_TITLE (3ms)`),
    '  x 51 private/PRIVATE_PATH.spec.mjs:8:3 › PRIVATE_TITLE (3ms)',
    'Error: PRIVATE_OUTPUT',
  ].join('\n')
  const result = safePlaywrightFailureDetails(output, changed, exported)
  assert.deepEqual(result, {
    test_diagnostics: Array.from({ length: 20 }, (_, index) =>
      ({ changed_path_index: 0, line: index + 1, column: 1 })),
    test_unrelated_diagnostics: Array.from({ length: 20 }, (_, index) =>
      ({ exported_path_index: 1, line: index + 1, column: 2 })),
    test_unrelated_count: 26,
  })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|tests\/|\.spec\.mjs|Error:/)
})
