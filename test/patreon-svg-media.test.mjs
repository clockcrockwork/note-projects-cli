import assert from 'node:assert/strict'
import test from 'node:test'
import { sourcePaths } from '../scripts/run-ccw-publication-console.mjs'
import { isExportablePatreonPath, planPatreonExport, requiresMachineVerification } from '../scripts/run-patreon-verify.mjs'

const root = 'media/patreon/ai-image-to-svg/'
const approved = [
  'source-bg-02-crossing.png', 'comparison.png', 'comparison-whale-detail-v2-v3.png',
  'comparison-bg-02-crossing.png', 'bg-02-crossing.png', 'bg-02-crossing-teal.png',
  'comparison-bg-01-trench.png',
].map((name) => root + name)
const rejected = [
  `${root}other.png`, `${root}comparison.jpg`, `${root}comparison.svg`,
  `${root}comparison.png.js`, `${root}comparison.PNG`, `${root}nested/comparison.png`,
  `${root}../comparison.png`, `${root}./comparison.png`, `${root}/comparison.png`,
  `${root}%2e%2e/comparison.png`, `${root}%63omparison.png`,
  `${root}comparison.png?download=1`, `${root}comparison.png#fragment`,
  `${root}comparison.png\0`, `${root}comparison.png/extra`,
  'media/patreon/ai-image-to-svg-other/comparison.png',
  'media/patreon/other/comparison.png', '/'+approved[0],
  'C:/'+approved[0], approved[0].replaceAll('/', '\\'),
]
const blob = (path) => ({ path, type: 'blob', mode: '100644', sha: 'a'.repeat(40) })
const required = [
  'tools/publication-console/build.mjs', 'tools/publication-console/payload-boundary.mjs',
  'tools/workflow/creator-review-gate.mjs', 'tools/workflow/note-creator-review-gate.mjs',
  'content/publications/example.md', 'content/note-jp/example.md',
]

test('Console and CI export exactly the seven approved PNGs and verify asset-only changes', () => {
  assert.deepEqual(sourcePaths({ tree: [...required, ...approved, ...rejected].map(blob) })
    .filter((path) => !required.includes(path)), [...approved].sort())
  const plan = planPatreonExport({ truncated: false, tree: ['package.json', 'package-lock.json', ...approved].map(blob) })
  assert.deepEqual(plan.filter(({ path }) => path.startsWith('media/')).map(({ path }) => path).sort(), [...approved].sort())
  for (const path of approved) {
    assert.equal(isExportablePatreonPath(path), true, path)
    assert.equal(requiresMachineVerification([path]), true, path)
  }
  for (const path of rejected) {
    assert.equal(isExportablePatreonPath(path), false, path)
    assert.equal(requiresMachineVerification([path]), false, path)
  }
})

test('CI rejects unsafe and non-regular approved media entries', () => {
  const base = ['package.json', 'package-lock.json'].map(blob)
  for (const path of [`${root}../comparison.png`, `${root}./comparison.png`, approved[0].replaceAll('/', '\\')]) {
    assert.throws(() => planPatreonExport({ truncated: false, tree: [...base, blob(path)] }), /PATH_UNSAFE/)
  }
  for (const [mode, diagnostic] of [['120000', /SYMLINK_REJECTED/], ['160000', /GITLINK_REJECTED/]]) {
    assert.throws(() => planPatreonExport({ truncated: false, tree: [...base, { ...blob(approved[0]), mode }] }), diagnostic)
  }
})
