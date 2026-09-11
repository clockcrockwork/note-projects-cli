import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fetchBlob,
  fetchTextFile,
  listCompleteTree,
  mintInstallationToken,
  resolvePullRequestSource,
  revokeInstallationToken,
} from './github-app.mjs'

const REPOSITORY = 'clockcrockwork/threads-affiliates'
const REPOSITORY_NAME = 'threads-affiliates'
const TASK = 'threads-affiliates-verify'
const SOURCE_ROOTS = ['gas/', 'tests/', 'tools/']
const SOURCE_EXTENSIONS = ['.mjs', '.json']

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

function runCaptured(argv, { cwd, timeout = 15 * 60_000, env = childEnv() } = {}) {
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
    error: child.error ?? null,
  }
}

function isolatedDockerArgs({ image, sourceRoot, argv }) {
  return [
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
    '-v',
    `${sourceRoot}:/workspace`,
    '-w',
    '/workspace',
    image,
    ...argv,
  ]
}

function parseRequest() {
  const raw = process.env.REQUEST_JSON
  if (!raw) throw new Error('REQUEST_JSON_REQUIRED')
  const request = JSON.parse(raw)
  if (request?.task !== TASK || request?.source !== 'pull_request') {
    throw new Error('REQUEST_TASK_MISMATCH')
  }
  if (!Number.isSafeInteger(request.pull_request) || request.pull_request < 1) {
    throw new Error('REQUEST_PR_INVALID')
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

export function isSafeRepositoryPath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  const segments = path.split('/')
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..')
}

export function isExportableThreadsAffiliatePath(path) {
  if (path === 'package.json' || path === 'package-lock.json') return true
  if (!SOURCE_ROOTS.some((root) => path.startsWith(root))) return false
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))
}

export function planThreadsAffiliateExport(listing) {
  if (!listing || !Array.isArray(listing.tree) || listing.truncated) {
    throw new Error('SOURCE_EXPORT_TREE_INVALID')
  }
  const include = []
  for (const entry of listing.tree) {
    const path = entry?.path
    if (!isSafeRepositoryPath(path)) throw new Error('SOURCE_EXPORT_PATH_UNSAFE')
    if (entry?.mode === '120000') throw new Error('SOURCE_EXPORT_SYMLINK_REJECTED')
    if (entry?.mode === '160000' || entry?.type === 'commit') {
      throw new Error('SOURCE_EXPORT_GITLINK_REJECTED')
    }
    if (entry?.type === 'tree' || entry?.mode === '040000') continue
    if (entry?.type !== 'blob') throw new Error('SOURCE_EXPORT_ENTRY_TYPE_REJECTED')
    if (isExportableThreadsAffiliatePath(path)) {
      if (!/^[0-9a-f]{40}$/.test(entry?.sha ?? '')) throw new Error('SOURCE_EXPORT_BLOB_SHA_INVALID')
      include.push({ path, sha: entry.sha })
    }
  }
  if (!include.some((entry) => entry.path === 'package.json')) {
    throw new Error('SOURCE_EXPORT_PACKAGE_JSON_MISSING')
  }
  if (!include.some((entry) => entry.path === 'package-lock.json')) {
    throw new Error('SOURCE_EXPORT_PACKAGE_LOCK_MISSING')
  }
  return include.sort((a, b) => a.path.localeCompare(b.path))
}

function requiresMachineVerification(changedPaths) {
  return changedPaths.some(
    (path) =>
      path === 'package.json' ||
      path === 'package-lock.json' ||
      SOURCE_ROOTS.some((root) => path.startsWith(root)),
  )
}

async function emit(result, exitCode = 0) {
  const safe = JSON.stringify(result)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(output, `result_json=${safe}\n`)
    if (result.source_sha) await appendFile(output, `source_sha=${result.source_sha}\n`)
    if (result.status) await appendFile(output, `status=${result.status}\n`)
  }
  process.stdout.write(
    `${TASK} ${result.status}${result.source_sha ? ` ${result.source_sha}` : ''}${result.diagnostic ? ` ${result.diagnostic}` : ''}\n`,
  )
  process.exitCode = exitCode
}

async function main() {
  let accessToken = null
  let sourceSha = null
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `threads-affiliates-ci-${process.pid}`)
  const sourceRoot = resolve(root, 'source')

  try {
    const request = parseRequest()
    await rm(root, { recursive: true, force: true })
    await mkdir(sourceRoot, { recursive: true })

    accessToken = await mintInstallationToken({
      appId: requiredEnv('NPR_APP_ID'),
      privateKey: requiredEnv('NPR_APP_PRIVATE_KEY'),
      installationId: requiredEnv('NPR_APP_INSTALLATION_ID'),
      repositoryName: REPOSITORY_NAME,
      permissions: { contents: 'read', pull_requests: 'read' },
    })

    const resolved = await resolvePullRequestSource({
      token: accessToken,
      repository: REPOSITORY,
      pullRequest: request.pull_request,
    })
    sourceSha = resolved.sourceSha

    if (!requiresMachineVerification(resolved.changedPaths)) {
      await revokeInstallationToken(accessToken)
      accessToken = null
      await emit({
        schema_version: 1,
        task: TASK,
        status: 'NOT_REQUIRED',
        source_sha: sourceSha,
        changed_path_count: resolved.changedPaths.length,
        exported_file_count: 0,
        public_commands: [],
      })
      return
    }

    const [packageJson, packageLock] = await Promise.all([
      fetchTextFile({ token: accessToken, repository: REPOSITORY, sha: sourceSha, path: 'package.json' }),
      fetchTextFile({
        token: accessToken,
        repository: REPOSITORY,
        sha: sourceSha,
        path: 'package-lock.json',
      }),
    ])
    await writeSafe(sourceRoot, 'package.json', packageJson)
    await writeSafe(sourceRoot, 'package-lock.json', packageLock)

    const install = runCaptured(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: sourceRoot,
      timeout: 15 * 60_000,
      env: childEnv({ NPM_CONFIG_CACHE: resolve(root, 'npm-cache') }),
    })
    if (!install.ok) throw new Error('DEPENDENCY_INSTALL_FAILED')

    // esbuild needs its platform binary prepared by its lifecycle script. Keep
    // the broad dependency install script-free, then rebuild only the reviewed,
    // lockfile-pinned esbuild package before any private source blob is exported.
    // This preserves the source isolation boundary while making build:gas usable
    // later inside the no-network container.
    const esbuildPrepare = runCaptured(
      ['npm', 'rebuild', 'esbuild', '--no-audit', '--no-fund'],
      {
        cwd: sourceRoot,
        timeout: 5 * 60_000,
        env: childEnv({ NPM_CONFIG_CACHE: resolve(root, 'npm-cache') }),
      },
    )
    if (!esbuildPrepare.ok) throw new Error('ESBUILD_PREPARE_FAILED')

    const listing = await listCompleteTree({
      token: accessToken,
      repository: REPOSITORY,
      sha: sourceSha,
    })
    const exportPlan = planThreadsAffiliateExport(listing)
    for (const entry of exportPlan) {
      if (entry.path === 'package.json' || entry.path === 'package-lock.json') continue
      const bytes = await fetchBlob({
        token: accessToken,
        repository: REPOSITORY,
        blobSha: entry.sha,
      })
      await writeSafe(sourceRoot, entry.path, bytes)
    }

    await revokeInstallationToken(accessToken)
    accessToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    const image = process.env.NPR_NODE_IMAGE || 'node:22-bookworm'
    const pull = runCaptured(['docker', 'pull', image], {
      timeout: 10 * 60_000,
      env: childEnv(),
    })
    if (!pull.ok) throw new Error('NO_EGRESS_RUNTIME_PREPARE_FAILED')

    const tests = runCaptured(
      isolatedDockerArgs({ image, sourceRoot, argv: ['npm', 'test'] }),
      { timeout: 15 * 60_000, env: childEnv() },
    )
    if (!tests.ok) throw new Error('PUBLIC_TEST_FAILED')

    const build = runCaptured(
      isolatedDockerArgs({ image, sourceRoot, argv: ['npm', 'run', 'build:gas'] }),
      { timeout: 15 * 60_000, env: childEnv() },
    )
    if (!build.ok) throw new Error('GAS_BUILD_FAILED')

    await emit({
      schema_version: 1,
      task: TASK,
      status: 'PASS',
      source_sha: sourceSha,
      changed_path_count: resolved.changedPaths.length,
      exported_file_count: exportPlan.length,
      public_commands: ['npm test', 'npm run build:gas'],
    })
  } catch (error) {
    await emit(
      {
        schema_version: 1,
        task: TASK,
        status: 'FAIL',
        ...(sourceSha ? { source_sha: sourceSha } : {}),
        diagnostic: stableDiagnostic(error),
      },
      1,
    )
  } finally {
    if (accessToken) {
      try {
        await revokeInstallationToken(accessToken)
      } catch {
        // Best-effort revocation. The installation token is short-lived and no
        // source command executes while it remains available to the process.
      }
    }
    delete process.env.NPR_APP_PRIVATE_KEY
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
