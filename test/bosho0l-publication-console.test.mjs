import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  PROJECT_NAME,
  STABLE_CONSOLE_URL,
  classifyConsoleBuildFailure,
  safePublicResult,
  sourcePaths,
} from '../scripts/run-bosho0l-publication-console.mjs'

test('stable bosho0l carrier exports only publication delivery inputs', () => {
  const listing = {
    tree: [
      { type: 'blob', path: 'tools/build-bosho0l-publication-console.mjs' },
      { type: 'blob', path: 'src/publication-bundle/source-loader.mjs' },
      { type: 'blob', path: 'src/publish-console/publication-gate.mjs' },
      { type: 'blob', path: 'src/publish-console/parts/CopyPanel.astro' },
      { type: 'blob', path: 'articles/ai-policy/ART-026/publication/publication.yaml' },
      { type: 'blob', path: 'articles/ai-policy/ART-026/publication/body.note.md' },
      { type: 'blob', path: 'articles/ai-policy/ART-026/draft.md' },
      { type: 'blob', path: 'docs/themes/ai-policy/feeder/FDR-AI-019.contract.yaml' },
      { type: 'blob', path: 'docs/themes/ai-policy/feeder/FDR-AI-019.fdr-04-write-review.md' },
      { type: 'blob', path: '.github/workflows/private.yml' },
    ],
  }

  assert.deepEqual(sourcePaths(listing), [
    'articles/ai-policy/ART-026/publication/body.note.md',
    'articles/ai-policy/ART-026/publication/publication.yaml',
    'docs/themes/ai-policy/feeder/FDR-AI-019.contract.yaml',
    'src/publication-bundle/source-loader.mjs',
    'src/publish-console/publication-gate.mjs',
    'tools/build-bosho0l-publication-console.mjs',
  ])
})

test('stable bosho0l carrier uses a project separate from the CCW production alias', () => {
  assert.equal(PROJECT_NAME, 'note-projects-bosho0l-publication-console')
  assert.equal(STABLE_CONSOLE_URL, 'https://note-projects-bosho0l-publication-console.vercel.app')
  assert.notEqual(STABLE_CONSOLE_URL, 'https://note-projects-publication-preview.vercel.app')
})

test('public result never exposes protected URL or private inventory detail', () => {
  assert.deepEqual(
    safePublicResult({
      status: 'PASS',
      source_sha: 'a'.repeat(40),
      inventory_count: 3,
      url: STABLE_CONSOLE_URL,
      inventory: ['ART-001'],
    }),
    {
      schema_version: 1,
      task: 'bosho0l-publication-console',
      status: 'PASS',
      source_sha: 'a'.repeat(40),
      inventory_count: 3,
    },
  )
})

test('workflow refreshes on a bounded cadence and request-file merge', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/bosho0l-publication-console.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/)
  assert.match(workflow, /requests\/bosho0l-publication-console\.json/)
  assert.match(workflow, /runs-on: ubuntu-latest/)
  assert.match(workflow, /environment: private-source-read/)
  assert.match(workflow, /run: node scripts\/run-bosho0l-publication-console\.mjs/)
  assert.doesNotMatch(workflow, /pull_request:/)
  assert.doesNotMatch(workflow, /self-hosted/)
})

test('build failure classifier emits only stable non-sensitive diagnostics', () => {
  assert.equal(
    classifyConsoleBuildFailure({
      status: 1,
      signal: null,
      stdout: '',
      stderr:
        '/workspace/articles/x/publication/publication.yaml: reference links cannot be materialized deterministically: 3 reference item(s), 2 HTTP official_surfaces URL(s).',
    }),
    'PUBLICATION_CONSOLE_REFERENCE_LINKS_AMBIGUOUS',
  )
  assert.equal(
    classifyConsoleBuildFailure({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'Configured sidecar does not exist: private/path/example.png',
    }),
    'PUBLICATION_CONSOLE_SIDECAR_MISSING',
  )
  assert.equal(
    classifyConsoleBuildFailure({
      status: 1,
      signal: null,
      stdout: 'unexpected private builder output',
      stderr: '',
    }),
    'PUBLICATION_CONSOLE_BUILD_FAILED',
  )
  assert.equal(
    classifyConsoleBuildFailure({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    }),
    'PUBLICATION_CONSOLE_BUILD_SIGNALLED',
  )
})


test('unclassified private build errors become bounded codes without private text', () => {
  const cases = [
    ['Error [ERR_MODULE_NOT_FOUND]: Cannot find package private-name', 'PUBLICATION_CONSOLE_MODULE_MISSING'],
    ['ENOENT: no such file or directory, open /workspace/private/body.md', 'PUBLICATION_CONSOLE_INPUT_FILE_MISSING'],
    ['EACCES: permission denied, open /workspace/private/body.md', 'PUBLICATION_CONSOLE_FILESYSTEM_DENIED'],
    ['RangeError: Invalid string length: private content', 'PUBLICATION_CONSOLE_OUTPUT_TOO_LARGE'],
    ['private/publication.yaml: YAML root must be a mapping.', 'PUBLICATION_CONSOLE_SOURCE_ROOT_INVALID'],
    ['TypeError: private value is not iterable', 'PUBLICATION_CONSOLE_BUILD_TYPE_ERROR'],
    ['SyntaxError: private source token', 'PUBLICATION_CONSOLE_BUILD_SYNTAX_ERROR'],
  ]
  for (const [stderr, expected] of cases) {
    const diagnostic = classifyConsoleBuildFailure({ status: 1, signal: null, stdout: '', stderr })
    assert.equal(diagnostic, expected)
    assert.deepEqual(safePublicResult({ status: 'FAIL', diagnostic, stderr }), {
      schema_version: 1,
      task: 'bosho0l-publication-console',
      status: 'FAIL',
      diagnostic: expected,
    })
  }
})
