import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflow = await readFile(new URL('../.github/workflows/remote-run.yml', import.meta.url), 'utf8')

test('verify-publication has a dedicated activated job and safe evidence upload', () => {
  assert.match(workflow, /\n  verify_publication:\n/)
  assert.match(workflow, /task == 'verify-publication'/)
  assert.match(workflow, /run: node scripts\/run-verify-publication\.mjs/)
  assert.match(workflow, /Upload sanitized live-verification evidence/)
  assert.match(workflow, /verify-publication-safe-\$\{\{ github\.event\.issue\.number \}\}/)
  assert.match(workflow, /\n  report_verify_publication:\n/)
})

test('verify-publication no longer falls into the unactivated task job', () => {
  const unactivated = workflow.slice(workflow.indexOf('\n  unactivated_typed_task:'))
  assert.match(unactivated, /task != 'verify-publication'/)
})
