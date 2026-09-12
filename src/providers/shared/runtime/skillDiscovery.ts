import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { asRecord } from '@shared/lib/asRecord.js'

export const SKILL_METADATA_BYTES = 64 * 1024

// WHY every ancestor walk is capped: the cwd comes from renderer state. A
// pathological or symlink-heavy path must not turn one status panel into an
// unbounded sequence of stat calls in Electron main. 128 levels is far deeper
// than any real checkout.
const MAX_ANCESTORS = 128

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

/**
 * Nearest ancestor of `cwd` (inclusive) that contains one of `markers`.
 *
 * A marker only needs to exist: a linked worktree's `.git` is a FILE, and
 * treating only directories as repository roots is how a walk escapes into the
 * parent checkout. Probe errors other than "missing" are treated as absent —
 * every provider we mirror logs and continues past an unreadable marker rather
 * than failing skill discovery for the whole session.
 */
export async function findAncestorWithMarker(cwd: string, markers: readonly string[]): Promise<string | null> {
  let current = resolve(cwd)
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    for (const marker of markers) {
      if (await stat(join(current, marker)).then(() => true, () => false)) return current
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** `cwd` and its ancestors, nearest first, through `stop` (inclusive), or up to
 *  the filesystem root when `stop` is null. */
export function ancestorsThrough(cwd: string, stop: string | null): string[] {
  const directories: string[] = []
  const end = stop === null ? null : resolve(stop)
  let current = resolve(cwd)
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    directories.push(current)
    if (current === end) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

/**
 * Resolve a manifest-declared path under a plugin root, or null when it escapes.
 *
 * WHY containment is enforced for every provider: a plugin manifest is
 * repository-controlled input. Without this check `"skills": "../../.."` made
 * main scan (bounded, but still) arbitrary directories and surface foreign
 * SKILL.md names in the panel. Codex rejects escaping paths itself
 * (core-plugins/src/manifest.rs resolve_manifest_path); Claude joins without a
 * check, so for a malicious Claude manifest this inventory lists slightly less
 * than Claude would load — the safe direction for a read-only status view.
 */
export function pathInsidePlugin(pluginRoot: string, manifestPath: string): string | null {
  const root = resolve(pluginRoot)
  const resolved = resolve(root, manifestPath)
  const rel = relative(root, resolved)
  if (rel === '') return resolved
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : resolved
}
