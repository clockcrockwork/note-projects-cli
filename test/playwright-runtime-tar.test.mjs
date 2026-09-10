import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { computeSha256, listTarGzEntries, verifyTarPayload } from '../scripts/playwright-runtime-tar.mjs'

const EXPECTED_EXECUTABLE_PATH =
  'pw-browsers/chromium_headless_shell-9999/chrome-headless-shell-linux64/chrome-headless-shell'

async function buildFixtureTar({ executable = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pw-tar-fixture-'))
  const root = join(dir, 'pw-browsers')
  const browserDir = join(root, 'chromium_headless_shell-9999')
  const shellDir = join(browserDir, 'chrome-headless-shell-linux64')
  await mkdir(shellDir, { recursive: true })
  const exePath = join(shellDir, 'chrome-headless-shell')
  await writeFile(exePath, '#!/bin/sh\necho fake\n')
  await chmod(exePath, executable ? 0o755 : 0o644)
  await writeFile(join(browserDir, 'INSTALLATION_COMPLETE'), '')

  const tarPath = join(dir, 'payload.tar.gz')
  const result = spawnSync('tar', ['--numeric-owner', '--owner=0', '--group=0', '-czf', tarPath, 'pw-browsers'], {
    cwd: dir,
  })
  assert.equal(result.status, 0)
  return tarPath
}

test('generated tar contains the expected browser cache root', async () => {
  const tarPath = await buildFixtureTar()
  const entries = listTarGzEntries(tarPath)
  assert.ok(entries.length > 0)
  assert.ok(entries.every((entry) => entry.name === 'pw-browsers' || entry.name.startsWith('pw-browsers/')))
})

test('executable permission bit is preserved inside the tar', async () => {
  const tarPath = await buildFixtureTar()
  const entries = listTarGzEntries(tarPath)
  const executable = entries.find((entry) => entry.name === EXPECTED_EXECUTABLE_PATH)
  assert.ok(executable)
  assert.notEqual(executable.mode & 0o111, 0)
})

test('verifyTarPayload passes for a well-formed payload', async () => {
  const tarPath = await buildFixtureTar()
  const entries = listTarGzEntries(tarPath)
  assert.doesNotThrow(() =>
    verifyTarPayload(entries, { expectedRoot: 'pw-browsers', expectedExecutablePath: EXPECTED_EXECUTABLE_PATH }),
  )
})

test('verifyTarPayload fails closed when the executable bit is missing', async () => {
  const tarPath = await buildFixtureTar({ executable: false })
  const entries = listTarGzEntries(tarPath)
  assert.throws(
    () => verifyTarPayload(entries, { expectedRoot: 'pw-browsers', expectedExecutablePath: EXPECTED_EXECUTABLE_PATH }),
    /TAR_EXECUTABLE_PERMISSION_MISSING/,
  )
})

test('verifyTarPayload fails closed when the executable entry is absent', async () => {
  const tarPath = await buildFixtureTar()
  const entries = listTarGzEntries(tarPath)
  assert.throws(
    () => verifyTarPayload(entries, { expectedRoot: 'pw-browsers', expectedExecutablePath: 'pw-browsers/missing' }),
    /TAR_EXECUTABLE_MISSING/,
  )
})

test('verifyTarPayload fails closed when the archive root does not match', async () => {
  const tarPath = await buildFixtureTar()
  const entries = listTarGzEntries(tarPath)
  assert.throws(
    () => verifyTarPayload(entries, { expectedRoot: 'other-root', expectedExecutablePath: 'other-root/x' }),
    /TAR_ROOT_MISMATCH/,
  )
})

test('computeSha256 matches a known digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-sha-fixture-'))
  const filePath = join(dir, 'file.txt')
  await writeFile(filePath, 'hello world\n')
  const digest = await computeSha256(filePath)
  assert.equal(digest, 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447')
})
