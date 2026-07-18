import { afterEach, describe, expect, it, vi } from 'vitest'

import { deliverClaudePrompt } from './promptDelivery.js'
import type { PromptDeliveryIo } from '@shared/types/providerConfig.js'

// Pins the never-ending short-prompt delivery bug ("did not confirm pasted
// prompt before submit (timeout)" for EVERY phone / dictated prompt): Claude's
// TUI only renders the `[Pasted text #N]` placeholder for pastes it COLLAPSES
// (big single-line / multiline). Everything smaller — including every dictated
// prompt, since the <stt> wrapper adds newlines and forces the paste route —
// is INLINED with no placeholder. The old delivery hard-required the
// placeholder, so it timed out and left the prompt stuck in the composer. The
// fix confirms on placeholder OR inline tail (shared @shared/claude/
// pasteConfirm), the same content-match the desktop composer uses.

// snapshotScreen is called once for the baseline (BEFORE the paste is written),
// then polled after. The mock returns '' for the baseline and `afterPaste` on
// every subsequent read, so the detector sees the paste land as a transition.
function makeIo(prompt: string, afterPaste: string): {
  io: PromptDeliveryIo
  writes: string[]
  snapshotScreen: ReturnType<typeof vi.fn>
} {
  const writes: string[] = []
  let calls = 0
  const snapshotScreen = vi.fn(() => {
    calls += 1
    return calls === 1 ? '' : afterPaste
  })
  const io = {
    sessionId: 's1',
    prompt,
    write: (data: string) => {
      writes.push(data)
      return true
    },
    session: {
      snapshotScreen,
      armPromptAcceptance: () => ({
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
        cancel: vi.fn(),
      }),
    },
  } as unknown as PromptDeliveryIo
  return { io, writes, snapshotScreen }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('deliverClaudePrompt routing', () => {
  it('waits for transcript replay readiness before writing any prompt bytes', async () => {
    let releaseReady!: () => void
    const ready = new Promise<
      { kind: 'ready'; waitedMs: number }
    >(resolve => {
      releaseReady = () => resolve({ kind: 'ready', waitedMs: 250 })
    })
    const { io, writes } = makeIo('fix the bug', '❯ fix the bug')
    io.session.awaitReadyForPrompt = vi.fn(() => ready)

    const delivery = deliverClaudePrompt(io)
    await Promise.resolve()
    expect(writes).toEqual([])

    releaseReady()
    await expect(delivery).resolves.toMatchObject({ ok: true })
    expect(writes).toEqual(['fix the bug', '\r'])
  })

  it('returns a retry-safe pre-write failure when replay readiness times out', async () => {
    const { io, writes } = makeIo('fix the bug', '❯ fix the bug')
    io.session.awaitReadyForPrompt = vi.fn(async () => ({
      kind: 'timeout' as const,
      waitedMs: 12_000,
      lastState: { kind: 'warming' as const, reason: 'composer-unpainted' as const },
    }))

    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({
      ok: false,
      stage: 'before-write',
      code: 'not-ready',
      retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false,
      enterWritten: false,
    })
    expect(writes).toEqual([])
  })

  it.each([
    [
      { kind: 'blocked' as const, condition: 'claude.trust-dialog', resolvable: true },
      'retry-after-resolve',
    ],
    [
      { kind: 'occupied' as const, reason: 'human-draft' as const },
      'retry-after-resolve',
    ],
    [
      { kind: 'terminal' as const, reason: 'exited' as const },
      'session-unusable',
    ],
  ])('maps readiness state to an explicit session disposition', async (readiness, disposition) => {
    const { io, writes } = makeIo('fix the bug', '❯ fix the bug')
    io.session.awaitReadyForPrompt = vi.fn(async () => readiness)

    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({
      ok: false,
      retrySafe: true,
      disposition,
      promptWritten: false,
    })
    expect(writes).toEqual([])
  })

  it('charges readiness time against the later acceptance budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { io } = makeIo('fix the bug', '❯ fix the bug')
    let acceptanceTimeoutMs = -1
    io.session.awaitReadyForPrompt = vi.fn(async () => {
      vi.setSystemTime(11_000)
      return { kind: 'ready' as const, waitedMs: 10_000 }
    })
    io.session.armPromptAcceptance = (_prompt, opts) => {
      acceptanceTimeoutMs = opts?.timeoutMs ?? -1
      return {
        promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
        cancel: vi.fn(),
      }
    }

    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(acceptanceTimeoutMs).toBe(18_000)
  })

  it('short single-line prompts prove composer absorption before a separate Enter', async () => {
    const { io, writes, snapshotScreen } = makeIo('fix the bug', '❯ fix the bug')
    const result = await deliverClaudePrompt(io)
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'user' } })
    expect(writes).toEqual(['fix the bug', '\r'])
    expect(snapshotScreen).toHaveBeenCalled()
  })

  it('short MULTILINE prompts (incl. dictated <stt>) confirm via the INLINE tail — the fix', async () => {
    const prompt = 'line one\nline two'
    // Claude inlines this (too small to collapse) — NO placeholder, just the
    // text in the composer. The tail must be findable in the screen.
    const { io, writes } = makeIo(prompt, '❯ line one line two')
    const result = await deliverClaudePrompt(io)
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'user' } })
    // Paste, then Enter — Enter only AFTER the inline tail confirmed.
    expect(writes).toEqual([`\x1b[200~${prompt}\x1b[201~`, '\r'])
  })

  it('big pastes confirm via the [Pasted text #N] placeholder (collapse path)', async () => {
    const long = 'x'.repeat(150)
    const { io, writes } = makeIo(long, '❯ [Pasted text #1]')
    const result = await deliverClaudePrompt(io)
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'user' } })
    expect(writes).toEqual([`\x1b[200~${long}\x1b[201~`, '\r'])
  })

  it('a SECOND paste ignores the first paste\'s stale placeholder (baseline count)', async () => {
    // Composer already shows [Pasted text #1] from a prior paste. A new paste
    // that inlines must NOT confirm on the stale #1 — it waits for its own tail.
    const prompt = 'second one\nmore text'
    const writes: string[] = []
    let calls = 0
    const snapshotScreen = vi.fn(() => {
      calls += 1
      if (calls === 1) return '[Pasted text #1]' // baseline already has #1
      if (calls === 2) return '[Pasted text #1]' // right after paste: tail not on screen yet
      return '[Pasted text #1] ❯ second one more text' // tail lands
    })
    const io = {
      sessionId: 's1', prompt,
      write: (d: string) => { writes.push(d); return true },
      session: {
        snapshotScreen,
        armPromptAcceptance: () => ({
          promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
          cancel: vi.fn(),
        }),
      },
    } as unknown as PromptDeliveryIo
    const result = await deliverClaudePrompt(io)
    expect(result).toMatchObject({ ok: true, acceptance: { kind: 'user' } })
    expect(writes).toEqual([`\x1b[200~${prompt}\x1b[201~`, '\r'])
    // It did NOT confirm on the first post-paste read (stale #1 only); it kept polling.
    expect(snapshotScreen.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('paste-like prompts still fail loudly when NEITHER signal ever appears (Enter withheld)', async () => {
    vi.useFakeTimers()
    const { io, writes } = makeIo('line one\nline two', '') // screen never reflects the paste
    const p = deliverClaudePrompt(io)
    await vi.advanceTimersByTimeAsync(2100)
    const result = await p
    expect(result.ok).toBe(false)
    // Critically: Enter must NOT be sent after an unconfirmed paste.
    expect(writes).toEqual(['\x1b[200~line one\nline two\x1b[201~'])
  })

  it('fails visibly when the session has no snapshotScreen probe', async () => {
    const writes: string[] = []
    const io = {
      sessionId: 's1', prompt: 'line one\nline two',
      write: (d: string) => { writes.push(d); return true },
      session: {
        armPromptAcceptance: () => ({
          promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
          cancel: vi.fn(),
        }),
      },
    } as unknown as PromptDeliveryIo
    const result = await deliverClaudePrompt(io)
    expect(result.ok).toBe(false)
    expect(writes).toEqual([]) // nothing pasted if we can't confirm
  })

  it('reports post-Enter acceptance timeout as unsafe to retry', async () => {
    const writes: string[] = []
    const io = {
      sessionId: 's1', prompt: 'hello',
      write: (data: string) => { writes.push(data); return true },
      session: {
        snapshotScreen: (() => {
          let calls = 0
          return () => calls++ === 0 ? '❯' : '❯ hello'
        })(),
        armPromptAcceptance: () => ({
          promise: Promise.resolve({ kind: 'timeout' as const }),
          cancel: vi.fn(),
        }),
      },
    } as unknown as PromptDeliveryIo

    const result = await deliverClaudePrompt(io)
    expect(result).toMatchObject({
      ok: false,
      stage: 'after-enter',
      code: 'acceptance-timeout',
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: true,
    })
    expect(writes).toEqual(['hello', '\r'])
  })

  it('waits for image pills before Enter and then requires JSONL acceptance', async () => {
    const writes: string[] = []
    let snapshots = 0
    const io = {
      sessionId: 's1', prompt: '', imagePaths: ['/tmp/a.png'],
      write: (data: string) => { writes.push(data); return true },
      session: {
        snapshotScreen: () => snapshots++ === 0 ? '❯' : '❯ [Image #1]',
        armPromptAcceptance: () => ({
          promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
          cancel: vi.fn(),
        }),
      },
    } as unknown as PromptDeliveryIo
    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(writes).toEqual(['\x1b[200~/tmp/a.png\x1b[201~', '\r'])
  })

  it('keeps text and image writes in one acknowledged main-owned transaction', async () => {
    const writes: string[] = []
    const screens = [
      '❯',
      '❯ line one line two',
      '❯ line one line two',
      '❯ line one line two [Image #1]',
    ]
    const io = {
      sessionId: 's1', prompt: 'line one\nline two', imagePaths: ['/tmp/a.png'],
      write: (data: string) => { writes.push(data); return true },
      session: {
        snapshotScreen: () => screens.shift() ?? '❯ line one line two [Image #1]',
        armPromptAcceptance: () => ({
          promise: Promise.resolve({ kind: 'user' as const, acceptedAt: 123 }),
          cancel: vi.fn(),
        }),
      },
    } as unknown as PromptDeliveryIo
    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(writes).toEqual([
      '\x1b[200~line one\nline two\x1b[201~',
      ' ',
      '\x1b[200~/tmp/a.png\x1b[201~',
      '\r',
    ])
  })

  it('does not await a diagnostic sink before writing', async () => {
    const never = new Promise<void>(() => {})
    const { io, writes } = makeIo('hello', '❯ hello')
    io.record = () => never
    await expect(deliverClaudePrompt(io)).resolves.toMatchObject({ ok: true })
    expect(writes).toEqual(['hello', '\r'])
  })
})
