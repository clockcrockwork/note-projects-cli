import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { computeSha256 } from './playwright-runtime-tar.mjs'

export const SCHEMA_VERSION = 1
export const KIND = 'playwright-runtime-carrier'
export const PLAYWRIGHT_VERSION = '1.63.0'
export const BROWSER = 'chromium-headless-shell'
export const PLATFORM = 'linux-x64'
export const PAYLOAD_FILENAME = `playwright-runtime-${PLAYWRIGHT_VERSION}-${PLATFORM}-headless-shell.tar.gz`
export const ARTIFACT_NAME = `playwright-runtime-${PLAYWRIGHT_VERSION}-${PLATFORM}-headless-shell`

const SHA_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
const TOKEN_RE = /^[A-Za-z0-9._-]+$/
const MANIFEST_FIELDS = [
  'schema_version',
  'kind',
  'playwright_version',
  'browser',
  'platform',
  'runner',
  'workflow_repository',
  'workflow_sha',
  'browser_cache_directory',
  'browser_revision',
  'payload_filename',
  'payload_sha256',
  'generated_at',
]

function invalid(field) {
  throw new Error(`MANIFEST_${field}_INVALID`)
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') invalid('SHAPE')
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.includes(key)) invalid(`FIELD_UNEXPECTED_${key}`)
  }
  for (const field of MANIFEST_FIELDS) {
    if (!(field in manifest)) invalid(`FIELD_MISSING_${field}`)
  }

  if (manifest.schema_version !== SCHEMA_VERSION) invalid('SCHEMA_VERSION')
  if (manifest.kind !== KIND) invalid('KIND')
  if (manifest.playwright_version !== PLAYWRIGHT_VERSION) invalid('PLAYWRIGHT_VERSION')
  if (manifest.browser !== BROWSER) invalid('BROWSER')
  if (manifest.platform !== PLATFORM) invalid('PLATFORM')
  if (!TOKEN_RE.test(manifest.runner ?? '')) invalid('RUNNER')
  if (!REPO_RE.test(manifest.workflow_repository ?? '')) invalid('WORKFLOW_REPOSITORY')
  if (!SHA_RE.test(manifest.workflow_sha ?? '')) invalid('WORKFLOW_SHA')
  if (!TOKEN_RE.test(manifest.browser_cache_directory ?? '')) invalid('BROWSER_CACHE_DIRECTORY')
  if (!TOKEN_RE.test(manifest.browser_revision ?? '')) invalid('BROWSER_REVISION')
  if (manifest.payload_filename !== PAYLOAD_FILENAME) invalid('PAYLOAD_FILENAME')
  if (!SHA256_RE.test(manifest.payload_sha256 ?? '')) invalid('PAYLOAD_SHA256')
  if (Number.isNaN(Date.parse(manifest.generated_at ?? ''))) invalid('GENERATED_AT')

  return manifest
}

export function buildManifest({
  runner,
  workflowRepository,
  workflowSha,
  browserCacheDirectory,
  browserRevision,
  payloadSha256,
  generatedAt,
}) {
  return validateManifest({
    schema_version: SCHEMA_VERSION,
    kind: KIND,
    playwright_version: PLAYWRIGHT_VERSION,
    browser: BROWSER,
    platform: PLATFORM,
    runner,
    workflow_repository: workflowRepository,
    workflow_sha: workflowSha,
    browser_cache_directory: browserCacheDirectory,
    browser_revision: browserRevision,
    payload_filename: PAYLOAD_FILENAME,
    payload_sha256: payloadSha256,
    generated_at: generatedAt,
  })
}

export function findBrowserRevision(browsersJsonText, browserName = BROWSER) {
  let parsed
  try {
    parsed = JSON.parse(browsersJsonText)
  } catch {
    throw new Error('BROWSERS_JSON_INVALID')
  }
  const entry = Array.isArray(parsed?.browsers) ? parsed.browsers.find((item) => item?.name === browserName) : null
  if (!entry || typeof entry.revision !== 'string' || !TOKEN_RE.test(entry.revision)) {
    throw new Error('BROWSER_REVISION_NOT_FOUND')
  }
  return entry.revision
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`MANIFEST_ENV_${name}_MISSING`)
  return value
}

async function main() {
  const outputPath = process.argv[2]
  if (!outputPath) throw new Error('MANIFEST_OUTPUT_PATH_REQUIRED')

  const payloadPath = requiredEnv('PAYLOAD_PATH')
  const browsersJsonPath = requiredEnv('BROWSERS_JSON_PATH')
  const browserCacheDirectory = requiredEnv('BROWSER_CACHE_DIRECTORY')
  const workflowRepository = requiredEnv('WORKFLOW_REPOSITORY')
  const workflowSha = requiredEnv('WORKFLOW_SHA')
  const runnerLabel = requiredEnv('RUNNER_LABEL')

  const browsersJsonText = await readFile(browsersJsonPath, 'utf8')
  const browserRevision = findBrowserRevision(browsersJsonText)
  const payloadSha256 = await computeSha256(payloadPath)

  const manifest = buildManifest({
    runner: runnerLabel,
    workflowRepository,
    workflowSha,
    browserCacheDirectory,
    browserRevision,
    payloadSha256,
    generatedAt: new Date().toISOString(),
  })

  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(manifest)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'MANIFEST_BUILD_FAILED'}\n`)
    process.exitCode = 1
  })
}
