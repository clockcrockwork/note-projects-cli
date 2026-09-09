import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../scripts/run-repository-verify.mjs', import.meta.url), 'utf8')

test('public verify is decomposed into the canonical no-network stages', () => {
  for (const command of [
    "['npm', 'run', 'format:check']",
    "['npm', 'run', 'lint']",
    "['npm', 'run', 'typecheck']",
    "['npm', 'run', 'build']",
    "['npm', 'run', 'test:public']",
  ]) {
    assert.match(source, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('each public stage has a stable non-content diagnostic', () => {
  for (const diagnostic of [
    'PUBLIC_FORMAT_CHECK_FAILED',
    'PUBLIC_LINT_FAILED',
    'PUBLIC_TYPECHECK_FAILED',
    'PUBLIC_BUILD_FAILED',
    'PUBLIC_TEST_FAILED',
    'GAS_BUILD_FAILED',
  ]) {
    assert.match(source, new RegExp(diagnostic))
  }
  assert.doesNotMatch(source, /throw new Error\('PUBLIC_VERIFY_FAILED'\)/)
})
