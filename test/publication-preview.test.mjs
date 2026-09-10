import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findArticleRoot,
  isolatedDockerCreateArgs,
  safePublicResult,
} from '../scripts/run-publication-preview.mjs'
import {
  formatPreviewResultComment,
  parseSafePreviewResult,
} from '../scripts/report-publication-preview-result.mjs'

test('findArticleRoot resolves one exact Article-ID-prefixed package', () => {
  const listing = {
    tree: [
      { type: 'tree', path: 'articles/work-insight/ART-012-search-state-verification' },
      { type: 'tree', path: 'articles/payment-notice/ART-009-payment-notice-complete' },
    ],
  }
  assert.equal(
    findArticleRoot(listing, 'ART-012'),
    'articles/work-insight/ART-012-search-state-verification',
  )
})

test('findArticleRoot fails closed on ambiguity and absence', () => {
  assert.throws(
    () =>
      findArticleRoot(
        {
          tree: [
            { type: 'tree', path: 'articles/a/ART-012-one' },
            { type: 'tree', path: 'articles/b/ART-012-two' },
          ],
        },
        'ART-012',
      ),
    /PUBLICATION_PREVIEW_TARGET_AMBIGUOUS/,
  )
  assert.throws(() => findArticleRoot({ tree: [] }, 'ART-012'), /PUBLICATION_PREVIEW_TARGET_NOT_FOUND/)
})

test('preview build container is created no-egress without a host bind mount', () => {
  const args = isolatedDockerCreateArgs({
    image: 'node:22-bookworm',
    workdir: '/workspace',
    argv: ['node', 'tools/build-publication-preview.mjs', 'ART-012'],
    env: { SOURCE_SHA: 'a'.repeat(40) },
  })

  assert.deepEqual(args.slice(0, 4), ['docker', 'create', '--network', 'none'])
  assert.equal(args.includes('--cap-drop'), true)
  assert.equal(args.includes('no-new-privileges'), true)
  assert.equal(args.includes('-v'), false)
  assert.equal(args.includes('SOURCE_SHA=' + 'a'.repeat(40)), true)
  assert.deepEqual(args.slice(-5), [
    '-w',
    '/workspace',
    'node:22-bookworm',
    'node',
    'tools/build-publication-preview.mjs',
    'ART-012',
  ].slice(-5))
})

test('safe public preview result never carries protected URLs or deployment IDs', () => {
  const result = safePublicResult({
    status: 'PASS',
    source_sha: 'a'.repeat(40),
    tooling_sha: 'b'.repeat(40),
    target: 'ART-012',
    preview_count: 1,
    url: 'https://secret.vercel.app',
    deployment_id: 'dpl_secret',
  })
  assert.deepEqual(result, {
    schema_version: 1,
    task: 'publication-preview',
    status: 'PASS',
    source_sha: 'a'.repeat(40),
    tooling_sha: 'b'.repeat(40),
    target: 'ART-012',
    preview_count: 1,
  })
})

test('public result formatter strips unreviewed fields and withholds preview URLs', () => {
  const raw = JSON.stringify({
    task: 'publication-preview',
    status: 'PASS',
    source_sha: 'a'.repeat(40),
    tooling_sha: 'b'.repeat(40),
    target: 'ART-012',
    preview_count: 1,
    previews: [{ url: 'https://secret.vercel.app', deployment_id: 'dpl_secret' }],
  })
  const parsed = parseSafePreviewResult(raw)
  assert.equal(parsed.preview_count, 1)
  assert.equal('previews' in parsed, false)
  const comment = formatPreviewResultComment(
    raw,
    'https://github.com/clockcrockwork/note-projects-cli/actions/runs/123',
  )
  assert.match(comment, /protected previews: 1/)
  assert.match(comment, /intentionally not included/)
  assert.doesNotMatch(comment, /secret\.vercel\.app|dpl_secret/)
})
