import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { api, createAppJwt, isRetryableGitHubGetStatus } from '../scripts/github-app.mjs'

function response(status, value = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value)
    },
  }
}

test('creates an RS256 GitHub App JWT with bounded lifetime', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const token = createAppJwt({ appId: '12345', privateKey: pem, now: 1000 })
  const [header, payload, signature] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: 970, exp: 1480, iss: '12345' })
  const verify = createVerify('RSA-SHA256')
  verify.update(`${header}.${payload}`)
  verify.end()
  assert.equal(verify.verify(publicKey, Buffer.from(signature, 'base64url')), true)
})

test('rejects malformed app identity material', () => {
  assert.throws(() => createAppJwt({ appId: 'x', privateKey: 'nope' }), /APP_ID_INVALID/)
  assert.throws(() => createAppJwt({ appId: '1', privateKey: 'nope' }), /APP_PRIVATE_KEY_INVALID/)
})

test('classifies only rate-limit and server statuses as retryable GET failures', () => {
  assert.equal(isRetryableGitHubGetStatus(429), true)
  assert.equal(isRetryableGitHubGetStatus(500), true)
  assert.equal(isRetryableGitHubGetStatus(503), true)
  assert.equal(isRetryableGitHubGetStatus(404), false)
  assert.equal(isRetryableGitHubGetStatus(403), false)
})

test('GET retries a transient server failure and succeeds without exposing response content', async () => {
  let calls = 0
  const delays = []
  const result = await api('/test', {
    fetchImpl: async () => {
      calls += 1
      return calls === 1 ? response(503, { private: 'ignored' }) : response(200, { ok: true })
    },
    sleepFn: async (ms) => delays.push(ms),
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [250])
})

test('GET retries a transient network failure and succeeds', async () => {
  let calls = 0
  const delays = []
  const result = await api('/test', {
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new Error('socket reset')
      return response(200, { ok: true })
    },
    sleepFn: async (ms) => delays.push(ms),
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [250])
})

test('GET does not retry contract failures such as 404', async () => {
  let calls = 0
  await assert.rejects(
    api('/missing', {
      fetchImpl: async () => {
        calls += 1
        return response(404, { message: 'not found' })
      },
      sleepFn: async () => assert.fail('404 must not sleep or retry'),
    }),
    /GITHUB_API_404:GET:\/missing/,
  )
  assert.equal(calls, 1)
})

test('mutating requests never retry even on server failure', async () => {
  let calls = 0
  await assert.rejects(
    api('/mutation', {
      method: 'POST',
      body: { value: true },
      fetchImpl: async () => {
        calls += 1
        return response(503, { message: 'temporary' })
      },
      sleepFn: async () => assert.fail('POST must not sleep or retry'),
    }),
    /GITHUB_API_503:POST:\/mutation/,
  )
  assert.equal(calls, 1)
})
