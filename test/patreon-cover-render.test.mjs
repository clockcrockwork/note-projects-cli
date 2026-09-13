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

const archiveManifest = {
  schema_version: 1,
  targets: {
    'PTN-COVER-WELCOME': {
      request: 'covers/requests/welcome.yaml',
      media: [
        {
          source_archive: 'covers/media/public-ready/patreon-cover-media-v1.zip',
          archive_entry: 'welcome.png',
          destination: 'covers/media/generated/welcome.png',
          sha256: '23a264a1426d7b6bc2f756649909f4b9c9afba2e243eced273ae4b3673849dac',
        },
      ],
    },
  },
}

const chunkedManifest = {
  schema_version: 1,
  targets: {
    'PTN-COVER-AI-COST-RECOVERY': {
      request: 'covers/requests/ai-cost-recovery.yaml',
      media: [
        {
          source_parts: [
            'covers/media/public-ready/_chunks/ai-cost/part-001.b64part',
            'covers/media/public-ready/_chunks/ai-cost/part-002.b64part',
          ],
          destination: 'covers/media/generated/ai-cost-recovery.jpg',
          sha256: 'ce694ac62489afcdf75081728a86e6a090505f6b45bdcc2d2da5d0490de5fb19',
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

test('accepts one export-approved ZIP plus an allowlisted root image entry', () => {
  assert.deepEqual(validateManifest(archiveManifest, 'PTN-COVER-WELCOME'), {
    request: 'covers/requests/welcome.yaml',
    media: [
      {
        source_archive: 'covers/media/public-ready/patreon-cover-media-v1.zip',
        archive_entry: 'welcome.png',
        destination: 'covers/media/generated/welcome.png',
        sha256: '23a264a1426d7b6bc2f756649909f4b9c9afba2e243eced273ae4b3673849dac',
      },
    ],
  })
})

test('accepts ordered base64 parts inside the public-ready recovery boundary', () => {
  assert.deepEqual(validateManifest(chunkedManifest, 'PTN-COVER-AI-COST-RECOVERY'), {
    request: 'covers/requests/ai-cost-recovery.yaml',
    media: [
      {
        source_parts: [
          'covers/media/public-ready/_chunks/ai-cost/part-001.b64part',
          'covers/media/public-ready/_chunks/ai-cost/part-002.b64part',
        ],
        destination: 'covers/media/generated/ai-cost-recovery.jpg',
        sha256: 'ce694ac62489afcdf75081728a86e6a090505f6b45bdcc2d2da5d0490de5fb19',
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

test('rejects ZIP traversal and nested archive entries', () => {
  const unsafe = structuredClone(archiveManifest)
  unsafe.targets['PTN-COVER-WELCOME'].media[0].archive_entry = '../welcome.png'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)

  const nested = structuredClone(archiveManifest)
  nested.targets['PTN-COVER-WELCOME'].media[0].archive_entry = 'folder/welcome.png'
  assert.throws(() => validateManifest(nested, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects base64 parts outside the explicit recovery boundary', () => {
  const unsafe = structuredClone(chunkedManifest)
  unsafe.targets['PTN-COVER-AI-COST-RECOVERY'].media[0].source_parts[0] = 'covers/media/public-ready/../private.b64part'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-AI-COST-RECOVERY'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects media declarations with more than one source mode', () => {
  const unsafe = structuredClone(archiveManifest)
  unsafe.targets['PTN-COVER-WELCOME'].media[0].source = 'covers/media/public-ready/welcome.png'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-WELCOME'), /PUBLIC_RENDER_MEDIA_SOURCE_INVALID/)
})

test('rejects request paths outside covers/requests', () => {
  const unsafe = structuredClone(directManifest)
  unsafe.targets['PTN-COVER-OVERGRID'].request = 'content/publications/overgrid-retrospective.md'
  assert.throws(() => validateManifest(unsafe, 'PTN-COVER-OVERGRID'), /PUBLIC_RENDER_REQUEST_INVALID/)
})
