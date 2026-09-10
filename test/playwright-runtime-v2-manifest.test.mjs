import assert from 'node:assert/strict'
import test from 'node:test'
import { ARTIFACT_NAME, CARRIER_PROFILE, PAYLOAD_FILENAME, PLAYWRIGHT_VERSION, SCHEMA_VERSION, buildManifest, validateManifest } from '../scripts/playwright-runtime-v2-manifest.mjs'

const runtime = (directory) => ({ revision: '1243', directory, executable_relative_path: 'bin/chrome', executable_sha256: 'b'.repeat(64), executable_size: 42, executable_mode: '755' })
const valid = () => ({ schema_version: SCHEMA_VERSION, kind: 'playwright-runtime-carrier', carrier_profile: CARRIER_PROFILE, playwright_version: PLAYWRIGHT_VERSION, platform: 'linux-x64', runner: 'ubuntu-24.04', workflow_repository: 'clockcrockwork/note-projects-cli', workflow_sha: 'a'.repeat(40), browser_cache_directory: 'pw-browsers', chromium: runtime('chromium-1243'), chromium_headless_shell: runtime('chromium_headless_shell-1243'), payload_filename: PAYLOAD_FILENAME, payload_sha256: 'c'.repeat(64), generated_at: '2026-09-10T00:00:00.000Z' })

test('V2 is a fixed complete Chromium schema with identity for both executables', () => {
  const manifest = valid()
  assert.deepEqual(validateManifest(manifest), manifest)
  assert.equal(PLAYWRIGHT_VERSION, '1.63.0')
  assert.equal(ARTIFACT_NAME, 'playwright-runtime-1.63.0-linux-x64-chromium-complete')
})
test('V2 rejects omitted inner executable identity and arbitrary schema fields', () => {
  const missing = valid(); delete missing.chromium.executable_sha256
  assert.throws(() => validateManifest(missing), /chromium_MISSING_executable_sha256/)
  assert.throws(() => validateManifest({ ...valid(), arbitrary_command: 'x' }), /UNEXPECTED_arbitrary_command/)
})
test('buildManifest validates the complete fixed contract', () => {
  const manifest = buildManifest({ runner: 'ubuntu-24.04', workflowRepository: 'clockcrockwork/note-projects-cli', workflowSha: 'a'.repeat(40), browserCacheDirectory: 'pw-browsers', chromium: runtime('chromium-1243'), chromiumHeadlessShell: runtime('chromium_headless_shell-1243'), payloadSha256: 'c'.repeat(64), generatedAt: '2026-09-10T00:00:00.000Z' })
  assert.equal(manifest.schema_version, 2)
})
