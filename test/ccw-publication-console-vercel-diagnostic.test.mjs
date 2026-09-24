import test from 'node:test'
import assert from 'node:assert/strict'

import { deploymentFileIdentity, vercelApiDiagnostic } from '../scripts/run-ccw-publication-console.mjs'

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

test('CCW console deployment file identity uses Vercel SHA1 reference semantics', () => {
  const file = deploymentFileIdentity('abc')
  assert.equal(file.file, 'index.html')
  assert.equal(file.sha, 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(file.size, 3)
  assert.equal(file.bytes.toString('utf8'), 'abc')
})
