import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
  },
}))
vi.mock('../pasteDebugJournal.js', () => ({
  readRecentPasteSessions: vi.fn(() => []),
}))

const { registerDevDebugIpc } = await import('./devDebug.js')

afterEach(() => {
  delete process.env.AGENT_CODE_DEV_DEBUG
  harness.handlers.clear()
})

describe('dev-debug recording provenance', () => {
  it('seeds a mid-session recorder from the trusted main run id', () => {
    process.env.AGENT_CODE_DEV_DEBUG = '1'
    const startRecording = vi.fn()
    const recordingGeneration = vi.fn(() => 'recording-generation')
    registerDevDebugIpc({ startRecording, recordingGeneration } as never, {
      getSessionRunId: () => '71717171-7171-4171-8171-717171717171',
    })
    const start = harness.handlers.get('record-session:start')
    if (!start) throw new Error('record-session:start was not registered')

    expect(start({}, '70707070-7070-4070-8070-707070707070', 'codex')).toEqual({
      recording: true,
      generation: 'recording-generation',
    })
    expect(startRecording).toHaveBeenCalledWith(
      '70707070-7070-4070-8070-707070707070',
      {
        kind: 'codex',
        sessionRunId: '71717171-7171-4171-8171-717171717171',
      },
    )
  })
})
