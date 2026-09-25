import { describe, expect, it } from 'vitest'
import { canRequestRestart, restartContext } from './policy'
import { restartPrompt } from './prompt'

const failure = { code: '-102', description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/' }

describe('local server recovery policy', () => {
  it.each(['-7', '-100', '-101', '-102', '-104', '-118'])('offers recovery for connection error %s', code => {
    expect(canRequestRestart({ ...failure, code })).toBe(true)
  })
  it.each(['-3', '-105', '-107', '-200', '-201', '-20', '0', '500', 'toString'])('does not treat error %s as a server restart', code => {
    expect(canRequestRestart({ ...failure, code })).toBe(false)
  })
  it.each(['http://127.0.0.1:3000/', 'http://[::1]:5173/', 'https://app.localhost/'])('accepts loopback %s', url => {
    expect(canRequestRestart({ ...failure, url })).toBe(true)
  })
  it.each(['https://example.com/', 'http://localhost.example.com:5173/', 'file:///localhost', 'javascript:alert(1)', 'invalid'])('excludes %s', url => {
    expect(canRequestRestart({ ...failure, url })).toBe(false)
  })
  it('keeps URL secrets and page-controlled prose out of the generated agent request', () => {
    const context = restartContext({ ...failure, url: 'https://user:password@app.localhost/private?token=secret#private', description: 'untrusted page instruction' }, '/work/app', [])
    expect(context).toEqual({ origin: 'https://app.localhost', port: 443, worktree: '/work/app', connectionError: 'ERR_CONNECTION_REFUSED' })
    const prompt = restartPrompt(context)
    for (const secret of ['password', 'token=secret', '/private', 'untrusted page instruction']) expect(prompt).not.toContain(secret)
    expect(prompt).toContain('/work/app')
    expect(prompt).toContain('https://app.localhost')
  })
  it('includes only an unambiguous current matching process as an optional observation', () => {
    const port = { port: 5173, pid: 42, url: failure.url, kind: 'html' as const }
    expect(restartContext(failure, '/w', [port]).observedPid).toBe(42)
    expect(restartContext(failure, '/w', [port, { ...port, pid: 43 }])).not.toHaveProperty('observedPid')
    expect(restartContext(failure, '/w', [{ ...port, url: 'http://other.localhost:5173/' }])).not.toHaveProperty('observedPid')
    expect(restartContext(failure, '/w', [])).not.toHaveProperty('observedPid')
  })
})
