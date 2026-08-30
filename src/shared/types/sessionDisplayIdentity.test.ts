import { describe, expect, it } from 'vitest'

import {
  buildSessionDisplayIdentity,
  identityInputFromSessionInfo,
  isFallbackLabel,
} from '@shared/types/sessionDisplayIdentity'
import type { SessionInfo } from '@shared/types/session'

// Tests for the #96 identity ladder.
//
// WHY these assert `labelSource` and not just `label`: the label alone cannot
// distinguish "the user titled this conversation `agent-code`" from "we gave up
// and used the folder name". That distinction is the entire reason this module
// exists, so every case pins the provenance, not only the text.

function claudeInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: '8d6926a5-1111-2222-3333-444455556666',
    summary: 'summary text',
    lastModified: 1_700_000_000_000,
    fileSize: 4096,
    cwd: '/Users/dev/projects/agent-code',
    ...over,
  }
}

describe('buildSessionDisplayIdentity — the ladder', () => {
  it('prefers a custom title over everything else', () => {
    const id = buildSessionDisplayIdentity({
      providerSessionId: 'abc12345-x',
      kind: 'claude',
      customTitle: 'Renderer rewrite',
      firstPrompt: 'help me refactor the feed',
      lastPrompt: 'now run the tests',
      cwd: '/Users/dev/agent-code',
      lastActivityAt: 1,
    })
    expect(id.label).toBe('Renderer rewrite')
    expect(id.labelSource).toBe('custom-title')
  })

  it('prefers the first prompt over the last prompt', () => {
    // The behavioural change at the heart of #96. Claude previously labelled by
    // lastPrompt, which means a row renames itself as the conversation runs and
    // is unrecognisable an hour later. Codex already keyed on the first message;
    // this is what makes the two providers agree.
    const id = buildSessionDisplayIdentity({
      providerSessionId: 'abc12345-x',
      kind: 'claude',
      firstPrompt: 'help me refactor the feed',
      lastPrompt: 'now run the tests',
      lastActivityAt: 1,
    })
    expect(id.label).toBe('help me refactor the feed')
    expect(id.labelSource).toBe('first-prompt')
  })

  it('falls to the last prompt only when there is no first prompt', () => {
    const id = buildSessionDisplayIdentity({
      providerSessionId: 'abc12345-x',
      kind: 'claude',
      lastPrompt: 'now run the tests',
      lastActivityAt: 1,
    })
    expect(id.labelSource).toBe('last-prompt')
  })

  it('falls to the cwd basename when the session said nothing usable', () => {
    const id = buildSessionDisplayIdentity({
      providerSessionId: 'abc12345-x',
      kind: 'codex',
      cwd: '/Users/dev/projects/agent-code/',
      lastActivityAt: 1,
    })
    expect(id.label).toBe('agent-code')
    expect(id.labelSource).toBe('cwd')
    expect(isFallbackLabel(id.labelSource)).toBe(true)
  })

  it('falls to a truncated id last, and never returns an empty label', () => {
    // The floor of the ladder. This case previously made Claude drop the session
    // from the list entirely (`if (!summary) return null`), so it was invisible
    // rather than merely poorly named.
    const id = buildSessionDisplayIdentity({
      providerSessionId: '8d6926a5-1111-2222',
      kind: 'claude',
      lastActivityAt: 1,
    })
    expect(id.label).toBe('8d6926a5')
    expect(id.labelSource).toBe('session-id')
    expect(isFallbackLabel(id.labelSource)).toBe(true)
  })

  it('treats whitespace-only and empty strings as absent rungs', () => {
    // Guards the ladder against a provider emitting '' or '   ' rather than
    // null, which would otherwise produce a blank row that looks like a
    // rendering bug rather than a missing name.
    const id = buildSessionDisplayIdentity({
      providerSessionId: 'abc12345-x',
      kind: 'claude',
      customTitle: '   ',
      firstPrompt: '',
      cwd: '/Users/dev/projects/agent-code',
      lastActivityAt: 1,
    })
    expect(id.labelSource).toBe('cwd')
  })

  it('collapses a multi-line prompt and truncates a wall of text', () => {
    const id = buildSessionDisplayIdentity({
      providerSessionId: 'abc12345-x',
      kind: 'claude',
      firstPrompt: 'line one\n\nline two ' + 'x'.repeat(400),
      lastActivityAt: 1,
    })
    expect(id.label).not.toContain('\n')
    expect(id.label.endsWith('…')).toBe(true)
    expect(id.label.length).toBeLessThanOrEqual(121)
  })
})

describe('identityInputFromSessionInfo — recovering ingredients from listers', () => {
  it('recovers Claude lastPrompt from a summary that is neither title nor first prompt', () => {
    // Claude's lister flattens `customTitle ?? lastPrompt ?? firstPrompt` into
    // `summary`. When summary matches neither of the two fields it also returns,
    // the remaining branch of that expression is the lastPrompt.
    const input = identityInputFromSessionInfo(
      claudeInfo({ summary: 'now run the tests', firstPrompt: undefined, customTitle: undefined }),
      'claude',
    )
    expect(input.lastPrompt).toBe('now run the tests')
    expect(buildSessionDisplayIdentity(input).labelSource).toBe('last-prompt')
  })

  it('does not mistake a Claude summary that equals the first prompt for a lastPrompt', () => {
    const input = identityInputFromSessionInfo(
      claudeInfo({ summary: 'help me refactor', firstPrompt: 'help me refactor' }),
      'claude',
    )
    expect(input.lastPrompt).toBeNull()
    expect(buildSessionDisplayIdentity(input).labelSource).toBe('first-prompt')
  })

  it('reads a Codex summary as the first user message', () => {
    const input = identityInputFromSessionInfo(
      claudeInfo({ summary: 'port the proxy to zstd' }),
      'codex',
    )
    expect(buildSessionDisplayIdentity(input).labelSource).toBe('first-prompt')
  })

  it('rejects the Codex hex-id summary instead of rendering it as a title', () => {
    // codex-headless writes `sessionId.slice(0, 8)` into `summary` when it finds
    // no user text. Without this bridge the ladder would treat a hex id as a
    // real first prompt and the row could never be marked as a fallback — the
    // exact defect #96 reported.
    const info = claudeInfo({ sessionId: '8d6926a5-aaaa-bbbb', summary: '8d6926a5' })
    const id = buildSessionDisplayIdentity(identityInputFromSessionInfo(info, 'codex'))
    expect(id.labelSource).toBe('cwd')
    expect(id.label).toBe('agent-code')
  })

  it('gives the same identity for the same conversation under either provider', () => {
    // The provider-parity contract, and the reason a shared ladder was worth
    // building: moving a session between Claude and Codex must not rename it.
    const shared = { sessionId: 'abc12345-x', lastModified: 5, fileSize: 1, cwd: '/w/proj' }
    const claude = buildSessionDisplayIdentity(
      identityInputFromSessionInfo(
        { ...shared, summary: 'design the ledger', firstPrompt: 'design the ledger' },
        'claude',
      ),
    )
    const codex = buildSessionDisplayIdentity(
      identityInputFromSessionInfo({ ...shared, summary: 'design the ledger' }, 'codex'),
    )
    expect(codex.label).toBe(claude.label)
    expect(codex.labelSource).toBe(claude.labelSource)
  })
})
