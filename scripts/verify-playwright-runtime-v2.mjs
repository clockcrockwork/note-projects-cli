import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const PLAYWRIGHT_VERSION = '1.63.0'
export const RUNTIME_SPECS = [
  { key: 'chromium', browsersJsonName: 'chromium', directoryPrefix: 'chromium-', executableNames: new Set(['chrome']) },
  {
    key: 'chromium_headless_shell',
    browsersJsonName: 'chromium-headless-shell',
    directoryPrefix: 'chromium_headless_shell-',
    executableNames: new Set(['chrome-headless-shell', 'headless_shell']),
  },
]

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`VERIFY_V2_ENV_${name}_MISSING`)
  return value
}

function sha256(path) {
  const output = spawnSync('sha256sum', [path], { encoding: 'utf8' })
  if (output.error || output.status !== 0) throw new Error('RUNTIME_V2_SHA256_FAILED')
  return output.stdout.trim().split(/\s+/)[0]
}

export function findBrowserRevisions(browsersJsonText) {
  let parsed
  try { parsed = JSON.parse(browsersJsonText) } catch { throw new Error('RUNTIME_V2_BROWSERS_JSON_INVALID') }
  const entries = Array.isArray(parsed?.browsers) ? parsed.browsers : []
  return Object.fromEntries(RUNTIME_SPECS.map((spec) => {
    const entry = entries.find((candidate) => candidate?.name === spec.browsersJsonName)
    if (!entry || typeof entry.revision !== 'string' || !/^[A-Za-z0-9._-]+$/.test(entry.revision)) {
      throw new Error(`RUNTIME_V2_REVISION_MISSING_${spec.key}`)
    }
    return [spec.key, entry.revision]
  }))
}

function walkForExecutable(dir, names) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = walkForExecutable(full, names)
      if (found) return found
    } else if (entry.isFile() && names.has(entry.name)) return full
  }
  return null
}

export function inspectRuntime(browsersPath, spec, revision) {
  const directory = `${spec.directoryPrefix}${revision}`
  const root = join(browsersPath, directory)
  let executable
  try { executable = walkForExecutable(root, spec.executableNames) } catch { throw new Error(`RUNTIME_V2_DIRECTORY_MISSING_${spec.key}`) }
  if (!executable) throw new Error(`RUNTIME_V2_EXECUTABLE_MISSING_${spec.key}`)
  const stat = statSync(executable)
  if ((stat.mode & 0o111) === 0) throw new Error(`RUNTIME_V2_EXECUTABLE_MODE_MISSING_${spec.key}`)
  if (stat.size <= 0) throw new Error(`RUNTIME_V2_EXECUTABLE_EMPTY_${spec.key}`)
  return {
    revision,
    directory,
    executable_relative_path: executable.slice(root.length + 1),
    executable_sha256: sha256(executable),
    executable_size: stat.size,
    executable_mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
  }
}

export function assertPlaywrightCliVersion(installDir) {
  const result = spawnSync(join(installDir, 'node_modules', '.bin', 'playwright'), ['--version'], { encoding: 'utf8' })
  if (result.error || result.status !== 0 || result.stdout.trim() !== `Version ${PLAYWRIGHT_VERSION}`) {
    throw new Error('RUNTIME_V2_PLAYWRIGHT_VERSION_MISMATCH')
  }
}

export async function launchSmokeTests(installDir) {
  const require = createRequire(join(installDir, 'noop.cjs'))
  const { chromium } = require('playwright')
  for (const options of [{ name: 'headless_shell', options: {} }, { name: 'chromium', options: { channel: 'chromium' } }]) {
    const browser = await chromium.launch(options.options)
    try {
      const page = await browser.newPage()
      await page.goto('about:blank')
      if (await page.url() !== 'about:blank') throw new Error(`RUNTIME_V2_ABOUT_BLANK_FAILED_${options.name}`)
    } finally { await browser.close() }
  }
}

async function main() {
  const browsersPath = requiredEnv('PLAYWRIGHT_BROWSERS_PATH')
  const installDir = requiredEnv('PW_INSTALL_DIR')
  const browsersJsonPath = requiredEnv('BROWSERS_JSON_PATH')
  const reportPath = requiredEnv('RUNTIME_REPORT_PATH')
  const browsersJsonText = await (await import('node:fs/promises')).readFile(browsersJsonPath, 'utf8')
  const revisions = findBrowserRevisions(browsersJsonText)
  assertPlaywrightCliVersion(installDir)
  const runtimes = Object.fromEntries(RUNTIME_SPECS.map((spec) => [spec.key, inspectRuntime(browsersPath, spec, revisions[spec.key])]))
  await launchSmokeTests(installDir)
  const report = { playwright_version: PLAYWRIGHT_VERSION, browser_cache_directory: 'pw-browsers', chromium: runtimes.chromium, chromium_headless_shell: runtimes.chromium_headless_shell }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    `chromium_dir_name=${runtimes.chromium.directory}`,
    `chromium_headless_shell_dir_name=${runtimes.chromium_headless_shell.directory}`,
  ]
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  process.stdout.write(`${lines.join('\n')}\nPLAYWRIGHT_RUNTIME_V2_VERIFY_OK\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'PLAYWRIGHT_RUNTIME_V2_VERIFY_FAILED'}\n`); process.exitCode = 1 })
}
