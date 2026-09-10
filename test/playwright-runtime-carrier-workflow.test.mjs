import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { ARTIFACT_NAME, PAYLOAD_FILENAME, PLAYWRIGHT_VERSION } from '../scripts/playwright-runtime-manifest.mjs'

const source = await readFile(new URL('../.github/workflows/playwright-runtime-carrier.yml', import.meta.url), 'utf8')

test('workflow_dispatch takes no inputs and no other input surface is defined', () => {
  assert.match(source, /workflow_dispatch:\s*\{\}/)
  assert.doesNotMatch(source, /inputs:/)
})

test('workflow never touches the private canonical repository or its credentials', () => {
  assert.doesNotMatch(source, /clockcrockwork\/note-projects(?!-cli)\b/)
  assert.doesNotMatch(source, /private-source-read/)
  assert.doesNotMatch(source, /secrets\./)
})

test('permissions are declared exactly once and are read-only', () => {
  assert.match(source, /permissions:\s*\n\s*contents: read/)
  assert.equal((source.match(/permissions:/g) ?? []).length, 1)
})

test('Playwright version is pinned to the exported manifest constant, never latest', () => {
  assert.match(source, new RegExp(`PLAYWRIGHT_VERSION:\\s*${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}\\b`))
  assert.doesNotMatch(source, /playwright@latest/)
  assert.doesNotMatch(source, /@playwright\/test@latest/)
})

test('runner image is pinned rather than left floating', () => {
  assert.match(source, /runs-on: ubuntu-24\.04/)
  assert.doesNotMatch(source, /runs-on: ubuntu-latest/)
})

test('artifact name, payload filename and retention are fixed rather than run-ID keyed', () => {
  assert.match(source, new RegExp(`ARTIFACT_NAME:\\s*${ARTIFACT_NAME}\\b`))
  assert.match(source, new RegExp(`PAYLOAD_FILENAME:\\s*${PAYLOAD_FILENAME.replace(/\./g, '\\.')}`))
  assert.match(source, /retention-days: 30/)
  assert.doesNotMatch(source, /name:\s*\$\{\{\s*github\.run_id\s*\}\}/)
})

test('the build performs an on-runner verification step before packaging', () => {
  assert.match(source, /verify-playwright-runtime\.mjs/)
  assert.match(source, /playwright-runtime-tar\.mjs verify/)
  assert.match(source, /playwright-runtime-manifest\.mjs/)
})

test('every action reference is pinned to a full commit SHA, not a floating tag', () => {
  const usesLines = [...source.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1])
  assert.ok(usesLines.length >= 3)
  for (const usesLine of usesLines) {
    assert.match(usesLine, /@[0-9a-f]{40}$/)
  }
})
