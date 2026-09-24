import test from 'node:test'
import assert from 'node:assert/strict'

import { vercelApiDiagnostic } from '../scripts/run-ccw-publication-console.mjs'

test('CCW console Vercel deploy diagnostic exposes only HTTP status and safe code', () => {
  const diagnostic = vercelApiDiagnostic(413, {
    error: {
      code: 'request_body_too_large',
      message: 'secret unpublished content https://private.example',
    },
  })
  assert.equal(diagnostic, 'VERCEL_DEPLOY_HTTP_413_REQUEST_BODY_TOO_LARGE')
  assert.equal(diagnostic.includes('secret'), false)
  assert.equal(diagnostic.includes('private.example'), false)
})

test('CCW console Vercel deploy diagnostic keeps HTTP status without a safe code', () => {
  assert.equal(vercelApiDiagnostic(400, { error: { message: 'private' } }), 'VERCEL_DEPLOY_HTTP_400')
})

test('CCW console Vercel deploy diagnostic rejects invalid status values', () => {
  assert.equal(vercelApiDiagnostic(999, { error: { code: 'bad' } }), 'VERCEL_DEPLOY_FAILED')
})
