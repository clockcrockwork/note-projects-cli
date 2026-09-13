import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const TASKS = new Set([
  'repository-verify',
  'threads-affiliates-verify',
  'verify-publication',
  'publication-prepare',
  'publication-preview',
])
export const SOURCES = new Set(['main', 'pull_request'])
const TARGET_ID = /^(?:ART-\d+|FDR-[A-Z0-9-]+)$/
const PR_ONLY_TASKS = new Set(['repository-verify', 'threads-affiliates-verify'])

function normalized(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseIssueFormBody(body) {
  const text = normalized(body)
  if (!text) throw new Error('REQUEST_BODY_EMPTY')

  const fields = new Map()
  const heading = /^###\s+(.+)$/gm
  const matches = [...text.matchAll(heading)]
  for (let i = 0; i < matches.length; i += 1) {
    const name = normalized(matches[i][1])
    if (fields.has(name)) throw new Error(`REQUEST_FIELD_DUPLICATE:${name}`)
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    fields.set(name, normalized(text.slice(start, end)))
  }

  const expected = ['Task', 'Target', 'Source', 'Pull Request']
  for (const name of expected) {
    if (!fields.has(name)) throw new Error(`REQUEST_FIELD_MISSING:${name}`)
  }
  for (const name of fields.keys()) {
    if (!expected.includes(name)) throw new Error(`REQUEST_FIELD_UNEXPECTED:${name}`)
  }

  const task = fields.get('Task')
  const targetRaw = fields.get('Target')
  const source = fields.get('Source')
  const prRaw = fields.get('Pull Request')

  if (!TASKS.has(task)) throw new Error('REQUEST_TASK_INVALID')
  if (!SOURCES.has(source)) throw new Error('REQUEST_SOURCE_INVALID')

  const target = targetRaw === '_No response_' || targetRaw === 'NONE' ? null : targetRaw
  if (PR_ONLY_TASKS.has(task)) {
    if (target !== null) throw new Error('REQUEST_TARGET_NOT_ALLOWED')
    if (source !== 'pull_request') throw new Error('REQUEST_REPOSITORY_VERIFY_REQUIRES_PR')
  } else if (!target || !TARGET_ID.test(target)) {
    throw new Error('REQUEST_TARGET_INVALID')
  }

  let pullRequest = null
  if (source === 'pull_request') {
    if (!/^\d+$/.test(prRaw)) throw new Error('REQUEST_PR_INVALID')
    pullRequest = Number(prRaw)
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) throw new Error('REQUEST_PR_INVALID')
  } else if (prRaw && prRaw !== '_No response_' && prRaw !== 'NONE') {
    throw new Error('REQUEST_PR_NOT_ALLOWED')
  }

  return { task, target, source, pull_request: pullRequest }
}

export function authorizeEvent(event) {
  if (!event || event.action === undefined || !event.issue) throw new Error('REQUEST_EVENT_INVALID')
  if (event.issue.author_association !== 'OWNER') throw new Error('REQUEST_NOT_OWNER')
  return parseIssueFormBody(event.issue.body)
}

async function main() {
  const eventPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH_REQUIRED')
  const event = JSON.parse(await readFile(eventPath, 'utf8'))
  const request = authorizeEvent(event)
  process.stdout.write(`${JSON.stringify(request)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}
