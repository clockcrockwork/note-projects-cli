import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  fetchBlob,
  fetchTextFile,
  listCompleteTree,
  mintInstallationToken,
  resolveSource,
  revokeInstallationToken,
} from './github-app.mjs'
import { deploymentFileIdentity, vercelApiDiagnostic } from './run-ccw-publication-console.mjs'

const PRIVATE_REPOSITORY = 'clockcrockwork/note-projects'
export const PROJECT_NAME = 'note-projects-bosho0l-publication-console'
export const STABLE_CONSOLE_URL = `https://${PROJECT_NAME}.vercel.app`
const API = 'https://api.vercel.com'
const SHA_RE = /^[0-9a-f]{40}$/
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+\.vercel\.app\/?$/

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error('EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE')
  return value
}

function stableDiagnostic(error) {
  const value = error instanceof Error ? error.message : String(error)
  const first = value.split(':', 1)[0]
  return /^[A-Z0-9_]+$/.test(first) ? first : 'UNCLASSIFIED_FAILURE'
}

function childEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    ...extra,
  }
}

function runCaptured(argv, { cwd, timeout = 15 * 60_000, env = process.env } = {}) {
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    windowsHide: true,
  })
  return {
    ok: child.status === 0 && !child.error,
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  }
}

function safeResolvedPath(root, path) {
  const destination = resolve(root, path)
  const prefix = resolve(root) + sep
  if (!destination.startsWith(prefix)) throw new Error('EXPORT_DESTINATION_ESCAPE')
  return destination
}

async function writeSafe(root, path, bytes) {
  const destination = safeResolvedPath(root, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}

function treeEntriesByPath(listing) {
  return new Map(
    (listing?.tree ?? [])
      .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => [entry.path, entry]),
  )
}

export function sourcePaths(listing) {
  const paths = (listing?.tree ?? [])
    .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path)
    .filter((path) =>
      path === 'tools/build-bosho0l-publication-console.mjs' ||
      /^src\/publication-bundle\/.+\.mjs$/.test(path) ||
      /^src\/publish-console\/.+\.(?:mjs|ts)$/.test(path) ||
      /^articles\/[^/]+\/[^/]+\/publication\/.+$/.test(path) ||
      /^docs\/themes\/.+\/feeder\/[^/]+\.contract\.ya?ml$/.test(path),
    )
    .sort()

  if (!paths.includes('tools/build-bosho0l-publication-console.mjs')) {
    throw new Error('BOSHO0L_CONSOLE_BUILDER_MISSING')
  }
  if (!paths.some((path) => path.startsWith('src/publication-bundle/'))) {
    throw new Error('BOSHO0L_CONSOLE_BUNDLE_SOURCE_MISSING')
  }
  if (!paths.some((path) => path.startsWith('src/publish-console/'))) {
    throw new Error('BOSHO0L_CONSOLE_ADAPTER_SOURCE_MISSING')
  }
  return paths
}

async function materializePaths({ token, listing, paths, destinationRoot }) {
  const entries = treeEntriesByPath(listing)
  for (const path of paths) {
    const entry = entries.get(path)
    if (!entry?.sha) throw new Error('SOURCE_EXPORT_ENTRY_MISSING')
    await writeSafe(
      destinationRoot,
      path,
      await fetchBlob({ token, blobSha: entry.sha, repository: PRIVATE_REPOSITORY }),
    )
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function jsonOrThrow(response, diagnostic) {
  const text = await response.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(diagnostic)
  }
  if (!response.ok) {
    if (diagnostic === 'VERCEL_DEPLOY_FAILED' || diagnostic === 'VERCEL_FILE_UPLOAD_FAILED') {
      throw new Error(vercelApiDiagnostic(response.status, data, diagnostic))
    }
    throw new Error(diagnostic)
  }
  return data
}

async function ensureProtectedProject({ token, teamId }) {
  const query = new URLSearchParams({ teamId })
  let response = await fetch(`${API}/v9/projects/${encodeURIComponent(PROJECT_NAME)}?${query}`, {
    headers: authHeaders(token),
  })
  let project
  if (response.status === 404) {
    response = await fetch(`${API}/v11/projects?${query}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name: PROJECT_NAME }),
    })
    project = await jsonOrThrow(response, 'VERCEL_PROJECT_CREATE_FAILED')
  } else {
    project = await jsonOrThrow(response, 'VERCEL_PROJECT_UNAVAILABLE')
  }
  const id = project?.id
  if (!/^prj_[A-Za-z0-9]+$/.test(id ?? '')) throw new Error('VERCEL_PROJECT_INVALID')

  const protect = await fetch(`${API}/v9/projects/${encodeURIComponent(id)}?${query}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ ssoProtection: { deploymentType: 'all' } }),
  })
  const protectedProject = await jsonOrThrow(protect, 'VERCEL_PROTECTION_FAILED')
  if (protectedProject?.ssoProtection?.deploymentType !== 'all') {
    throw new Error('VERCEL_PROTECTION_NOT_CONFIRMED')
  }
  return id
}

function protectionProbePassed(response) {
  if ([401, 403].includes(response.status)) return true
  if (![301, 302, 303, 307, 308].includes(response.status)) return false
  const location = response.headers.get('location') ?? ''
  try {
    const host = new URL(location).hostname.toLowerCase()
    return host === 'vercel.com' || host.endsWith('.vercel.com')
  } catch {
    return false
  }
}

async function probeProtection(url) {
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const probeUrl = new URL(url)
    probeUrl.searchParams.set('__bosho0l_console_probe', `${Date.now()}-${attempt}`)
    const response = await fetch(probeUrl, {
      redirect: 'manual',
      headers: { 'cache-control': 'no-cache, no-store, max-age=0', pragma: 'no-cache' },
    })
    if (protectionProbePassed(response)) return response.status
    if (attempt < 15) await new Promise((resolvePromise) => setTimeout(resolvePromise, 4000))
  }
  throw new Error('VERCEL_PROTECTION_PROBE_FAILED')
}

async function currentProductionSource({ token, teamId, projectId }) {
  const query = new URLSearchParams({
    teamId,
    projectId,
    target: 'production',
    state: 'READY',
    limit: '1',
  })
  const response = await fetch(`${API}/v6/deployments?${query}`, { headers: authHeaders(token) })
  if (!response.ok) return null
  let payload
  try {
    payload = await response.json()
  } catch {
    return null
  }
  const deployment = Array.isArray(payload?.deployments) ? payload.deployments[0] : null
  const source = deployment?.meta?.publication_console_source
  return SHA_RE.test(source ?? '') ? source : null
}

async function uploadDeploymentFile({ token, teamId, file, data }) {
  const identity = deploymentFileIdentity(data)
  const query = new URLSearchParams({ teamId })
  const response = await fetch(`${API}/v2/files?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(identity.size),
      'x-Vercel-Digest': identity.sha,
    },
    body: identity.bytes,
  })
  await jsonOrThrow(response, 'VERCEL_FILE_UPLOAD_FAILED')
  return { file, sha: identity.sha, size: identity.size }
}

async function deployProductionConsole({ token, teamId, projectId, sourceSha, html, manifest }) {
  const files = [
    await uploadDeploymentFile({ token, teamId, file: 'index.html', data: html }),
    await uploadDeploymentFile({ token, teamId, file: 'console.json', data: manifest }),
  ]
  const query = new URLSearchParams({ teamId })
  const create = await fetch(`${API}/v13/deployments?${query}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name: PROJECT_NAME,
      project: projectId,
      target: 'production',
      projectSettings: { framework: null },
      meta: {
        publication_preview_target: 'bosho0l-console',
        publication_console_source: sourceSha,
        publication_preview_channel: 'production',
      },
      files,
    }),
  })
  let deployment = await jsonOrThrow(create, 'VERCEL_DEPLOY_FAILED')
  const deadline = Date.now() + 120_000
  while (!['READY', 'ERROR', 'CANCELED'].includes(deployment?.readyState ?? '')) {
    if (Date.now() >= deadline) throw new Error('VERCEL_DEPLOY_TIMEOUT')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
    const poll = await fetch(`${API}/v13/deployments/${encodeURIComponent(deployment.id)}?${query}`, {
      headers: authHeaders(token),
    })
    deployment = await jsonOrThrow(poll, 'VERCEL_DEPLOY_POLL_FAILED')
  }
  if (deployment.readyState !== 'READY') throw new Error('VERCEL_DEPLOY_NOT_READY')
  const deploymentUrl = `https://${deployment.url}`
  if (!URL_RE.test(deploymentUrl)) throw new Error('VERCEL_DEPLOY_URL_INVALID')
  const deploymentProtectionStatus = await probeProtection(deploymentUrl)
  const stableProtectionStatus = await probeProtection(STABLE_CONSOLE_URL)
  return {
    deployment_id: deployment.id,
    protection_status: stableProtectionStatus,
    deployment_protection_status: deploymentProtectionStatus,
  }
}

function assertConsoleOutput({ html, manifest, sourceSha }) {
  const remotePatterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']https?:/i,
    /<link\b[^>]*\bhref\s*=\s*["']https?:/i,
    /<(?:img|iframe|video|audio|source)\b[^>]*\bsrc\s*=\s*["']https?:/i,
    /@import\s+(?:url\()?\s*["']?https?:/i,
    /url\(\s*["']?https?:/i,
  ]
  if (remotePatterns.some((pattern) => pattern.test(html))) {
    throw new Error('PUBLICATION_CONSOLE_REMOTE_LOAD_REJECTED')
  }
  if (!html.includes('name="robots" content="noindex,nofollow"')) {
    throw new Error('PUBLICATION_CONSOLE_NOINDEX_MISSING')
  }
  if (!html.includes('某所OL · Publication Console')) {
    throw new Error('PUBLICATION_CONSOLE_IDENTITY_MISSING')
  }
  let receipt
  try {
    receipt = JSON.parse(manifest)
  } catch {
    throw new Error('PUBLICATION_CONSOLE_MANIFEST_INVALID')
  }
  if (receipt?.schema_version !== 1 || receipt?.channel !== 'bosho0l') {
    throw new Error('PUBLICATION_CONSOLE_MANIFEST_INVALID')
  }
  if (receipt?.source_sha !== sourceSha || !Array.isArray(receipt?.inventory)) {
    throw new Error('PUBLICATION_CONSOLE_MANIFEST_SOURCE_MISMATCH')
  }
  return receipt.inventory.length
}

export function safePublicResult(result) {
  const safe = {
    schema_version: 1,
    task: 'bosho0l-publication-console',
    status: result.status,
  }
  if (SHA_RE.test(result.source_sha ?? '')) safe.source_sha = result.source_sha
  if (/^[A-Z0-9_]+$/.test(result.diagnostic ?? '')) safe.diagnostic = result.diagnostic
  if (Number.isSafeInteger(result.inventory_count) && result.inventory_count >= 0) {
    safe.inventory_count = result.inventory_count
  }
  return safe
}

async function emit(result, exitCode = 0) {
  const safe = JSON.stringify(safePublicResult(result))
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    await appendFile(output, `result_json=${safe}\n`)
    if (result.source_sha) await appendFile(output, `source_sha=${result.source_sha}\n`)
    if (result.status) await appendFile(output, `status=${result.status}\n`)
  }
  process.stdout.write(
    `bosho0l-publication-console ${result.status}${result.diagnostic ? ` ${result.diagnostic}` : ''}\n`,
  )
  process.exitCode = exitCode
}

async function main() {
  let accessToken = null
  let sourceSha = null
  let phase = 'CREDENTIALS'
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `bosho0l-console-${process.pid}`)
  const workspaceRoot = resolve(root, 'workspace')
  const cleanRoot = resolve(root, 'clean')
  const npmCache = resolve(root, 'npm-cache')

  try {
    const appId = requiredEnv('NPR_APP_ID')
    const privateKey = requiredEnv('NPR_APP_PRIVATE_KEY')
    const installationId = requiredEnv('NPR_APP_INSTALLATION_ID')
    const vercelToken = requiredEnv('VERCEL_TOKEN')
    const teamId = requiredEnv('VERCEL_TEAM_ID')

    await rm(root, { recursive: true, force: true })
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(cleanRoot, { recursive: true })

    phase = 'ACCESS_TOKEN'
    accessToken = await mintInstallationToken({
      appId,
      privateKey,
      installationId,
      permissions: { contents: 'read' },
    })

    phase = 'SOURCE_RESOLVE'
    const resolved = await resolveSource({
      token: accessToken,
      source: 'main',
      pullRequest: null,
      repository: PRIVATE_REPOSITORY,
    })
    sourceSha = resolved.sourceSha

    phase = 'VERCEL_PROJECT'
    const projectId = await ensureProtectedProject({ token: vercelToken, teamId })
    const currentSource = await currentProductionSource({
      token: vercelToken,
      teamId,
      projectId,
    })
    if (currentSource === sourceSha) {
      await probeProtection(STABLE_CONSOLE_URL)
      await revokeInstallationToken(accessToken)
      accessToken = null
      await emit({
        status: 'PASS',
        source_sha: sourceSha,
        diagnostic: 'PUBLICATION_CONSOLE_ALREADY_CURRENT',
      })
      return
    }

    phase = 'BOOTSTRAP_FETCH'
    const [packageJson, packageLock] = await Promise.all([
      fetchTextFile({ token: accessToken, sha: sourceSha, path: 'package.json', repository: PRIVATE_REPOSITORY }),
      fetchTextFile({ token: accessToken, sha: sourceSha, path: 'package-lock.json', repository: PRIVATE_REPOSITORY }),
    ])
    await writeSafe(workspaceRoot, 'package.json', packageJson)
    await writeSafe(workspaceRoot, 'package-lock.json', packageLock)

    phase = 'RUNTIME_PREPARE'
    const image = process.env.NPR_NODE_IMAGE || 'node:22-bookworm'
    const pull = runCaptured(['docker', 'pull', image], { timeout: 10 * 60_000, env: childEnv() })
    if (!pull.ok) throw new Error('NO_EGRESS_RUNTIME_PREPARE_FAILED')

    phase = 'DEPENDENCY_INSTALL'
    const install = runCaptured(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: workspaceRoot,
      timeout: 15 * 60_000,
      env: childEnv({ NPM_CONFIG_CACHE: npmCache }),
    })
    if (!install.ok) throw new Error('DEPENDENCY_INSTALL_FAILED')

    phase = 'TREE_LIST'
    const listing = await listCompleteTree({
      token: accessToken,
      sha: sourceSha,
      repository: PRIVATE_REPOSITORY,
    })
    const paths = sourcePaths(listing)

    phase = 'PRIVATE_EXPORT'
    await materializePaths({
      token: accessToken,
      listing,
      paths,
      destinationRoot: workspaceRoot,
    })

    phase = 'ACCESS_REVOKE'
    await revokeInstallationToken(accessToken)
    accessToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    phase = 'BUILD'
    const build = runCaptured(
      [
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '512',
        '-e',
        'CI=1',
        '-e',
        'NO_COLOR=1',
        '-e',
        'HOME=/tmp',
        '-e',
        `SOURCE_SHA=${sourceSha}`,
        '-v',
        `${workspaceRoot}:/workspace`,
        '-w',
        '/workspace',
        image,
        'node',
        'tools/build-bosho0l-publication-console.mjs',
      ],
      { timeout: 5 * 60_000, env: childEnv() },
    )
    if (!build.ok) throw new Error('PUBLICATION_CONSOLE_BUILD_FAILED')

    phase = 'OUTPUT_ISOLATE'
    const outputRoot = resolve(workspaceRoot, 'artifacts/publication-console')
    const html = await readFile(resolve(outputRoot, 'index.html'), 'utf8')
    const manifest = await readFile(resolve(outputRoot, 'console.json'), 'utf8')
    const inventoryCount = assertConsoleOutput({ html, manifest, sourceSha })
    await copyFile(resolve(outputRoot, 'index.html'), resolve(cleanRoot, 'index.html'))
    await copyFile(resolve(outputRoot, 'console.json'), resolve(cleanRoot, 'console.json'))

    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(npmCache, { recursive: true, force: true })

    phase = 'VERCEL_DEPLOY'
    await deployProductionConsole({
      token: vercelToken,
      teamId,
      projectId,
      sourceSha,
      html: await readFile(resolve(cleanRoot, 'index.html'), 'utf8'),
      manifest: await readFile(resolve(cleanRoot, 'console.json'), 'utf8'),
    })

    await emit({ status: 'PASS', source_sha: sourceSha, inventory_count: inventoryCount })
  } catch (error) {
    await emit(
      {
        status: ['CREDENTIALS', 'ACCESS_TOKEN', 'SOURCE_RESOLVE'].includes(phase) ? 'HOLD' : 'FAIL',
        source_sha: sourceSha,
        diagnostic: stableDiagnostic(error),
      },
      2,
    )
  } finally {
    if (accessToken) await revokeInstallationToken(accessToken).catch(() => {})
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
