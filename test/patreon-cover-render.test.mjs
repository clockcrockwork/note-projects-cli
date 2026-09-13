import assert from 'node:assert/strict'
import test from 'node:test'
import { validateManifest } from '../scripts/run-patreon-cover-render.mjs'

const manifest = {
  schema_version: 1,
  targets: {
    'PTN-COVER-WELCOME': {
      request: 'covers/requests/welcome.yaml',
      media: [
        {
          source: 'covers/media/public-ready/welcome.png',
          destination: 'covers/media/generated/welcome.png',
        },
      ],
    },
  },
}

test('accepts a declared Patreon cover target with export-approved media only', () => {
  assert.deepEqual(validateManifest(manifest, 'PTN-COVER-WELCOME'), {
    request: 'covers/requests/welcome.yaml',
    media: [
      {
        source: 'covers/media/public-ready/welcome.png',
        destination: 'covers/media/generated/welcome.png',
      },
    ],
  })
})

test('rejects undeclared target and path-shaped target input', () => {
  assert.throws(() => validateManifest(manifest, 'PTN-COVER-UNKNOWN'), /TARGET_NOT_DECLARED/)
  assert.throws(() => validateManifest(manifest, '../secret'), /TARGET_INVALID/)
})

test('rejects media outside the explicit public-ready boundary', () => {
  const unsafe = structuredClone(manifest)
  unsafe.targets['PTN-COVER-WELCOME'].media[0].source = 'covers/media/generated/private.png'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects request paths outside covers/requests', () => {
  const unsafe = structuredClone(manifest)
  unsafe.targets['PTN-COVER-WELCOME'].request = 'content/publications/welcome.md'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_REQUEST_INVALID/)
})
