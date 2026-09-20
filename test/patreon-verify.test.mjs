import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExportablePatreonPath,
  isSafePatreonRepositoryPath,
  planPatreonExport,
} from '../scripts/run-patreon-verify.mjs'

const SHA = 'a'.repeat(40)

function blob(path, overrides = {}) {
  return { path, type: 'blob', mode: '100644', sha: SHA, ...overrides }
}

test('exports only Patreon verification inputs and excludes workflows/media/output', () => {
  const plan = planPatreonExport({
    truncated: false,
    tree: [
      blob('package.json'),
      blob('package-lock.json'),
      blob('AGENTS.md'),
      blob('content/publications/welcome.md'),
      blob('content/quips/launch-quips.md'),
      blob('docs/bilingual-authoring-review.md'),
      blob('tools/workflow/stock-activation-policy.test.mjs'),
      blob('tools/publication-console/build.mjs'),
      blob('tools/public-view/build.test.mjs'),
      blob('.github/workflows/verify.yml'),
      blob('covers/media/public-ready/example.png'),
      blob('public-view/out/publication-console.html'),
      blob('README.md'),
    ],
  })

  assert.deepEqual(
    plan.map((entry) => entry.path),
    [
      'AGENTS.md',
      'content/publications/welcome.md',
      'content/quips/launch-quips.md',
      'docs/bilingual-authoring-review.md',
      'package-lock.json',
      'package.json',
      'tools/public-view/build.test.mjs',
      'tools/publication-console/build.mjs',
      'tools/workflow/stock-activation-policy.test.mjs',
    ],
  )
})

test('rejects symlinks, gitlinks, unsafe paths and truncated listings', () => {
  const base = [blob('package.json'), blob('package-lock.json')]
  assert.throws(
    () => planPatreonExport({ truncated: false, tree: [...base, blob('content/link.md', { mode: '120000' })] }),
    /SYMLINK_REJECTED/,
  )
  assert.throws(
    () => planPatreonExport({ truncated: false, tree: [...base, { path: 'vendor', type: 'commit', mode: '160000', sha: SHA }] }),
    /GITLINK_REJECTED/,
  )
  assert.throws(
    () => planPatreonExport({ truncated: false, tree: [...base, blob('../secret.md')] }),
    /PATH_UNSAFE/,
  )
  assert.throws(
    () => planPatreonExport({ truncated: true, tree: base }),
    /TREE_INVALID/,
  )
})

test('Patreon export helpers remain narrow', () => {
  assert.equal(isSafePatreonRepositoryPath('content/publications/x.md'), true)
  assert.equal(isSafePatreonRepositoryPath('../x.md'), false)
  assert.equal(isSafePatreonRepositoryPath('content\\x.md'), false)
  assert.equal(isExportablePatreonPath('content/publications/x.md'), true)
  assert.equal(isExportablePatreonPath('docs/workflow.md'), true)
  assert.equal(isExportablePatreonPath('tools/workflow/x.test.mjs'), true)
  assert.equal(isExportablePatreonPath('covers/request.yaml'), false)
  assert.equal(isExportablePatreonPath('.github/workflows/x.yml'), false)
  assert.equal(isExportablePatreonPath('public-view/out/x.html'), false)
})
