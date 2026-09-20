import { describe, expect, it } from 'vitest'
import { tldrIdentityForReplacement, tldrIdentityForSession } from './identity'

describe('TLDR conversation continuity', () => {
  const source = { cwd: '/project', kind: 'claude' as const, providerSessionId: 'native-1', tldrIdentity: 'logical-1' }
  it('preserves reloads and explicitly translated provider handoffs', () => {
    expect(tldrIdentityForReplacement('old', source, { kind: 'claude', resumeSessionId: 'native-1' })).toBe('logical-1')
    expect(tldrIdentityForReplacement('old', source, { kind: 'codex', resumeSessionId: 'translated', preserveTldr: true })).toBe('logical-1')
  })
  it('starts fresh for unrelated resumes, rewinds and new conversations', () => {
    expect(tldrIdentityForReplacement('old', source, { kind: 'claude', resumeSessionId: 'rewound-clone' })).toBeUndefined()
    expect(tldrIdentityForReplacement('old', source, { kind: 'claude' })).toBeUndefined()
    expect(tldrIdentityForReplacement('old', source, { kind: 'terminal', preserveTldr: true })).toBeUndefined()
  })
})

describe('reporting identity', () => {
  it('gives a Goal-only agent an identity and none to an agent without reporting', () => {
    expect(tldrIdentityForSession('pane', { cwd: '/project', kind: 'claude', builtInMcpDomains: ['goal'] })).toBe('pane')
    expect(tldrIdentityForSession('pane', { cwd: '/project', kind: 'claude', builtInMcpDomains: ['orchestration'] })).toBeUndefined()
  })
})
