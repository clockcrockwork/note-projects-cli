import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeEvent, parseIssueFormBody } from '../scripts/parse-request.mjs'

function body({ task='repository-verify', target='_No response_', source='pull_request', pr='245' } = {}) {
  return `### Task\n\n${task}\n\n### Target\n\n${target}\n\n### Source\n\n${source}\n\n### Pull Request\n\n${pr}`
}

test('accepts owner repository-verify request for numeric same-repo PR identity', () => {
  assert.deepEqual(authorizeEvent({ action: 'opened', issue: { author_association: 'OWNER', body: body() } }), {
    task: 'repository-verify', target: null, source: 'pull_request', pull_request: 245,
  })
})

test('rejects non-owner before any privileged work can start', () => {
  assert.throws(() => authorizeEvent({ action: 'opened', issue: { author_association: 'MEMBER', body: body() } }), /REQUEST_NOT_OWNER/)
})

test('rejects arbitrary task/shell-shaped input', () => {
  assert.throws(() => parseIssueFormBody(body({ task: 'npm run verify; curl attacker' })), /REQUEST_TASK_INVALID/)
})

test('repository-verify does not accept main or target', () => {
  assert.throws(() => parseIssueFormBody(body({ source: 'main', pr: '_No response_' })), /REQUIRES_PR/)
  assert.throws(() => parseIssueFormBody(body({ target: 'ART-010' })), /TARGET_NOT_ALLOWED/)
})

test('publication task requires controlled target grammar', () => {
  assert.deepEqual(parseIssueFormBody(body({ task: 'verify-publication', target: 'ART-010' })), {
    task: 'verify-publication', target: 'ART-010', source: 'pull_request', pull_request: 245,
  })
  assert.throws(() => parseIssueFormBody(body({ task: 'verify-publication', target: '../secret' })), /TARGET_INVALID/)
})

test('rejects duplicate and unexpected headings', () => {
  assert.throws(() => parseIssueFormBody(`${body()}\n\n### Task\n\nrepository-verify`), /FIELD_DUPLICATE/)
  assert.throws(() => parseIssueFormBody(`${body()}\n\n### Command\n\nrm -rf /`), /FIELD_UNEXPECTED/)
})
