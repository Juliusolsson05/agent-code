import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { formatWorktreeDumpPrompt } from '@renderer/features/worktrees/lib/formatWorktreeDump'
import { loadWorktreeDump } from '@renderer/features/worktrees/lib/loadWorktreeDump'
import type { PromptTemplate, PromptTemplateContext } from '@renderer/features/prompt-templates/types'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { buildProviderResumeCommand } from '@renderer/workspace/providerResumeCommand'

type AgentTranscriptRequest = {
  sessionId: string
  kind: AgentProviderKind
  cwd: string
  providerSessionId: string
}

type AgentTranscriptResolved = AgentTranscriptRequest & {
  transcriptPath: string | null
  exists: boolean
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
  // resolveTabSessions composes the same union (grid leaves ∪
  // detached Dispatch agents owned by this tab) the manual concat
  // used to do. It deliberately does NOT strip pinned sessions, which
  // is what we want here — the dispatch-UI selector strips pinned for
  // a display concern (Pinned section renders them exclusively at the
  // top of the Dispatch list); the generated prompt is content, not
  // display, so a pinned agent that visibly lives in this tab must
  // still appear.
  //
  // We deliberately do NOT include `state.buried` entries even when
  // `sourceTabId === tab.id`. Burying a pane is the user's signal
  // that they have put it away; surfacing it back into an LLM context
  // without prompting would defeat that. resolveTabSessions already
  // excludes buried entries.
  const sessionIds = resolveTabSessions(workspace.state, tab.id)
  return sessionIds.flatMap(sessionId => {
    const meta = workspace.state.sessions[sessionId]
    const kind = meta?.kind ?? DEFAULT_PROVIDER
    // Registry-driven: prompt templates that reference "the other agents in
    // this tab" must include every agent provider on the tab, not just the
    // two-provider pair. A dropped OpenCode session here would mean the
    // template LLM never sees that agent — silently narrowing the context
    // window in ways the user cannot detect.
    if (!isAgentProviderKind(kind) || !meta?.providerSessionId) {
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
    const label = getRendererProviderCapabilities(agent.kind).shortLabel
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
      fenced(buildProviderResumeCommand(agent.kind, agent.cwd, agent.providerSessionId)),
      '',
    )
  })

  return lines.join('\n')
}

export const builtinPromptTemplates: PromptTemplate[] = [
  // The first two built-ins are deliberately ordered ahead of the older
  // three. `allPromptTemplates` returns custom templates first and then
  // this array verbatim, so array position is the palette's TIEBREAK
  // ordering — what you see with an empty query, and what settles ties
  // between equally-relevant matches. It is no longer the only signal:
  // once the user types, `rankEntries` orders by match strength first
  // (see `filteredPromptTemplates`). It used to be the only signal, which
  // is exactly why searching "read this p" used to bury the entry below.
  // These two are the ones reached for constantly (every fresh agent, and
  // as a follow-up to almost any long answer), so they get the top slots.
  {
    id: 'builtin:context-bootstrap',
    // Titled for what the user would type, not for what the feature is
    // called internally: nobody searching for this types "bootstrap" —
    // they type "read" or "project". The title is the `primary` match
    // field, so typing it from the start is the strongest signal the
    // ranker has and this row wins outright.
    title: 'Read This Project',
    description: 'Bootstrap a fresh agent with what this project actually is.',
    scope: 'builtin',
    insertMode: 'replace',
    variables: [],
    body: [
      'Please read what this project is for me — README, CLAUDE.md/AGENTS.md, and the repo layout.',
      '',
      'Tell me what it is, why it exists, how it works, and any conventions I would get wrong.',
      // Load-bearing final line. Without an explicit stop, a fresh agent
      // reliably reads two or three files and then starts "helpfully"
      // editing something it has only half-understood. The whole point of
      // this template is to spend a turn on comprehension and nothing else.
      'Do not change anything yet. This is context bootstrapping.',
    ].join('\n'),
  },
  {
    id: 'builtin:adhd-friendly-breakdown',
    title: 'ADHD-Friendly Breakdown',
    description: 'Re-explain the last answer as scannable chunks instead of prose.',
    scope: 'builtin',
    insertMode: 'replace',
    variables: [],
    // Intentionally a single sentence with no formatting instructions
    // appended. Longer drafts that spelled out "short chunks, bold the key
    // thing, no long paragraphs" did not measurably beat the bare phrase —
    // models already have a strong prior for it — and the extra lines only
    // made the inserted draft more tedious to edit before sending.
    body: 'Give me that in an ADHD-friendly breakdown.',
  },
  {
    id: 'builtin:ask-agent-for-review-prompt',
    title: 'Ask Agent For Review Prompt',
    description: 'Draft a self-contained prompt for another agent to review this work.',
    scope: 'builtin',
    insertMode: 'replace',
    variables: [],
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
    insertMode: 'replace',
    variables: [],
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
    insertMode: 'replace',
    variables: [],
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

export function allPromptTemplates(customTemplates: PromptTemplate[]): PromptTemplate[] {
  return [...customTemplates, ...builtinPromptTemplates]
}
