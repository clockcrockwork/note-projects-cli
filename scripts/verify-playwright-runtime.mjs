import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HEADLESS_SHELL_DIR_RE = /^chromium_headless_shell-/
const HEADLESS_SHELL_EXECUTABLE_NAMES = new Set(['chrome-headless-shell', 'headless_shell'])

export function findHeadlessShellDirName(browsersPath) {
  const entries = readdirSync(browsersPath, { withFileTypes: true })
  const match = entries.find((entry) => entry.isDirectory() && HEADLESS_SHELL_DIR_RE.test(entry.name))
  if (!match) throw new Error('HEADLESS_SHELL_DIRECTORY_MISSING')
  return match.name
}

function walkForExecutable(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = walkForExecutable(full)
      if (found) return found
    } else if (entry.isFile() && HEADLESS_SHELL_EXECUTABLE_NAMES.has(entry.name)) {
      return full
    }
  }
  return null
}

export function findExecutableRelativePath(browsersPath, dirName) {
  const root = join(browsersPath, dirName)
  const found = walkForExecutable(root)
  if (!found) throw new Error('HEADLESS_SHELL_EXECUTABLE_MISSING')
  return found.slice(root.length + 1)
}

export function assertExecutableBit(filePath) {
  const mode = statSync(filePath).mode
  if ((mode & 0o111) === 0) throw new Error('HEADLESS_SHELL_EXECUTABLE_BIT_MISSING')
}

export function assertPlaywrightCliVersion(installDir, expectedVersion) {
  const cliPath = join(installDir, 'node_modules', '.bin', 'playwright')
  const result = spawnSync(cliPath, ['--version'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error('PLAYWRIGHT_CLI_FAILED')
  const reportedVersion = result.stdout.trim().split(/\s+/).pop()
  if (reportedVersion !== expectedVersion) {
    throw new Error(`PLAYWRIGHT_CLI_VERSION_MISMATCH`)
  }
  return reportedVersion
}

export async function launchSmokeTest(installDir) {
  const require = createRequire(join(installDir, 'noop.cjs'))
  const { chromium } = require('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto('about:blank')
  } finally {
    await browser.close()
  }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`VERIFY_ENV_${name}_MISSING`)
  return value
}

async function main() {
  const browsersPath = requiredEnv('PLAYWRIGHT_BROWSERS_PATH')
  const installDir = requiredEnv('PW_INSTALL_DIR')
  const expectedVersion = requiredEnv('PLAYWRIGHT_VERSION')

  assertPlaywrightCliVersion(installDir, expectedVersion)

  const dirName = findHeadlessShellDirName(browsersPath)
  const executableRelativePath = findExecutableRelativePath(browsersPath, dirName)
  assertExecutableBit(join(browsersPath, dirName, executableRelativePath))

  await launchSmokeTest(installDir)

  const outputLines = [`browser_dir_name=${dirName}`, `executable_relative_path=${executableRelativePath}`]
  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) appendFileSync(githubOutput, `${outputLines.join('\n')}\n`)
  process.stdout.write(`${outputLines.join('\n')}\n`)
  process.stdout.write('PLAYWRIGHT_RUNTIME_VERIFY_OK\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'PLAYWRIGHT_RUNTIME_VERIFY_FAILED'}\n`)
    process.exitCode = 1
  })
}
