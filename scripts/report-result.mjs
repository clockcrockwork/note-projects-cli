import { pathToFileURL } from 'node:url'

const REPOSITORY = 'clockcrockwork/note-projects-cli'
const STATUSES = new Set(['PASS', 'FAIL', 'HOLD', 'NOT_REQUIRED'])
const SHA_RE = /^[0-9a-f]{40}$/
const DIAGNOSTIC_RE = /^[A-Z0-9_]+$/

function code(value) {
  return `\`${String(value).replaceAll('`', '')}\``
}

export function parseSafeResult(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: 'FAIL', diagnostic: 'RESULT_JSON_INVALID' }
  }

  if (value?.task !== 'repository-verify' || !STATUSES.has(value?.status)) {
    return { status: 'FAIL', diagnostic: 'RESULT_JSON_INVALID' }
  }

  const safe = {
    task: 'repository-verify',
    status: value.status,
  }

  if (SHA_RE.test(value.source_sha ?? '')) safe.source_sha = value.source_sha
  if (SHA_RE.test(value.tooling_sha ?? '')) safe.tooling_sha = value.tooling_sha
  if (DIAGNOSTIC_RE.test(value.diagnostic ?? '')) safe.diagnostic = value.diagnostic
  if (Number.isSafeInteger(value.changed_path_count) && value.changed_path_count >= 0) {
    safe.changed_path_count = value.changed_path_count
  }
  if (Number.isSafeInteger(value.exported_file_count) && value.exported_file_count >= 0) {
    safe.exported_file_count = value.exported_file_count
  }
  if (Array.isArray(value.format_changed_path_indices)) {
    const max = safe.changed_path_count ?? Number.MAX_SAFE_INTEGER
    const indices = value.format_changed_path_indices
      .filter((item) => Number.isSafeInteger(item) && item >= 0 && item < max)
      .sort((a, b) => a - b)
    safe.format_changed_path_indices = [...new Set(indices)]
  }
  if (Number.isSafeInteger(value.format_unrelated_count) && value.format_unrelated_count >= 0) {
    safe.format_unrelated_count = value.format_unrelated_count
  }
  if (Array.isArray(value.public_commands)) {
    safe.public_commands = value.public_commands.filter((item) =>
      item === 'npm run verify:public' || item === 'npm run gas:build')
  }
  if (typeof value.qualified_render_required === 'boolean') {
    safe.qualified_render_required = value.qualified_render_required
  }
  return safe
}

export function formatResultComment(raw, runUrl) {
  const result = parseSafeResult(raw)
  const lines = [
    '<!-- note-projects-cli:remote-run-result -->',
    '### Remote machine result',
    '',
    `- status: ${code(result.status)}`,
  ]
  if (result.source_sha) lines.push(`- SOURCE_SHA: ${code(result.source_sha)}`)
  if (result.tooling_sha) lines.push(`- TOOLING_SHA: ${code(result.tooling_sha)}`)
  if (result.diagnostic) lines.push(`- diagnostic: ${code(result.diagnostic)}`)
  if (result.changed_path_count !== undefined) lines.push(`- changed paths: ${result.changed_path_count}`)
  if (result.exported_file_count !== undefined) lines.push(`- exported files: ${result.exported_file_count}`)
  if (result.format_changed_path_indices !== undefined) {
    lines.push(
      `- format changed-path indices: ${result.format_changed_path_indices.length ? result.format_changed_path_indices.join(', ') : 'none'}`,
    )
  }
  if (result.format_unrelated_count !== undefined) {
    lines.push(`- unrelated format differences: ${result.format_unrelated_count}`)
  }
  if (result.public_commands?.length) {
    lines.push(`- public commands: ${result.public_commands.map(code).join(', ')}`)
  }
  if (result.qualified_render_required !== undefined) {
    lines.push(`- qualified render required: ${result.qualified_render_required ? 'yes' : 'no'}`)
  }
  if (/^https:\/\/github\.com\/clockcrockwork\/note-projects-cli\/actions\/runs\/\d+$/.test(runUrl ?? '')) {
    lines.push(`- run: ${runUrl}`)
  }
  lines.push('', 'No raw private command output is included in this comment.')
  return lines.join('\n')
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  const issueNumber = process.env.ISSUE_NUMBER
  const resultJson = process.env.RESULT_JSON
  if (!token || repository !== REPOSITORY || !/^\d+$/.test(issueNumber ?? '') || !resultJson) {
    throw new Error('REPORT_INPUT_INVALID')
  }

  const body = formatResultComment(resultJson, process.env.RUN_URL)
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'note-projects-cli',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  })
  if (!response.ok) throw new Error(`REPORT_GITHUB_API_${response.status}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'REPORT_FAILED'}\n`)
    process.exitCode = 1
  })
}
