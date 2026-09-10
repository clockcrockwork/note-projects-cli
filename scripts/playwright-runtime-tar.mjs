import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const TAR_LINE_RE = /^([dlpscb-])([-rwxsStT]{9})\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/
const EXEC_COLUMN_INDICES = new Set([2, 5, 8])
const PERMISSION_BIT_VALUES = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]

function permissionBitsToMode(bits) {
  let mode = 0
  for (let i = 0; i < 9; i += 1) {
    const char = bits[i]
    if (char === '-') continue
    if (EXEC_COLUMN_INDICES.has(i)) {
      if (char === 'x' || char === 's' || char === 't') mode |= PERMISSION_BIT_VALUES[i]
    } else {
      mode |= PERMISSION_BIT_VALUES[i]
    }
  }
  return mode
}

export function parseTarListing(stdout) {
  const entries = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const match = TAR_LINE_RE.exec(line)
    if (!match) throw new Error('TAR_LIST_LINE_UNPARSEABLE')
    const [, typeChar, bits, sizeText, rawName] = match
    const name = rawName.split(' -> ')[0]
    entries.push({ name, type: typeChar, mode: permissionBitsToMode(bits), size: Number(sizeText) })
  }
  return entries
}

export function listTarGzEntries(tarPath) {
  const result = spawnSync('tar', ['-tvzf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error('TAR_LIST_FAILED')
  if (result.status !== 0) throw new Error('TAR_LIST_FAILED')
  return parseTarListing(result.stdout)
}

export function computeSha256(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export function verifyTarPayload(entries, { expectedRoot, expectedExecutablePath }) {
  if (entries.length === 0) throw new Error('TAR_EMPTY')
  const rootPrefix = `${expectedRoot}/`
  if (!entries.every((entry) => entry.name === expectedRoot || entry.name.startsWith(rootPrefix))) {
    throw new Error('TAR_ROOT_MISMATCH')
  }
  const executable = entries.find((entry) => entry.name === expectedExecutablePath)
  if (!executable) throw new Error('TAR_EXECUTABLE_MISSING')
  if (executable.type !== '-') throw new Error('TAR_EXECUTABLE_NOT_REGULAR_FILE')
  if ((executable.mode & 0o111) === 0) throw new Error('TAR_EXECUTABLE_PERMISSION_MISSING')
}

function main() {
  const [, , command, tarPath, expectedRoot, expectedExecutablePath] = process.argv
  if (command !== 'verify') throw new Error('TAR_COMMAND_INVALID')
  if (!tarPath || !expectedRoot || !expectedExecutablePath) throw new Error('TAR_VERIFY_ARGS_REQUIRED')
  const entries = listTarGzEntries(tarPath)
  verifyTarPayload(entries, { expectedRoot, expectedExecutablePath })
  process.stdout.write('TAR_VERIFY_OK\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'TAR_VERIFY_FAILED'}\n`)
    process.exitCode = 1
  }
}
