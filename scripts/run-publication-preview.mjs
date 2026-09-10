import { appendFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  api,
  fetchBlob,
  fetchTextFile,
  listCompleteTree,
  mintInstallationToken,
  resolveSource,
  revokeInstallationToken,
} from './github-app.mjs'

const PRIVATE_REPOSITORY = 'clockcrockwork/note-projects'
const PREVIEW_PROJECT_NAME = 'note-projects-publication-preview'
const TARGET_ID_RE = /^(?:ART-\d+|FDR-[A-Z0-9-]+)$/
const SHA_RE = /^[0-9a-f]{40}$/
const DEPLOYMENT_ID_RE = /^dpl_[A-Za-z0-9]+$/
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+\.vercel\.app\/?$/
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/

function stableDiagnostic(error) {
  const value = error instanceof Error ? error.message : String(error)
  const first = value.split(':', 1)[0]
  return /^[A-Z0-9_]+$/.test(first) ? first : 'UNCLASSIFIED_FAILURE'
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error('EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE')
  return value
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
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  }
}

function isolatedDockerArgs({ image, mounts, workdir, argv, env = {} }) {
  const args = [
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
  ]
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`)
  for (const mount of mounts) args.push('-v', mount)
  args.push('-w', workdir, image, ...argv)
  return args
}

export function isolatedDockerCreateArgs({ image, workdir, argv, env = {} }) {
  const args = [
    'docker',
    'create',
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
  ]
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`)
  args.push('-w', workdir, image, ...argv)
  return args
}

function runCopiedWorkspaceBuild({ image, workspaceRoot, target, sourceSha }) {
  const created = runCaptured(
    isolatedDockerCreateArgs({
      image,
      workdir: '/workspace',
      argv: ['node', 'tools/build-publication-preview.mjs', target],
      env: { SOURCE_SHA: sourceSha },
    }),
    { timeout: 2 * 60_000, env: childEnv() },
  )
  if (!created.ok) return created

  const containerId = created.stdout.trim()
  if (!CONTAINER_ID_RE.test(containerId)) {
    return {
      ok: false,
      stdout: created.stdout,
      stderr: 'PUBLICATION_PREVIEW_CONTAINER_ID_INVALID',
    }
  }

  try {
    const copiedIn = runCaptured(
      ['docker', 'cp', `${workspaceRoot}/.`, `${containerId}:/workspace`],
      { timeout: 5 * 60_000, env: childEnv() },
    )
    if (!copiedIn.ok) return copiedIn

    const build = runCaptured(['docker', 'start', '-a', containerId], {
      timeout: 5 * 60_000,
      env: childEnv(),
    })
    if (!build.ok) return build

    const copiedOut = runCaptured(
      ['docker', 'cp', `${containerId}:/workspace/artifacts`, workspaceRoot],
      { timeout: 2 * 60_000, env: childEnv() },
    )
    if (!copiedOut.ok) return copiedOut
    return build
  } finally {
    runCaptured(['docker', 'rm', '-f', containerId], {
      timeout: 60_000,
      env: childEnv(),
    })
  }
}

function parseRequest() {
  const raw = process.env.REQUEST_JSON
  if (!raw) throw new Error('REQUEST_JSON_REQUIRED')
  const request = JSON.parse(raw)
  if (request?.task !== 'publication-preview') throw new Error('REQUEST_TASK_MISMATCH')
  if (!TARGET_ID_RE.test(request?.target ?? '')) throw new Error('REQUEST_TARGET_INVALID')
  if (!['main', 'pull_request'].includes(request?.source)) throw new Error('REQUEST_SOURCE_INVALID')
  if (request.source === 'pull_request') {
    if (!Number.isSafeInteger(request.pull_request) || request.pull_request < 1) {
      throw new Error('REQUEST_PR_INVALID')
    }
  } else if (request.pull_request !== null) {
    throw new Error('REQUEST_PR_NOT_ALLOWED')
  }
  return request
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

export function findArticleRoot(listing, target) {
  if (!TARGET_ID_RE.test(target ?? '')) throw new Error('REQUEST_TARGET_INVALID')
  const candidates = (listing?.tree ?? [])
    .filter((entry) => entry?.type === 'tree' && typeof entry.path === 'string')
    .map((entry) => entry.path)
    .filter((path) => /^articles\/[^/]+\/[^/]+$/.test(path))
    .filter((path) => {
      const leaf = path.split('/').at(-1) ?? ''
      return leaf === target || leaf.startsWith(`${target}-`)
    })
  if (candidates.length === 0) throw new Error('PUBLICATION_PREVIEW_TARGET_NOT_FOUND')
  if (candidates.length !== 1) throw new Error('PUBLICATION_PREVIEW_TARGET_AMBIGUOUS')
  return candidates[0]
}

function treeEntriesByPath(listing) {
  return new Map(
    (listing?.tree ?? [])
      .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => [entry.path, entry]),
  )
}

async function materializePaths({ token, listing, paths, destinationRoot }) {
  const entries = treeEntriesByPath(listing)
  for (const path of paths) {
    const entry = entries.get(path)
    if (!entry?.sha) throw new Error('SOURCE_EXPORT_ENTRY_MISSING')
    await writeSafe(destinationRoot, path, await fetchBlob({ token, blobSha: entry.sha }))
  }
}

function parseJsonOutput(run, diagnostic) {
  if (!run.ok) throw new Error(diagnostic)
  try {
    return JSON.parse(run.stdout.trim())
  } catch {
    throw new Error(diagnostic)
  }
}

function exportPlan({ image, runnerRoot, trustedRoot, listingPath, manifestPath }) {
  const run = runCaptured(
    isolatedDockerArgs({
      image,
      mounts: [`${runnerRoot}:/runner:ro`, `${trustedRoot}:/trusted:ro`],
      workdir: '/runner',
      argv: [
        'node',
        '/runner/scripts/evaluate-export-plan.mjs',
        listingPath,
        manifestPath,
        '/trusted/source-export-policy.mjs',
      ],
    }),
    { timeout: 2 * 60_000, env: childEnv() },
  )
  const parsed = parseJsonOutput(run, 'EXPORT_CONTROL_FAILED')
  if (parsed?.ok !== true || !Array.isArray(parsed.include)) {
    throw new Error(parsed?.diagnostic ?? 'EXPORT_CONTROL_FAILED')
  }
  return parsed.include
}

function safeDeployment(value) {
  if (!value || typeof value !== 'object') throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  if (!DEPLOYMENT_ID_RE.test(value.deployment_id ?? '')) throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  if (!URL_RE.test(value.url ?? '')) throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  if (!SHA_RE.test(value.source_sha ?? '')) throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  if (!/^[0-9a-f]{64}$/.test(value.html_sha256 ?? '')) throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  if (!['note.clipboard', 'medium.clipboard'].includes(value.target_id)) {
    throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  }
  if (!['note', 'medium'].includes(value.target_slug)) throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  if (!Number.isInteger(value.protection_probe_status)) throw new Error('VERCEL_DEPLOY_RESULT_INVALID')
  return {
    deployment_id: value.deployment_id,
    url: value.url,
    target_id: value.target_id,
    target_slug: value.target_slug,
    source_sha: value.source_sha,
    html_sha256: value.html_sha256,
    protection_probe_status: value.protection_probe_status,
  }
}

export function safePublicResult(result) {
  const safe = {
    schema_version: 1,
    task: 'publication-preview',
    status: result.status,
  }
  if (SHA_RE.test(result.source_sha ?? '')) safe.source_sha = result.source_sha
  if (SHA_RE.test(result.tooling_sha ?? '')) safe.tooling_sha = result.tooling_sha
  if (TARGET_ID_RE.test(result.target ?? '')) safe.target = result.target
  if (/^[A-Z0-9_]+$/.test(result.diagnostic ?? '')) safe.diagnostic = result.diagnostic
  if (Number.isSafeInteger(result.preview_count) && result.preview_count >= 0) {
    safe.preview_count = result.preview_count
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
    `publication-preview ${result.status}${result.source_sha ? ` ${result.source_sha}` : ''}${result.diagnostic ? ` ${result.diagnostic}` : ''}\n`,
  )
  process.exitCode = exitCode
}

async function upsertPrivatePrComment({ token, pullRequest, target, sourceSha, deployments }) {
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) return
  const marker = `<!-- note-projects-cli:publication-preview:${target} -->`
  const comments = await api(`/repos/${PRIVATE_REPOSITORY}/issues/${pullRequest}/comments?per_page=100`, {
    token,
  })
  if (!Array.isArray(comments)) throw new Error('PREVIEW_COMMENT_LIST_INVALID')
  const existing = comments.find(
    (comment) => typeof comment?.body === 'string' && comment.body.includes(marker),
  )
  const lines = [
    marker,
    `### Protected Publication Preview — ${target}`,
    '',
    `- SOURCE_SHA: \`${sourceSha}\``,
    ...deployments.map(
      (deployment) =>
        `- ${deployment.target_slug}: ${deployment.url} (HTML SHA-256 \`${deployment.html_sha256}\`)`,
    ),
    '',
    'Anonymous access protection was machine-probed before these URLs were reported.',
  ]
  const body = lines.join('\n')
  if (existing?.id) {
    await api(`/repos/${PRIVATE_REPOSITORY}/issues/comments/${existing.id}`, {
      token,
      method: 'PATCH',
      body: { body },
    })
  } else {
    await api(`/repos/${PRIVATE_REPOSITORY}/issues/${pullRequest}/comments`, {
      token,
      method: 'POST',
      body: { body },
    })
  }
}

async function main() {
  let accessToken = null
  let sourceSha = null
  let toolingSha = null
  let phase = 'REQUEST'
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `note-projects-preview-${process.pid}`)
  const trustedRoot = resolve(root, 'trusted')
  const workspaceRoot = resolve(root, 'workspace')
  const cleanRoot = resolve(root, 'clean')
  const runnerRoot = fileURLToPath(new URL('..', import.meta.url))

  try {
    const request = parseRequest()
    phase = 'CREDENTIALS'
    const appId = requiredEnv('NPR_APP_ID')
    const privateKey = requiredEnv('NPR_APP_PRIVATE_KEY')
    const installationId = requiredEnv('NPR_APP_INSTALLATION_ID')

    phase = 'WORKSPACE_INIT'
    await rm(root, { recursive: true, force: true })
    await mkdir(trustedRoot, { recursive: true })
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(cleanRoot, { recursive: true })

    phase = 'ACCESS_TOKEN'
    accessToken = await mintInstallationToken({
      appId,
      privateKey,
      installationId,
      permissions: { contents: 'read', pull_requests: 'read' },
    })

    phase = 'SOURCE_RESOLVE'
    const resolved = await resolveSource({
      token: accessToken,
      source: request.source,
      pullRequest: request.pull_request,
    })
    sourceSha = resolved.sourceSha
    toolingSha = resolved.toolingSha

    phase = 'BOOTSTRAP_FETCH'
    const [packageJson, packageLock, exportPolicy, deployer] = await Promise.all([
      fetchTextFile({ token: accessToken, sha: toolingSha, path: 'package.json' }),
      fetchTextFile({ token: accessToken, sha: toolingSha, path: 'package-lock.json' }),
      fetchTextFile({ token: accessToken, sha: toolingSha, path: 'tools/source-export-policy.mjs' }),
      fetchTextFile({ token: accessToken, sha: toolingSha, path: 'tools/vercel-publication-preview.mjs' }),
    ])
    await writeSafe(workspaceRoot, 'package.json', packageJson)
    await writeSafe(workspaceRoot, 'package-lock.json', packageLock)
    await writeSafe(trustedRoot, 'source-export-policy.mjs', exportPolicy)
    await writeSafe(cleanRoot, 'vercel-publication-preview.mjs', deployer)

    phase = 'RUNTIME_PREPARE'
    const image = process.env.NPR_NODE_IMAGE || 'node:22-bookworm'
    const pull = runCaptured(['docker', 'pull', image], {
      timeout: 10 * 60_000,
      env: childEnv(),
    })
    if (!pull.ok) throw new Error('NO_EGRESS_RUNTIME_PREPARE_FAILED')

    phase = 'DEPENDENCY_INSTALL'
    const install = runCaptured(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: workspaceRoot,
      timeout: 15 * 60_000,
      env: childEnv({ NPM_CONFIG_CACHE: resolve(root, 'npm-cache') }),
    })
    if (!install.ok) throw new Error('DEPENDENCY_INSTALL_FAILED')

    phase = 'TREE_LIST'
    const toolingListing = await listCompleteTree({ token: accessToken, sha: toolingSha })
    const sourceListing =
      sourceSha === toolingSha
        ? toolingListing
        : await listCompleteTree({ token: accessToken, sha: sourceSha })
    const articleRoot = findArticleRoot(sourceListing, request.target)

    await writeFile(resolve(trustedRoot, 'tooling-tree.json'), JSON.stringify(toolingListing))
    await writeFile(resolve(trustedRoot, 'source-tree.json'), JSON.stringify(sourceListing))
    await writeFile(
      resolve(trustedRoot, 'tooling-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        task: 'publication-preview',
        allow: ['src/**', 'tools/build-publication-preview.mjs'],
        deny: ['articles/**', 'docs/**', '.github/**'],
      }),
    )
    await writeFile(
      resolve(trustedRoot, 'source-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        task: 'publication-preview',
        allow: [`${articleRoot}/publication/**`, `${articleRoot}/medium/**`],
        deny: [],
      }),
    )

    phase = 'EXPORT_PLAN'
    const toolingPaths = exportPlan({
      image,
      runnerRoot,
      trustedRoot,
      listingPath: '/trusted/tooling-tree.json',
      manifestPath: '/trusted/tooling-manifest.json',
    })
    const sourcePaths = exportPlan({
      image,
      runnerRoot,
      trustedRoot,
      listingPath: '/trusted/source-tree.json',
      manifestPath: '/trusted/source-manifest.json',
    })

    phase = 'PRIVATE_EXPORT'
    await materializePaths({
      token: accessToken,
      listing: toolingListing,
      paths: toolingPaths,
      destinationRoot: workspaceRoot,
    })
    await materializePaths({
      token: accessToken,
      listing: sourceListing,
      paths: sourcePaths,
      destinationRoot: workspaceRoot,
    })

    phase = 'ACCESS_REVOKE'
    await revokeInstallationToken(accessToken)
    accessToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    phase = 'PREVIEW_BUILD'
    const build = runCopiedWorkspaceBuild({
      image,
      workspaceRoot,
      target: request.target,
      sourceSha,
    })
    if (!build.ok) throw new Error('PUBLICATION_PREVIEW_BUILD_FAILED')

    phase = 'PAYLOAD_ISOLATE'
    const builtRoot = resolve(workspaceRoot, 'artifacts/publication-preview', request.target)
    const targetSlugs = (await readdir(builtRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    if (targetSlugs.length === 0 || targetSlugs.some((slug) => !['note', 'medium'].includes(slug))) {
      throw new Error('PUBLICATION_PREVIEW_PAYLOAD_INVALID')
    }
    const payloadRoot = resolve(cleanRoot, request.target)
    await mkdir(payloadRoot, { recursive: true })
    for (const slug of targetSlugs) {
      await cp(resolve(builtRoot, slug), resolve(payloadRoot, slug), { recursive: true })
    }

    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(trustedRoot, { recursive: true, force: true })
    await rm(resolve(root, 'npm-cache'), { recursive: true, force: true })

    phase = 'VERCEL_CREDENTIALS'
    const vercelToken = requiredEnv('VERCEL_TOKEN')
    const vercelTeamId = requiredEnv('VERCEL_TEAM_ID')
    const deployerPath = resolve(cleanRoot, 'vercel-publication-preview.mjs')
    const vercelBaseEnv = childEnv({
      VERCEL_TOKEN: vercelToken,
      VERCEL_TEAM_ID: vercelTeamId,
      VERCEL_PROJECT_NAME: PREVIEW_PROJECT_NAME,
    })

    phase = 'VERCEL_PROJECT'
    const ensured = parseJsonOutput(
      runCaptured(['node', deployerPath, 'ensure-project'], {
        cwd: cleanRoot,
        env: vercelBaseEnv,
        timeout: 2 * 60_000,
      }),
      'VERCEL_PROJECT_ENSURE_FAILED',
    )
    if (!/^prj_[A-Za-z0-9]+$/.test(ensured?.id ?? '') || ensured?.name !== PREVIEW_PROJECT_NAME) {
      throw new Error('VERCEL_PROJECT_IDENTITY_INVALID')
    }

    phase = 'VERCEL_DEPLOY'
    const deployments = []
    for (const slug of targetSlugs) {
      const deployed = parseJsonOutput(
        runCaptured(['node', deployerPath, 'deploy', resolve(payloadRoot, slug)], {
          cwd: cleanRoot,
          env: { ...vercelBaseEnv, VERCEL_PROJECT_ID: ensured.id },
          timeout: 3 * 60_000,
        }),
        'VERCEL_DEPLOY_FAILED',
      )
      const safe = safeDeployment(deployed)
      if (safe.source_sha !== sourceSha || safe.target_slug !== slug) {
        throw new Error('VERCEL_DEPLOY_IDENTITY_MISMATCH')
      }
      deployments.push(safe)
    }

    if (request.source === 'pull_request') {
      phase = 'PRIVATE_COMMENT_TOKEN'
      const commentToken = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        permissions: { pull_requests: 'write' },
      })
      try {
        phase = 'PRIVATE_COMMENT_UPSERT'
        await upsertPrivatePrComment({
          token: commentToken,
          pullRequest: request.pull_request,
          target: request.target,
          sourceSha,
          deployments,
        })
      } finally {
        await revokeInstallationToken(commentToken)
      }
    }

    phase = 'COMPLETE'
    await emit({
      schema_version: 1,
      task: 'publication-preview',
      status: 'PASS',
      tooling_sha: toolingSha,
      source_sha: sourceSha,
      target: request.target,
      preview_count: deployments.length,
    })
  } catch (error) {
    if (accessToken) {
      try {
        await revokeInstallationToken(accessToken)
      } catch {}
    }
    await emit(
      {
        schema_version: 1,
        task: 'publication-preview',
        status: ['CREDENTIALS', 'VERCEL_CREDENTIALS'].includes(phase) ? 'HOLD' : 'FAIL',
        tooling_sha: toolingSha,
        source_sha: sourceSha,
        target: (() => {
          try {
            return parseRequest().target
          } catch {
            return undefined
          }
        })(),
        diagnostic: stableDiagnostic(error),
      },
      ['CREDENTIALS', 'VERCEL_CREDENTIALS'].includes(phase) ? 3 : 2,
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(async () => {
    await emit(
      {
        schema_version: 1,
        task: 'publication-preview',
        status: 'FAIL',
        diagnostic: 'UNCLASSIFIED_FAILURE',
      },
      2,
    )
  })
}
