import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { manager, registry, pairing, baseUrl, restartServer, pairDevice, connect, waitFor, framesOfType } from './RemoteServer.testSupport.js'

describe('pairing endpoint', () => {
  it('redeems a live code and rejects a bogus one', async () => {
    const token = await pairDevice('Julius iPhone')
    expect(pairing.verifyToken(token).ok).toBe(true)

    const bad = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'NOPE1234', deviceName: 'x' }),
    })
    expect(bad.status).toBe(403)
  })
})

describe('websocket auth', () => {
  it('rejects upgrades without a valid token', async () => {
    const wsUrl = baseUrl.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws?token=garbage`)
    const outcome = await new Promise<string>(resolve => {
      ws.once('open', () => resolve('open'))
      ws.once('error', () => resolve('rejected'))
    })
    expect(outcome).toBe('rejected')
  })

  it('greets an authenticated socket with hello + session-list', async () => {
    const token = await pairDevice()
    const { ws, frames } = await connect(token)
    await waitFor(frames, f => framesOfType(f, 'session-list').length > 0)
    expect(framesOfType(frames, 'hello')).toHaveLength(1)
    ws.close()
  })
})

describe('event fan-out', () => {
  it('broadcasts manager events and replays cached state to late joiners', async () => {
    const token = await pairDevice()
    const screen = {
      sessionId: 's1', plain: 'hello', markdown: '', recent: 'hello',
      recentMarkdown: '', picker: { visible: false, items: [] },
    }
    manager.emit('started', { sessionId: 's1', kind: 'claude', projectDir: '/repo' })

    const live = await connect(token)
    await waitFor(live.frames, f => framesOfType(f, 'session-list').length > 0)
    manager.emit('screen', screen)
    await waitFor(live.frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'screen'),
    )
    live.ws.close()

    // Late joiner: connected AFTER the screen event — must still receive the
    // cached screen so an idle session isn't a blank pane on the phone.
    const late = await connect(token)
    await waitFor(late.frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'screen'),
    )
    late.ws.close()
  })

  it('primes pre-enable state from the manager snapshot caches', async () => {
    // The headline scenario the review caught: an agent blocked on a
    // permission prompt BEFORE the user enabled remote. The manager's
    // snapshot caches are the only source for that state; the server must
    // seed its late-joiner caches from them at start().
    ;(manager.list as ReturnType<typeof vi.fn>).mockReturnValue(['pre'])
    ;(manager.getScreenSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      plain: 'pre-enable output', markdown: '', recent: 'pre-enable output',
      recentMarkdown: '', picker: { visible: false, items: [] },
    })
    ;(manager.getConditionsSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'claude', ts: 1,
      conditions: {
        'claude.permission-prompt': {
          kind: 'claude.permission-prompt', state: { visible: true },
          actions: [{ kind: 'pty', id: 'yes', label: 'Yes', data: '1\r' }],
        },
      },
    })
    ;(manager.getBackendSnapshot as ReturnType<typeof vi.fn>).mockReturnValue({
      sessionId: 'pre',
      kind: 'claude',
      cwd: '/repo',
      lifecycle: 'live',
      input: { ready: false, revision: 3, reason: 'replaying-history' },
    })
    await restartServer()
    const token = await pairDevice()

    const { ws, frames } = await connect(token)
    await waitFor(frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'conditions') &&
      framesOfType(f, 'session-event').some(e => e.channel === 'screen') &&
      framesOfType(f, 'session-event').some(e => e.channel === 'input-readiness'),
    )
    // And the primed condition's pty action must be actionable.
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: {
        type: 'permission-reply', sessionId: 'pre',
        action: { kind: 'pty', id: 'yes', label: 'Yes', data: '1\r' },
      },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    // The third arg is the write's ORIGIN, and it is asserted rather than
    // relaxed away: this is the phone-client path, and `remote` is one of the
    // few attributions the write boundary can make for free. If a refactor
    // dropped the label, every remote keystroke would silently journal as a
    // local renderer write — a wrong answer to the one question the
    // input.write event exists to answer.
    expect(manager.write).toHaveBeenCalledWith('pre', '1\r', 'remote')
    ws.close()
  })
})

describe('inbound scope enforcement on a live socket', () => {
  async function openAuthed(): Promise<{ ws: WebSocket; frames: unknown[]; token: string }> {
    const token = await pairDevice()
    const { ws, frames } = await connect(token)
    await waitFor(frames, f => framesOfType(f, 'session-list').length > 0)
    return { ws, frames, token }
  }

  it('send-prompt routes EVERY kind through the provider prompt-delivery discipline', async () => {
    // Not a bare bracketed-paste write: deliverPromptToAgent hands the text
    // to the provider's own delivery module (paste → await absorption →
    // Enter), which is the desktop's swallowed-Enter protection. The reply
    // arrives only after real delivery.
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'send-prompt', sessionId: 's1', text: 'do the thing' },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('s1', 'do the thing')
    expect(manager.write).not.toHaveBeenCalled()
    expect(framesOfType(frames, 'reply')[0]).toMatchObject({ id: 'r1', ok: true })
    ws.close()
  })

  it('submit and interrupt write their control bytes', async () => {
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({ token, id: 'a', message: { type: 'submit', sessionId: 's1' } }))
    ws.send(JSON.stringify({ token, id: 'b', message: { type: 'interrupt', sessionId: 's1' } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    expect(manager.submitStagedPrompt).toHaveBeenCalledWith('s1')
    expect(manager.write).toHaveBeenCalledWith('s1', '\x1b', 'remote')
    ws.close()
  })

  it('custom permission-reply routes through resolveCondition', async () => {
    const { ws, frames, token } = await openAuthed()
    const action = { kind: 'custom', id: 'q', label: 'Answer', name: 'claude.auq', payload: { a: 1 } }
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'permission-reply', sessionId: 's1', action },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(manager.resolveCondition).toHaveBeenCalledWith('s1', action)
    ws.close()
  })

  it('pty permission-reply only applies when it matches a LIVE condition action', async () => {
    const { ws, frames, token } = await openAuthed()
    const offered = { kind: 'pty', id: 'yes', label: 'Yes', data: '1\r' }

    // No live condition yet → rejected, nothing written.
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'permission-reply', sessionId: 's1', action: offered },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 1)
    expect(framesOfType(frames, 'reply')[0]?.ok).toBe(false)
    expect(manager.write).not.toHaveBeenCalled()

    // Provider raises a permission prompt offering that exact action.
    manager.emit('conditions', {
      sessionId: 's1',
      snapshot: {
        provider: 'claude', ts: 1,
        conditions: {
          'claude.permission-prompt': {
            kind: 'claude.permission-prompt', state: { visible: true }, actions: [offered],
          },
        },
      },
    })
    await waitFor(frames, f =>
      framesOfType(f, 'session-event').some(e => e.channel === 'conditions'),
    )
    ws.send(JSON.stringify({
      token, id: 'r2',
      message: { type: 'permission-reply', sessionId: 's1', action: offered },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length >= 2)
    expect(manager.write).toHaveBeenCalledWith('s1', '1\r', 'remote')
    ws.close()
  })

  it('out-of-scope message types get an error reply and never touch the manager', async () => {
    const { ws, frames, token } = await openAuthed()
    ws.send(JSON.stringify({
      token, id: 'r1',
      message: { type: 'exec', sessionId: 's1', command: 'rm -rf /' },
    }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]?.ok).toBe(false)
    expect(manager.write).not.toHaveBeenCalled()
    expect(manager.resolveCondition).not.toHaveBeenCalled()
    ws.close()
  })

  it('a revoked device is cut off mid-session', async () => {
    const { ws, frames, token } = await openAuthed()
    const verdict = pairing.verifyToken(token)
    if (!verdict.ok) throw new Error('setup failed')
    await registry.revoke(verdict.deviceId)

    ws.send(JSON.stringify({ token, id: 'r1', message: { type: 'submit', sessionId: 's1' } }))
    await waitFor(frames, f => framesOfType(f, 'reply').length > 0)
    expect(framesOfType(frames, 'reply')[0]?.ok).toBe(false)
    expect(manager.write).not.toHaveBeenCalled()
    ws.close()
  })
})
