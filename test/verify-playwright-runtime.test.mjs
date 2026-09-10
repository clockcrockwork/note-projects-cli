import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertExecutableBit,
  assertPlaywrightCliVersion,
  findExecutableRelativePath,
  findHeadlessShellDirName,
} from '../scripts/verify-playwright-runtime.mjs'

async function fixtureBrowsersDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pw-verify-fixture-'))
  const browserDir = join(dir, 'chromium_headless_shell-4242')
  const shellDir = join(browserDir, 'chrome-headless-shell-linux64')
  await mkdir(shellDir, { recursive: true })
  const exePath = join(shellDir, 'chrome-headless-shell')
  await writeFile(exePath, '#!/bin/sh\necho fake\n')
  await chmod(exePath, 0o755)
  return { dir, exePath }
}

test('findHeadlessShellDirName finds the chromium_headless_shell-* directory', async () => {
  const { dir } = await fixtureBrowsersDir()
  assert.equal(findHeadlessShellDirName(dir), 'chromium_headless_shell-4242')
})

test('findHeadlessShellDirName fails closed when no such directory exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-verify-empty-'))
  assert.throws(() => findHeadlessShellDirName(dir), /HEADLESS_SHELL_DIRECTORY_MISSING/)
})

test('findExecutableRelativePath locates the executable regardless of nested directory naming', async () => {
  const { dir } = await fixtureBrowsersDir()
  const relative = findExecutableRelativePath(dir, 'chromium_headless_shell-4242')
  assert.equal(relative, join('chrome-headless-shell-linux64', 'chrome-headless-shell'))
})

test('findExecutableRelativePath fails closed when the executable is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-verify-nobin-'))
  await mkdir(join(dir, 'chromium_headless_shell-1'), { recursive: true })
  assert.throws(
    () => findExecutableRelativePath(dir, 'chromium_headless_shell-1'),
    /HEADLESS_SHELL_EXECUTABLE_MISSING/,
  )
})

test('assertExecutableBit fails closed when the executable bit is not set', async () => {
  const { exePath } = await fixtureBrowsersDir()
  await chmod(exePath, 0o644)
  assert.throws(() => assertExecutableBit(exePath), /HEADLESS_SHELL_EXECUTABLE_BIT_MISSING/)
})

test('assertExecutableBit passes when the executable bit is set', async () => {
  const { exePath } = await fixtureBrowsersDir()
  assert.doesNotThrow(() => assertExecutableBit(exePath))
})

test('assertPlaywrightCliVersion reports the fixed pinned version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-cli-fixture-'))
  const binDir = join(dir, 'node_modules', '.bin')
  await mkdir(binDir, { recursive: true })
  const cliPath = join(binDir, 'playwright')
  await writeFile(cliPath, '#!/bin/sh\necho "Version 1.63.0"\n')
  await chmod(cliPath, 0o755)
  assert.equal(assertPlaywrightCliVersion(dir, '1.63.0'), '1.63.0')
})

test('assertPlaywrightCliVersion fails closed on a version mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-cli-mismatch-'))
  const binDir = join(dir, 'node_modules', '.bin')
  await mkdir(binDir, { recursive: true })
  const cliPath = join(binDir, 'playwright')
  await writeFile(cliPath, '#!/bin/sh\necho "Version 1.64.0"\n')
  await chmod(cliPath, 0o755)
  assert.throws(() => assertPlaywrightCliVersion(dir, '1.63.0'), /PLAYWRIGHT_CLI_VERSION_MISMATCH/)
})
