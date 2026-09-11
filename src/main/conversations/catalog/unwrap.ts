// What an angle-bracket or heading prefix on a user record MEANS.
//
// WHY a closed list (docs/decomposition/conversations.md §2.3): the old
// listers dropped every `<`-prefixed text as "a Claude Code system wrapper".
// That is false for `<stt …>` (a prompt the user dictated), loses the task
// text inside `<orchestration-handoff>`, and does nothing about Codex's
// `# AGENTS.md instructions for …` injection, which is why every Codex row
// read the same. Each entry below is proven by a corpus record; a wrapper not
// listed is treated as "not a prompt", and the fixture that surfaces it is
// the signal to extend the list, never a heuristic.

export type UnwrappedUserText = {
  text: string
  wrapper: 'stt' | 'orchestration-handoff' | 'projected-handoff' | null
}

/** Injected by a provider or by Agent Code; never something the user meant as a prompt. */
const NOT_A_PROMPT_PREFIXES: readonly string[] = [
  '# AGENTS.md instructions for',
  '<environment_context>',
  '<command-name>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<recommended_plugins>',
  '<user_instructions>',
  '<system-reminder>',
  '<task-notification>',
]

const PROJECTED_PREFIXES: readonly string[] = ['# Handoff Summary', '# Portable handoff summary']

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function unwrapUserText(raw: string): UnwrappedUserText | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('<stt')) {
    const open = trimmed.indexOf('>')
    const close = trimmed.lastIndexOf('</stt>')
    const inner = open >= 0 ? trimmed.slice(open + 1, close > open ? close : undefined) : ''
    const text = collapse(inner)
    return text ? { text, wrapper: 'stt' } : null
  }

  if (trimmed.startsWith('<orchestration-handoff>')) {
    const taskOpen = trimmed.indexOf('<task>')
    const taskClose = trimmed.lastIndexOf('</task>')
    if (taskOpen >= 0) {
      const text = collapse(trimmed.slice(taskOpen + '<task>'.length, taskClose > taskOpen ? taskClose : undefined))
      if (text) return { text, wrapper: 'orchestration-handoff' }
    }
    const end = trimmed.indexOf('</orchestration-handoff>')
    const after = end >= 0 ? trimmed.slice(end + '</orchestration-handoff>'.length) : ''
    const text = collapse(after)
    return text ? { text, wrapper: 'orchestration-handoff' } : { text: 'Orchestration child', wrapper: 'orchestration-handoff' }
  }

  for (const prefix of PROJECTED_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      // The summary body is the previous provider's whole conversation; its
      // first sub-heading is the most recognisable one-line handle.
      const heading = trimmed.split('\n').map(l => l.trim()).find(l => /^##+\s+\S/.test(l))
      return { text: heading ? collapse(heading.replace(/^#+\s+/, '')) : 'Continued conversation', wrapper: 'projected-handoff' }
    }
  }

  for (const prefix of NOT_A_PROMPT_PREFIXES) {
    if (trimmed.startsWith(prefix)) return null
  }
  if (trimmed.startsWith('<')) return null

  return { text: collapse(trimmed), wrapper: null }
}

export function firstUnwrappedPrompt(userTexts: readonly string[]): UnwrappedUserText | null {
  for (const raw of userTexts) {
    const unwrapped = unwrapUserText(raw)
    if (unwrapped) return unwrapped
  }
  return null
}
