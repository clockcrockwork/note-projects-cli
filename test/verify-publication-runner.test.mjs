import test from 'node:test'
import assert from 'node:assert/strict'

import {
  findTargetPublicationPath,
  publicationDataPaths,
  safeEvidenceFromReport,
} from '../scripts/run-verify-publication.mjs'

const blob = (path) => ({ path, type: 'blob', sha: 'a'.repeat(40) })

test('findTargetPublicationPath resolves one exact target folder prefix', () => {
  const tree = [
    blob('articles/work-insight/ART-012-search-state-verification/publication/publication.yaml'),
    blob('articles/work-insight/ART-010-ai-visual-quality-bar/publication/publication.yaml'),
  ]
  assert.equal(
    findTargetPublicationPath(tree, 'ART-012'),
    'articles/work-insight/ART-012-search-state-verification/publication/publication.yaml',
  )
})

test('findTargetPublicationPath fails closed on ambiguity', () => {
  const tree = [
    blob('articles/a/ART-012-one/publication/publication.yaml'),
    blob('articles/b/ART-012-two/publication/publication.yaml'),
  ]
  assert.throws(() => findTargetPublicationPath(tree, 'ART-012'), /PUBLICATION_TARGET_AMBIGUOUS/)
})

test('publicationDataPaths exports publication metadata plus markdown only', () => {
  const publication =
    'articles/work-insight/ART-012-search-state-verification/publication/publication.yaml'
  const tree = [
    blob(publication),
    blob('articles/work-insight/ART-012-search-state-verification/publication/body.note.md'),
    blob('articles/work-insight/ART-012-search-state-verification/publication/notes.md'),
    blob('articles/work-insight/ART-012-search-state-verification/publication/assets/cover.png'),
    blob('articles/work-insight/ART-012-search-state-verification/draft.md'),
  ]
  assert.deepEqual(publicationDataPaths(tree, publication), [
    'articles/work-insight/ART-012-search-state-verification/publication/body.note.md',
    'articles/work-insight/ART-012-search-state-verification/publication/notes.md',
    publication,
  ])
})

test('safeEvidenceFromReport strips page text, URLs and check details', () => {
  const sourceSha = 'a'.repeat(40)
  const toolingSha = 'b'.repeat(40)
  const safe = safeEvidenceFromReport(
    {
      article_id: 'ART-012',
      checked_at: '2026-09-11T10:00:00.000Z',
      published_url: 'https://note.com/private-looking-path',
      result: 'HOLD',
      expected: { title: 'PRIVATE_TITLE', body_signature: { first: 'PRIVATE_BODY' } },
      viewports: {
        desktop: {
          result: 'HOLD',
          status: 200,
          retries: 0,
          snapshot: { pageText: 'PRIVATE_PAGE_TEXT' },
          checks: [
            { id: 'title', status: 'PASS', detail: { expected: 'PRIVATE_TITLE' } },
            { id: 'tags', status: 'HOLD', detail: { missing: ['PRIVATE_TAG'] } },
            { id: '../escape', status: 'HOLD', detail: 'PRIVATE' },
          ],
        },
        mobile: { result: 'RETRYABLE_FAIL', status: 503, retries: 5, checks: [] },
      },
    },
    { sourceSha, toolingSha, target: 'ART-012' },
  )

  assert.deepEqual(safe, {
    schema_version: 1,
    task: 'verify-publication',
    article_id: 'ART-012',
    source_sha: sourceSha,
    tooling_sha: toolingSha,
    live_result: 'HOLD',
    checked_at: '2026-09-11T10:00:00.000Z',
    viewports: {
      desktop: {
        result: 'HOLD',
        status: 200,
        retries: 0,
        checks: [
          { id: 'title', status: 'PASS' },
          { id: 'tags', status: 'HOLD' },
        ],
      },
      mobile: { result: 'RETRYABLE_FAIL', status: 503, retries: 5, checks: [] },
    },
  })
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|note\.com/)
})
