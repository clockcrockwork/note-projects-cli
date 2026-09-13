import assert from 'node:assert/strict'
import test from 'node:test'
import { validateManifest } from '../scripts/run-patreon-cover-render.mjs'

const directManifest = {
  schema_version: 1,
  targets: {
    'PTN-COVER-OVERGRID': {
      request: 'covers/requests/overgrid.yaml',
      media: [
        {
          source: 'covers/media/public-ready/overgrid-newtab.png',
          destination: 'covers/media/overgrid-newtab.png',
        },
      ],
    },
  },
}

const chunkedManifest = {
  schema_version: 1,
  targets: {
    'PTN-COVER-WELCOME': {
      request: 'covers/requests/welcome.yaml',
      media: [
        {
          source_parts: [
            'covers/media/public-ready/_chunks/welcome/part-001.b64part',
            'covers/media/public-ready/_chunks/welcome/part-002.b64part',
          ],
          destination: 'covers/media/generated/welcome.jpg',
          sha256: '16552525be6d3eea0769f281e417b77b1fda4a167b3e2916a41af8bccfdd7ace',
        },
      ],
    },
  },
}

test('accepts a declared Patreon cover target with a direct export-approved image', () => {
  assert.deepEqual(validateManifest(directManifest, 'PTN-COVER-OVERGRID'), {
    request: 'covers/requests/overgrid.yaml',
    media: [
      {
        source: 'covers/media/public-ready/overgrid-newtab.png',
        destination: 'covers/media/overgrid-newtab.png',
      },
    ],
  })
})

test('accepts ordered base64 parts inside the public-ready recovery boundary', () => {
  assert.deepEqual(validateManifest(chunkedManifest, 'PTN-COVER-WELCOME'), {
    request: 'covers/requests/welcome.yaml',
    media: [
      {
        source_parts: [
          'covers/media/public-ready/_chunks/welcome/part-001.b64part',
          'covers/media/public-ready/_chunks/welcome/part-002.b64part',
        ],
        destination: 'covers/media/generated/welcome.jpg',
        sha256: '16552525be6d3eea0769f281e417b77b1fda4a167b3e2916a41af8bccfdd7ace',
      },
    ],
  })
})

test('rejects undeclared target and path-shaped target input', () => {
  assert.throws(() => validateManifest(directManifest, 'PTN-COVER-UNKNOWN'), /TARGET_NOT_DECLARED/)
  assert.throws(() => validateManifest(directManifest, '../secret'), /TARGET_INVALID/)
})

test('rejects media outside the explicit public-ready boundary', () => {
  const unsafe = structuredClone(directManifest)
  unsafe.targets['PTN-COVER-OVERGRID'].media[0].source = 'covers/media/generated/private.png'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-OVERGRID'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects base64 parts outside the explicit recovery boundary', () => {
  const unsafe = structuredClone(chunkedManifest)
  unsafe.targets['PTN-COVER-WELCOME'].media[0].source_parts[0] = 'covers/media/public-ready/../private.b64part'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects media declarations that specify both direct source and source parts', () => {
  const unsafe = structuredClone(chunkedManifest)
  unsafe.targets['PTN-COVER-WELCOME'].media[0].source = 'covers/media/public-ready/welcome.jpg'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects request paths outside covers/requests', () => {
  const unsafe = structuredClone(directManifest)
  unsafe.targets['PTN-COVER-OVERGRID'].request = 'content/publications/overgrid-retrospective.md'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-OVERGRID'), /PUBLIC_RENDER_REQUEST_INVALID/)
})
