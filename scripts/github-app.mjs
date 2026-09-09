import { createSign } from 'node:crypto'

const API = 'https://api.github.com'
const REPOSITORY = 'clockcrockwork/note-projects'
const REPOSITORY_NAME = 'note-projects'

function b64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function createAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  if (!/^\d+$/.test(String(appId ?? ''))) throw new Error('APP_ID_INVALID')
  const key = String(privateKey ?? '').replaceAll('\\n', '\n').trim()
  if (!key.includes('BEGIN') || !key.includes('PRIVATE KEY')) throw new Error('APP_PRIVATE_KEY_INVALID')
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: String(appId) }))
  const unsigned = `${header}.${payload}`
  const sign = createSign('RSA-SHA256')
  sign.update(unsigned)
  sign.end()
  return `${unsigned}.${sign.sign(key).toString('base64url')}`
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent': 'note-projects-cli',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GITHUB_API_${response.status}:${method}:${path}`)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GITHUB_API_INVALID_JSON:${method}:${path}`)
  }
}

export async function mintInstallationToken({ appId, privateKey, installationId, permissions }) {
  if (!/^\d+$/.test(String(installationId ?? ''))) throw new Error('APP_INSTALLATION_ID_INVALID')
  const jwt = createAppJwt({ appId, privateKey })
  const result = await api(`/app/installations/${installationId}/access_tokens`, {
    token: jwt,
    method: 'POST',
    body: { repositories: [REPOSITORY_NAME], permissions },
  })
  if (!result?.token) throw new Error('APP_TOKEN_MISSING')
  return result.token
}

export async function revokeInstallationToken(token) {
  if (!token) return
  await api('/installation/token', { token, method: 'DELETE' })
}

export async function resolveSource({ token, source, pullRequest }) {
  const main = await api(`/repos/${REPOSITORY}/commits/main`, { token })
  const toolingSha = main?.sha
  if (!/^[0-9a-f]{40}$/.test(toolingSha ?? '')) throw new Error('TOOLING_SHA_INVALID')

  if (source === 'main') return { toolingSha, sourceSha: toolingSha, changedPaths: [] }
  if (source !== 'pull_request' || !Number.isSafeInteger(pullRequest)) throw new Error('SOURCE_REQUEST_INVALID')

  const pr = await api(`/repos/${REPOSITORY}/pulls/${pullRequest}`, { token })
  if (pr?.head?.repo?.full_name !== REPOSITORY) throw new Error('PR_HEAD_REPOSITORY_REJECTED')
  if (pr?.base?.repo?.full_name !== REPOSITORY) throw new Error('PR_BASE_REPOSITORY_REJECTED')
  if (pr?.state !== 'open') throw new Error('PR_STATE_UNSUPPORTED')
  const sourceSha = pr?.head?.sha
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('SOURCE_SHA_INVALID')

  const changedPaths = []
  for (let page = 1; ; page += 1) {
    const files = await api(`/repos/${REPOSITORY}/pulls/${pullRequest}/files?per_page=100&page=${page}`, { token })
    if (!Array.isArray(files)) throw new Error('PR_FILES_INVALID')
    for (const file of files) {
      if (typeof file?.filename !== 'string' || !file.filename) throw new Error('PR_FILE_PATH_INVALID')
      changedPaths.push(file.filename)
    }
    if (files.length < 100) break
    if (page >= 30) throw new Error('PR_FILES_PAGE_LIMIT')
  }
  return { toolingSha, sourceSha, changedPaths: [...new Set(changedPaths)].sort() }
}

export async function fetchTextFile({ token, sha, path }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('FETCH_SHA_INVALID')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const result = await api(`/repos/${REPOSITORY}/contents/${encoded}?ref=${sha}`, { token })
  if (result?.type !== 'file' || result?.encoding !== 'base64' || typeof result?.content !== 'string') {
    throw new Error(`FETCH_FILE_INVALID:${path}`)
  }
  return Buffer.from(result.content.replaceAll('\n', ''), 'base64')
}

export async function listCompleteTree({ token, sha }) {
  const commit = await api(`/repos/${REPOSITORY}/git/commits/${sha}`, { token })
  const rootTree = commit?.tree?.sha
  if (!/^[0-9a-f]{40}$/.test(rootTree ?? '')) throw new Error('ROOT_TREE_SHA_INVALID')

  const flattened = []
  const queue = [{ treeSha: rootTree, prefix: '' }]
  let visited = 0
  while (queue.length) {
    const current = queue.shift()
    visited += 1
    if (visited > 10000) throw new Error('TREE_WALK_LIMIT')
    const listing = await api(`/repos/${REPOSITORY}/git/trees/${current.treeSha}`, { token })
    if (listing?.truncated) throw new Error('SOURCE_EXPORT_TREE_TRUNCATED')
    if (!Array.isArray(listing?.tree)) throw new Error('SOURCE_EXPORT_TREE_INVALID')
    for (const entry of listing.tree) {
      const path = current.prefix ? `${current.prefix}/${entry.path}` : entry.path
      const normalized = { ...entry, path }
      flattened.push(normalized)
      if (entry.type === 'tree') queue.push({ treeSha: entry.sha, prefix: path })
    }
  }
  return { tree: flattened, truncated: false }
}

export async function fetchBlob({ token, blobSha }) {
  const result = await api(`/repos/${REPOSITORY}/git/blobs/${blobSha}`, { token })
  if (result?.encoding !== 'base64' || typeof result?.content !== 'string') throw new Error('BLOB_INVALID')
  return Buffer.from(result.content.replaceAll('\n', ''), 'base64')
}
