import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { computeSha256 } from './playwright-runtime-tar.mjs'

export const SCHEMA_VERSION = 2
export const KIND = 'playwright-runtime-carrier'
export const CARRIER_PROFILE = 'chromium-complete'
export const PLAYWRIGHT_VERSION = '1.63.0'
export const PLATFORM = 'linux-x64'
export const PAYLOAD_FILENAME = `playwright-runtime-${PLAYWRIGHT_VERSION}-${PLATFORM}-${CARRIER_PROFILE}.tar.gz`
export const ARTIFACT_NAME = `playwright-runtime-${PLAYWRIGHT_VERSION}-${PLATFORM}-${CARRIER_PROFILE}`

const SHA40 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const TOKEN = /^[A-Za-z0-9._-]+$/
const TOP_FIELDS = new Set(['schema_version', 'kind', 'carrier_profile', 'playwright_version', 'platform', 'runner', 'workflow_repository', 'workflow_sha', 'browser_cache_directory', 'chromium', 'chromium_headless_shell', 'payload_filename', 'payload_sha256', 'generated_at'])
const RUNTIME_FIELDS = new Set(['revision', 'directory', 'executable_relative_path', 'executable_sha256', 'executable_size', 'executable_mode'])

function invalid(field) { throw new Error(`RUNTIME_V2_MANIFEST_${field}_INVALID`) }
function validateRuntime(runtime, key) {
  if (!runtime || typeof runtime !== 'object') invalid(`${key}_SHAPE`)
  for (const field of Object.keys(runtime)) if (!RUNTIME_FIELDS.has(field)) invalid(`${key}_UNEXPECTED_${field}`)
  for (const field of RUNTIME_FIELDS) if (!(field in runtime)) invalid(`${key}_MISSING_${field}`)
  if (![runtime.revision, runtime.directory, runtime.executable_relative_path, runtime.executable_mode].every((value) => typeof value === 'string' && value.length > 0)) invalid(`${key}_PATH`)
  if (!TOKEN.test(runtime.revision) || !TOKEN.test(runtime.directory) || !/^[0-7]{3}$/.test(runtime.executable_mode)) invalid(`${key}_TOKEN`)
  if (!runtime.executable_relative_path.split('/').every((part) => TOKEN.test(part))) invalid(`${key}_PATH`)
  if (!SHA256.test(runtime.executable_sha256)) invalid(`${key}_SHA256`)
  if (!Number.isInteger(runtime.executable_size) || runtime.executable_size <= 0) invalid(`${key}_SIZE`)
  if ((Number.parseInt(runtime.executable_mode, 8) & 0o111) === 0) invalid(`${key}_MODE`)
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') invalid('SHAPE')
  for (const field of Object.keys(manifest)) if (!TOP_FIELDS.has(field)) invalid(`UNEXPECTED_${field}`)
  for (const field of TOP_FIELDS) if (!(field in manifest)) invalid(`MISSING_${field}`)
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.kind !== KIND || manifest.carrier_profile !== CARRIER_PROFILE || manifest.playwright_version !== PLAYWRIGHT_VERSION || manifest.platform !== PLATFORM) invalid('CONTRACT')
  if (!TOKEN.test(manifest.runner) || !/^[\w.-]+\/[\w.-]+$/.test(manifest.workflow_repository) || !SHA40.test(manifest.workflow_sha) || !TOKEN.test(manifest.browser_cache_directory)) invalid('PROVENANCE')
  if (manifest.payload_filename !== PAYLOAD_FILENAME || !SHA256.test(manifest.payload_sha256) || Number.isNaN(Date.parse(manifest.generated_at))) invalid('PAYLOAD')
  validateRuntime(manifest.chromium, 'chromium')
  validateRuntime(manifest.chromium_headless_shell, 'chromium_headless_shell')
  return manifest
}

export function buildManifest({ runner, workflowRepository, workflowSha, browserCacheDirectory, chromium, chromiumHeadlessShell, payloadSha256, generatedAt }) {
  return validateManifest({ schema_version: SCHEMA_VERSION, kind: KIND, carrier_profile: CARRIER_PROFILE, playwright_version: PLAYWRIGHT_VERSION, platform: PLATFORM, runner, workflow_repository: workflowRepository, workflow_sha: workflowSha, browser_cache_directory: browserCacheDirectory, chromium, chromium_headless_shell: chromiumHeadlessShell, payload_filename: PAYLOAD_FILENAME, payload_sha256: payloadSha256, generated_at: generatedAt })
}

function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`RUNTIME_V2_MANIFEST_ENV_${name}_MISSING`); return value }

async function main() {
  const outputPath = process.argv[2]
  if (!outputPath) throw new Error('RUNTIME_V2_MANIFEST_OUTPUT_PATH_REQUIRED')
  const report = JSON.parse(await readFile(requiredEnv('RUNTIME_REPORT_PATH'), 'utf8'))
  if (report.playwright_version !== PLAYWRIGHT_VERSION) throw new Error('RUNTIME_V2_REPORT_VERSION_MISMATCH')
  const manifest = buildManifest({
    runner: requiredEnv('RUNNER_LABEL'), workflowRepository: requiredEnv('WORKFLOW_REPOSITORY'), workflowSha: requiredEnv('WORKFLOW_SHA'), browserCacheDirectory: report.browser_cache_directory,
    chromium: report.chromium, chromiumHeadlessShell: report.chromium_headless_shell,
    payloadSha256: await computeSha256(requiredEnv('PAYLOAD_PATH')), generatedAt: new Date().toISOString(),
  })
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(manifest)}\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'RUNTIME_V2_MANIFEST_BUILD_FAILED'}\n`); process.exitCode = 1 })
