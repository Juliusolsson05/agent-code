import { describe, expect, it } from 'vitest'
import { OperationTimers } from './operationTimers.js'
import { ResponseTracker } from './responseTracker.js'
import type { MonitorOperation } from './monitorContracts.js'

describe('bounded real-operation timing', () => {
  it('records once, expires abandoned work, and never retains arbitrary metadata', () => {
    let now = 0
    const records: MonitorOperation[] = []
    const timers = new OperationTimers(record => records.push(record), () => now, 2, 100)
    const first = timers.begin('session.spawn', 'safe-id', 'operation-id')
    timers.begin('ipc.handler', '/private/prompt')
    timers.begin('ipc.handler')
    expect(timers.size).toBe(2); expect(timers.dropped).toBe(1)
    now = 50; first('error'); first()
    expect(records).toHaveLength(1)
    now = 101; timers.sweep()
    expect(records[1]).toMatchObject({ outcome: 'timeout', durationMs: 101 })
    expect(JSON.stringify(records)).not.toContain('private')
    expect(timers.size).toBe(0)
  })
  it('isolates sink failures and excludes PTY/user events from first semantic output', () => {
    const timer = new OperationTimers(() => { throw new Error('sink') })
    expect(() => timer.begin('ipc.handler')()).not.toThrow()
    const records: MonitorOperation[] = []
    const tracker = new ResponseTracker(new OperationTimers(record => records.push(record)))
    tracker.begin('session')
    tracker.output('session', { type: 'user_message', text: 'sentinel' })
    expect(records).toHaveLength(0)
    tracker.output('session', { type: 'thinking_delta', text: 'sentinel' })
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain('sentinel')
  })
  it('deduplicates the renderer and provider begin signals for one submitted operation', () => {
    const records: MonitorOperation[] = []
    const tracker = new ResponseTracker(new OperationTimers(record => records.push(record)))
    tracker.begin('session', 'submit-a')
    tracker.begin('session', 'submit-a')
    expect(records).toHaveLength(0)
    tracker.output('session', { type: 'text_delta' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'success', operationId: 'submit-a' })
  })
  it('credits output only after acceptance says the prompt started a turn', () => {
    let now = 0
    const records: MonitorOperation[] = []
    const tracker = new ResponseTracker(new OperationTimers(record => records.push(record), () => now), () => now)
    tracker.begin('queued', 'submit-q', false)
    now = 20; tracker.output('queued', { type: 'text_delta' })
    tracker.cancel('queued')
    // A late renderer begin for the retired submit cannot restart its clock.
    tracker.begin('queued', 'submit-q')
    now = 900; tracker.output('queued', { type: 'text_delta' })
    expect(records).toEqual([expect.objectContaining({ outcome: 'cancelled', operationId: 'submit-q' })])
    tracker.begin('idle', 'submit-i', false)
    now = 1000; tracker.output('idle', { type: 'text_delta' })
    now = 1500; tracker.arm('idle', 'submit-i')
    expect(records[1]).toMatchObject({ outcome: 'success', durationMs: 100, operationId: 'submit-i' })
  })
  it('settles only the named submit', () => {
    let now = 0
    const records: MonitorOperation[] = []
    const tracker = new ResponseTracker(new OperationTimers(record => records.push(record), () => now), () => now)
    tracker.begin('pane', 'submit-new', false)
    tracker.cancelOperation('pane', 'submit-old')
    now = 40; tracker.output('pane', { type: 'text_delta' })
    tracker.arm('pane', 'submit-new')
    expect(records).toEqual([expect.objectContaining({ outcome: 'success', durationMs: 40, operationId: 'submit-new' })])
  })
})
