// Main-process provider registry — Node-only, imports session factories.
//
// sessionManager and IPC handlers import from HERE.

import { join } from 'path'
import { readdir, stat } from 'fs/promises'

import type { MainProviderConfig } from '@shared/types/providerConfig'
import { type AgentProviderKind, isAgentProviderKind } from '@shared/types/providerKind'
import { ClaudeSession } from '@providers/claude/runtime/claudeSession'
import { listAllClaudeSessions } from '@providers/claude/runtime/sessionList'
import { listSessionsForCwd, getProjectDirForCwd } from 'claude-code-headless'
import { CodexSession } from '@providers/codex/runtime/codexSession'
import { listCodexSessions, getCodexSessionsDir } from 'codex-headless'

const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Find the newest Codex rollout whose structured filename owns `threadId`.
 *
 * WHY this lives behind MainProviderConfig instead of in historyLoader:
 * Codex durable history is global/date-bucketed while Claude durable history is
 * cwd/project-dir scoped. The shared history loader should ask the provider for
 * "the transcript path for this provider session" instead of carrying a
 * provider-specific directory walk and a Claude path join beside its paging
 * code. Keeping the exact filename parse here also preserves the important
 * invariant from the old loader: never substring-match a global rollout tree.
 */
async function findCodexRolloutPathByThreadId(
  sessionsDir: string,
  threadId: string,
): Promise<string | null> {
  const matches: Array<{ path: string; mtimeMs: number }> = []
  try {
    await collectCodexRolloutMatches(sessionsDir, threadId, matches)
  } catch {
    return null
  }
  if (matches.length === 0) return null
  // WHY mtime, not reverse date-dir / first readdir match: Codex can leave more
  // than one rollout filename for the same thread id after resume/remap flows.
  // Provider switching, duplicate, rewind, history pagination, and prompt
  // templates must all agree on the newest durable transcript, and file mtime is
  // the old shared tie-break those flows already relied on.
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches[0]?.path ?? null
}

async function collectCodexRolloutMatches(
  dir: string,
  threadId: string,
  matches: Array<{ path: string; mtimeMs: number }>,
  depth = 0,
): Promise<void> {
  if (depth > 3) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let entryStat
    try {
      entryStat = await stat(fullPath)
    } catch {
      continue
    }
    if (entryStat.isDirectory()) {
      await collectCodexRolloutMatches(fullPath, threadId, matches, depth + 1)
      continue
    }
    if (!entryStat.isFile()) continue
    const parsed = CODEX_ROLLOUT_RE.exec(entry)
    if (parsed?.[2] !== threadId) continue
    matches.push({ path: fullPath, mtimeMs: entryStat.mtimeMs })
  }
}

const claudeMain: MainProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  createSession: (opts) => new ClaudeSession(opts),
  listSessions: (cwd, limit) => listSessionsForCwd(cwd, { limit }),
  // Claude's package API is cwd-scoped today. Keep the app's global walker
  // behind the same provider registry slot so debug IPC does not know which
  // providers still need app-local compatibility shims.
  listAllSessions: (limit) => listAllClaudeSessions({ limit }),
  getProjectDir: getProjectDirForCwd,
  resolveTranscriptPath: async (cwd, providerSessionId) =>
    join(await getProjectDirForCwd(cwd), `${providerSessionId}.jsonl`),
}

const codexMain: MainProviderConfig = {
  id: 'codex',
  name: 'Codex',
  createSession: (opts) => new CodexSession(opts),
  // Pass cwd through so the resume picker only shows sessions
  // recorded in the user's current working directory. Without this
  // filter the codex picker silently returned every session globally
  // (Codex doesn't partition by cwd), which let the user pick a
  // session whose underlying rollout cwd != Agent Code's spawn cwd.
  // That mismatch triggers Codex's upstream `cwd_prompt` modal, which
  // Agent Code has no detector for — the modal then eats the user's
  // first bracketed-paste submission. See the matching change in
  // packages/codex-headless/src/transcript/SessionList.ts.
  listSessions: (cwd, limit) => listCodexSessions({ cwd, limit }),
  listAllSessions: (limit) => listCodexSessions({ limit }),
  getProjectDir: async () => getCodexSessionsDir(),
  resolveTranscriptPath: async (_cwd, providerSessionId) =>
    findCodexRolloutPathByThreadId(await getCodexSessionsDir(), providerSessionId),
}

// Typed as Record<AgentProviderKind, …> (not Record<string, …>) so that
// adding a kind to AGENT_PROVIDER_KINDS without registering a config here
// is a COMPILE error, not a runtime "Unknown provider" surprise. That is
// the compiler-enforced checklist for future provider integrations.
const mainProviders: Record<AgentProviderKind, MainProviderConfig> = {
  claude: claudeMain,
  codex: codexMain,
}

// Accepts a bare string (callers pass IPC args / persisted `kind` values)
// and validates BEFORE indexing the exhaustive record — TypeScript will
// not let an unvalidated string index a Record<AgentProviderKind, …>, and
// that is the point: an unknown id fails loudly here rather than deep in a
// provider factory. 'terminal' is intentionally rejected — it has no
// MainProviderConfig (terminal sessions are handled directly by the manager).
export function getMainProvider(id: string): MainProviderConfig {
  if (!isAgentProviderKind(id)) throw new Error(`Unknown provider: ${id}`)
  return mainProviders[id]
}
