import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const version of ['', '-v2']) {
  const filename = `playwright-runtime-carrier${version}.yml`
  const source = await readFile(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8')
  const steps = source.split(/^      - /m).slice(1)

  test(`${filename}: runtime upload policy matches exact event and ref bytes`, async () => {
    const policySteps = steps.filter((step) => /id: runtime_upload_policy\b/.test(step))
    assert.equal(policySteps.length, 1, 'case-sensitive policy step must exist')
    const policy = policySteps[0]
    assert.match(policy, /shell: bash/)
    const script = policy.match(/        run: \|\n((?:          .*\n?)+)/)?.[1].replace(/^          /gm, '')
    assert.ok(script, 'execute the actual workflow policy script')
    const directory = await mkdtemp(join(tmpdir(), 'runtime-upload-policy-'))
    try {
      let index = 0
      for (const event of ['workflow_dispatch', 'WORKFLOW_DISPATCH', 'pull_request', 'push', 'schedule', 'workflow_run', '']) {
        for (const ref of ['refs/heads/main', 'refs/heads/MAIN', 'refs/heads/Main', 'REFS/heads/main', 'refs/heads/main-extra', 'refs/heads/feature', 'refs/pull/42/merge', 'refs/tags/main', '']) {
          const output = join(directory, `output-${index++}`)
          const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_OUTPUT: output },
          })
          assert.equal(run.status, 0, run.stderr)
          const content = await readFile(output, 'utf8').catch((error) => {
            if (error.code === 'ENOENT') return ''
            throw error
          })
          assert.equal(content, event === 'workflow_dispatch' && ref === 'refs/heads/main' ? 'upload=true\n' : '', `${event} on ${ref}`)
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test(`${filename}: upload requires successful validation and an affirmative policy output`, () => {
    const uploads = steps.filter((step) => /uses: actions\/upload-artifact@/.test(step))
    assert.equal(uploads.length, 1)
    const conditions = [...uploads[0].matchAll(/^        if: (.+)$/gm)]
    assert.equal(conditions.length, 1)
    assert.equal(conditions[0][1], "success() && steps.runtime_upload_policy.outputs.upload == 'true'")
    assert.ok(steps.findIndex((step) => /id: runtime_upload_policy\b/.test(step)) < steps.indexOf(uploads[0]))
    assert.match(uploads[0], /retention-days: 30/)
    assert.match(uploads[0], /if-no-files-found: error/)
    assert.doesNotMatch(source, /continue-on-error:|always\(\)|failure\(\)/)
    // PR validation/packaging stays unconditional. Only the upload is gated.
    assert.equal((source.match(/^\s*if:/gm) ?? []).length, 1)
    assert.match(source, /pull_request:/)
    assert.match(source, /workflow_dispatch:\s*\{\}/)
  })
}
