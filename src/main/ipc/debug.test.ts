import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  order: [] as string[],
  saveDebugBundle: vi.fn(async () => {
    harness.order.push('save')
    return { bundlePath: '/tmp/test-bundle' }
  }),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler)
    },
  },
}))
vi.mock('@main/storage/debugBundle.js', () => ({
  saveDebugBundle: harness.saveDebugBundle,
}))
vi.mock('@main/storage/debugBundleLog.js', () => ({
  addDebugBundleNote: vi.fn(async () => {}),
  isAutosaveDebugBundleReason: (reason?: string | null) =>
    typeof reason === 'string' && reason.startsWith('autosave-'),
}))
vi.mock('@main/storage/feedDebugLog.js', () => ({
  queueFeedDebugAppend: vi.fn(async () => {}),
}))
vi.mock('@main/storage/proxyEventsReader.js', () => ({
  readProxyEventsForBundle: vi.fn(async () => null),
}))

const { registerDebugIpc } = await import('./debug.js')

function saveHandler(): (...args: unknown[]) => Promise<unknown> {
  const handler = harness.handlers.get('debug:save-bundle')
  if (!handler) throw new Error('debug:save-bundle was not registered')
  return handler as (...args: unknown[]) => Promise<unknown>
}

beforeEach(() => {
  harness.handlers.clear()
  harness.order.length = 0
  harness.saveDebugBundle.mockClear()
})

describe('debug bundle IPC lifecycle flush', () => {
  it('drains the app journal before a manual bundle reads its observation stream', async () => {
    const journal = {
      flush: vi.fn(async () => {
        harness.order.push('flush')
        return true
      }),
      getCompletenessSnapshot: vi.fn(() => ({
        capped: false,
        bytesWritten: 123,
        droppedEvents: 0,
      })),
    }
    registerDebugIpc(journal as never, {
      getCodexTranscriptObservationCompletenessSnapshot: () => ({ gapTrackingCapped: false }),
    })

    await saveHandler()({}, {
      sessionId: 's1',
      kind: 'codex',
      reason: 'manual',
      files: [{ name: 'manifest.json', content: '{}' }],
    })

    expect(harness.order).toEqual(['flush', 'save'])
    expect(journal.flush).toHaveBeenCalledTimes(1)
    expect(harness.saveDebugBundle).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1' }),
      {
        appRunJournalCompleteness: {
          capped: false,
          bytesWritten: 123,
          droppedEvents: 0,
          flushFailed: false,
        },
        codexTranscriptObservationCompleteness: { gapTrackingCapped: false },
      },
    )
  })

  it('keeps autosave cheap and identity-only by skipping the forced journal drain', async () => {
    const journal = {
      flush: vi.fn(async () => true),
      getCompletenessSnapshot: vi.fn(() => ({
        capped: false,
        bytesWritten: 0,
        droppedEvents: 0,
      })),
    }
    registerDebugIpc(journal as never, {
      getCodexTranscriptObservationCompletenessSnapshot: () => ({ gapTrackingCapped: false }),
    })

    await saveHandler()({}, {
      sessionId: 's1',
      kind: 'codex',
      reason: 'autosave-interval',
      files: [{ name: 'manifest.json', content: '{}' }],
    })

    expect(journal.flush).not.toHaveBeenCalled()
    expect(journal.getCompletenessSnapshot).not.toHaveBeenCalled()
    expect(harness.order).toEqual(['save'])
  })

  it('still saves the core bundle when the forensic journal reports a failed append', async () => {
    const journal = {
      flush: vi.fn(async () => false),
      getCompletenessSnapshot: vi.fn(() => ({
        capped: false,
        bytesWritten: 77,
        droppedEvents: 2,
      })),
    }
    registerDebugIpc(journal as never, {
      getCodexTranscriptObservationCompletenessSnapshot: () => ({ gapTrackingCapped: true }),
    })

    await expect(saveHandler()({}, {
      sessionId: 's1',
      kind: 'codex',
      reason: 'manual',
      files: [{ name: 'manifest.json', content: '{}' }],
    })).resolves.toEqual({ bundlePath: '/tmp/test-bundle' })
    expect(harness.order).toEqual(['save'])
    expect(harness.saveDebugBundle).toHaveBeenCalledWith(
      expect.anything(),
      {
        appRunJournalCompleteness: {
          capped: false,
          bytesWritten: 77,
          droppedEvents: 2,
          flushFailed: true,
        },
        codexTranscriptObservationCompleteness: { gapTrackingCapped: true },
      },
    )
  })
})
