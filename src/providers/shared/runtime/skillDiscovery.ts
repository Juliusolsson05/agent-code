import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { asRecord } from '@shared/lib/asRecord.js'
import type { AgentSkillRoot } from '@shared/types/agentSkills.js'

export const SKILL_METADATA_BYTES = 64 * 1024

export function missingSkillPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function readSkillFile(path: string, limit = SKILL_METADATA_BYTES, prefix = false): Promise<string | null> {
  let file
  try {
    // Nonblocking open + fstat prevents a SKILL.md FIFO/device from hanging
    // Electron main. Symlinks ARE supported for this read-only inventory:
    // native providers accept linked skills, unlike our installation writer.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Not a regular file')
    if (!prefix && info.size > limit) throw new Error('File exceeds metadata limit')
    const buffer = Buffer.alloc(Math.min(info.size, limit))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    if (missingSkillPath(error)) return null
    throw error
  } finally {
    await file?.close()
  }
}

export async function readSkillJson(path: string, notices: string[]): Promise<Record<string, unknown>> {
  try {
    const text = await readSkillFile(path, 1024 * 1024)
    if (text === null) return {}
    const value = asRecord(JSON.parse(text))
    if (!value) throw new Error('Not an object')
    return value
  } catch {
    // Exceptions from YAML/JSON parsers can quote user configuration. The UI
    // needs the failed location, never arbitrary config values or skill bodies.
    notices.push(`Could not read skill configuration: ${path}`)
    return {}
  }
}

export async function skillProjectDirectories(cwd: string): Promise<string[]> {
  const directories: string[] = []
  let current = resolve(cwd)
  // A worktree's .git is a FILE. Checking only directories would walk outside
  // the project and attribute another project's skills to this agent.
  for (let depth = 0; depth < 128; depth += 1) {
    directories.push(current)
    try { await stat(join(current, '.git')); return directories } catch (error) {
      if (!missingSkillPath(error)) throw error
    }
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }
  throw new Error('Project ancestry exceeds discovery limit')
}

export async function pluginSkillRoots(
  installPath: string,
  pluginName: string,
  manifestDirectory: string,
  notices: string[],
): Promise<AgentSkillRoot[]> {
  const manifest = await readSkillJson(join(installPath, manifestDirectory, 'plugin.json'), notices)
  const paths = [join(installPath, 'skills')]
  const configured = typeof manifest.skills === 'string' ? [manifest.skills]
    : Array.isArray(manifest.skills) ? manifest.skills : []
  for (const value of configured) {
    if (typeof value === 'string') paths.push(resolve(installPath, value))
  }
  return [...new Set(paths)].map(path => ({
    path, source: 'plugin', sourceLabel: pluginName,
    optionalFrontmatter: manifestDirectory === '.claude-plugin',
  }))
}
