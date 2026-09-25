import { describe, expect, it } from 'vitest'

import { POCKET_PARTITION_PREFIX, decideGuestAttach, hardenGuestPreferences } from './guestGuard'

// Adversarial inputs, labelled as such: this is the attach boundary a renderer
// XSS would probe (Electron security checklist #12; Orca's and T3 Code's
// will-attach-webview handlers were read for the shape).
const P = `${POCKET_PARTITION_PREFIX}0f7c`

describe('decideGuestAttach', () => {
  it('allows a pocket partition with an http(s) or blank src', () => {
    for (const src of ['http://localhost:5173/', 'https://example.com/', 'about:blank', undefined]) {
      expect(decideGuestAttach({ partition: P, src })).toEqual({ allow: true })
    }
  })

  it.each([
    [undefined, 'default session'],
    ['', 'default session'],
    ['persist:other', 'partition'],
    ['ac-pocket-no-persist', 'partition'],
    [POCKET_PARTITION_PREFIX, 'partition'],
    ['persist:ac-pocketX', 'partition'],
  ])('refuses partition %s', (partition, reason) => {
    const d = decideGuestAttach({ partition, src: 'http://x/' })
    expect(d.allow).toBe(false)
    expect(d.allow === false && d.reason).toContain(reason)
  })

  it.each(['file:///etc/hosts', 'agent-code-ext://ext/view', 'javascript:alert(1)', 'data:text/html,x', 'chrome://gpu'])('refuses src %s', src => {
    expect(decideGuestAttach({ partition: P, src }).allow).toBe(false)
  })
})

describe('hardenGuestPreferences', () => {
  it('strips every preload form and forces the sandboxed, isolated profile', () => {
    const prefs: Record<string, unknown> = {
      preload: '/evil.js', preloadURL: 'file:///evil.js', nodeIntegration: true, nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false, webSecurity: false,
      allowRunningInsecureContent: true, enableBlinkFeatures: 'X', backgroundThrottling: false, webviewTag: true,
    }
    hardenGuestPreferences(prefs as Electron.WebPreferences)
    expect(prefs).not.toHaveProperty('preload')
    expect(prefs).not.toHaveProperty('preloadURL')
    expect(prefs).toEqual({
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      enableBlinkFeatures: '', backgroundThrottling: true, webviewTag: false,
    })
  })
})
