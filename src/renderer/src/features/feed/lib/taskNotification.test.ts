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
