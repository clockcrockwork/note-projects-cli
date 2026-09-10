import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const TASKS = new Set(['repository-verify', 'publication-preview'])

function fail(code) {
  process.stdout.write(JSON.stringify({ ok: false, diagnostic: code }))
  process.exitCode = 2
}

async function main() {
  const [listingPath, manifestPath, policyPath] = process.argv.slice(2)
  if (!listingPath || !manifestPath || !policyPath) return fail('EXPORT_CONTROL_ARGUMENTS_INVALID')

  let listing
  let manifest
  try {
    listing = JSON.parse(await readFile(listingPath, 'utf8'))
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return fail('EXPORT_CONTROL_INPUT_INVALID')
  }

  if (
    manifest?.schema_version !== 1 ||
    !TASKS.has(manifest?.task) ||
    !Array.isArray(manifest.allow)
  ) {
    return fail('TASK_MANIFEST_INVALID')
  }

  const policy = await import(pathToFileURL(policyPath).href)
  const result = policy.planExport(listing, {
    allow: manifest.allow,
    deny: manifest.deny ?? [],
  })

  if (!result?.ok || !Array.isArray(result.include)) {
    return fail('SOURCE_EXPORT_UNSAFE_ENTRY')
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      include: result.include,
    }),
  )
}

main().catch(() => fail('EXPORT_CONTROL_FAILED'))
