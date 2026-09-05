import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { reconcileExternalCodexConfig } from './externalCodexConfig'

const skillMarker = '\n<!-- agent-code-external-operator:v1 '
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

// This writer is intentionally separate from the all-provider skill manager:
// installing the operator into ~/.agents/skills would advertise it to the very
// agents it operates. Only the selected external Codex home receives this skill.
// Marked content carries its own exact-byte ownership proof, so interrupted
// installs and app upgrades can reconcile without claiming a user-created file.
export function createExternalCodexIntegration(codexHome: string, skillSource: string) {
  const configPath = join(codexHome, 'config.toml')
  const skillPath = join(codexHome, 'skills', 'agent-code-computer-execution', 'SKILL.md')
  const skill = skillSource + `${skillMarker}${sha(skillSource)} -->\n`
  return {
    configPath, skillPath,
    async reconcile(connection: { url: string; token: string } | null): Promise<void> {
      const existing = await readRegular(configPath)
      const oldSkill = await readRegular(skillPath)
      if (oldSkill !== null) {
        const marker = oldSkill.lastIndexOf(skillMarker)
        if (marker < 0 || oldSkill.slice(marker) !== `${skillMarker}${sha(oldSkill.slice(0, marker))} -->\n`) {
          throw new Error(`Operator skill is not app-owned or was edited: ${skillPath}`)
        }
      }
      const next = reconcileExternalCodexConfig(existing ?? '', connection)
      // Validate both destinations before either mutation. On a later I/O failure
      // Settings stops the listener; the next retry recognizes any completed half.
      if (connection) await replaceObserved(skillPath, oldSkill, skill)
      if (next !== (existing ?? '')) await replaceObserved(configPath, existing, next)
      if (!connection && oldSkill !== null) await replaceObserved(skillPath, oldSkill, null)
    },
  }
}

async function readRegular(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected an ordinary file; refusing to replace: ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function replaceObserved(path: string, observed: string | null, next: string | null) {
  if (observed === next) return
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    if (next !== null) await writeFile(temporary, next, { mode: 0o600, flag: 'wx' })
    // Detect edits made during staging, including Codex's own config writer.
    // Atomic rename prevents torn reads. There is no cross-product filesystem
    // CAS protocol; another writer in the final check/rename interval can still
    // race, so keep that interval free of application awaits or extra work.
    if (await readRegular(path) !== observed) throw new Error(`File changed during setup; retry: ${path}`)
    if (next === null) await unlink(path)
    else await rename(temporary, path)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
