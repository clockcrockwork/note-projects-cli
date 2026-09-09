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

function isolatedDockerArgs({ image, mounts, workdir, argv }) {
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
  for (const mount of mounts) args.push('-v', mount)
  args.push('-w', workdir, image, ...argv)
  return args
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

function parseJson(value, diagnostic) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
  } catch {
    throw new Error(diagnostic)
  }
}

async function main() {
  let sourceSha = null
  let toolingSha = null
  let accessToken = null
  let phase = 'REQUEST'
  const root = resolve(process.env.RUNNER_TEMP || tmpdir(), `note-projects-cli-${process.pid}`)
  const trustedRoot = resolve(root, 'trusted')
  const sourceRoot = resolve(root, 'source')
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
    await mkdir(sourceRoot, { recursive: true })

    // One same-repository installation token is kept only by this trusted parent
    // process. Private control/source code is never executed in this process while
    // the credential is live; control modules run in no-network child containers.
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

    phase = 'BOOTSTRAP_FETCH'
    const bootstrapFiles = await Promise.all([
      fetchTextFile({ token: accessToken, sha: toolingSha, path: 'tools/pr-validation-plan.mjs' }),
      fetchTextFile({ token: accessToken, sha: toolingSha, path: 'tools/source-export-policy.mjs' }),
      fetchTextFile({
        token: accessToken,
        sha: toolingSha,
        path: 'config/public-execution/repository-verify.json',
      }),
      fetchTextFile({ token: accessToken, sha: sourceSha, path: 'package.json' }),
      fetchTextFile({ token: accessToken, sha: sourceSha, path: 'package-lock.json' }),
    ])

    phase = 'BOOTSTRAP_WRITE'
    await writeSafe(trustedRoot, 'pr-validation-plan.mjs', bootstrapFiles[0])
    await writeSafe(trustedRoot, 'source-export-policy.mjs', bootstrapFiles[1])
    await writeSafe(trustedRoot, 'repository-verify.json', bootstrapFiles[2])
    await writeSafe(sourceRoot, 'package.json', bootstrapFiles[3])
    await writeSafe(sourceRoot, 'package-lock.json', bootstrapFiles[4])

    phase = 'RUNTIME_PREPARE'
    const image = process.env.NPR_NODE_IMAGE || 'node:22-bookworm'
    const pull = runCaptured(['docker', 'pull', image], {
      timeout: 10 * 60_000,
      env: childEnv(),
    })
    if (!pull.ok) throw new Error('NO_EGRESS_RUNTIME_PREPARE_FAILED')

    phase = 'PLAN_ISOLATED'
    const plannerRun = runCaptured(
      isolatedDockerArgs({
        image,
        mounts: [`${trustedRoot}:/trusted:ro`],
        workdir: '/trusted',
        argv: ['node', '/trusted/pr-validation-plan.mjs', ...resolved.changedPaths],
      }),
      { timeout: 2 * 60_000, env: childEnv() },
    )
    if (!plannerRun.ok) throw new Error('VALIDATION_PLAN_EXECUTION_FAILED')
    const plan = parseJson(plannerRun.stdout, 'VALIDATION_PLAN_INVALID')

    if (plan.generic_repository_validation === 'NOT_REQUIRED') {
      phase = 'ACCESS_REVOKE'
      await revokeInstallationToken(accessToken)
      accessToken = null
      delete process.env.NPR_APP_PRIVATE_KEY
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

    phase = 'DEPENDENCY_INSTALL'
    const install = runCaptured(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: sourceRoot,
      timeout: 15 * 60_000,
      env: childEnv({ NPM_CONFIG_CACHE: resolve(root, 'npm-cache') }),
    })
    if (!install.ok) throw new Error('DEPENDENCY_INSTALL_FAILED')

    phase = 'TREE_LIST'
    const listing = await listCompleteTree({ token: accessToken, sha: sourceSha })
    await writeFile(resolve(trustedRoot, 'tree-listing.json'), JSON.stringify(listing))

    phase = 'EXPORT_PLAN_ISOLATED'
    const exportRun = runCaptured(
      isolatedDockerArgs({
        image,
        mounts: [`${runnerRoot}:/runner:ro`, `${trustedRoot}:/trusted:ro`],
        workdir: '/runner',
        argv: [
          'node',
          '/runner/scripts/evaluate-export-plan.mjs',
          '/trusted/tree-listing.json',
          '/trusted/repository-verify.json',
          '/trusted/source-export-policy.mjs',
        ],
      }),
      { timeout: 2 * 60_000, env: childEnv() },
    )
    if (!exportRun.ok) throw new Error('EXPORT_CONTROL_EXECUTION_FAILED')
    const exportPlan = parseJson(exportRun.stdout, 'EXPORT_CONTROL_RESULT_INVALID')
    if (!exportPlan?.ok || !Array.isArray(exportPlan.include)) {
      throw new Error(exportPlan?.diagnostic || 'SOURCE_EXPORT_UNSAFE_ENTRY')
    }

    phase = 'EXPORT_FETCH'
    const entryByPath = new Map(listing.tree.map((entry) => [entry.path, entry]))
    for (const path of exportPlan.include) {
      const entry = entryByPath.get(path)
      if (!entry?.sha || entry.type !== 'blob') throw new Error('SOURCE_EXPORT_ENTRY_INVALID')
      const bytes = await fetchBlob({ token: accessToken, blobSha: entry.sha })
      await writeSafe(sourceRoot, path, bytes)
    }

    // The credential boundary is complete before any exported private source is
    // executed. The public validation containers receive neither token nor key.
    phase = 'ACCESS_REVOKE'
    await revokeInstallationToken(accessToken)
    accessToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    const hostUid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000'
    const hostGid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000'

    phase = 'PUBLIC_EXECUTION'
    for (const command of expectedPublic) {
      const stages = SAFE_COMMANDS.get(command)
      for (const stage of stages) {
        const isolated = runCaptured(
          isolatedDockerArgs({
            image,
            mounts: [`${sourceRoot}:/workspace`],
            workdir: '/workspace',
            argv: [...stage.argv],
          }).toSpliced(14, 0, '--user', `${hostUid}:${hostGid}`),
          { timeout: 20 * 60_000, env: childEnv() },
        )
        if (!isolated.ok) throw new Error(stage.diagnostic)
      }
    }

    phase = 'PASS_EMIT'
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
      if (accessToken) await revokeInstallationToken(accessToken)
    } catch {}
    const rawDiagnostic = stableDiagnostic(error)
    const diagnostic =
      rawDiagnostic === 'UNCLASSIFIED_FAILURE' ? `RUNNER_${phase}_FAILED` : rawDiagnostic
    const status = diagnostic === 'EXECUTION_PLANE_CREDENTIALS_UNAVAILABLE' ? 'HOLD' : 'FAIL'
    await emit(
      {
        schema_version: 1,
        task: 'repository-verify',
        status,
        ...(toolingSha ? { tooling_sha: toolingSha } : {}),
        ...(sourceSha ? { source_sha: sourceSha } : {}),
        diagnostic,
        phase,
      },
      status === 'HOLD' ? 3 : 1,
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

main()
