import { formatWorktreeDumpPrompt } from '@renderer/features/worktrees/lib/formatWorktreeDump'
import { loadWorktreeDump } from '@renderer/features/worktrees/lib/loadWorktreeDump'
import type { Workspace } from '@renderer/workspace/workspaceStore'

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

const CUSTOM_TEMPLATES_KEY = 'cc-shell.promptTemplates.v1'

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
    body: 'Please analyze this cc-shell worktree status dump.',
    buildBody: async ({ workspace, sessionId }) => {
      const cwd = workspace.state.sessions[sessionId]?.cwd ?? null
      const dump = await loadWorktreeDump({ cwd, workspace, forceActivityRefresh: false })
      return formatWorktreeDumpPrompt(dump)
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
    const raw = window.localStorage.getItem(CUSTOM_TEMPLATES_KEY)
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
