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
      {
        argv: ['./node_modules/.bin/prettier', '--list-different'],
        diagnostic: 'PUBLIC_FORMAT_CHECK_FAILED',
        changedPathsOnly: true,
        captureFormatPaths: true,
      },
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

const MAX_LINE_DIFF_INPUT = 2000

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

function isolatedDockerArgs({ image, mounts, workdir, argv, user = null }) {
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
  ]
  if (user) args.push('--user', user)
  args.push('-e', 'CI=1', '-e', 'NO_COLOR=1', '-e', 'HOME=/tmp')
  for (const mount of mounts) args.push('-v', mount)
  args.push('-w', workdir, image, ...argv)
  return args
}

export function parseDifferentPaths(stdout) {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((value) => value.trim().replace(/^\.\//, ''))
        .filter(Boolean),
    ),
  ].sort()
}

export function safeFormatFailureDetails(stdout, changedPaths) {
  const differentPaths = parseDifferentPaths(stdout)
  const changedIndex = new Map(changedPaths.map((path, index) => [path, index]))
  const formatChangedPathIndices = []
  let formatUnrelatedCount = 0

  for (const path of differentPaths) {
    const index = changedIndex.get(path)
    if (index === undefined) formatUnrelatedCount += 1
    else formatChangedPathIndices.push(index)
  }

  return {
    format_changed_path_indices: [...new Set(formatChangedPathIndices)].sort((a, b) => a - b),
    format_unrelated_count: formatUnrelatedCount,
  }
}

function textLines(value) {
  return String(value).replaceAll('\r\n', '\n').split('\n')
}

export function safeLineChangeSpan(beforeText, afterText) {
  const before = textLines(beforeText)
  const after = textLines(afterText)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  if (prefix === before.length && prefix === after.length) return null

  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    start_line: prefix + 1,
    old_line_count: before.length - prefix - suffix,
    new_line_count: after.length - prefix - suffix,
  }
}

export function safeLineChangeSpans(beforeText, afterText) {
  const before = textLines(beforeText)
  const after = textLines(afterText)
  if (before.length > MAX_LINE_DIFF_INPUT || after.length > MAX_LINE_DIFF_INPUT) {
    const fallback = safeLineChangeSpan(beforeText, afterText)
    return fallback ? [fallback] : []
  }

  const width = after.length + 1
  const table = new Uint16Array((before.length + 1) * width)
  const at = (i, j) => i * width + j

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        before[i] === after[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)])
    }
  }

  const spans = []
  let i = 0
  let j = 0
  let hunkStartBefore = null
  let hunkStartAfter = null

  const closeHunk = () => {
    if (hunkStartBefore === null || hunkStartAfter === null) return
    spans.push({
      start_line: hunkStartBefore + 1,
      old_line_count: i - hunkStartBefore,
      new_line_count: j - hunkStartAfter,
    })
    hunkStartBefore = null
    hunkStartAfter = null
  }

  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      closeHunk()
      i += 1
      j += 1
      continue
    }

    if (hunkStartBefore === null) {
      hunkStartBefore = i
      hunkStartAfter = j
    }

    if (i >= before.length) {
      j += 1
    } else if (j >= after.length) {
      i += 1
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      i += 1
    } else {
      j += 1
    }
  }
  closeHunk()
  return spans
}

export function safeFormatChangedSpans(entries, changedPaths) {
  const changedIndex = new Map(changedPaths.map((path, index) => [path, index]))
  const spans = []
  for (const entry of entries) {
    const index = changedIndex.get(entry.path)
    if (index === undefined) continue
    for (const span of safeLineChangeSpans(entry.before, entry.after)) {
      spans.push({ changed_path_index: index, ...span })
    }
  }
  return spans.sort(
    (a, b) => a.changed_path_index - b.changed_path_index || a.start_line - b.start_line,
  )
}

export function changedExportedPaths(changedPaths, exportedPaths) {
  const exported = new Set(exportedPaths)
  return changedPaths.filter((path) => exported.has(path))
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

async function readSafeText(root, path) {
  return readFile(safeResolvedPath(root, path), 'utf8')
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
  let safeFailureDetails = {}
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

    phase = 'ACCESS_REVOKE'
    await revokeInstallationToken(accessToken)
    accessToken = null
    delete process.env.NPR_APP_PRIVATE_KEY

    const hostUid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000'
    const hostGid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000'
    const formatPaths = changedExportedPaths(resolved.changedPaths, exportPlan.include)

    phase = 'PUBLIC_EXECUTION'
    for (const command of expectedPublic) {
      const stages = SAFE_COMMANDS.get(command)
      for (const stage of stages) {
        if (stage.changedPathsOnly && formatPaths.length === 0) continue
        const argv = stage.changedPathsOnly ? [...stage.argv, ...formatPaths] : stage.argv
        const isolated = runCaptured(
          isolatedDockerArgs({
            image,
            mounts: [`${sourceRoot}:/workspace`],
            workdir: '/workspace',
            argv,
            user: `${hostUid}:${hostGid}`,
          }),
          { timeout: 20 * 60_000, env: childEnv() },
        )
        if (!isolated.ok) {
          if (stage.captureFormatPaths) {
            const differentPaths = parseDifferentPaths(isolated.stdout)
            safeFailureDetails = safeFormatFailureDetails(isolated.stdout, resolved.changedPaths)
            const formatPathSet = new Set(formatPaths)
            const differentChangedPaths = differentPaths.filter((path) => formatPathSet.has(path))
            if (differentChangedPaths.length) {
              const beforeEntries = await Promise.all(
                differentChangedPaths.map(async (path) => ({
                  path,
                  before: await readSafeText(sourceRoot, path),
                })),
              )
              const formatWrite = runCaptured(
                isolatedDockerArgs({
                  image,
                  mounts: [`${sourceRoot}:/workspace`],
                  workdir: '/workspace',
                  argv: ['./node_modules/.bin/prettier', '--write', ...differentChangedPaths],
                  user: `${hostUid}:${hostGid}`,
                }),
                { timeout: 2 * 60_000, env: childEnv() },
              )
              if (formatWrite.ok) {
                const formattedEntries = await Promise.all(
                  beforeEntries.map(async (entry) => ({
                    ...entry,
                    after: await readSafeText(sourceRoot, entry.path),
                  })),
                )
                safeFailureDetails = {
                  ...safeFailureDetails,
                  format_changed_spans: safeFormatChangedSpans(
                    formattedEntries,
                    resolved.changedPaths,
                  ),
                }
              }
            }
          }
          throw new Error(stage.diagnostic)
        }
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
        ...safeFailureDetails,
      },
      status === 'HOLD' ? 3 : 1,
    )
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
