import { describe, expect, it } from 'vitest'

import { splitReasoning, stabilizeChat, type ChatItem } from './chatProjection'

// Fixture provenance: the reasoning texts are copied verbatim from the owner's
// debug bundle (debug-bundles/manual/2026-10-14T16-26-49-613-5da95adc,
// html-clean.html, reasoning rows 402 and 423; the Codex route on v0.22.0).
const AUDIT = '**Auditing comprehensive Hermes setup** **Verifying GitHub MCP and backup status** **Checking Gmail watcher cron status** I’m running a full live audit now: model/auth, gateway, memory, MCPs, Google, cron jobs, backups, and the still-missing integrations.'
const HEADINGS_ONLY = '**Investigating missing host gateway ownership** **Verifying gateway status and metadata sources**'

describe('Hermes progress updates inside reasoning', () => {
  it('shows the progress prose and keeps the headings for the disclosure', () => {
    const { headings, prose } = splitReasoning(AUDIT)
    expect(headings).toEqual(['Auditing comprehensive Hermes setup', 'Verifying GitHub MCP and backup status', 'Checking Gmail watcher cron status'])
    expect(prose).toBe('I’m running a full live audit now: model/auth, gateway, memory, MCPs, Google, cron jobs, backups, and the still-missing integrations.')
  })

  it('has no visible prose for a headings-only block, or for reasoning without headings', () => {
    expect(splitReasoning(HEADINGS_ONLY).prose).toBe('')
    // Plain reasoning (no summary headings) stays private in the disclosure.
    expect(splitReasoning('Let me check the config first.').prose).toBe('')
  })
})

describe('stabilizeChat', () => {
  it('reuses unchanged rows so memoized rows skip, and replaces changed ones', () => {
    const tool: ChatItem = { kind: 'tool', key: 't', toolUseId: 't', name: 'terminal', label: 'ls', status: 'done', input: {}, result: 'x' }
    const live: ChatItem = { kind: 'assistant', key: 'a', text: 'Hel', streaming: true }
    const first = stabilizeChat(null, [tool, live])
    const second = stabilizeChat(first, [{ ...tool }, { ...live, text: 'Hello' }])
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
  })
})
