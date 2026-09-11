// Main-process provider registry — Node-only, imports session factories.
//
// sessionManager and IPC handlers import from HERE.

import { join } from 'path'
import { opencodeTranscriptFile, parseOpencodeTranscriptFile, type OpencodeSessionInfo } from 'opencode-terminal-headless'
import { opencodeDatabase, readOpencodeSessionInfo } from '@providers/opencode/runtime/opencodeDatabase'

import type { MainProviderConfig } from '@shared/types/providerConfig'
import type { SessionInfo } from '@shared/types/session'
import { AGENT_PROVIDER_KINDS, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { ClaudeSession } from '@providers/claude/runtime/claudeSession'
import { listAllClaudeSessions } from '@providers/claude/runtime/sessionList'
import { deliverClaudePrompt } from '@providers/claude/runtime/promptDelivery'
import { listSessionsForCwd, getProjectDirForCwd, resolveClaudeTranscriptPath } from 'claude-code-headless'
import { CodexSession } from '@providers/codex/runtime/codexSession'
import { deliverCodexPrompt } from '@providers/codex/runtime/promptDelivery'
import { OpencodeSession } from '@providers/opencode/runtime/opencodeSession'
import { OpencodeTerminalSession } from '@providers/opencode/runtime/opencodeTerminalSession'
import { loadOpencodeHistoryChunk } from '@providers/opencode/runtime/opencodeHistory'
import { deliverOpencodePrompt } from '@providers/opencode/runtime/promptDelivery'
import {
  findCodexRolloutPathByThreadId,
  getCodexSessionsDir,
  listCodexSessions,
} from 'codex-headless'

// Shared by OpenCode's cwd-scoped and global listings so the two can never
// disagree about what the picker is told. The store row is the source of
// truth for `cwd`: the global listing has no ambient directory to fall back
// on, and a resumed session must be spawned in the directory it recorded.
function toOpencodeSessionInfos(
  rows: ReadonlyArray<Pick<OpencodeSessionInfo, 'id' | 'title' | 'directory' | 'timeUpdated'>>,
): SessionInfo[] {
  return rows.map(row => ({
    sessionId: row.id,
    summary: row.title,
    lastModified: row.timeUpdated,
    // SQLite rows have no per-session file size. Zero avoids attributing
    // the entire shared database to every session in the Resume picker.
    fileSize: 0,
    cwd: row.directory,
  }))
}

const claudeMain: MainProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  personalAgentSkills: {
    supported: true,
    locations: [
      {
        id: 'claude-personal-skills',
        resolveDirectory: ({ homeDirectory, environment }) =>
          join(environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'skills'),
      },
    ],
  },
  createSession: (opts) => new ClaudeSession(opts),
  listSessions: (cwd, limit) => listSessionsForCwd(cwd, { limit }),
  // Claude's package API is cwd-scoped today. Keep the app's global walker
  // behind the same provider registry slot so debug IPC does not know which
  // providers still need app-local compatibility shims.
  listAllSessions: (limit) => listAllClaudeSessions({ limit }),
  getProjectDir: getProjectDirForCwd,
  resolveTranscriptPath: (cwd, providerSessionId) => {
    // Native EnterWorktree moves the durable file without changing its UUID.
    // History, rewind and the live tailer must share the package's exact-session
    // resolver; reconstructing the launch-cwd path here silently returned empty
    // history while a real prompt was accepted in the relocated transcript.
    // Absence is a normal locator result for inventory/batch consumers. The
    // history/resume boundaries require a durable file and throw there instead;
    // throwing here made one absent pane abort every active-tab transcript path.
    return resolveClaudeTranscriptPath(cwd, providerSessionId)
  },
  deliverPrompt: deliverClaudePrompt,
}

const codexMain: MainProviderConfig = {
  id: 'codex',
  name: 'Codex',
  personalAgentSkills: {
    supported: true,
    locations: [
      {
        id: 'agents-standard-personal-skills',
        resolveDirectory: ({ homeDirectory }) => join(homeDirectory, '.agents', 'skills'),
      },
    ],
  },
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
  // WHY Agent Code delegates exact identity to codex-headless: live resume and
  // offline history must validate requested ID, filename UUID, session_meta.id,
  // and duplicate ordering with one rule. A second app-local directory walker
  // previously disagreed with the runtime on which duplicate was authoritative.
  resolveTranscriptPath: async (_cwd, providerSessionId) =>
    findCodexRolloutPathByThreadId(await getCodexSessionsDir(), providerSessionId),
  deliverPrompt: deliverCodexPrompt,
}

const opencodeMain: MainProviderConfig = {
  id: 'opencode',
  name: 'OpenCode',
  personalAgentSkills: {
    supported: true,
    locations: [
      {
        id: 'agents-standard-personal-skills',
        resolveDirectory: ({ homeDirectory }) => join(homeDirectory, '.agents', 'skills'),
      },
      {
        // OpenCode documents Claude-compatible skill discovery as well as the
        // shared .agents root. Listing both makes the unavoidable overlap
        // visible in health/UI instead of pretending OpenCode sees one copy.
        id: 'claude-personal-skills',
        resolveDirectory: ({ homeDirectory, environment }) =>
          join(environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'skills'),
      },
    ],
  },
  createSession: (opts) => new OpencodeSession(opts),
  createTerminalSession: (opts) => new OpencodeTerminalSession(opts),
  // Both runtimes share OpenCode's database. The store owns root-session
  // filtering and newest-first ordering; the host only projects the picker
  // contract. Discovery must use cwd, just like the eventual resumed process.
  listSessions: async (cwd, limit) =>
    toOpencodeSessionInfos((await opencodeDatabase.store()).listSessions({ directory: cwd, limit })),
  // The native-history control has no cwd. OpenCode's store answers a global
  // listing from the same statement (the directory filter is optional) and
  // returns each row's own directory, so the picker still shows the true
  // spawn directory per row rather than inventing one.
  listAllSessions: async limit =>
    toOpencodeSessionInfos((await opencodeDatabase.store()).listSessions({ limit })),
  // Opencode has no per-cwd project dir concept; the storage root is
  // server-owned. Returning cwd keeps consumers (which only display
  // it) harmless.
  getProjectDir: async (cwd) => cwd,
  // No durable transcript FILE exists, so generic file consumers get null.
  // History reads go through `loadHistoryChunk` instead: OpenCode's database,
  // opened read-only by opencode-terminal-headless, serves both runtimes'
  // parked panes, reloads and MCP reads. Writes and transforms (switch,
  // duplicate, rewind) stay on `opencode import`/`export` in the transcript
  // adapter.
  resolveTranscriptPath: async () => null,
  loadHistoryChunk: loadOpencodeHistoryChunk,
  // OpenCode names a session by `opencode://session/<id>`, a locator the
  // package mints and parses; it names a database row, not a file.
  transcriptLocator: opencodeTranscriptFile,
  parseTranscriptLocator: parseOpencodeTranscriptFile,
  // The session row's time_updated stands in for a JSONL file's mtime.
  // OpenCode rewrites that row when a prompt is submitted and again as each
  // step's summary lands, so it tracks the conversation, not just renames:
  // in every recorded session under opencode-terminal-headless's
  // testing/fixtures/durable it sits within seconds of the newest part write.
  // Null (session gone, database unreadable) means "do not publish".
  transcriptLastModifiedAt: async id => (await readOpencodeSessionInfo(id))?.timeUpdated ?? null,
  deliverPrompt: deliverOpencodePrompt,
}

// Typed as Record<AgentProviderKind, …> (not Record<string, …>) so that
// adding a kind to AGENT_PROVIDER_KINDS without registering a config here
// is a COMPILE error, not a runtime "Unknown provider" surprise. That is
// the compiler-enforced checklist for future provider integrations.
const mainProviders: Record<AgentProviderKind, MainProviderConfig> = {
  claude: claudeMain,
  codex: codexMain,
  opencode: opencodeMain,
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

export function listMainProviders(): readonly MainProviderConfig[] {
  // Return a new array rather than the exhaustive record: callers may iterate
  // capabilities, but they must not gain a mutable registry reference that can
  // bypass the compile-time AgentProviderKind coverage check above.
  return AGENT_PROVIDER_KINDS.map(kind => mainProviders[kind])
}
