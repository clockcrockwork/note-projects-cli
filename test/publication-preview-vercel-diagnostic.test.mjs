import test from 'node:test'
import assert from 'node:assert/strict'

import { vercelSubprocessDiagnostic } from '../scripts/run-publication-preview.mjs'

test('Vercel deploy failure exposes only HTTP status and machine-safe error code', () => {
  const diagnostic = vercelSubprocessDiagnostic({
    stderr:
      'create Vercel preview deployment: HTTP 400: CODE=missing_files token=secret-value https://private-preview.vercel.app unpublished body',
  })

  assert.equal(diagnostic, 'VERCEL_DEPLOY_HTTP_400_MISSING_FILES')
  assert.equal(diagnostic.includes('secret-value'), false)
  assert.equal(diagnostic.includes('private-preview'), false)
  assert.equal(diagnostic.includes('unpublished'), false)
})

test('Vercel deploy failure still exposes HTTP status when no safe code exists', () => {
  assert.equal(
    vercelSubprocessDiagnostic({
      stderr:
        'create Vercel preview deployment: HTTP 400: token=secret-value https://private-preview.vercel.app unpublished body',
    }),
    'VERCEL_DEPLOY_HTTP_400',
  )
})

test('Vercel deploy failure falls back when stderr does not match the trusted prefix', () => {
  assert.equal(
    vercelSubprocessDiagnostic({ stderr: 'HTTP 403: arbitrary unrelated subprocess output' }),
    'VERCEL_DEPLOY_FAILED',
  )
  assert.equal(
    vercelSubprocessDiagnostic({
      stderr: 'create Vercel preview deployment: HTTP 999: impossible status',
    }),
    'VERCEL_DEPLOY_FAILED',
  )
})
