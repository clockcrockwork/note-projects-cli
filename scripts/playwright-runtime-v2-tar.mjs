import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { listTarGzEntries } from './playwright-runtime-tar.mjs'

export function hashTarEntry(tarPath, entryPath) {
  const result = spawnSync('tar', ['-xOf', tarPath, entryPath], { encoding: null, maxBuffer: 1024 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`RUNTIME_V2_TAR_STREAM_FAILED_${entryPath}`)
  return { size: result.stdout.length, sha256: createHash('sha256').update(result.stdout).digest('hex') }
}

export function verifyTarPayloadV2(entries, { expectedRoot, runtimes }) {
  const prefix = `${expectedRoot}/`
  if (!entries.length || !entries.every((entry) => entry.name === expectedRoot || entry.name.startsWith(prefix))) throw new Error('RUNTIME_V2_TAR_ROOT_MISMATCH')
  for (const [key, runtime] of Object.entries(runtimes)) {
    const expected = `${expectedRoot}/${runtime.directory}/${runtime.executable_relative_path}`
    const entry = entries.find((candidate) => candidate.name === expected)
    if (!entry || entry.type !== '-' || (entry.mode & 0o111) === 0 || entry.size <= 0) throw new Error(`RUNTIME_V2_TAR_EXECUTABLE_INVALID_${key}`)
  }
}

function main() {
  const [, , command, tarPath, expectedRoot, reportPath] = process.argv
  if (command !== 'verify' || !tarPath || !expectedRoot || !reportPath) throw new Error('RUNTIME_V2_TAR_ARGS_INVALID')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const runtimes = { chromium: report.chromium, chromium_headless_shell: report.chromium_headless_shell }
  verifyTarPayloadV2(listTarGzEntries(tarPath), { expectedRoot, runtimes })
  for (const [key, runtime] of Object.entries(runtimes)) {
    const actual = hashTarEntry(tarPath, `${expectedRoot}/${runtime.directory}/${runtime.executable_relative_path}`)
    if (actual.sha256 !== runtime.executable_sha256 || actual.size !== runtime.executable_size) throw new Error(`RUNTIME_V2_TAR_IDENTITY_MISMATCH_${key}`)
  }
  process.stdout.write('RUNTIME_V2_TAR_VERIFY_OK\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'RUNTIME_V2_TAR_VERIFY_FAILED'}\n`); process.exitCode = 1 }
}
