import { describe, expect, it } from 'vitest'

import { mapOpencodeMessageToFeedEntries } from '@providers/opencode/renderer/transcript/mapper'
import type { Entry } from '@shared/types/transcript'

import { extractLatestUserPrompt, extractLatestUserPrompts } from './latestUserPrompts'

// View Prompts, Dispatch titles and composer ↑ history all ask "what did the
// user type?". Each provider marks its non-typed user rows differently, so
// each case below uses rows shaped the way that provider's feed produces
// them.

const userRow = (text: string, extra: Record<string, unknown> = {}): Entry => ({
  type: 'user',
  uuid: `u-${text}`,
  parentUuid: null,
  timestamp: '2026-09-11T10:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra,
} as Entry)

// OpenCode entries come from the real feed mapper, fed `{ info, parts }`
// records exactly as OpenCode's database holds them.
function opencodeEntries(): Entry[] {
  const records = [
    {
      info: { id: 'msg_1', sessionID: 'ses_1', role: 'user', time: { created: 1_000 } },
      parts: [
        { id: 'prt_1', type: 'text', text: 'Fix the failing parser test' },
        { id: 'prt_2', type: 'text', text: 'You are in plan mode. Do not edit files.', synthetic: true },
      ],
    },
    {
      info: { id: 'msg_2', sessionID: 'ses_1', role: 'assistant', time: { created: 2_000, completed: 3_000 }, finish: 'tool-calls' },
      parts: [{ id: 'prt_3', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'npm test' }, output: '1 failing' } }],
    },
    // OpenCode's own follow-up after a task tool: entirely synthetic.
    {
      info: { id: 'msg_3', sessionID: 'ses_1', role: 'user', time: { created: 4_000 } },
      parts: [{ id: 'prt_4', type: 'text', text: 'Summarize the task tool output above and continue with your task.', synthetic: true }],
    },
    {
      info: { id: 'msg_4', sessionID: 'ses_1', role: 'user', time: { created: 5_000 } },
      parts: [{ id: 'prt_5', type: 'text', text: '<div>render this</div> as JSX' }],
    },
  ]
  return records.flatMap(record => mapOpencodeMessageToFeedEntries(record).entries)
}

describe('latest user prompts', () => {
  it('lists what the user typed in an OpenCode session, not tool results or OpenCode\'s own instructions', () => {
    const entries = opencodeEntries()
    expect(extractLatestUserPrompts(entries, 'opencode').map(prompt => prompt.text)).toEqual([
      '<div>render this</div> as JSX',
      'Fix the failing parser test',
    ])
    expect(extractLatestUserPrompt(entries, 'opencode')?.text).toBe('<div>render this</div> as JSX')
  })

  it('keeps Claude\'s rule: only rows stamped with permissionMode, and no scaffolding', () => {
    const entries = [
      userRow('Rename the loader', { permissionMode: 'default' }),
      userRow('<command-name>/clear</command-name>'),
      userRow('<local-command-stdout>ok</local-command-stdout>', { permissionMode: 'default' }),
      userRow('tool output without a mode'),
    ]
    expect(extractLatestUserPrompts(entries, 'claude').map(prompt => prompt.text)).toEqual(['Rename the loader'])
    // Legacy sessions without a kind were Claude sessions.
    expect(extractLatestUserPrompts(entries, undefined).map(prompt => prompt.text)).toEqual(['Rename the loader'])
  })

  it('keeps Codex\'s rule: no permissionMode needed, context blocks skipped', () => {
    const entries = [
      userRow('<environment_context><cwd>/repo</cwd></environment_context>'),
      userRow('Run the tests'),
    ]
    expect(extractLatestUserPrompts(entries, 'codex').map(prompt => prompt.text)).toEqual(['Run the tests'])
  })
})
