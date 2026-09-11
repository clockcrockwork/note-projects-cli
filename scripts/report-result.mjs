import { pathToFileURL } from 'node:url'

const REPOSITORY = 'clockcrockwork/note-projects-cli'
const TASKS = new Set(['repository-verify', 'threads-affiliates-verify', 'verify-publication'])
const STATUSES = new Set(['PASS', 'FAIL', 'HOLD', 'NOT_REQUIRED'])
const LIVE_RESULTS = new Set(['PASS', 'HOLD', 'RETRYABLE_FAIL'])
const VIEWPORT_RESULTS = new Set(['PASS', 'HOLD', 'RETRYABLE_FAIL', 'REACHABLE'])
const ARTICLE_ID_RE = /^(?:ART-\d+|FDR-[A-Z0-9-]+)$/
const SHA_RE = /^[0-9a-f]{40}$/
const DIAGNOSTIC_RE = /^[A-Z0-9_]+$/
const MAX_SAFE_LINE_NUMBER = 1_000_000
const MAX_FORMAT_SPANS = 20
const PUBLIC_COMMANDS = new Set([
  'npm run verify:public',
  'npm run gas:build',
  'npm test',
  'npm run build:gas',
])

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

  if (!TASKS.has(value?.task) || !STATUSES.has(value?.status)) {
    return { status: 'FAIL', diagnostic: 'RESULT_JSON_INVALID' }
  }

  const safe = {
    task: value.task,
    status: value.status,
  }

  if (SHA_RE.test(value.source_sha ?? '')) safe.source_sha = value.source_sha
  if (SHA_RE.test(value.tooling_sha ?? '')) safe.tooling_sha = value.tooling_sha
  if (DIAGNOSTIC_RE.test(value.diagnostic ?? '')) safe.diagnostic = value.diagnostic
  if (ARTICLE_ID_RE.test(value.article_id ?? '')) safe.article_id = value.article_id
  if (LIVE_RESULTS.has(value.live_result)) safe.live_result = value.live_result
  if (value.viewport_results && typeof value.viewport_results === 'object') {
    const viewportResults = {}
    for (const name of ['desktop', 'mobile']) {
      const result = value.viewport_results[name]
      if (VIEWPORT_RESULTS.has(result)) viewportResults[name] = result
    }
    if (Object.keys(viewportResults).length) safe.viewport_results = viewportResults
  }
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
  if (Array.isArray(value.format_changed_spans)) {
    const max = safe.changed_path_count ?? Number.MAX_SAFE_INTEGER
    safe.format_changed_spans = value.format_changed_spans
      .filter(
        (item) =>
          item &&
          Number.isSafeInteger(item.changed_path_index) &&
          item.changed_path_index >= 0 &&
          item.changed_path_index < max &&
          Number.isSafeInteger(item.start_line) &&
          item.start_line >= 1 &&
          item.start_line <= MAX_SAFE_LINE_NUMBER &&
          Number.isSafeInteger(item.old_line_count) &&
          item.old_line_count >= 0 &&
          item.old_line_count <= MAX_SAFE_LINE_NUMBER &&
          Number.isSafeInteger(item.new_line_count) &&
          item.new_line_count >= 0 &&
          item.new_line_count <= MAX_SAFE_LINE_NUMBER,
      )
      .map((item) => ({
        changed_path_index: item.changed_path_index,
        start_line: item.start_line,
        old_line_count: item.old_line_count,
        new_line_count: item.new_line_count,
      }))
      .sort((a, b) => a.changed_path_index - b.changed_path_index || a.start_line - b.start_line)
      .slice(0, MAX_FORMAT_SPANS)
  }
  if (Number.isSafeInteger(value.format_unrelated_count) && value.format_unrelated_count >= 0) {
    safe.format_unrelated_count = value.format_unrelated_count
  }
  if (Array.isArray(value.public_commands)) {
    safe.public_commands = value.public_commands.filter((item) => PUBLIC_COMMANDS.has(item))
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
    `- task: ${code(result.task ?? 'unknown')}`,
    `- status: ${code(result.status)}`,
  ]
  if (result.source_sha) lines.push(`- SOURCE_SHA: ${code(result.source_sha)}`)
  if (result.tooling_sha) lines.push(`- TOOLING_SHA: ${code(result.tooling_sha)}`)
  if (result.article_id) lines.push(`- article: ${code(result.article_id)}`)
  if (result.live_result) lines.push(`- live result: ${code(result.live_result)}`)
  if (result.viewport_results) {
    const summary = Object.entries(result.viewport_results)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ')
    lines.push(`- viewports: ${code(summary)}`)
  }
  if (result.diagnostic) lines.push(`- diagnostic: ${code(result.diagnostic)}`)
  if (result.changed_path_count !== undefined) lines.push(`- changed paths: ${result.changed_path_count}`)
  if (result.exported_file_count !== undefined) lines.push(`- exported files: ${result.exported_file_count}`)
  if (result.format_changed_path_indices !== undefined) {
    lines.push(
      `- format changed-path indices: ${result.format_changed_path_indices.length ? result.format_changed_path_indices.join(', ') : 'none'}`,
    )
  }
  if (result.format_changed_spans?.length) {
    lines.push(
      `- format change spans: ${result.format_changed_spans
        .map(
          (span) =>
            `#${span.changed_path_index}@L${span.start_line} ${span.old_line_count}->${span.new_line_count}`,
        )
        .join('; ')}`,
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
