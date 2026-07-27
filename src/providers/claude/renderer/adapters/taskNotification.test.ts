import { describe, expect, it } from 'vitest'

import {
  parseTaskNotification,
  taskNotificationFromEntry,
  taskNotificationStatusKind,
} from './taskNotification'

const REAL_SHAPE = `<task-notification>
<task-id>t-42</task-id>
<tool-use-id>toolu_bg7</tool-use-id>
<status>completed</status>
<summary>Review AppRunJournal engine</summary>
<usage>27.5k tokens · 13 tools · 98s</usage>
<result>## Findings

The engine handles <result-like> markup and *markdown* fine.
</result>
</task-notification>`

describe('parseTaskNotification', () => {
  it('parses the full real shape, result body kept verbatim', () => {
    const n = parseTaskNotification(REAL_SHAPE)
    expect(n?.taskId).toBe('t-42')
    expect(n?.toolUseId).toBe('toolu_bg7')
    expect(n?.status).toBe('completed')
    expect(n?.usage).toBe('27.5k tokens · 13 tools · 98s')
    expect(n?.result).toContain('<result-like> markup and *markdown*')
  })

  it('tolerates missing optional tags', () => {
    const n = parseTaskNotification('<task-notification><status>failed</status></task-notification>')
    expect(n?.status).toBe('failed')
    expect(n?.toolUseId).toBeNull()
    expect(taskNotificationStatusKind(n!)).toBe('error')
  })

  it('classifies the statusless stall watchdog as attention, not success', () => {
    // LocalShellTask.startStallWatchdog emits NO <status> on purpose (print.ts
    // treats <status> as terminal and would falsely close the task). Callers
    // rendered `error ? '✗' : '✓'`, so a background command BLOCKED on an
    // interactive prompt showed a green check — the most misleading state this
    // surface can paint, since the watchdog exists to ask for a human.
    const n = parseTaskNotification(`<task-notification>
<task-id>t-99</task-id>
<output-file>/tmp/t-99</output-file>
<summary>Background command "migrate" appears to be waiting for interactive input</summary>
</task-notification>`)
    expect(n?.status).toBeNull()
    expect(taskNotificationStatusKind(n!)).toBe('attention')
  })

  it('keeps an unrecognised status distinct from attention', () => {
    // 'other' means "a status we do not recognise", which is not a call for
    // attention. Collapsing the two would put the ⏸ glyph on ordinary states.
    const n = parseTaskNotification(
      `<task-notification><status>queued</status><summary>x</summary></task-notification>`,
    )
    expect(taskNotificationStatusKind(n!)).toBe('other')
  })

  it('bounds status and usage before they become joined headline text', () => {
    const n = parseTaskNotification(`<task-notification>
      <tool-use-id>exact-correlation-id</tool-use-id>
      <status>${'s'.repeat(500)}</status>
      <usage>${'u'.repeat(500)}</usage>
    </task-notification>`)
    expect(n?.toolUseId).toBe('exact-correlation-id')
    expect(n?.status?.length).toBe(120)
    expect(n?.usage?.length).toBe(240)
  })

  it('rejects non-notification text', () => {
    expect(parseTaskNotification('<command-name>/compact</command-name>')).toBeNull()
  })
})

describe('taskNotificationFromEntry', () => {
  it('reads string and block-array content, user rows only', () => {
    const base = { type: 'user', message: { role: 'user' } }
    const s = { ...base, message: { role: 'user', content: REAL_SHAPE } }
    const a = { ...base, message: { role: 'user', content: [{ type: 'text', text: REAL_SHAPE }] } }
    expect(taskNotificationFromEntry(s as never)?.toolUseId).toBe('toolu_bg7')
    expect(taskNotificationFromEntry(a as never)?.toolUseId).toBe('toolu_bg7')
    const assistant = { type: 'assistant', message: { role: 'assistant', content: REAL_SHAPE } }
    expect(taskNotificationFromEntry(assistant as never)).toBeNull()
  })
})
