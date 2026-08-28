// Main-process provider registry — Node-only, imports session factories.
//
// sessionManager and IPC handlers import from HERE.

import { join } from 'path'

import type { MainProviderConfig } from '@shared/types/providerConfig'
import { AGENT_PROVIDER_KINDS, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { ClaudeSession } from '@providers/claude/runtime/claudeSession'
import { listAllClaudeSessions } from '@providers/claude/runtime/sessionList'
import { deliverClaudePrompt } from '@providers/claude/runtime/promptDelivery'
import { listSessionsForCwd, getProjectDirForCwd } from 'claude-code-headless'
import { CodexSession } from '@providers/codex/runtime/codexSession'
import { deliverCodexPrompt } from '@providers/codex/runtime/promptDelivery'
import { OpencodeSession } from '@providers/opencode/runtime/opencodeSession'
import { deliverOpencodePrompt } from '@providers/opencode/runtime/promptDelivery'
import {
  findCodexRolloutPathByThreadId,
  getCodexSessionsDir,
  listCodexSessions,
} from 'codex-headless'

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
  resolveTranscriptPath: async (cwd, providerSessionId) =>
    join(await getProjectDirForCwd(cwd), `${providerSessionId}.jsonl`),
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

// STATUS (#406, wiring step 2 of 7): compile-green stub config. The
// stub session fails loudly on start(); listSessions/resolveTranscript
// degradations are the documented smallest-viable resolutions from the
// gap analysis. Steps 3–6 make the pane real before this branch merges.
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
  // No offline session listing yet: opencode stores sessions in
  // SQLite behind a server API (#406 blocker 1). Empty list = resume
  // picker shows nothing; fresh spawns unaffected. The ephemeral-
  // server lister is a step-7 follow-up.
  listSessions: async () => [],
  // Opencode has no per-cwd project dir concept; the storage root is
  // server-owned. Returning cwd keeps consumers (which only display
  // it) harmless.
  getProjectDir: async (cwd) => cwd,
  // No durable transcript FILE exists (#406 blocker 2): initial
  // history arrives via the start-time committed replay, not the
  // file loader. Every consumer types string|null and degrades.
  resolveTranscriptPath: async () => null,
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
