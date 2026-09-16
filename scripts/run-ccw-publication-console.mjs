import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import {
  api,
  fetchBlob,
  listCompleteTree,
  mintInstallationToken,
  resolveSource,
  revokeInstallationToken,
} from './github-app.mjs'

const PRIVATE_REPOSITORY = 'clockcrockwork/patreon'
const PRIVATE_REPOSITORY_NAME = 'patreon'
const TARGET = 'CCW-CONSOLE'
const PREVIEW_PROJECT_NAME = 'note-projects-publication-preview'
const SHA_RE = /^[0-9a-f]{40}$/
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+\.vercel\.app\/?$/
const API = 'https://api.vercel.com'

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error('EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE')
  return value
}

function parseRequest() {
  const raw = process.env.REQUEST_JSON
  if (!raw) throw new Error('REQUEST_JSON_REQUIRED')
  const request = JSON.parse(raw)
  if (request?.task !== 'publication-preview') throw new Error('REQUEST_TASK_MISMATCH')
  if (request?.target !== TARGET) throw new Error('REQUEST_TARGET_INVALID')
  if (!['main', 'pull_request'].includes(request?.source)) throw new Error('REQUEST_SOURCE_INVALID')
  if (request.source === 'pull_request') {
    if (!Number.isSafeInteger(request.pull_request) || request.pull_request < 1) throw new Error('REQUEST_PR_INVALID')
  } else if (request.pull_request !== null) {
    throw new Error('REQUEST_PR_NOT_ALLOWED')
  }
  return request
}

function stableDiagnostic(error) {
  const value = error instanceof Error ? error.message : String(error)
  const first = value.split(':', 1)[0]
  return /^[A-Z0-9_]+$/.test(first) ? first : 'UNCLASSIFIED_FAILURE'
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

function sourcePaths(listing) {
  const allowed = (listing?.tree ?? [])
    .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path)
    .filter((path) =>
      path === 'tools/publication-console/build.mjs' ||
      /^content\/publications\/[^/]+\.md$/.test(path) ||
      /^content\/note-jp\/[^/]+\.md$/.test(path),
    )
    .sort()
  if (!allowed.includes('tools/publication-console/build.mjs')) throw new Error('PUBLICATION_CONSOLE_BUILDER_MISSING')
  if (!allowed.some((path) => path.startsWith('content/publications/'))) throw new Error('PUBLICATION_CONSOLE_PATREON_SOURCE_MISSING')
  if (!allowed.some((path) => path.startsWith('content/note-jp/'))) throw new Error('PUBLICATION_CONSOLE_NOTE_SOURCE_MISSING')
  return allowed
}

async function materializeSource({ token, listing, sourceSha, workspaceRoot }) {
  const entries = new Map(
    (listing?.tree ?? [])
      .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => [entry.path, entry]),
  )
  for (const path of sourcePaths(listing)) {
    const entry = entries.get(path)
    if (!entry?.sha) throw new Error('SOURCE_EXPORT_ENTRY_MISSING')
    await writeSafe(
      workspaceRoot,
      path,
      await fetchBlob({ token, blobSha: entry.sha, repository: PRIVATE_REPOSITORY }),
    )
  }
  await writeSafe(workspaceRoot, '.source-sha', Buffer.from(`${sourceSha}\n`, 'utf8'))
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

function runCaptured(argv, { cwd, timeout = 10 * 60_000, env = process.env } = {}) {
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
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  }
}

function buildConsole({ image, workspaceRoot, outputRoot }) {
  const pull = runCaptured(['docker', 'pull', image], { timeout: 10 * 60_000, env: childEnv() })
  if (!pull.ok) throw new Error('PUBLICATION_CONSOLE_RUNTIME_UNAVAILABLE')

  const run = runCaptured(
    [
      'docker', 'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '-e', 'CI=1', '-e', 'NO_COLOR=1', '-e', 'HOME=/tmp',
      '-v', `${workspaceRoot}:/workspace:ro`,
      '-v', `${outputRoot}:/workspace/public-view/out`,
      '-w', '/workspace', image,
      'node', 'tools/publication-console/build.mjs',
    ],
    { timeout: 5 * 60_000, env: childEnv() },
  )
  if (!run.ok) throw new Error('PUBLICATION_CONSOLE_BUILD_FAILED')
}

function assertNoRemoteLoads(html) {
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']https?:/i,
    /<link\b[^>]*\bhref\s*=\s*["']https?:/i,
    /<(?:img|iframe|video|audio|source)\b[^>]*\bsrc\s*=\s*["']https?:/i,
    /@import\s+(?:url\()?\s*["']?https?:/i,
    /url\(\s*["']?https?:/i,
  ]
  if (patterns.some((pattern) => pattern.test(html))) throw new Error('PUBLICATION_CONSOLE_REMOTE_LOAD_REJECTED')
  if (!html.includes('name="robots" content="noindex,nofollow"')) throw new Error('PUBLICATION_CONSOLE_NOINDEX_MISSING')
  if (!html.includes('clockcrockworker / 時計廃職人 · Publication Console')) throw new Error('PUBLICATION_CONSOLE_IDENTITY_MISSING')
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function jsonOrThrow(response, diagnostic) {
  const text = await response.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { throw new Error(diagnostic) }
  if (!response.ok) throw new Error(diagnostic)
  return data
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

async function deployProtectedConsole({ token, teamId, html, sourceSha }) {
  const query = new URLSearchParams({ teamId })
  const getProject = await fetch(`${API}/v9/projects/${encodeURIComponent(PREVIEW_PROJECT_NAME)}?${query}`, {
    headers: authHeaders(token),
  })
  const project = await jsonOrThrow(getProject, 'VERCEL_PROJECT_UNAVAILABLE')
  if (!/^prj_[A-Za-z0-9]+$/.test(project?.id ?? '')) throw new Error('VERCEL_PROJECT_INVALID')

  const protect = await fetch(`${API}/v9/projects/${encodeURIComponent(project.id)}?${query}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ ssoProtection: { deploymentType: 'all' } }),
  })
  const protectedProject = await jsonOrThrow(protect, 'VERCEL_PROTECTION_FAILED')
  if (protectedProject?.ssoProtection?.deploymentType !== 'all') throw new Error('VERCEL_PROTECTION_NOT_CONFIRMED')

  const htmlSha = createHash('sha256').update(html).digest('hex')
  const create = await fetch(`${API}/v13/deployments?${query}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name: PREVIEW_PROJECT_NAME,
      project: project.id,
      projectSettings: { framework: null },
      meta: {
        publication_preview_target: 'ccw-console',
        publication_preview_source: sourceSha,
      },
      files: [{ file: 'index.html', data: html }],
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
  const url = `https://${deployment.url}`
  if (!URL_RE.test(url)) throw new Error('VERCEL_DEPLOY_URL_INVALID')
  const probe = await fetch(url, { redirect: 'manual' })
  if (!protectionProbePassed(probe)) throw new Error('VERCEL_PROTECTION_PROBE_FAILED')
  return { url, htmlSha, deploymentId: deployment.id, protectionStatus: probe.status }
}

async function upsertPrivatePrComment({ token, pullRequest, sourceSha, deployment }) {
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) return
  const marker = '<!-- note-projects-cli:ccw-publication-console -->'
  const comments = await api(`/repos/${PRIVATE_REPOSITORY}/issues/${pullRequest}/comments?per_page=100`, { token })
  if (!Array.isArray(comments)) throw new Error('PREVIEW_COMMENT_LIST_INVALID')
  const existing = comments.find((comment) => typeof comment?.body === 'string' && comment.body.includes(marker))
  const body = [
    marker,
    '### Protected clockcrockworker / 時計廃職人 Publication Console',
    '',
    `- SOURCE_SHA: \`${sourceSha}\``,
    `- protected URL: ${deployment.url}`,
    `- HTML SHA-256: \`${deployment.htmlSha}\``,
    '',
    'Vercel Authentication was asserted and anonymous access was rejected before this URL was reported.',
  ].join('\n')
  if (existing?.id) {
    await api(`/repos/${PRIVATE_REPOSITORY}/issues/comments/${existing.id}`, { token, method: 'PATCH', body: { body } })
  } else {
    await api(`/repos/${PRIVATE_REPOSITORY}/issues/${pullRequest}/comments`, { token, method: 'POST', body: { body } })
  }
}

function safePublicResult(result) {
  const safe = { schema_version: 1, task: 'publication-preview', status: result.status, target: TARGET }
  if (SHA_RE.test(result.source_sha ?? '')) safe.source_sha = result.source_sha
  if (SHA_RE.test(result.tooling_sha ?? '')) safe.tooling_sha = result.tooling_sha
  if (/^[A-Z0-9_]+$/.test(result.diagnostic ?? '')) safe.diagnostic = result.diagnostic
  if (result.status === 'PASS') safe.preview_count = 1
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
  process.stdout.write(`publication-preview ${result.status} ${TARGET}${result.diagnostic ? ` ${result.diagnostic}` : ''}\n`)
  process.exitCode = exitCode
}

async function main() {
  let sourceToken = null
  let commentToken = null
  let sourceSha = null
  let toolingSha = null
  let phase = 'REQUEST'
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `ccw-console-${process.pid}`)
  const workspaceRoot = resolve(root, 'workspace')
  const outputRoot = resolve(root, 'generated')
  const cleanRoot = resolve(root, 'clean')

  try {
    const request = parseRequest()
    phase = 'CREDENTIALS'
    const appId = requiredEnv('NPR_APP_ID')
    const privateKey = requiredEnv('NPR_APP_PRIVATE_KEY')
    const installationId = requiredEnv('NPR_APP_INSTALLATION_ID')
    const vercelToken = requiredEnv('VERCEL_TOKEN')
    const teamId = requiredEnv('VERCEL_TEAM_ID')

    await rm(root, { recursive: true, force: true })
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(outputRoot, { recursive: true })
    await mkdir(cleanRoot, { recursive: true })

    phase = 'ACCESS_TOKEN'
    sourceToken = await mintInstallationToken({
      appId,
      privateKey,
      installationId,
      repositoryName: PRIVATE_REPOSITORY_NAME,
      permissions: { contents: 'read', pull_requests: 'read' },
    })

    phase = 'SOURCE_RESOLVE'
    const resolved = await resolveSource({
      token: sourceToken,
      source: request.source,
      pullRequest: request.pull_request,
      repository: PRIVATE_REPOSITORY,
    })
    sourceSha = resolved.sourceSha
    toolingSha = resolved.toolingSha

    phase = 'SOURCE_EXPORT'
    const listing = await listCompleteTree({ token: sourceToken, sha: sourceSha, repository: PRIVATE_REPOSITORY })
    await materializeSource({ token: sourceToken, listing, sourceSha, workspaceRoot })

    phase = 'BUILD'
    buildConsole({ image: process.env.NPR_NODE_IMAGE || 'node:22-bookworm', workspaceRoot, outputRoot })
    const generatedFiles = await readdir(outputRoot)
    if (JSON.stringify(generatedFiles.sort()) !== JSON.stringify(['publication-console.html'])) {
      throw new Error('PUBLICATION_CONSOLE_OUTPUT_INVALID')
    }
    const generatedPath = resolve(outputRoot, 'publication-console.html')
    const cleanPath = resolve(cleanRoot, 'index.html')
    await copyFile(generatedPath, cleanPath)
    const html = await readFile(cleanPath, 'utf8')
    assertNoRemoteLoads(html)

    phase = 'VERCEL_DEPLOY'
    const deployment = await deployProtectedConsole({ token: vercelToken, teamId, html, sourceSha })

    if (request.source === 'pull_request') {
      phase = 'PRIVATE_COMMENT_TOKEN'
      commentToken = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        repositoryName: PRIVATE_REPOSITORY_NAME,
        permissions: { pull_requests: 'write' },
      })
      phase = 'PRIVATE_COMMENT_UPSERT'
      await upsertPrivatePrComment({
        token: commentToken,
        pullRequest: request.pull_request,
        sourceSha,
        deployment,
      })
    }

    await emit({ status: 'PASS', source_sha: sourceSha, tooling_sha: toolingSha })
  } catch (error) {
    await emit({
      status: ['CREDENTIALS', 'ACCESS_TOKEN'].includes(phase) ? 'HOLD' : 'FAIL',
      source_sha: sourceSha,
      tooling_sha: toolingSha,
      diagnostic: stableDiagnostic(error),
    }, 2)
  } finally {
    if (commentToken) await revokeInstallationToken(commentToken).catch(() => {})
    if (sourceToken) await revokeInstallationToken(sourceToken).catch(() => {})
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

main()
