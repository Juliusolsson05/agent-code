import { describe, expect, it } from 'vitest'

import { projectSessionRecovery } from './recoveryProjection.js'

const sessions = {
  visible: { cwd: '/repo', kind: 'claude' as const },
  parked: { cwd: '/repo', kind: 'codex' as const },
}

describe('projectSessionRecovery', () => {
  it('retains stable ids for live and failed leaves while preserving hibernated metadata', () => {
    const projected = projectSessionRecovery({
      persistedSessions: sessions,
      ownedIds: new Set(['visible', 'parked']),
      liveProcessIds: new Set(['visible']),
      outcomes: new Map([['visible', {
        status: 'failed' as const,
        meta: sessions.visible,
        message: 'provider missing',
        code: 'start-failed' as const,
      }]]),
    })

    expect(projected.idMap.get('visible')).toBe('visible')
    expect(projected.sessions).toEqual(sessions)
    expect(projected.resolvedIds).toEqual(new Set(['visible']))
    expect(projected.liveBackendIds.size).toBe(0)
    expect(projected.failures.get('visible')).toBe('provider missing')
    expect(projected.failureCodes.get('visible')).toBe('start-failed')
  })

  it('publishes unresolved visible ownership without calling it resolved', () => {
    const projected = projectSessionRecovery({
      persistedSessions: sessions,
      ownedIds: new Set(['visible', 'parked']),
      liveProcessIds: new Set(['visible']),
      outcomes: new Map(),
    })

    expect(projected.idMap).toEqual(new Map([
      ['visible', 'visible'],
      ['parked', 'parked'],
    ]))
    expect(projected.sessions).toEqual(sessions)
    expect(projected.resolvedIds.size).toBe(0)
    expect(projected.liveBackendIds.size).toBe(0)
  })

  it('marks adopted or spawned leaves live without changing their local id', () => {
    const snapshot = {
      sessionId: 'visible',
      kind: 'claude' as const,
      cwd: '/repo',
      lifecycle: 'live' as const,
      input: { ready: true, revision: 3, reason: 'ready' as const },
    }
    const projected = projectSessionRecovery({
      persistedSessions: sessions,
      ownedIds: new Set(['visible', 'parked']),
      liveProcessIds: new Set(['visible']),
      outcomes: new Map([['visible', {
        status: 'live' as const,
        meta: sessions.visible,
        snapshot,
      }]]),
    })

    expect(projected.idMap.get('visible')).toBe('visible')
    expect(projected.liveBackendIds).toEqual(new Set(['visible']))
    expect(projected.backendSnapshots.get('visible')).toEqual(snapshot)
    expect(projected.sessions.parked).toEqual(sessions.parked)
  })
})
