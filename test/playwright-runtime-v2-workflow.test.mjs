import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { ARTIFACT_NAME, PAYLOAD_FILENAME, PLAYWRIGHT_VERSION } from '../scripts/playwright-runtime-v2-manifest.mjs'

const source = await readFile(new URL('../.github/workflows/playwright-runtime-carrier-v2.yml', import.meta.url), 'utf8')
test('V1 workflow remains present and V2 dispatch has no inputs', async () => {
  const v1 = await readFile(new URL('../.github/workflows/playwright-runtime-carrier.yml', import.meta.url), 'utf8')
  assert.match(v1, /PLAYWRIGHT_RUNTIME_CARRIER_V1/)
  assert.match(source, /workflow_dispatch:\s*\{\}/)
  assert.doesNotMatch(source, /inputs:/)
})
test('V2 is public, pinned, and installs normal chromium rather than only-shell', () => {
  assert.match(source, new RegExp(`PLAYWRIGHT_VERSION:\\s*${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}\\b`))
  assert.match(source, /playwright" install chromium/)
  assert.doesNotMatch(source, /--only-shell|--no-shell|latest|clockcrockwork\/note-projects(?!-cli)\b|secrets\./)
  assert.match(source, new RegExp(`ARTIFACT_NAME:\\s*${ARTIFACT_NAME}\\b`))
  assert.match(source, new RegExp(`PAYLOAD_FILENAME:\\s*${PAYLOAD_FILENAME.replace(/\./g, '\\.')}\\b`))
})
test('V2 verifies both launch modes, both executable trees, and tar stream identity before packaging', () => {
  assert.match(source, /verify-playwright-runtime-v2\.mjs/)
  assert.match(source, /playwright-runtime-v2-tar\.mjs verify/)
  assert.match(source, /playwright-runtime-v2-manifest\.mjs/)
  assert.match(source, /chromium-\*/)
  assert.match(source, /chromium_headless_shell-\*/)
})
test('V2 uses only full-SHA action references and a pinned runner', () => {
  assert.match(source, /runs-on: ubuntu-24\.04/)
  for (const match of source.matchAll(/uses:\s*(\S+)/g)) assert.match(match[1], /@[0-9a-f]{40}$/)
})
