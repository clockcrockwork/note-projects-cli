import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fetchBlob,
  fetchTextFile,
  listCompleteTree,
  mintInstallationToken,
  resolveSource,
  revokeInstallationToken,
} from './github-app.mjs'

const TARGET_RE = /^(?:ART-\d+|FDR-[A-Z0-9-]+)$/
const TRUSTED_FILES = [
  'package.json',
  'package-lock.json',
  'tools/verify-published.mjs',
  'src/publish-console/publication-metadata.mjs',
  'src/publish-console/published-verification-metadata.mjs',
  'src/publish-console/published-verification.mjs',
]
const LIVE_RESULTS = new Set(['PASS', 'HOLD', 'RETRYABLE_FAIL'])
const VIEWPORT_RESULTS = new Set(['PASS', 'HOLD', 'RETRYABLE_FAIL', 'REACHABLE'])
const CHECK_RESULTS = new Set(['PASS', 'HOLD'])

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
    error: child.error ?? null,
  }
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

function parseRequest() {
  const raw = process.env.REQUEST_JSON
  if (!raw) throw new Error('REQUEST_JSON_REQUIRED')
  const request = JSON.parse(raw)
  if (request?.task !== 'verify-publication') throw new Error('REQUEST_TASK_MISMATCH')
  if (request?.source !== 'main' && request?.source !== 'pull_request') {
    throw new Error('REQUEST_SOURCE_INVALID')
  }
  if (!TARGET_RE.test(request?.target ?? '')) throw new Error('REQUEST_TARGET_INVALID')
  if (
    request.source === 'pull_request' &&
    (!Number.isSafeInteger(request.pull_request) || request.pull_request < 1)
  ) {
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

export function findTargetPublicationPath(tree, target) {
  if (!TARGET_RE.test(target ?? '')) throw new Error('REQUEST_TARGET_INVALID')
  if (!Array.isArray(tree)) throw new Error('SOURCE_EXPORT_TREE_INVALID')
  const matches = tree
    .filter((entry) => entry?.type === 'blob' && typeof entry?.path === 'string')
    .map((entry) => entry.path)
    .filter((path) => /^articles\/[^/]+\/[^/]+\/publication\/publication\.yaml$/.test(path))
    .filter((path) => {
      const articleDir = path.split('/')[2]
      return articleDir === target || articleDir.startsWith(`${target}-`)
    })
  if (matches.length === 0) throw new Error('PUBLICATION_TARGET_NOT_FOUND')
  if (matches.length !== 1) throw new Error('PUBLICATION_TARGET_AMBIGUOUS')
  return matches[0]
}

export function publicationDataPaths(tree, publicationPath) {
  if (!Array.isArray(tree) || typeof publicationPath !== 'string') {
    throw new Error('PUBLICATION_EXPORT_INPUT_INVALID')
  }
  const directory = publicationPath.slice(0, -'/publication.yaml'.length)
  const paths = tree
    .filter((entry) => entry?.type === 'blob' && typeof entry?.path === 'string')
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path === publicationPath ||
        (path.startsWith(`${directory}/`) && path.toLowerCase().endsWith('.md')),
    )
    .sort()
  if (!paths.includes(publicationPath)) throw new Error('PUBLICATION_METADATA_MISSING')
  if (paths.length > 32) throw new Error('PUBLICATION_EXPORT_LIMIT')
  return paths
}

export function safeEvidenceFromReport(report, { sourceSha, toolingSha, target }) {
  if (!report || !LIVE_RESULTS.has(report.result) || typeof report.article_id !== 'string') {
    throw new Error('PUBLICATION_LIVE_RESULT_INVALID')
  }
  if (report.article_id !== target) throw new Error('PUBLICATION_LIVE_TARGET_MISMATCH')
  const viewports = {}
  for (const name of ['desktop', 'mobile']) {
    const viewport = report.viewports?.[name]
    if (!viewport || !VIEWPORT_RESULTS.has(viewport.result)) continue
    const checks = Array.isArray(viewport.checks)
      ? viewport.checks
          .filter(
            (check) =>
              check &&
              typeof check.id === 'string' &&
              /^[a-z0-9_]+$/.test(check.id) &&
              CHECK_RESULTS.has(check.status),
          )
          .map((check) => ({ id: check.id, status: check.status }))
      : []
    viewports[name] = {
      result: viewport.result,
      status: Number.isInteger(viewport.status) ? viewport.status : null,
      retries: Number.isInteger(viewport.retries) && viewport.retries >= 0 ? viewport.retries : 0,
      checks,
    }
  }
  return {
    schema_version: 1,
    task: 'verify-publication',
    article_id: target,
    source_sha: sourceSha,
    tooling_sha: toolingSha,
    live_result: report.result,
    checked_at: typeof report.checked_at === 'string' ? report.checked_at : null,
    viewports,
  }
}

async function emit(result, evidence, exitCode = 0) {
  const runnerTemp = resolve(process.env.RUNNER_TEMP || tmpdir())
  const evidencePath = resolve(runnerTemp, `verify-publication-safe-evidence-${process.pid}.json`)
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  const safe = JSON.stringify(result)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    await appendFile(output, `result_json=${safe}\n`)
    if (result.source_sha) await appendFile(output, `source_sha=${result.source_sha}\n`)
    if (result.status) await appendFile(output, `status=${result.status}\n`)
    await appendFile(output, `evidence_path=${evidencePath}\n`)
  }
  process.stdout.write(
    `verify-publication ${result.status}${result.source_sha ? ` ${result.source_sha}` : ''}${result.diagnostic ? ` ${result.diagnostic}` : ''}\n`,
  )
  process.exitCode = exitCode
}

async function main() {
  let sourceSha = null
  let toolingSha = null
  let accessToken = null
  let target = null
  let phase = 'REQUEST'
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `verify-publication-${process.pid}`)
  const sourceRoot = resolve(root, 'source')
  const evidenceDir = resolve(sourceRoot, 'artifacts', 'published-verification')

  try {
    const request = parseRequest()
    target = request.target

    phase = 'CREDENTIALS'
    const appId = requiredEnv('NPR_APP_ID')
    const privateKey = requiredEnv('NPR_APP_PRIVATE_KEY')
    const installationId = requiredEnv('NPR_APP_INSTALLATION_ID')

    phase = 'WORKSPACE_INIT'
    await rm(root, { recursive: true, force: true })
    await mkdir(sourceRoot, { recursive: true })

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
    toolingSha = resolved.toolingSha
    sourceSha = resolved.sourceSha

    phase = 'TREE_LIST'
    const listing = await listCompleteTree({ token: accessToken, sha: sourceSha })
    const publicationPath = findTargetPublicationPath(listing.tree, target)
    const dataPaths = publicationDataPaths(listing.tree, publicationPath)
    const entryByPath = new Map(listing.tree.map((entry) => [entry.path, entry]))

    phase = 'TRUSTED_TOOLING_FETCH'
    for (const path of TRUSTED_FILES) {
      const bytes = await fetchTextFile({ token: accessToken, sha: toolingSha, path })
      await writeSafe(sourceRoot, path, bytes)
    }

    phase = 'PUBLICATION_DATA_FETCH'
    for (const path of dataPaths) {
      const entry = entryByPath.get(path)
      if (!entry?.sha || entry.type !== 'blob') throw new Error('SOURCE_EXPORT_ENTRY_INVALID')
      const bytes = await fetchBlob({ token: accessToken, blobSha: entry.sha })
      await writeSafe(sourceRoot, path, bytes)
    }

    phase = 'ACCESS_REVOKE'
    await revokeInstallationToken(accessToken)
    accessToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    phase = 'DEPENDENCY_INSTALL'
    const install = runCaptured(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: sourceRoot,
      timeout: 15 * 60_000,
      env: childEnv({ NPM_CONFIG_CACHE: resolve(root, 'npm-cache') }),
    })
    if (!install.ok) throw new Error('DEPENDENCY_INSTALL_FAILED')

    phase = 'BROWSER_INSTALL'
    const browserPath = resolve(root, 'pw-browsers')
    const browserInstall = runCaptured(
      ['./node_modules/.bin/playwright', 'install', '--with-deps', 'chromium'],
      {
        cwd: sourceRoot,
        timeout: 15 * 60_000,
        env: childEnv({ PLAYWRIGHT_BROWSERS_PATH: browserPath }),
      },
    )
    if (!browserInstall.ok) throw new Error('PLAYWRIGHT_RUNTIME_PREPARE_FAILED')

    phase = 'LIVE_VERIFY'
    const targetOutput = resolve(evidenceDir, target)
    const verification = runCaptured(
      [
        'node',
        'tools/verify-published.mjs',
        target,
        '--attempts',
        '6',
        '--delay-ms',
        '30000',
        '--output',
        `artifacts/published-verification/${target}`,
      ],
      {
        cwd: sourceRoot,
        timeout: 15 * 60_000,
        env: childEnv({ PLAYWRIGHT_BROWSERS_PATH: browserPath }),
      },
    )

    const reportPath = resolve(targetOutput, 'report.json')
    let report = null
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'))
    } catch {}

    if (report) {
      const evidence = safeEvidenceFromReport(report, { sourceSha, toolingSha, target })
      if (evidence.live_result === 'PASS' && verification.ok) {
        await emit(
          {
            schema_version: 1,
            task: 'verify-publication',
            status: 'PASS',
            article_id: target,
            source_sha: sourceSha,
            tooling_sha: toolingSha,
            live_result: evidence.live_result,
            viewport_results: Object.fromEntries(
              Object.entries(evidence.viewports).map(([name, value]) => [name, value.result]),
            ),
          },
          evidence,
        )
        return
      }

      const diagnostic =
        evidence.live_result === 'RETRYABLE_FAIL'
          ? 'PUBLICATION_LIVE_RETRYABLE'
          : 'PUBLICATION_LIVE_HOLD'
      await emit(
        {
          schema_version: 1,
          task: 'verify-publication',
          status: 'HOLD',
          article_id: target,
          source_sha: sourceSha,
          tooling_sha: toolingSha,
          diagnostic,
          live_result: evidence.live_result,
          viewport_results: Object.fromEntries(
            Object.entries(evidence.viewports).map(([name, value]) => [name, value.result]),
          ),
        },
        evidence,
        3,
      )
      return
    }

    if (verification.status === 1) {
      const evidence = {
        schema_version: 1,
        task: 'verify-publication',
        article_id: target,
        source_sha: sourceSha,
        tooling_sha: toolingSha,
        live_result: 'HOLD',
        diagnostic: 'PUBLICATION_LIVE_PRECONDITION_FAILED',
        viewports: {},
      }
      await emit(
        {
          schema_version: 1,
          task: 'verify-publication',
          status: 'HOLD',
          article_id: target,
          source_sha: sourceSha,
          tooling_sha: toolingSha,
          diagnostic: evidence.diagnostic,
          live_result: evidence.live_result,
        },
        evidence,
        3,
      )
      return
    }

    throw new Error('PUBLICATION_LIVE_EXECUTION_FAILED')
  } catch (error) {
    try {
      if (accessToken) await revokeInstallationToken(accessToken)
    } catch {}
    const rawDiagnostic = stableDiagnostic(error)
    const diagnostic =
      rawDiagnostic === 'UNCLASSIFIED_FAILURE' ? `RUNNER_${phase}_FAILED` : rawDiagnostic
    const status = diagnostic === 'EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE' ? 'HOLD' : 'FAIL'
    const evidence = {
      schema_version: 1,
      task: 'verify-publication',
      ...(target ? { article_id: target } : {}),
      ...(sourceSha ? { source_sha: sourceSha } : {}),
      ...(toolingSha ? { tooling_sha: toolingSha } : {}),
      diagnostic,
      phase,
      viewports: {},
    }
    await emit(
      {
        schema_version: 1,
        task: 'verify-publication',
        status,
        ...(target ? { article_id: target } : {}),
        ...(sourceSha ? { source_sha: sourceSha } : {}),
        ...(toolingSha ? { tooling_sha: toolingSha } : {}),
        diagnostic,
        phase,
      },
      evidence,
      status === 'HOLD' ? 3 : 1,
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
