import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse } from '@iarna/toml'

const begin = '# agent-code-external-control:v1 '
const end = '# /agent-code-external-control\n'
const skillMarker = '\n<!-- agent-code-external-operator:v1 '
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const serverName = 'agent-code-control'

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
      const original = parseConfig(existing ?? '')
      let remaining = existing ?? ''
      const offset = remaining.indexOf(begin)
      if (offset >= 0) {
        const bodyStart = remaining.indexOf('\n', offset) + 1
        const endStart = remaining.indexOf(end, bodyStart)
        if (offset > 0 && remaining[offset - 1] !== '\n' || !bodyStart || endStart < 0
          || remaining.slice(offset, bodyStart) !== `${begin}${sha(remaining.slice(bodyStart, endStart))}\n`
          || remaining.indexOf(begin, bodyStart) >= 0) {
          throw new Error(`Managed Codex connection was edited; preserve or remove that block manually: ${configPath}`)
        }
        remaining = remaining.slice(0, offset) + remaining.slice(endStart + end.length)
        // A marker inside a TOML multiline string is not ownership. Likewise,
        // removing our table must not change the meaning of a user's later keys.
        const withoutOwned = structuredClone(original)
        const servers = withoutOwned.mcp_servers as Record<string, unknown> | undefined
        if (!servers || !Object.hasOwn(servers, serverName)) throw new Error('Codex connection ownership markers are outside the expected table')
        delete servers[serverName]
        if (Object.keys(servers).length === 0) delete withoutOwned.mcp_servers
        const parsedRemaining = parseConfig(remaining)
        if (parsedRemaining.mcp_servers && Object.keys(parsedRemaining.mcp_servers).length === 0) delete parsedRemaining.mcp_servers
        if (!isDeepStrictEqual(withoutOwned, parsedRemaining)) throw new Error('Removing the managed connection would change unrelated Codex configuration')
      } else if (Object.hasOwn((original.mcp_servers as object | undefined) ?? {}, serverName)) {
        throw new Error(`Codex already has an unmanaged ${serverName} connection: ${configPath}`)
      }
      let next = remaining
      if (connection) {
        const body = `[mcp_servers.agent-code-control]\nurl = ${JSON.stringify(connection.url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${connection.token}`)} }\n`
        next += `${next && !next.endsWith('\n') ? '\n' : ''}${begin}${sha(body)}\n${body}${end}`
      }
      // Validation, not serialization: comments, ordering and unrelated bytes
      // survive unchanged. Inline mcp_servers tables cannot be extended this way;
      // report that unsupported shape instead of writing invalid TOML.
      parseConfig(next)
      // Validate both destinations before either mutation. On a later I/O failure
      // Settings stops the listener; the next retry recognizes any completed half.
      if (connection) await replaceObserved(skillPath, oldSkill, skill)
      if (next !== (existing ?? '')) await replaceObserved(configPath, existing, next)
      if (!connection && oldSkill !== null) await replaceObserved(skillPath, oldSkill, null)
    },
  }
}

function parseConfig(text: string) {
  try { return parse(text) }
  // Parser errors can quote a line containing a bearer. Never expose them in
  // Settings, SDK history or logs; the path and repair action are sufficient.
  catch { throw new Error('Codex config.toml is invalid or uses a table shape that cannot be extended safely') }
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
