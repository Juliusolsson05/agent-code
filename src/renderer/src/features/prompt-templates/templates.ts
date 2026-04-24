export type PromptTemplate = {
  id: string
  title: string
  description: string
  body: string
  scope: 'builtin' | 'custom'
  createdAt?: number
  updatedAt?: number
}

const CUSTOM_TEMPLATES_KEY = 'cc-shell.promptTemplates.v1'

export const builtinPromptTemplates: PromptTemplate[] = [
  {
    id: 'builtin:investigate-rendering',
    title: 'Deep Bug Investigation',
    description: 'Read logs and code first, identify root causes before patching.',
    scope: 'builtin',
    body: [
      'Please investigate this deeply before patching.',
      '',
      'Symptoms:',
      '- ',
      '',
      'What I want:',
      '- Read the relevant logs and code paths closely.',
      '- Check timestamps, duplicate events, ordering, and ownership/state transitions.',
      '- Identify likely root causes and explain the evidence.',
      '- Only patch once the failure mode is concrete.',
      '',
      'Constraints:',
      '- Keep changes scoped.',
      '- Preserve existing behavior unless it is part of the bug.',
      '- Add comments explaining why the fix is shaped this way.',
    ].join('\n'),
  },
  {
    id: 'builtin:code-review',
    title: 'Code Review',
    description: 'Review a diff for bugs, regressions, and missing tests.',
    scope: 'builtin',
    body: [
      'Please review this like a senior engineer.',
      '',
      'Focus on:',
      '- Bugs or behavioral regressions.',
      '- State, lifecycle, concurrency, or ordering risks.',
      '- Missing tests or weak verification.',
      '- Places where the implementation conflicts with existing architecture.',
      '',
      'Return findings first, ordered by severity, with file/line references.',
    ].join('\n'),
  },
  {
    id: 'builtin:refactor-safely',
    title: 'Refactor Safely',
    description: 'Make a scoped refactor while preserving behavior.',
    scope: 'builtin',
    body: [
      'Please refactor this safely.',
      '',
      'Goals:',
      '- Preserve behavior.',
      '- Match the existing codebase patterns.',
      '- Keep the diff focused and avoid unrelated cleanup.',
      '- Explain any tradeoffs in comments where future readers need the why.',
      '',
      'Verification:',
      '- Run the narrowest useful tests/build checks.',
      '- Call out anything that could not be verified.',
    ].join('\n'),
  },
  {
    id: 'builtin:write-tests',
    title: 'Write Tests',
    description: 'Add focused tests for a behavior or regression.',
    scope: 'builtin',
    body: [
      'Please add focused tests for this behavior.',
      '',
      'Behavior to cover:',
      '- ',
      '',
      'Expectations:',
      '- Prefer existing test utilities and local style.',
      '- Cover the regression path, not only the happy path.',
      '- Keep the tests readable and deterministic.',
      '- Run the relevant test command and report the result.',
    ].join('\n'),
  },
  {
    id: 'builtin:explain-code',
    title: 'Explain Code Path',
    description: 'Trace how a feature works through the codebase.',
    scope: 'builtin',
    body: [
      'Please explain this code path from entry point to render/effect.',
      '',
      'I care about:',
      '- Source of truth.',
      '- State transitions.',
      '- Important side effects.',
      '- Where errors or races are likely.',
      '',
      'Use concrete file references and keep the explanation grounded in the code.',
    ].join('\n'),
  },
]

function normalizeCustomTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    if (typeof record.title !== 'string') return []
    if (typeof record.body !== 'string') return []
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
  const next = [template, ...loadCustomPromptTemplates()]
  window.localStorage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(next))
  return template
}

export function allPromptTemplates(customTemplates = loadCustomPromptTemplates()): PromptTemplate[] {
  return [...customTemplates, ...builtinPromptTemplates]
}
