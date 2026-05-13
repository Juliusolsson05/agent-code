import { formatWorktreeDumpPrompt } from '@renderer/features/worktrees/lib/formatWorktreeDump'
import { loadWorktreeDump } from '@renderer/features/worktrees/lib/loadWorktreeDump'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { detachedDispatchSessionIdsForTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import {
  LEGACY_PROMPT_TEMPLATES_STORAGE_KEY,
  PROMPT_TEMPLATES_STORAGE_KEY,
} from '@renderer/app-state/localStorageMigration'

export type PromptTemplateContext = {
  workspace: Workspace
  sessionId: string
}

export type PromptTemplate = {
  id: string
  title: string
  description: string
  body: string
  buildBody?: (context: PromptTemplateContext) => string | Promise<string>
  scope: 'builtin' | 'custom'
  createdAt?: number
  updatedAt?: number
}

const CUSTOM_TEMPLATES_KEY = PROMPT_TEMPLATES_STORAGE_KEY

type AgentTranscriptRequest = {
  sessionId: string
  kind: 'claude' | 'codex'
  cwd: string
  providerSessionId: string
}

type AgentTranscriptResolved = AgentTranscriptRequest & {
  transcriptPath: string | null
  exists: boolean
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildResumeCommand(kind: 'claude' | 'codex', cwd: string, providerSessionId: string): string {
  const cd = `cd ${shellQuote(cwd)}`
  const resume = kind === 'codex'
    ? `codex resume ${shellQuote(providerSessionId)}`
    : `claude --resume ${shellQuote(providerSessionId)}`
  return `${cd} && ${resume}`
}

function activeTabAgentTranscriptRequests(workspace: Workspace): AgentTranscriptRequest[] {
  const tab = workspace.activeTab
  if (!tab) return []

  // The template is active-tab scoped, but "in this tab" means BOTH the
  // visible tile tree AND the detached Dispatch agents owned by this tab.
  //
  // We used to only walk `collectLeaves(tab.root)` here, which silently
  // dropped every agent the user had moved into Dispatch Mode for this
  // tab. The symptom was running the template with ten agents present
  // and getting two in the output (only the panes left in the grid).
  // Detached agents are still "in" the tab — they share its
  // `projectTabId` and show up in that tab's Dispatch view — so they
  // belong in the prompt context too.
  //
  // We intentionally compose the two atomic selectors instead of going
  // through `dispatchSessionIdsForTab`. That higher-level selector
  // routes through `buildDispatchGroups`, which strips pinned sessions
  // out of their project group so the Pinned section can render them
  // exclusively at the top of the dispatch UI. That exclusion is a
  // display concern, not a scoping concern — if we reused it here, a
  // pinned agent that visibly lives in this tab would be missing from
  // the generated prompt with no obvious reason why.
  //
  // We deliberately do NOT include `state.buried` entries even when
  // `sourceTabId === tab.id`. Burying a pane is the user's signal that
  // they have put it away; surfacing it back into an LLM context
  // without prompting would defeat that.
  //
  // The types-level invariant (see `WorkspaceState.sessions` doc in
  // workspace/types.ts) is that a session is in the tile tree OR in
  // `detachedSessions`, never both — so we don't strictly need to
  // dedupe, but a Set guard is cheap insurance against a future bug
  // that violates that invariant producing duplicate entries in the
  // generated prompt.
  const seen = new Set<string>()
  const sessionIds = [
    ...collectLeaves(tab.root),
    ...detachedDispatchSessionIdsForTab(workspace.state, tab.id),
  ]
  return sessionIds.flatMap(sessionId => {
    if (seen.has(sessionId)) return []
    seen.add(sessionId)
    const meta = workspace.state.sessions[sessionId]
    const kind = meta?.kind ?? 'claude'
    if ((kind !== 'claude' && kind !== 'codex') || !meta?.providerSessionId) {
      return []
    }
    return [{
      sessionId,
      kind,
      cwd: meta.cwd,
      providerSessionId: meta.providerSessionId,
    }]
  })
}

function fenced(value: string): string {
  return ['```text', value, '```'].join('\n')
}

function buildActiveTabTranscriptPrompt(
  tabTitle: string,
  agents: AgentTranscriptResolved[],
): string {
  const lines: string[] = [
    'Please read the active-tab agent transcripts below and use them as context for this task.',
    '',
    `Tab: ${tabTitle}`,
    `Agent transcripts: ${agents.length}`,
    '',
    'These files are provider JSONL transcripts. Treat them as read-only evidence, not files to edit.',
    '',
    'How to read them:',
    '- Codex: use shell reads such as `tail -n 200 "<path>"` for recent context, or parse the JSONL line by line when you need the full thread.',
    '- Claude: use Read on the exact path when practical, or Bash `tail -n 200 "<path>"` for a bounded first pass.',
    '- Each JSONL line is one event/object. If the transcript is large, start at the tail and only expand earlier when recent context is insufficient.',
    '',
  ]

  if (agents.length === 0) {
    lines.push('No active-tab Claude/Codex transcript paths were available.')
    return lines.join('\n')
  }

  agents.forEach((agent, index) => {
    const label = agent.kind === 'codex' ? 'Codex' : 'Claude'
    const transcriptPath = agent.transcriptPath ?? '(transcript path not found)'
    lines.push(
      `## ${index + 1}. ${label} agent`,
      '',
      `Agent Code session id: \`${agent.sessionId}\``,
      `provider session id: \`${agent.providerSessionId}\``,
      `provider: \`${agent.kind}\``,
      'cwd:',
      fenced(agent.cwd),
      'transcript:',
      fenced(transcriptPath),
      `transcript exists: ${agent.exists ? 'yes' : 'no'}`,
      'resume command:',
      fenced(buildResumeCommand(agent.kind, agent.cwd, agent.providerSessionId)),
      '',
    )
  })

  return lines.join('\n')
}

export const builtinPromptTemplates: PromptTemplate[] = [
  {
    id: 'builtin:ask-agent-for-review-prompt',
    title: 'Ask Agent For Review Prompt',
    description: 'Draft a self-contained prompt for another agent to review this work.',
    scope: 'builtin',
    body: [
      'Please write a prompt I can send to another agent to review the work we just did.',
      '',
      'The prompt should:',
      '- Explain the goal of the change.',
      '- Summarize the important files and behavior touched.',
      '- Ask the reviewing agent to look for bugs, regressions, missing tests, and architectural concerns.',
      '- Include any context from this conversation or current repo state that would help the reviewer.',
      '- Be self-contained so I can paste it into a fresh agent.',
      '',
      'Do not review the work yourself. Only write the review prompt.',
    ].join('\n'),
  },
  {
    id: 'builtin:analyze-worktree-dump',
    title: 'Analyze Worktree Dump',
    description: 'Insert a live status dump for all Git worktrees in the focused project.',
    scope: 'builtin',
    body: 'Please analyze this Agent Code worktree status dump.',
    buildBody: async ({ workspace, sessionId }) => {
      const cwd = workspace.state.sessions[sessionId]?.cwd ?? null
      const dump = await loadWorktreeDump({ cwd, workspace, forceActivityRefresh: false })
      return formatWorktreeDumpPrompt(dump)
    },
  },
  {
    id: 'builtin:active-tab-agent-transcripts',
    title: 'Active Tab Agent Transcripts',
    description: 'Insert transcript paths and read instructions for every agent in this tab (grid + Dispatch).',
    scope: 'builtin',
    body: 'Please read the active-tab agent transcripts and use them as context.',
    buildBody: async ({ workspace }) => {
      const tab = workspace.activeTab
      const requests = activeTabAgentTranscriptRequests(workspace)
      const resolved = requests.length > 0
        ? await window.api.resolveTranscriptPaths(requests)
        : []
      return buildActiveTabTranscriptPrompt(tab?.title ?? 'Untitled', resolved)
    },
  },
]

function normalizeCustomTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    if (typeof record.title !== 'string') return []
    if (typeof record.body !== 'string') return []
    if (seen.has(record.id)) return []
    seen.add(record.id)
    return [{
      id: record.id,
      title: record.title,
      description: typeof record.description === 'string' ? record.description : 'Saved locally',
      body: record.body,
      scope: 'custom' as const,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : undefined,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
    }]
  })
}

function saveCustomPromptTemplates(templates: PromptTemplate[]): void {
  window.localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(templates))
}

export function loadCustomPromptTemplates(): PromptTemplate[] {
  try {
    const raw =
      window.localStorage.getItem(CUSTOM_TEMPLATES_KEY) ??
      window.localStorage.getItem(LEGACY_PROMPT_TEMPLATES_STORAGE_KEY)
    if (!raw) return []
    return normalizeCustomTemplates(JSON.parse(raw))
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
  } catch {
    return []
  }
}

export function saveCustomPromptTemplate(title: string, body: string): PromptTemplate {
  const now = Date.now()
  const template: PromptTemplate = {
    id: `custom:${crypto.randomUUID()}`,
    title: title.trim(),
    description: 'Saved locally',
    body,
    scope: 'custom',
    createdAt: now,
    updatedAt: now,
  }
  saveCustomPromptTemplates([template, ...loadCustomPromptTemplates()])
  return template
}

export function updateCustomPromptTemplate(
  id: string,
  title: string,
  body: string,
): PromptTemplate | null {
  const now = Date.now()
  let updated: PromptTemplate | null = null
  const next = loadCustomPromptTemplates().map(template => {
    if (template.id !== id) return template
    updated = {
      ...template,
      title: title.trim(),
      body,
      updatedAt: now,
    }
    return updated
  })
  if (!updated) return null
  saveCustomPromptTemplates(next)
  return updated
}

export function deleteCustomPromptTemplate(id: string): void {
  saveCustomPromptTemplates(loadCustomPromptTemplates().filter(template => template.id !== id))
}

export function allPromptTemplates(customTemplates = loadCustomPromptTemplates()): PromptTemplate[] {
  return [...customTemplates, ...builtinPromptTemplates]
}
