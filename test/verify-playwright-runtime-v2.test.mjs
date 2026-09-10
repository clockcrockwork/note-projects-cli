import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBrowserRevisions, inspectRuntime } from '../scripts/verify-playwright-runtime-v2.mjs'

test('both browser revisions are derived from Playwright browsers.json', () => {
  assert.deepEqual(findBrowserRevisions(JSON.stringify({ browsers: [{ name: 'chromium', revision: '1243' }, { name: 'chromium-headless-shell', revision: '1243' }] })), { chromium: '1243', chromium_headless_shell: '1243' })
  assert.throws(() => findBrowserRevisions(JSON.stringify({ browsers: [{ name: 'chromium', revision: '1243' }] })), /RUNTIME_V2_REVISION_MISSING_chromium_headless_shell/)
})
test('runtime inspection requires an executable, executable mode, and nonzero hashable file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pw-v2-verify-')); const file = join(root, 'chromium-1243', 'chrome-linux64', 'chrome')
  await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'fixture'); await chmod(file, 0o755)
  const result = inspectRuntime(root, { key: 'chromium', directoryPrefix: 'chromium-', executableNames: new Set(['chrome']) }, '1243')
  assert.equal(result.directory, 'chromium-1243'); assert.equal(result.executable_mode, '755'); assert.equal(result.executable_size, 7); assert.match(result.executable_sha256, /^[0-9a-f]{64}$/)
})
