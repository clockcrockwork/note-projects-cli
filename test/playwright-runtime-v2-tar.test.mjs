import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hashTarEntry, verifyTarPayloadV2 } from '../scripts/playwright-runtime-v2-tar.mjs'
import { listTarGzEntries } from '../scripts/playwright-runtime-tar.mjs'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pw-v2-tar-'))
  for (const [runtime, leaf] of [['chromium-1243', 'chrome-linux64/chrome'], ['chromium_headless_shell-1243', 'chrome-headless-shell-linux64/chrome-headless-shell']]) {
    const path = join(dir, 'pw-browsers', runtime, leaf)
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '#!/bin/sh\necho fixture\n'); await chmod(path, 0o755)
  }
  const tar = join(dir, 'payload.tar.gz'); assert.equal(spawnSync('tar', ['-czf', tar, 'pw-browsers'], { cwd: dir }).status, 0)
  return { tar, runtimes: { chromium: { directory: 'chromium-1243', executable_relative_path: 'chrome-linux64/chrome' }, chromium_headless_shell: { directory: 'chromium_headless_shell-1243', executable_relative_path: 'chrome-headless-shell-linux64/chrome-headless-shell' } } }
}
test('V2 tar requires and preserves both browser runtime trees', async () => {
  const { tar, runtimes } = await fixture(); const entries = listTarGzEntries(tar)
  assert.doesNotThrow(() => verifyTarPayloadV2(entries, { expectedRoot: 'pw-browsers', runtimes }))
  const full = hashTarEntry(tar, 'pw-browsers/chromium-1243/chrome-linux64/chrome')
  const shell = hashTarEntry(tar, 'pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell')
  assert.equal(full.size, shell.size); assert.equal(full.sha256, shell.sha256)
})
test('V2 tar fails closed if either executable is absent', async () => {
  const { tar, runtimes } = await fixture(); runtimes.chromium.executable_relative_path = 'missing'
  assert.throws(() => verifyTarPayloadV2(listTarGzEntries(tar), { expectedRoot: 'pw-browsers', runtimes }), /RUNTIME_V2_TAR_EXECUTABLE_INVALID_chromium/)
})
