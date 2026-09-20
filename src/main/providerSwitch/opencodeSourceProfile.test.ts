import { describe, expect, it } from 'vitest'

import { opencodeProfileFromExport } from './transcriptEngine.js'

// #1038: which model a duplicated or rewound OpenCode conversation keeps.
//
// The shape is OpenCode's own export envelope — `messages[].info.model` with
// `providerID`, `modelID` and an optional reasoning `variant` — which is
// exactly what the projector in agent-transcript-parser stamps on every
// imported user message (opencode/project/nativeResume.ts), so this reads
// back what a previous duplicate wrote.
const userMessage = (model: Record<string, unknown> | undefined, id = 'msg_1') => ({
  info: { id, sessionID: 'ses_source', role: 'user', time: { created: 1 }, agent: 'build', ...(model ? { model } : {}) },
  parts: [],
})
const assistantMessage = (model: Record<string, unknown>) => ({
  info: { id: 'msg_a', sessionID: 'ses_source', role: 'assistant', time: { created: 2 }, model },
  parts: [],
})

describe('the model an OpenCode export was last run with', () => {
  it('takes the LAST user message, which is what the conversation was on when it stopped', () => {
    // A conversation whose model changed mid-way: the later choice is the one
    // a copy continues with.
    expect(opencodeProfileFromExport({
      messages: [
        userMessage({ providerID: 'opencode', modelID: 'big-pickle' }),
        userMessage({ providerID: 'zai-coding-plan', modelID: 'glm-5.3', variant: 'max' }, 'msg_2'),
      ],
    })).toEqual({ model: 'glm-5.3', modelProvider: 'zai-coding-plan', modelVariant: 'max' })
  })

  it('keeps the variant only when there is one', () => {
    expect(opencodeProfileFromExport({ messages: [userMessage({ providerID: 'opencode', modelID: 'big-pickle' })] }))
      .toEqual({ model: 'big-pickle', modelProvider: 'opencode' })
  })

  it('ignores assistant messages, which carry the model as a different shape', () => {
    expect(opencodeProfileFromExport({
      messages: [userMessage({ providerID: 'zai-coding-plan', modelID: 'glm-5.3' }), assistantMessage({ id: 'other', providerID: 'x' })],
    })).toMatchObject({ model: 'glm-5.3' })
  })

  it('answers null for an export that records no model, so the caller keeps its own default', () => {
    // A blank OpenCode Terminal session: the durable identity exists before
    // the first prompt, so Duplicate is legitimately offered on it.
    expect(opencodeProfileFromExport({ messages: [] })).toBeNull()
    expect(opencodeProfileFromExport({ messages: [userMessage(undefined)] })).toBeNull()
    expect(opencodeProfileFromExport({ messages: [userMessage({ providerID: 'opencode' })] })).toBeNull()
    expect(opencodeProfileFromExport({})).toBeNull()
  })
})
