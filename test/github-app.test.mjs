import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { createAppJwt } from '../scripts/github-app.mjs'

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
