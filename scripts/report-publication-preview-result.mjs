import { pathToFileURL } from 'node:url'

const REPOSITORY = 'clockcrockwork/note-projects-cli'
const STATUSES = new Set(['PASS', 'FAIL', 'HOLD'])
const SHA_RE = /^[0-9a-f]{40}$/
const TARGET_RE = /^(?:ART-\d+|FDR-[A-Z0-9-]+)$/
const DIAGNOSTIC_RE = /^[A-Z0-9_]+$/

function code(value) {
  return `\`${String(value).replaceAll('`', '')}\``
}

export function parseSafePreviewResult(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { task: 'publication-preview', status: 'FAIL', diagnostic: 'RESULT_JSON_INVALID' }
  }
  if (value?.task !== 'publication-preview' || !STATUSES.has(value?.status)) {
    return { task: 'publication-preview', status: 'FAIL', diagnostic: 'RESULT_JSON_INVALID' }
  }
  const safe = { task: 'publication-preview', status: value.status }
  if (SHA_RE.test(value.source_sha ?? '')) safe.source_sha = value.source_sha
  if (SHA_RE.test(value.tooling_sha ?? '')) safe.tooling_sha = value.tooling_sha
  if (TARGET_RE.test(value.target ?? '')) safe.target = value.target
  if (DIAGNOSTIC_RE.test(value.diagnostic ?? '')) safe.diagnostic = value.diagnostic
  if (Number.isSafeInteger(value.preview_count) && value.preview_count >= 0 && value.preview_count <= 2) {
    safe.preview_count = value.preview_count
  }
  return safe
}

export function formatPreviewResultComment(raw, runUrl) {
  const result = parseSafePreviewResult(raw)
  const lines = [
    '<!-- note-projects-cli:publication-preview-result -->',
    '### Publication Preview machine result',
    '',
    `- status: ${code(result.status)}`,
  ]
  if (result.target) lines.push(`- target: ${code(result.target)}`)
  if (result.source_sha) lines.push(`- SOURCE_SHA: ${code(result.source_sha)}`)
  if (result.tooling_sha) lines.push(`- TOOLING_SHA: ${code(result.tooling_sha)}`)
  if (result.preview_count !== undefined) lines.push(`- protected previews: ${result.preview_count}`)
  if (result.diagnostic) lines.push(`- diagnostic: ${code(result.diagnostic)}`)
  if (/^https:\/\/github\.com\/clockcrockwork\/note-projects-cli\/actions\/runs\/\d+$/.test(runUrl ?? '')) {
    lines.push(`- run: ${runUrl}`)
  }
  lines.push(
    '',
    'Protected preview URLs and unpublished payload are intentionally not included in this public issue.',
  )
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

  const body = formatPreviewResultComment(resultJson, process.env.RUN_URL)
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
