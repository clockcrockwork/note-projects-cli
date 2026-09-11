import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isExportableThreadsAffiliatePath,
  isSafeRepositoryPath,
  planThreadsAffiliateExport,
} from '../scripts/run-threads-affiliates-verify.mjs'

const SHA = 'a'.repeat(40)

function blob(path, overrides = {}) {
  return { path, type: 'blob', mode: '100644', sha: SHA, ...overrides }
}

test('exports only package/runtime/test/build inputs and excludes docs/workflows', () => {
  const plan = planThreadsAffiliateExport({
    truncated: false,
    tree: [
      { path: 'gas', type: 'tree', mode: '040000', sha: SHA },
      blob('package.json'),
      blob('package-lock.json'),
      blob('gas/domain/reply-templates.mjs'),
      blob('gas/apps-script/appsscript.json'),
      blob('tests/reply-templates.spec.mjs'),
      blob('tools/build-gas-bundle.mjs'),
      blob('docs/product-and-policy.md'),
      blob('.github/workflows/verify.yml'),
      blob('README.md'),
    ],
  })

  assert.deepEqual(
    plan.map((entry) => entry.path),
    [
      'gas/apps-script/appsscript.json',
      'gas/domain/reply-templates.mjs',
      'package-lock.json',
      'package.json',
      'tests/reply-templates.spec.mjs',
      'tools/build-gas-bundle.mjs',
    ],
  )
})

test('rejects symlinks, gitlinks, unsafe paths and truncated listings', () => {
  const base = [blob('package.json'), blob('package-lock.json')]
  assert.throws(
    () =>
      planThreadsAffiliateExport({
        truncated: false,
        tree: [...base, blob('gas/link.mjs', { mode: '120000' })],
      }),
    /SYMLINK_REJECTED/,
  )
  assert.throws(
    () =>
      planThreadsAffiliateExport({
        truncated: false,
        tree: [...base, { path: 'vendor', type: 'commit', mode: '160000', sha: SHA }],
      }),
    /GITLINK_REJECTED/,
  )
  assert.throws(
    () => planThreadsAffiliateExport({ truncated: false, tree: [...base, blob('../secret.mjs')] }),
    /PATH_UNSAFE/,
  )
  assert.throws(
    () => planThreadsAffiliateExport({ truncated: true, tree: base }),
    /TREE_INVALID/,
  )
})

test('path helpers stay narrow and deterministic', () => {
  assert.equal(isSafeRepositoryPath('gas/domain/x.mjs'), true)
  assert.equal(isSafeRepositoryPath('../x.mjs'), false)
  assert.equal(isSafeRepositoryPath('gas\\x.mjs'), false)
  assert.equal(isExportableThreadsAffiliatePath('gas/domain/x.mjs'), true)
  assert.equal(isExportableThreadsAffiliatePath('tests/fixture.json'), true)
  assert.equal(isExportableThreadsAffiliatePath('docs/private.md'), false)
  assert.equal(isExportableThreadsAffiliatePath('.github/workflows/verify.yml'), false)
})
