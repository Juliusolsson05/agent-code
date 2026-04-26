import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { getProjectDirForCwd } from '@shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '@providers/codex/runtime/projectDir.js'
import type { TranscriptCandidate } from '@main/worktreeActivity/types.js'

const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export async function discoverTranscriptCandidates(): Promise<TranscriptCandidate[]> {
  const [claude, codex] = await Promise.all([
    discoverClaudeCandidates(),
    discoverCodexCandidates(),
  ])
  return [...claude, ...codex]
}

async function discoverClaudeCandidates(): Promise<TranscriptCandidate[]> {
  const out: TranscriptCandidate[] = []
  const projectsRootForSlash = (await getProjectDirForCwd('/')).replace(/\/+$/, '')
  const projectsRoot = projectsRootForSlash.slice(0, projectsRootForSlash.lastIndexOf('/'))
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsRoot)
  } catch {
    return []
  }

  await Promise.all(projectDirs.map(async projectDirName => {
    const dir = join(projectsRoot, projectDirName)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      try {
        const st = await stat(file)
        if (!st.isFile()) continue
        out.push({
          provider: 'claude',
          providerSessionId: name.slice(0, -'.jsonl'.length),
          file,
          cwd: '',
          mtimeMs: st.mtimeMs,
          size: st.size,
        })
      } catch {
        // Unreadable session files are skipped. The index is best-effort
        // metadata, not the source of truth for the underlying agent data.
      }
    }
  }))

  return out
}

async function discoverCodexCandidates(): Promise<TranscriptCandidate[]> {
  const out: TranscriptCandidate[] = []
  const root = getCodexSessionsDir()

  async function walk(dir: string, depth: number): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    await Promise.all(names.map(async name => {
      const full = join(dir, name)
      try {
        const st = await stat(full)
        if (st.isDirectory() && depth < 4) {
          await walk(full, depth + 1)
          return
        }
        if (!st.isFile()) return
        const match = CODEX_ROLLOUT_RE.exec(name)
        if (!match) return
        out.push({
          provider: 'codex',
          providerSessionId: match[2],
          file: full,
          cwd: '',
          mtimeMs: st.mtimeMs,
          size: st.size,
        })
      } catch {
        // Same best-effort rule as Claude discovery.
      }
    }))
  }

  await walk(root, 0)
  return out
}
