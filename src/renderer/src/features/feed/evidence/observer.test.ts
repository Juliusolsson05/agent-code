import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  armRenderShapeCapture,
  disarmRenderShapeCapture,
  isRenderShapeCaptureArmed,
  observeRenderShape,
  renderShapeObserverStats,
  type ObserveRenderShapeInput,
} from '@renderer/features/feed/evidence/observer'
import type { RenderShapeSighting } from '@shared/types/renderShapes'

// Phase 2 exit gates as executable spec:
//   - observer inert when capture is off;
//   - one unknown prefix × thousands → ONE bounded record + counts, no
//     IPC flood (backpressure by construction);
//   - outcome/lifecycle transitions emit explicit records;
//   - queue caps, final flush, missing preload, serialization-hostile
//     payloads: all swallowed, counted, never thrown.

const SESSION = 'sess-observer-test'

let sent: Array<{ sessionId: string; batch: RenderShapeSighting[] }>

function input(over: Partial<ObserveRenderShapeInput> = {}): ObserveRenderShapeInput {
  return {
    sessionId: SESSION,
    provider: 'codex',
    plane: 'semantic-tool',
    lifecycle: 'prefix',
    eventType: 'function_call',
    payload: { kind: 'function_call', toolName: 'exec_command', inputJson: '{"cmd":' },
    outcome: { kind: 'generic', rendererId: 'shared.generic-tool' },
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  // The observer reaches window.api only inside its own try/catch; tests run
  // in node, so provide the minimal preload surface it touches.
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      appendRenderShapeSightings: (sessionId: string, batch: RenderShapeSighting[]) => {
        sent.push({ sessionId, batch })
        return Promise.resolve({ status: 'accepted' as const })
      },
    },
  }
})

afterEach(async () => {
  await disarmRenderShapeCapture(SESSION)
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
})

describe('render-shape observer (Phase 2 gates)', () => {
  it('is inert when capture is off — zero state, zero sends', async () => {
    observeRenderShape(input())
    await vi.runAllTimersAsync()
    expect(sent).toEqual([])
    expect(isRenderShapeCaptureArmed(SESSION)).toBe(false)
  })

  it('a repeated identical delta ×5000 produces ONE sighting and ONE send', async () => {
    armRenderShapeCapture(SESSION)
    for (let i = 0; i < 5000; i++) {
      // Different content each tick — same structure. The fingerprint (not
      // the payload hash) is the dedup identity, so this is one key.
      observeRenderShape(
        input({ payload: { kind: 'function_call', toolName: 'exec_command', inputJson: `{"cmd":"x${i}` } }),
      )
    }
    await vi.runAllTimersAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0].batch).toHaveLength(1)
    // Final flush carries the true count for the sidecar.
    await disarmRenderShapeCapture(SESSION)
    const final = sent.at(-1)!.batch.at(-1)!
    expect(final.seenCount).toBe(5000)
  })

  it('lifecycle, outcome-kind, AND route transitions each emit an explicit record', async () => {
    armRenderShapeCapture(SESSION)
    observeRenderShape(input({ lifecycle: 'prefix' }))
    observeRenderShape(input({ lifecycle: 'input-complete' }))
    observeRenderShape(
      input({
        lifecycle: 'input-complete',
        outcome: { kind: 'specialized', shapeId: 'x', rendererId: 'x' },
      }),
    )
    // Same kind, DIFFERENT route — the git-widget-vs-dispatch case the
    // review panel flagged: must be its own record, not merged.
    observeRenderShape(
      input({
        lifecycle: 'input-complete',
        outcome: { kind: 'specialized', shapeId: 'y', rendererId: 'shared.git-widget' },
      }),
    )
    await vi.runAllTimersAsync()
    expect(sent.flatMap(s => s.batch)).toHaveLength(4)
  })

  it('the outbound queue is hard-capped live, and the final flush RECOVERS shed first-sights', async () => {
    armRenderShapeCapture(SESSION)
    for (let i = 0; i < 600; i++) {
      // 600 genuinely distinct structures inside one flush window (distinct
      // key names → distinct fingerprints).
      observeRenderShape(input({ payload: { [`k${i}`]: 1 } }))
    }
    await vi.runAllTimersAsync()
    const live = sent.flatMap(s => s.batch).length
    expect(live).toBeLessThanOrEqual(256)
    expect(renderShapeObserverStats().droppedQueue).toBeGreaterThan(0)
    // Review finding: a shed first-sight used to be unrecoverable
    // (flushedCount lied). The disarm flush bypasses the live cap in
    // bounded chunks, so ALL 600 keys reach the sidecar in the end.
    await disarmRenderShapeCapture(SESSION)
    const totalKeys = new Set(
      sent.flatMap(s => s.batch).map(b => `${b.structuralFingerprint}`),
    ).size
    expect(totalKeys).toBe(600)
  })

  it('hostile payloads (cycles) never throw into the caller', async () => {
    armRenderShapeCapture(SESSION)
    type Cyc = { self?: unknown }
    const cyc: Cyc = {}
    cyc.self = cyc
    expect(() => observeRenderShape(input({ payload: cyc }))).not.toThrow()
    await vi.runAllTimersAsync()
    expect(sent.flatMap(s => s.batch)).toHaveLength(1) // cycle marker is a valid shape
  })

  it('missing preload API is swallowed and counted, never thrown', async () => {
    delete (globalThis as Record<string, unknown>).window
    armRenderShapeCapture(SESSION)
    observeRenderShape(input())
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow()
    expect(renderShapeObserverStats().failures).toBeGreaterThan(0)
  })

  it('keeps an unacknowledged sighting for the authoritative stop flush without polling', async () => {
    let attempts = 0
    ;(globalThis as Record<string, unknown>).window = {
      api: {
        appendRenderShapeSightings: (sessionId: string, batch: RenderShapeSighting[]) => {
          attempts += 1
          if (attempts === 1) return Promise.reject(new Error('transient IPC failure'))
          sent.push({ sessionId, batch })
          return Promise.resolve({ status: 'accepted' as const })
        },
      },
    }
    armRenderShapeCapture(SESSION)
    observeRenderShape(input({ payload: { once: true } }))
    await vi.runAllTimersAsync()
    expect(attempts).toBe(1)
    await disarmRenderShapeCapture(SESSION)
    expect(attempts).toBe(2)
    expect(sent.flatMap(item => item.batch)).toHaveLength(1)
  })

  it('disarm waits for an in-flight append before computing the final delta', async () => {
    let release: (() => void) | undefined
    ;(globalThis as Record<string, unknown>).window = {
      api: {
        appendRenderShapeSightings: (sessionId: string, batch: RenderShapeSighting[]) =>
          new Promise<{ status: 'accepted' }>(resolve => {
            sent.push({ sessionId, batch })
            release = () => resolve({ status: 'accepted' })
          }),
      },
    }
    armRenderShapeCapture(SESSION)
    observeRenderShape(input({ payload: { finalRace: true } }))
    await vi.advanceTimersByTimeAsync(2000)
    const stopping = disarmRenderShapeCapture(SESSION)
    expect(isRenderShapeCaptureArmed(SESSION)).toBe(true)
    release?.()
    await stopping
    expect(isRenderShapeCaptureArmed(SESSION)).toBe(false)
    expect(sent.flatMap(item => item.batch)).toHaveLength(1)
  })

  it('sightings are metadata-only — no payload content crosses IPC', async () => {
    armRenderShapeCapture(SESSION)
    const secret = 'SECRET_COMMAND rm -rf /Users/private'
    observeRenderShape(input({ payload: { kind: 'function_call', command: secret } }))
    await vi.runAllTimersAsync()
    expect(JSON.stringify(sent)).not.toContain('SECRET_COMMAND')
    expect(JSON.stringify(sent)).not.toContain('/Users/private')
  })

  it('a definitive no-recorder acknowledgement disarms immediately', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      api: { appendRenderShapeSightings: () => Promise.resolve({ status: 'no-recorder' as const }) },
    }
    armRenderShapeCapture(SESSION)
    observeRenderShape(input({ payload: { miss: true } }))
    await vi.runAllTimersAsync()
    // A later recording start has its own push and will arm fresh state, so
    // retrying this explicit negative would only poll a closed lifecycle.
    expect(isRenderShapeCaptureArmed(SESSION)).toBe(false)
  })
})
