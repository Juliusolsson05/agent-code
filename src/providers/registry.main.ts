// Main-process provider registry — Node-only, imports session factories.
//
// sessionManager and IPC handlers import from HERE.

import { join } from 'path'
import { GrokSession } from '@providers/grok/runtime/grokSession.js'
import { discoverGrokSkillRoots } from '@providers/grok/runtime/skillDiscovery.js'
import { deliverGrokPrompt } from '@providers/grok/runtime/promptDelivery.js'
import { resolveGrokTranscriptPath } from 'grok-code-headless'
import { discoverClaudeSkillRoots } from '@providers/claude/runtime/skillDiscovery'
import { discoverCodexSkillRoots } from '@providers/codex/runtime/skillDiscovery'
import { discoverOpencodeSkillRoots } from '@providers/opencode/runtime/skillDiscovery'
import { opencodeTranscriptFile, parseOpencodeTranscriptFile } from 'opencode-terminal-headless'
import { readOpencodeSessionInfo } from '@providers/opencode/runtime/opencodeDatabase'
import { PiSession } from '@providers/pi/runtime/piSession.js'
import { deliverPiPrompt } from '@providers/pi/runtime/promptDelivery.js'
import { discoverPiSkillRoots } from '@providers/pi/runtime/skillDiscovery.js'
import { resolvePiBridgeScript } from '@providers/pi/runtime/bridgeScript.js'
import { loadPiHistoryChunk } from '@providers/pi/runtime/piHistory.js'
import { resolvePiSessionFile } from 'pi-terminal-headless'

import type { MainProviderConfig } from '@shared/types/providerConfig'
import { AGENT_PROVIDER_KINDS, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { ClaudeSession } from '@providers/claude/runtime/claudeSession'
import { deliverClaudePrompt } from '@providers/claude/runtime/promptDelivery'
import { getProjectDirForCwd, resolveClaudeTranscriptPath } from 'claude-code-headless'
import { CodexSession } from '@providers/codex/runtime/codexSession'
import { deliverCodexPrompt } from '@providers/codex/runtime/promptDelivery'
import { OpencodeSession } from '@providers/opencode/runtime/opencodeSession'
import { OpencodeTerminalSession } from '@providers/opencode/runtime/opencodeTerminalSession'
import { loadOpencodeHistoryChunk } from '@providers/opencode/runtime/opencodeHistory'
import { deliverOpencodePrompt } from '@providers/opencode/runtime/promptDelivery'
import {
  findCodexRolloutPathByThreadId,
  getCodexSessionsDir,
} from 'codex-headless'

const claudeMain: MainProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  discoverSkillRoots: discoverClaudeSkillRoots,
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
  discoverSkillRoots: discoverCodexSkillRoots,
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
  discoverSkillRoots: discoverOpencodeSkillRoots,
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

const grokMain: MainProviderConfig = {
  id: 'grok',
  name: 'Grok',
  // Native Grok skill locations are unrecorded (see skillDiscovery.ts); the
  // adapter returns an empty root list with a visible notice rather than
  // inventing a layout.
  discoverSkillRoots: discoverGrokSkillRoots,
  // supported:false for the same reason: nothing observed says native Grok
  // reads the personal-agent skill folders, and the type demands a reason.
  personalAgentSkills: { supported: false, reason: 'Native Grok skill discovery is not yet recorded; personal agent skills are not claimed for Grok panes.' },
  // Grok has exactly one runtime shape — the native terminal — so both
  // factories are the same session (unlike OpenCode's two runtimes).
  createSession: (opts) => new GrokSession(opts),
  createTerminalSession: (opts) => new GrokSession(opts),
  // The native terminal runs in the pane's cwd, like Claude's and Codex's.
  getProjectDir: async (cwd) => cwd,
  // Grok history is a file the package resolves from cwd + session id; the
  // generic file readers (reload, preview, switching) consume this path.
  resolveTranscriptPath: async (cwd, providerSessionId) => resolveGrokTranscriptPath(cwd, providerSessionId),
  // No transcriptLocator: the file path is the identity, and the catalog's
  // stat fallback covers last-modified (a hand-rolled mtime here was dead
  // code — only locator providers get transcriptLastModifiedAt — and would
  // have resolved against the wrong cwd).
  deliverPrompt: deliverGrokPrompt,
}

const piMain: MainProviderConfig = {
  id: 'pi',
  name: 'Pi',
  discoverSkillRoots: discoverPiSkillRoots,
  // Pi reads ~/.agents/skills (verified in Stage 0: it picked up Agent Code's
  // managed skills from there) as well as its own <agentDir>/skills. The
  // shared `.agents` location is where Agent Code deploys, like Codex/OpenCode.
  personalAgentSkills: {
    supported: true,
    locations: [
      {
        id: 'agents-standard-personal-skills',
        resolveDirectory: ({ homeDirectory }) => join(homeDirectory, '.agents', 'skills'),
      },
    ],
  },
  // Pi is terminal-only (TERMINAL_ONLY_PROVIDER_KINDS): both factories are the
  // same native-TUI session, like Grok, so no factory choice can reach a
  // structured runtime that does not exist.
  createSession: (opts) => new PiSession(opts, { bridgeScriptPath: resolvePiBridgeScript() }),
  createTerminalSession: (opts) => new PiSession(opts, { bridgeScriptPath: resolvePiBridgeScript() }),
  getProjectDir: async (cwd) => cwd,
  // The transcript is a file; the path is its identity (no locator). Resolved
  // with Pi's own session-dir precedence by the package.
  resolveTranscriptPath: async (cwd, providerSessionId) =>
    resolvePiSessionFile({ env: process.env, cwd, sessionId: providerSessionId }),
  // …but the shared backwards JSONL reader must not page it: a Pi file is a
  // TREE, and a line-order walk would show turns a /tree move abandoned.
  // History pages come from the active branch instead.
  loadHistoryChunk: loadPiHistoryChunk,
  deliverPrompt: deliverPiPrompt,
}

// Typed as Record<AgentProviderKind, …> (not Record<string, …>) so that
// adding a kind to AGENT_PROVIDER_KINDS without registering a config here
// is a COMPILE error, not a runtime "Unknown provider" surprise. That is
// the compiler-enforced checklist for future provider integrations.
const mainProviders: Record<AgentProviderKind, MainProviderConfig> = {
  claude: claudeMain,
  codex: codexMain,
  opencode: opencodeMain,
  grok: grokMain,
  pi: piMain,
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
