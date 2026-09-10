import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BROWSER,
  KIND,
  PAYLOAD_FILENAME,
  PLATFORM,
  PLAYWRIGHT_VERSION,
  SCHEMA_VERSION,
  buildManifest,
  findBrowserRevision,
  validateManifest,
} from '../scripts/playwright-runtime-manifest.mjs'

const SHA = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)

function validManifest(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    kind: KIND,
    playwright_version: PLAYWRIGHT_VERSION,
    browser: BROWSER,
    platform: PLATFORM,
    runner: 'ubuntu-24.04',
    workflow_repository: 'clockcrockwork/note-projects-cli',
    workflow_sha: SHA,
    browser_cache_directory: 'pw-browsers',
    browser_revision: '1243',
    payload_filename: PAYLOAD_FILENAME,
    payload_sha256: SHA256,
    generated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

test('accepts a fully populated schema_version 1 manifest', () => {
  const manifest = validManifest()
  assert.deepEqual(validateManifest(manifest), manifest)
})

test('playwright_version is fixed to 1.63.0 and rejects any other value including latest', () => {
  assert.equal(PLAYWRIGHT_VERSION, '1.63.0')
  assert.throws(() => validateManifest(validManifest({ playwright_version: 'latest' })), /MANIFEST_PLAYWRIGHT_VERSION_INVALID/)
  assert.throws(() => validateManifest(validManifest({ playwright_version: '1.64.0' })), /MANIFEST_PLAYWRIGHT_VERSION_INVALID/)
})

test('rejects missing required fields', () => {
  const manifest = validManifest()
  delete manifest.browser_revision
  assert.throws(() => validateManifest(manifest), /MANIFEST_FIELD_MISSING_browser_revision/)
})

test('rejects unexpected extra fields', () => {
  assert.throws(
    () => validateManifest(validManifest({ arbitrary_command: 'rm -rf /' })),
    /MANIFEST_FIELD_UNEXPECTED_arbitrary_command/,
  )
})

test('rejects malformed sha fields', () => {
  assert.throws(() => validateManifest(validManifest({ workflow_sha: 'not-a-sha' })), /MANIFEST_WORKFLOW_SHA_INVALID/)
  assert.throws(() => validateManifest(validManifest({ payload_sha256: 'short' })), /MANIFEST_PAYLOAD_SHA256_INVALID/)
})

test('rejects a payload filename that does not match the fixed pinned-version name', () => {
  assert.throws(
    () => validateManifest(validManifest({ payload_filename: 'playwright-runtime-latest-linux-x64-headless-shell.tar.gz' })),
    /MANIFEST_PAYLOAD_FILENAME_INVALID/,
  )
})

test('buildManifest produces a manifest that already passes validateManifest', () => {
  const manifest = buildManifest({
    runner: 'ubuntu-24.04',
    workflowRepository: 'clockcrockwork/note-projects-cli',
    workflowSha: SHA,
    browserCacheDirectory: 'pw-browsers',
    browserRevision: '1243',
    payloadSha256: SHA256,
    generatedAt: '2026-09-10T00:00:00.000Z',
  })
  assert.equal(manifest.schema_version, SCHEMA_VERSION)
  assert.equal(manifest.kind, KIND)
  assert.equal(manifest.playwright_version, PLAYWRIGHT_VERSION)
})

test('findBrowserRevision reads the machine-generated revision, not a human guess', () => {
  const browsersJson = JSON.stringify({
    browsers: [
      { name: 'chromium', revision: '1243' },
      { name: 'chromium-headless-shell', revision: '1243' },
      { name: 'firefox', revision: '1543' },
    ],
  })
  assert.equal(findBrowserRevision(browsersJson), '1243')
})

test('findBrowserRevision fails closed when the entry is missing or malformed', () => {
  assert.throws(() => findBrowserRevision('not json'), /BROWSERS_JSON_INVALID/)
  assert.throws(() => findBrowserRevision(JSON.stringify({ browsers: [] })), /BROWSER_REVISION_NOT_FOUND/)
  assert.throws(
    () => findBrowserRevision(JSON.stringify({ browsers: [{ name: 'chromium-headless-shell' }] })),
    /BROWSER_REVISION_NOT_FOUND/,
  )
})
