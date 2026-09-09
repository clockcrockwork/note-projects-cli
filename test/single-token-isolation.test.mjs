import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const runner = await readFile(new URL('../scripts/run-repository-verify.mjs', import.meta.url), 'utf8')

test('repository verify mints one installation token and revokes before source execution', () => {
  assert.equal((runner.match(/accessToken = await mintInstallationToken/g) ?? []).length, 1)
  assert.doesNotMatch(runner, /targetToken|bootstrapToken/)
  assert.match(runner, /phase = 'ACCESS_REVOKE'[\s\S]*revokeInstallationToken\(accessToken\)[\s\S]*phase = 'PUBLIC_EXECUTION'/)
})

test('private planner and export policy execute only through no-network containers', () => {
  assert.match(runner, /--network/)
  assert.match(runner, /'none'/)
  assert.match(runner, /\/trusted\/pr-validation-plan\.mjs/)
  assert.match(runner, /\/runner\/scripts\/evaluate-export-plan\.mjs/)
  assert.doesNotMatch(runner, /importTrusted/)
})

test('export-plan adapter returns only the selected allowlisted paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'npr-export-control-'))
  const listing = join(dir, 'listing.json')
  const manifest = join(dir, 'manifest.json')
  const policy = join(dir, 'policy.mjs')

  await writeFile(listing, JSON.stringify({ tree: [{ path: 'safe.mjs' }], truncated: false }))
  await writeFile(
    manifest,
    JSON.stringify({ schema_version: 1, task: 'repository-verify', allow: ['*.mjs'], deny: [] }),
  )
  await writeFile(
    policy,
    "export function planExport() { return { ok: true, include: ['safe.mjs'], exclude: [], unsafe: [] } }\n",
  )

  const child = spawnSync(
    process.execPath,
    ['scripts/evaluate-export-plan.mjs', listing, manifest, policy],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  )
  assert.equal(child.status, 0)
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, include: ['safe.mjs'] })
})
