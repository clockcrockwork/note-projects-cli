import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const SAFE_COMMANDS = new Map([
  [
    'npm run verify:public',
    [
      { argv: ['npm', 'run', 'format:check'], diagnostic: 'PUBLIC_FORMAT_CHECK_FAILED' },
      { argv: ['npm', 'run', 'lint'], diagnostic: 'PUBLIC_LINT_FAILED' },
      { argv: ['npm', 'run', 'typecheck:public'], diagnostic: 'PUBLIC_TYPECHECK_FAILED' },
      { argv: ['npm', 'run', 'test:public'], diagnostic: 'PUBLIC_TEST_FAILED' },
    ],
  ],
  [
    'npm run gas:build',
    [{ argv: ['npm', 'run', 'gas:build'], diagnostic: 'GAS_BUILD_FAILED' }],
  ],
])

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

async function emit(result, exitCode = 0) {
  const safe = JSON.stringify(result)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    await appendFile(output, `result_json=${safe}\n`)
    if (result.source_sha) await appendFile(output, `source_sha=${result.source_sha}\n`)
    if (result.status) await appendFile(output, `status=${result.status}\n`)
  }
  process.stdout.write(
    `repository-verify ${result.status}${result.source_sha ? ` ${result.source_sha}` : ''}${result.diagnostic ? ` ${result.diagnostic}` : ''}\n`,
  )
  process.exitCode = exitCode
}

function parseRequest() {
  const raw = process.env.REQUEST_JSON
  if (!raw) throw new Error('REQUEST_JSON_REQUIRED')
  const request = JSON.parse(raw)
  if (request?.task !== 'repository-verify' || request?.source !== 'pull_request') {
    throw new Error('REQUEST_TASK_MISMATCH')
  }
  if (!Number.isSafeInteger(request.pull_request) || request.pull_request < 1) {
    throw new Error('REQUEST_PR_INVALID')
  }
  return request
}

async function writeSafe(root, path, bytes) {
  const destination = resolve(root, path)
  const prefix = resolve(root) + sep
  if (!destination.startsWith(prefix)) throw new Error('EXPORT_DESTINATION_ESCAPE')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}

function parseJson(bytes, diagnostic) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(diagnostic)
  }
}

async function importTrusted(path) {
  return import(`${pathToFileURL(path).href}?v=${Date.now()}`)
}

async function main() {
  let sourceSha = null
  let toolingSha = null
  let bootstrapToken = null
  let targetToken = null
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `note-projects-cli-${process.pid}`)
  const trustedRoot = resolve(root, 'trusted')
  const sourceRoot = resolve(root, 'source')

  try {
    const request = parseRequest()
    const appId = requiredEnv('NPR_APP_ID')
    const privateKey = requiredEnv('NPR_APP_PRIVATE_KEY')
    const installationId = requiredEnv('NPR_APP_INSTALLATION_ID')

    await rm(root, { recursive: true, force: true })
    await mkdir(trustedRoot, { recursive: true })
    await mkdir(sourceRoot, { recursive: true })

    bootstrapToken = await mintInstallationToken({
      appId,
      privateKey,
      installationId,
      permissions: { contents: 'read', pull_requests: 'read' },
    })

    const resolved = await resolveSource({
      token: bootstrapToken,
      source: request.source,
      pullRequest: request.pull_request,
    })
    toolingSha = resolved.toolingSha
    sourceSha = resolved.sourceSha

    const bootstrapFiles = await Promise.all([
      fetchTextFile({ token: bootstrapToken, sha: toolingSha, path: 'tools/pr-validation-plan.mjs' }),
      fetchTextFile({ token: bootstrapToken, sha: toolingSha, path: 'tools/source-export-policy.mjs' }),
      fetchTextFile({
        token: bootstrapToken,
        sha: toolingSha,
        path: 'config/public-execution/repository-verify.json',
      }),
      fetchTextFile({ token: bootstrapToken, sha: sourceSha, path: 'package.json' }),
      fetchTextFile({ token: bootstrapToken, sha: sourceSha, path: 'package-lock.json' }),
    ])

    await writeSafe(trustedRoot, 'pr-validation-plan.mjs', bootstrapFiles[0])
    await writeSafe(trustedRoot, 'source-export-policy.mjs', bootstrapFiles[1])
    await writeSafe(trustedRoot, 'repository-verify.json', bootstrapFiles[2])
    await writeSafe(sourceRoot, 'package.json', bootstrapFiles[3])
    await writeSafe(sourceRoot, 'package-lock.json', bootstrapFiles[4])

    await revokeInstallationToken(bootstrapToken)
    bootstrapToken = null

    const planner = await importTrusted(resolve(trustedRoot, 'pr-validation-plan.mjs'))
    const plan = planner.planPrValidation(resolved.changedPaths)
    if (plan.generic_repository_validation === 'NOT_REQUIRED') {
      await emit({
        schema_version: 1,
        task: 'repository-verify',
        status: 'NOT_REQUIRED',
        tooling_sha: toolingSha,
        source_sha: sourceSha,
        changed_path_count: resolved.changedPaths.length,
        public_commands: [],
        qualified_render_required: false,
      })
      return
    }

    const expectedPublic = plan.public_execution?.commands ?? []
    for (const command of expectedPublic) {
      if (!SAFE_COMMANDS.has(command)) throw new Error('VALIDATION_PLAN_COMMAND_REJECTED')
    }

    const install = runCaptured(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: sourceRoot,
      timeout: 15 * 60_000,
      env: childEnv({ NPM_CONFIG_CACHE: resolve(root, 'npm-cache') }),
    })
    if (!install.ok) throw new Error('DEPENDENCY_INSTALL_FAILED')

    const image = process.env.NPR_NODE_IMAGE || 'node:22-bookworm'
    const pull = runCaptured(['docker', 'pull', image], {
      timeout: 10 * 60_000,
      env: childEnv(),
    })
    if (!pull.ok) throw new Error('NO_EGRESS_RUNTIME_PREPARE_FAILED')

    targetToken = await mintInstallationToken({
      appId,
      privateKey,
      installationId,
      permissions: { contents: 'read' },
    })

    const listing = await listCompleteTree({ token: targetToken, sha: sourceSha })
    const exportPolicy = await importTrusted(resolve(trustedRoot, 'source-export-policy.mjs'))
    const manifest = parseJson(
      await readFile(resolve(trustedRoot, 'repository-verify.json')),
      'TASK_MANIFEST_INVALID',
    )
    if (
      manifest?.schema_version !== 1 ||
      manifest?.task !== 'repository-verify' ||
      !Array.isArray(manifest.allow)
    ) {
      throw new Error('TASK_MANIFEST_INVALID')
    }
    const exportPlan = exportPolicy.planExport(listing, {
      allow: manifest.allow,
      deny: manifest.deny ?? [],
    })
    if (!exportPlan.ok) throw new Error('SOURCE_EXPORT_UNSAFE_ENTRY')

    const entryByPath = new Map(listing.tree.map((entry) => [entry.path, entry]))
    for (const path of exportPlan.include) {
      const entry = entryByPath.get(path)
      if (!entry?.sha || entry.type !== 'blob') throw new Error('SOURCE_EXPORT_ENTRY_INVALID')
      const bytes = await fetchBlob({ token: targetToken, blobSha: entry.sha })
      await writeSafe(sourceRoot, path, bytes)
    }

    await revokeInstallationToken(targetToken)
    targetToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    const hostUid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000'
    const hostGid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000'

    for (const command of expectedPublic) {
      const stages = SAFE_COMMANDS.get(command)
      for (const stage of stages) {
        const isolated = runCaptured(
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
            '--user',
            `${hostUid}:${hostGid}`,
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
            ...stage.argv,
          ],
          { timeout: 20 * 60_000, env: childEnv() },
        )
        if (!isolated.ok) throw new Error(stage.diagnostic)
      }
    }

    await emit({
      schema_version: 1,
      task: 'repository-verify',
      status: 'PASS',
      tooling_sha: toolingSha,
      source_sha: sourceSha,
      changed_path_count: resolved.changedPaths.length,
      exported_file_count: exportPlan.include.length,
      public_commands: expectedPublic,
      qualified_render_required: Boolean(plan.qualified_render_execution?.required),
      qualified_render_commands: plan.qualified_render_execution?.commands ?? [],
    })
  } catch (error) {
    try {
      if (targetToken) await revokeInstallationToken(targetToken)
    } catch {}
    try {
      if (bootstrapToken) await revokeInstallationToken(bootstrapToken)
    } catch {}
    const diagnostic = stableDiagnostic(error)
    const status = diagnostic === 'EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE' ? 'HOLD' : 'FAIL'
    await emit(
      {
        schema_version: 1,
        task: 'repository-verify',
        status,
        ...(toolingSha ? { tooling_sha: toolingSha } : {}),
        ...(sourceSha ? { source_sha: sourceSha } : {}),
        diagnostic,
      },
      status === 'HOLD' ? 3 : 1,
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

main()
