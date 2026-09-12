import { cp, mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Materialise the committed corpus under a temp HOME shaped exactly like the
// real one (~/.claude, ~/.codex, ~/.local/share/opencode), so adapters run
// with no test-only branches. Paths recorded as /fixture/home are rewritten
// to the temp root inside the sqlite copies; JSONL records keep /fixture/*
// because the adapters compare cwds as strings against the family, and the
// family for the fixture IS /fixture/repo.
const CORPUS = join(process.cwd(), 'testing', 'fixtures', 'conversations')

export type InstalledCorpus = {
  home: string
  claudeConfigDir: string
  codexHome: string
  opencodeDataDir: string
  repoRoot: string
  worktrees: string[]
  manifest: Record<string, unknown>
  cleanup(): Promise<void>
}

export async function installConversationCorpus(): Promise<InstalledCorpus> {
  const home = await mkdtemp(join(tmpdir(), 'conversations-corpus-'))
  const claudeConfigDir = join(home, '.claude')
  const codexHome = join(home, '.codex')
  const opencodeDataDir = join(home, '.local', 'share', 'opencode')
  await cp(join(CORPUS, 'claude', 'projects'), join(claudeConfigDir, 'projects'), { recursive: true })
  await cp(join(CORPUS, 'claude', 'history.jsonl'), join(claudeConfigDir, 'history.jsonl'))
  await cp(join(CORPUS, 'codex', 'sessions'), join(codexHome, 'sessions'), { recursive: true })
  await cp(join(CORPUS, 'codex', 'threads.sqlite'), join(codexHome, 'state_5.sqlite'))
  await cp(join(CORPUS, 'opencode', 'opencode.sqlite'), join(opencodeDataDir, 'opencode.db'))
  await applyRecordedStats(home)
  const codex = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
  codex.exec(`update threads set rollout_path = replace(rollout_path, '/fixture/home/.codex', '${codexHome.replaceAll("'", "''")}')`)
  codex.close()
  const manifest = JSON.parse(await readFile(join(CORPUS, 'manifest.json'), 'utf8')) as Record<string, unknown>
  return {
    home, claudeConfigDir, codexHome, opencodeDataDir,
    repoRoot: manifest.repoRoot as string,
    worktrees: manifest.worktrees as string[],
    manifest,
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

// Every recorded `<file>.stat.json` sidecar is applied to its file and then
// removed, so the installed HOME is shaped exactly like a real one. WHY: the
// adapters' last-resort activity is the file's mtime, and a copy's mtime is
// the install time. Without this, a transcript with no user timestamp ranked
// by when the test ran, and the ordering assertion drifted with every run.
async function applyRecordedStats(root: string): Promise<void> {
  for (const relative of await readdir(root, { recursive: true })) {
    if (!relative.endsWith('.stat.json')) continue
    const sidecar = join(root, relative)
    const { mtimeMs } = JSON.parse(await readFile(sidecar, 'utf8')) as { mtimeMs: number }
    await utimes(sidecar.slice(0, -'.stat.json'.length), mtimeMs / 1000, mtimeMs / 1000)
    await rm(sidecar)
  }
}

export async function corpusWorktreesPorcelain(): Promise<string> {
  return readFile(join(CORPUS, 'claude', 'worktrees.porcelain'), 'utf8')
}
