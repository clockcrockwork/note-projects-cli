import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  api,
  fetchBlob,
  fetchTextFile,
  listCompleteTree,
  mintInstallationToken,
  resolvePullRequestSource,
  revokeInstallationToken,
} from './github-app.mjs'

const REPOSITORY = 'clockcrockwork/patreon'
const REPOSITORY_NAME = 'patreon'
const MANIFEST_PATH = 'covers/public-render-manifest.json'
const TARGET_RE = /^PTN-COVER-[A-Z0-9-]+$/
const SAFE_SOURCE_RE = /^covers\/media\/public-ready\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g)$/
const SAFE_PART_RE = /^covers\/media\/public-ready\/_chunks\/[a-z0-9][a-z0-9._/-]*\.b64part$/
const SAFE_DEST_RE = /^covers\/media\/(?:generated|public-ready)\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g)$/
const SAFE_REQUEST_RE = /^covers\/requests\/[a-z0-9][a-z0-9._-]*\.yaml$/
const SHA256_RE = /^[0-9a-f]{64}$/
const PNG_SIZES = new Map([
  ['1920x1080', [1920, 1080]],
  ['320x180', [320, 180]],
  ['240x135', [240, 135]],
])

function fail(message) {
  throw new Error(message)
}

function safeResultDiagnostic(error) {
  const raw = error instanceof Error ? error.message : String(error)
  if (/PUBLIC_READY_MEDIA_MISSING/.test(raw)) return 'PUBLIC_READY_MEDIA_MISSING'
  if (/PUBLIC_READY_MEDIA_(?:ENCODING|HASH)_INVALID/.test(raw)) return 'PUBLIC_READY_MEDIA_INVALID'
  if (/TARGET_NOT_DECLARED/.test(raw)) return 'TARGET_NOT_DECLARED'
  if (/SOURCE_/.test(raw) || /GITHUB_API_/.test(raw)) return 'PRIVATE_SOURCE_UNAVAILABLE'
  if (/NPM_CI_FAILED/.test(raw)) return 'DEPENDENCY_INSTALL_FAILED'
  if (/COVER_TEST_FAILED/.test(raw)) return 'COVER_TEST_FAILED'
  if (/COVER_RENDER_FAILED/.test(raw)) return 'COVER_RENDER_FAILED'
  if (/ARTIFACT_/.test(raw)) return 'ARTIFACT_VALIDATION_FAILED'
  return 'PATREON_COVER_RENDER_FAILED'
}

export function validateManifest(raw, target) {
  if (!TARGET_RE.test(target ?? '')) fail('TARGET_INVALID')
  if (!raw || raw.schema_version !== 1 || !raw.targets || typeof raw.targets !== 'object' || Array.isArray(raw.targets)) {
    fail('PUBLIC_RENDER_MANIFEST_INVALID')
  }
  const entry = raw.targets[target]
  if (!entry) fail('TARGET_NOT_DECLARED')
  if (!SAFE_REQUEST_RE.test(entry.request ?? '')) fail('PUBLIC_RENDER_REQUEST_INVALID')
  if (!Array.isArray(entry.media) || entry.media.length < 1 || entry.media.length > 4) fail('PUBLIC_RENDER_MEDIA_INVALID')
  const media = entry.media.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('PUBLIC_RENDER_MEDIA_INVALID')
    const hasSource = typeof item.source === 'string'
    const hasParts = Array.isArray(item.source_parts)
    if (hasSource === hasParts) fail('PUBLIC_RENDER_MEDIA_SOURCE_INVALID')
    if (!SAFE_DEST_RE.test(item.destination ?? '')) fail('PUBLIC_RENDER_MEDIA_DESTINATION_INVALID')
    if (item.sha256 != null && !SHA256_RE.test(item.sha256)) fail('PUBLIC_RENDER_MEDIA_HASH_INVALID')

    if (hasSource) {
      if (!SAFE_SOURCE_RE.test(item.source)) fail('PUBLIC_RENDER_MEDIA_SOURCE_INVALID')
      return { source: item.source, destination: item.destination, ...(item.sha256 ? { sha256: item.sha256 } : {}) }
    }

    if (item.source_parts.length < 1 || item.source_parts.length > 32 || item.source_parts.some((part) => !SAFE_PART_RE.test(part))) {
      fail('PUBLIC_RENDER_MEDIA_SOURCE_INVALID')
    }
    return {
      source_parts: [...item.source_parts],
      destination: item.destination,
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
    }
  })
  return { request: entry.request, media }
}

function assertSafeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail('EXPORT_PATH_INVALID')
  return value.replaceAll('\\', '/')
}

async function writeBuffer(root, relative, bytes) {
  const safe = assertSafeRelative(relative)
  const file = path.join(root, ...safe.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

async function exportTrustedTooling({ token, sha, root }) {
  const listing = await listCompleteTree({ token, sha, repository: REPOSITORY })
  const blobs = listing.tree.filter((item) => item.type === 'blob')
  const wanted = blobs.filter((item) =>
    item.path === 'package.json' ||
    item.path === 'package-lock.json' ||
    item.path.startsWith('tools/cover/') ||
    item.path.startsWith('brand/logos/'),
  )
  if (!wanted.some((item) => item.path === 'package.json') || !wanted.some((item) => item.path === 'package-lock.json')) {
    fail('TOOLING_PACKAGE_FILES_MISSING')
  }
  if (!wanted.some((item) => item.path.startsWith('tools/cover/'))) fail('TOOLING_RENDERER_MISSING')
  for (const item of wanted) {
    const bytes = await fetchBlob({ token, blobSha: item.sha, repository: REPOSITORY })
    await writeBuffer(root, item.path, bytes)
  }
  return wanted.length
}

async function resolveSource(token, source, pullRequest) {
  const main = await api(`/repos/${REPOSITORY}/commits/main`, { token })
  const toolingSha = main?.sha
  if (!/^[0-9a-f]{40}$/.test(toolingSha ?? '')) fail('TOOLING_SHA_INVALID')
  if (source === 'main') return { toolingSha, sourceSha: toolingSha }
  if (source !== 'pull_request' || !Number.isSafeInteger(pullRequest) || pullRequest < 1) fail('SOURCE_REQUEST_INVALID')
  const resolved = await resolvePullRequestSource({ token, repository: REPOSITORY, pullRequest })
  return { toolingSha, sourceSha: resolved.sourceSha }
}

function run(command, args, cwd, failure) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) fail(failure)
}

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('ARTIFACT_NOT_PNG')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function loadDeclaredMedia({ token, sourceSha, item }) {
  try {
    let bytes
    if (item.source) {
      bytes = await fetchTextFile({ token, sha: sourceSha, path: item.source, repository: REPOSITORY })
    } else {
      let encoded = ''
      for (const part of item.source_parts) {
        const partBytes = await fetchTextFile({ token, sha: sourceSha, path: part, repository: REPOSITORY })
        encoded += partBytes.toString('ascii').trim()
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail('PUBLIC_READY_MEDIA_ENCODING_INVALID')
      bytes = Buffer.from(encoded, 'base64')
    }
    if (item.sha256 && sha256(bytes) !== item.sha256) fail('PUBLIC_READY_MEDIA_HASH_INVALID')
    return bytes
  } catch (error) {
    if (/PUBLIC_READY_MEDIA_(?:ENCODING|HASH)_INVALID/.test(error instanceof Error ? error.message : String(error))) throw error
    fail('PUBLIC_READY_MEDIA_MISSING')
  }
}

export async function collectSafeArtifact(outDir, artifactDir, metadata) {
  const files = (await readdir(outDir)).filter((name) => name.endsWith('.png')).sort()
  if (files.length !== 3) fail('ARTIFACT_OUTPUT_COUNT_INVALID')
  const seen = new Set()
  const manifestFiles = []
  await mkdir(artifactDir, { recursive: true })
  for (const name of files) {
    const match = name.match(/-(1920x1080|320x180|240x135)\.png$/)
    if (!match || seen.has(match[1])) fail('ARTIFACT_FILENAME_INVALID')
    seen.add(match[1])
    const bytes = await readFile(path.join(outDir, name))
    const [width, height] = pngSize(bytes)
    const expected = PNG_SIZES.get(match[1])
    if (width !== expected[0] || height !== expected[1]) fail('ARTIFACT_DIMENSION_INVALID')
    if (bytes.length > 15 * 1024 * 1024) fail('ARTIFACT_FILE_TOO_LARGE')
    await copyFile(path.join(outDir, name), path.join(artifactDir, name))
    manifestFiles.push({ name, width, height, bytes: bytes.length, sha256: sha256(bytes) })
  }
  if (seen.size !== 3) fail('ARTIFACT_SIZE_SET_INVALID')
  const manifest = {
    schema_version: 1,
    task: 'patreon-cover-render',
    target: metadata.target,
    source_sha: metadata.sourceSha,
    tooling_sha: metadata.toolingSha,
    files: manifestFiles,
  }
  await writeFile(path.join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifestFiles.length + 1
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  const line = `${name}=${String(value).replaceAll('\n', '')}\n`
  return import('node:fs').then(({ appendFileSync }) => appendFileSync(file, line))
}

async function main() {
  let token = null
  let root = null
  let sourceSha = null
  let toolingSha = null
  try {
    const request = JSON.parse(process.env.REQUEST_JSON ?? '{}')
    if (request.task !== 'patreon-cover-render' || !TARGET_RE.test(request.target ?? '')) fail('REQUEST_INVALID')

    token = await mintInstallationToken({
      appId: process.env.NPR_APP_ID,
      privateKey: process.env.NPR_APP_PRIVATE_KEY,
      installationId: process.env.NPR_APP_INSTALLATION_ID,
      repositoryName: REPOSITORY_NAME,
      permissions: { contents: 'read', pull_requests: 'read' },
    })

    const source = await resolveSource(token, request.source, request.pull_request)
    sourceSha = source.sourceSha
    toolingSha = source.toolingSha

    const manifestBytes = await fetchTextFile({ token, sha: toolingSha, path: MANIFEST_PATH, repository: REPOSITORY })
    const entry = validateManifest(JSON.parse(manifestBytes.toString('utf8')), request.target)

    root = await mkdtemp(path.join(os.tmpdir(), 'patreon-cover-'))
    await exportTrustedTooling({ token, sha: toolingSha, root })
    const requestBytes = await fetchTextFile({ token, sha: sourceSha, path: entry.request, repository: REPOSITORY })
    await writeBuffer(root, entry.request, requestBytes)

    for (const item of entry.media) {
      const bytes = await loadDeclaredMedia({ token, sourceSha, item })
      await writeBuffer(root, item.destination, bytes)
    }

    await revokeInstallationToken(token)
    token = null

    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root, 'NPM_CI_FAILED')
    run('npm', ['run', 'cover:test'], root, 'COVER_TEST_FAILED')
    const outDir = path.join(root, 'covers', 'out')
    run('npm', ['run', 'cover:render', '--', '--config', entry.request, '--out', 'covers/out'], root, 'COVER_RENDER_FAILED')

    const artifactDir = path.join(root, 'public-artifact')
    const exportedFiles = await collectSafeArtifact(outDir, artifactDir, {
      target: request.target,
      sourceSha,
      toolingSha,
    })
    const artifactName = `patreon-cover-${request.target.toLowerCase()}-${sourceSha.slice(0, 12)}`
    const result = {
      task: 'patreon-cover-render',
      status: 'PASS',
      source_sha: sourceSha,
      tooling_sha: toolingSha,
      exported_file_count: exportedFiles,
    }
    await setOutput('result_json', JSON.stringify(result))
    await setOutput('source_sha', sourceSha)
    await setOutput('artifact_path', artifactDir)
    await setOutput('artifact_name', artifactName)
    process.stdout.write('PATREON_COVER_RENDER_PASS\n')
  } catch (error) {
    const result = {
      task: 'patreon-cover-render',
      status: 'FAIL',
      ...(sourceSha ? { source_sha: sourceSha } : {}),
      ...(toolingSha ? { tooling_sha: toolingSha } : {}),
      diagnostic: safeResultDiagnostic(error),
    }
    await setOutput('result_json', JSON.stringify(result))
    process.stderr.write(`${result.diagnostic}\n`)
    process.exitCode = 1
  } finally {
    if (token) {
      try { await revokeInstallationToken(token) } catch {}
    }
    // Keep root for Actions artifact upload; the ephemeral hosted runner removes it after the job.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
