import test from 'node:test'
import assert from 'node:assert/strict'

import { formatResultComment, parseSafeResult, publishResult } from '../scripts/report-result.mjs'

test('parseSafeResult keeps only reviewed safe fields', () => {
  const sourceSha = 'a'.repeat(40)
  const toolingSha = 'b'.repeat(40)
  const result = parseSafeResult(
    JSON.stringify({
      schema_version: 1,
      task: 'repository-verify',
      status: 'FAIL',
      source_sha: sourceSha,
      tooling_sha: toolingSha,
      diagnostic: 'PUBLIC_FORMAT_CHECK_FAILED',
      changed_path_count: 6,
      exported_file_count: 120,
      format_changed_path_indices: [4, 1, 4, -1, 7, '2'],
      format_changed_spans: [
        {
          changed_path_index: 3,
          start_line: 61,
          old_line_count: 4,
          new_line_count: 2,
          path: 'private/file.mjs',
          content: 'PRIVATE_SENTINEL',
        },
        { changed_path_index: 9, start_line: 1, old_line_count: 1, new_line_count: 1 },
        { changed_path_index: 2, start_line: 0, old_line_count: 1, new_line_count: 1 },
      ],
      format_unrelated_count: 3,
      public_commands: ['npm run verify:public', 'rm -rf /'],
      qualified_render_required: false,
      stdout: 'PRIVATE_SENTINEL',
      secret: 'should-not-appear',
    }),
  )

  assert.deepEqual(result, {
    task: 'repository-verify',
    status: 'FAIL',
    source_sha: sourceSha,
    tooling_sha: toolingSha,
    diagnostic: 'PUBLIC_FORMAT_CHECK_FAILED',
    changed_path_count: 6,
    exported_file_count: 120,
    format_changed_path_indices: [1, 4],
    format_changed_spans: [
      {
        changed_path_index: 3,
        start_line: 61,
        old_line_count: 4,
        new_line_count: 2,
      },
    ],
    format_unrelated_count: 3,
    public_commands: ['npm run verify:public'],
    qualified_render_required: false,
  })
})

test('formatResultComment reports only numeric format locations, never file names or private output', () => {
  const comment = formatResultComment(
    JSON.stringify({
      task: 'repository-verify',
      status: 'FAIL',
      diagnostic: 'PUBLIC_FORMAT_CHECK_FAILED',
      changed_path_count: 5,
      format_changed_path_indices: [1, 3],
      format_changed_spans: [
        {
          changed_path_index: 3,
          start_line: 61,
          old_line_count: 4,
          new_line_count: 2,
          path: 'articles/private/body.note.md',
          content: 'PRIVATE_SENTINEL',
        },
      ],
      format_unrelated_count: 2,
      path: 'articles/private/body.note.md',
      stdout: 'PRIVATE_SENTINEL',
    }),
    'https://github.com/clockcrockwork/note-projects-cli/actions/runs/123',
  )

  assert.match(comment, /format changed-path indices: 1, 3/)
  assert.match(comment, /format change spans: #3@L61 4->2/)
  assert.match(comment, /unrelated format differences: 2/)
  assert.doesNotMatch(comment, /articles\/private/)
  assert.doesNotMatch(comment, /PRIVATE_SENTINEL/)
})

test('Patreon verify reports only fixed reviewed commands', () => {
  const result = parseSafeResult(
    JSON.stringify({
      task: 'patreon-verify',
      status: 'PASS',
      source_sha: 'a'.repeat(40),
      changed_path_count: 12,
      exported_file_count: 48,
      public_commands: [
        'npm run workflow:test',
        'npm run publication-console:test',
        'npm run public-view:test',
        'npm run publication-console:build',
        'npm run public-view:build',
        'cat content/publications/private.md',
      ],
      stdout: 'PRIVATE_SENTINEL',
    }),
  )

  assert.deepEqual(result.public_commands, [
    'npm run workflow:test',
    'npm run publication-console:test',
    'npm run public-view:test',
    'npm run publication-console:build',
    'npm run public-view:build',
  ])
  assert.equal('stdout' in result, false)
})

test('formatResultComment cannot relay unreviewed private output', () => {
  const comment = formatResultComment(
    JSON.stringify({
      task: 'repository-verify',
      status: 'FAIL',
      diagnostic: 'GAS_BUILD_FAILED',
      stdout: 'PRIVATE_SENTINEL',
      stderr: 'PRIVATE_ERROR_BODY',
    }),
    'https://github.com/clockcrockwork/note-projects-cli/actions/runs/123',
  )

  assert.match(comment, /GAS_BUILD_FAILED/)
  assert.match(comment, /actions\/runs\/123/)
  assert.doesNotMatch(comment, /PRIVATE_SENTINEL/)
  assert.doesNotMatch(comment, /PRIVATE_ERROR_BODY/)
})

test('verify-publication report exposes only safe result identifiers', () => {
  const sourceSha = 'a'.repeat(40)
  const toolingSha = 'b'.repeat(40)
  const comment = formatResultComment(
    JSON.stringify({
      task: 'verify-publication',
      status: 'HOLD',
      article_id: 'ART-012',
      source_sha: sourceSha,
      tooling_sha: toolingSha,
      live_result: 'HOLD',
      viewport_results: { desktop: 'PASS', mobile: 'HOLD', secret: 'PRIVATE_SENTINEL' },
      diagnostic: 'PUBLICATION_LIVE_HOLD',
      published_url: 'https://note.com/private-path',
      expected_title: 'PRIVATE_TITLE',
    }),
    'https://github.com/clockcrockwork/note-projects-cli/actions/runs/456',
  )

  assert.match(comment, /article: `ART-012`/)
  assert.match(comment, /live result: `HOLD`/)
  assert.match(comment, /viewports: `desktop=PASS, mobile=HOLD`/)
  assert.match(comment, /PUBLICATION_LIVE_HOLD/)
  assert.doesNotMatch(comment, /PRIVATE|note\.com/)
})

test('invalid result JSON fails closed to a stable diagnostic', () => {
  assert.deepEqual(parseSafeResult('{bad'), {
    status: 'FAIL',
    diagnostic: 'RESULT_JSON_INVALID',
  })
})


test('publishResult posts durable terminal result before closing the request issue', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200 }
  }

  await publishResult({
    token: 'test-token',
    repository: 'clockcrockwork/note-projects-cli',
    issueNumber: '278',
    resultJson: JSON.stringify({
      task: 'repository-verify',
      status: 'PASS',
      source_sha: 'a'.repeat(40),
    }),
    runUrl: 'https://github.com/clockcrockwork/note-projects-cli/actions/runs/123',
    fetchImpl,
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.method, 'POST')
  assert.match(calls[0].url, /\/issues\/278\/comments$/)
  assert.equal(calls[1].options.method, 'PATCH')
  assert.match(calls[1].url, /\/issues\/278$/)
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    state: 'closed',
    state_reason: 'completed',
  })
})

test('publishResult does not close the request issue when durable result comment fails', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { ok: false, status: 500 }
  }

  await assert.rejects(
    publishResult({
      token: 'test-token',
      repository: 'clockcrockwork/note-projects-cli',
      issueNumber: '278',
      resultJson: JSON.stringify({ task: 'repository-verify', status: 'FAIL', diagnostic: 'TEST_FAIL' }),
      fetchImpl,
    }),
    /REPORT_GITHUB_API_500/,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'POST')
})
