import assert from 'node:assert/strict'
import test from 'node:test'

import { formatResultComment, parseSafeResult } from '../scripts/report-result.mjs'

test('threads-affiliates result keeps only approved machine fields and commands', () => {
  const sha = 'a'.repeat(40)
  const result = parseSafeResult(
    JSON.stringify({
      task: 'threads-affiliates-verify',
      status: 'PASS',
      source_sha: sha,
      changed_path_count: 7,
      exported_file_count: 41,
      public_commands: ['npm test', 'npm run build:gas', 'cat private.txt'],
      stdout: 'PRIVATE_SENTINEL',
    }),
  )

  assert.deepEqual(result, {
    task: 'threads-affiliates-verify',
    status: 'PASS',
    source_sha: sha,
    changed_path_count: 7,
    exported_file_count: 41,
    public_commands: ['npm test', 'npm run build:gas'],
  })

  const comment = formatResultComment(
    JSON.stringify({
      ...result,
      stderr: 'PRIVATE_ERROR_BODY',
    }),
    'https://github.com/clockcrockwork/note-projects-cli/actions/runs/123',
  )
  assert.match(comment, /threads-affiliates-verify/)
  assert.match(comment, /npm test/)
  assert.doesNotMatch(comment, /PRIVATE_ERROR_BODY/)
})
