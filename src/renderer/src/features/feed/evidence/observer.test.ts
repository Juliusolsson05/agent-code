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
        return Promise.resolve(true)
      },
    },
  }
})

afterEach(() => {
  disarmRenderShapeCapture(SESSION)
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
})

describe('render-shape observer (Phase 2 gates)', () => {
  it('is inert when capture is off — zero state, zero sends', () => {
    observeRenderShape(input())
    vi.runAllTimers()
    expect(sent).toEqual([])
    expect(isRenderShapeCaptureArmed(SESSION)).toBe(false)
  })

  it('a repeated identical delta ×5000 produces ONE sighting and ONE send', () => {
    armRenderShapeCapture(SESSION)
    for (let i = 0; i < 5000; i++) {
      // Different content each tick — same structure. The fingerprint (not
      // the payload hash) is the dedup identity, so this is one key.
      observeRenderShape(
        input({ payload: { kind: 'function_call', toolName: 'exec_command', inputJson: `{"cmd":"x${i}` } }),
      )
    }
    vi.runAllTimers()
    expect(sent).toHaveLength(1)
    expect(sent[0].batch).toHaveLength(1)
    // Final flush carries the true count for the sidecar.
    disarmRenderShapeCapture(SESSION)
    const final = sent.at(-1)!.batch.at(-1)!
    expect(final.seenCount).toBe(5000)
  })

  it('lifecycle and outcome-kind transitions each emit an explicit record', () => {
    armRenderShapeCapture(SESSION)
    observeRenderShape(input({ lifecycle: 'prefix' }))
    observeRenderShape(input({ lifecycle: 'input-complete' }))
    observeRenderShape(
      input({
        lifecycle: 'input-complete',
        outcome: { kind: 'specialized', shapeId: 'x', rendererId: 'x' },
      }),
    )
    vi.runAllTimers()
    expect(sent.flatMap(s => s.batch)).toHaveLength(3)
  })

  it('the outbound queue is hard-capped — novel-key floods shed and count', () => {
    armRenderShapeCapture(SESSION)
    for (let i = 0; i < 600; i++) {
      // 600 genuinely distinct structures inside one flush window (distinct
      // key names → distinct fingerprints).
      observeRenderShape(input({ payload: { [`k${i}`]: 1 } }))
    }
    vi.runAllTimers()
    const flushed = sent.flatMap(s => s.batch).length
    expect(flushed).toBeLessThanOrEqual(256)
    expect(renderShapeObserverStats().droppedQueue).toBeGreaterThan(0)
  })

  it('hostile payloads (cycles) never throw into the caller', () => {
    armRenderShapeCapture(SESSION)
    type Cyc = { self?: unknown }
    const cyc: Cyc = {}
    cyc.self = cyc
    expect(() => observeRenderShape(input({ payload: cyc }))).not.toThrow()
    vi.runAllTimers()
    expect(sent.flatMap(s => s.batch)).toHaveLength(1) // cycle marker is a valid shape
  })

  it('missing preload API is swallowed and counted, never thrown', () => {
    delete (globalThis as Record<string, unknown>).window
    armRenderShapeCapture(SESSION)
    expect(() => {
      observeRenderShape(input())
      vi.runAllTimers()
    }).not.toThrow()
    expect(renderShapeObserverStats().failures).toBeGreaterThan(0)
  })

  it('sightings are metadata-only — no payload content crosses IPC', () => {
    armRenderShapeCapture(SESSION)
    const secret = 'SECRET_COMMAND rm -rf /Users/private'
    observeRenderShape(input({ payload: { kind: 'function_call', command: secret } }))
    vi.runAllTimers()
    expect(JSON.stringify(sent)).not.toContain('SECRET_COMMAND')
    expect(JSON.stringify(sent)).not.toContain('/Users/private')
  })
})
