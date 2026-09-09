import test from 'node:test'
import assert from 'node:assert/strict'

import { formatResultComment, parseSafeResult } from '../scripts/report-result.mjs'

test('parseSafeResult keeps only reviewed safe fields', () => {
  const sourceSha = 'a'.repeat(40)
  const toolingSha = 'b'.repeat(40)
  const result = parseSafeResult(JSON.stringify({
    schema_version: 1,
    task: 'repository-verify',
    status: 'FAIL',
    source_sha: sourceSha,
    tooling_sha: toolingSha,
    diagnostic: 'PUBLIC_VERIFY_FAILED',
    changed_path_count: 6,
    exported_file_count: 120,
    public_commands: ['npm run verify:public', 'rm -rf /'],
    qualified_render_required: false,
    stdout: 'PRIVATE_SENTINEL',
    secret: 'should-not-appear',
  }))

  assert.deepEqual(result, {
    task: 'repository-verify',
    status: 'FAIL',
    source_sha: sourceSha,
    tooling_sha: toolingSha,
    diagnostic: 'PUBLIC_VERIFY_FAILED',
    changed_path_count: 6,
    exported_file_count: 120,
    public_commands: ['npm run verify:public'],
    qualified_render_required: false,
  })
})

test('formatResultComment cannot relay unreviewed private output', () => {
  const comment = formatResultComment(JSON.stringify({
    task: 'repository-verify',
    status: 'FAIL',
    diagnostic: 'GAS_BUILD_FAILED',
    stdout: 'PRIVATE_SENTINEL',
    stderr: 'PRIVATE_ERROR_BODY',
  }), 'https://github.com/clockcrockwork/note-projects-cli/actions/runs/123')

  assert.match(comment, /GAS_BUILD_FAILED/)
  assert.match(comment, /actions\/runs\/123/)
  assert.doesNotMatch(comment, /PRIVATE_SENTINEL/)
  assert.doesNotMatch(comment, /PRIVATE_ERROR_BODY/)
})

test('invalid result JSON fails closed to a stable diagnostic', () => {
  assert.deepEqual(parseSafeResult('{bad'), {
    status: 'FAIL',
    diagnostic: 'RESULT_JSON_INVALID',
  })
})
