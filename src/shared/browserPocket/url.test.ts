import { describe, expect, it } from 'vitest'

import { isAllowedTopLevelUrl, isLoopbackUrl, normalisePocketUrl } from './url'

// This is a security boundary, so its inputs are an ADVERSARIAL list, not
// recordings: dangerous schemes from the Electron security checklist, plus the
// block-lists Emdash and T3 Code use (javascript:, data:, file:). The allowed
// forms are the shorthands products accept and dev servers actually print.

describe('normalisePocketUrl', () => {
  it.each([
    ['5173', 'http://localhost:5173/'],
    [':5173', 'http://localhost:5173/'],
    ['localhost:3000/login', 'http://localhost:3000/login'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['app.localhost:1355', 'http://app.localhost:1355/'],
    ['[::1]:4000', 'http://[::1]:4000/'],
    ['https://example.com', 'https://example.com/'],
    ['http://localhost:5173/checkout?x=1#y', 'http://localhost:5173/checkout?x=1#y'],
    ['example.com/docs', 'http://example.com/docs'],
  ])('%s → %s', (input, url) => {
    expect(normalisePocketUrl(input)).toEqual({ ok: true, url })
  })

  it.each([
    'file:///etc/passwd', 'javascript:alert(1)', 'javascript:1', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>1</script>',
    'agent-code-ext://ext/view', 'chrome://gpu', 'devtools://devtools', 'about:blank', 'blob:http://x/1', 'vbscript:x',
  ])('refuses %s', input => {
    expect(normalisePocketUrl(input)).toEqual({ ok: false, reason: 'scheme' })
  })

  it('refuses empty and out-of-range input', () => {
    expect(normalisePocketUrl('  ')).toEqual({ ok: false, reason: 'empty' })
    expect(normalisePocketUrl('99999')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('isAllowedTopLevelUrl', () => {
  it('allows http and https only', () => {
    expect(isAllowedTopLevelUrl('http://localhost:1/')).toBe(true)
    expect(isAllowedTopLevelUrl('https://a.b/')).toBe(true)
    for (const bad of ['file:///x', 'javascript:1', 'about:blank', 'not a url', '']) expect(isAllowedTopLevelUrl(bad)).toBe(false)
  })
})

describe('isLoopbackUrl', () => {
  it('recognises the loopback forms dev servers print', () => {
    for (const ok of ['http://localhost:5173/', 'http://127.0.0.1:3000/', 'http://[::1]:8080/', 'https://app.localhost/', 'http://feat-x.shop.localhost:1355/']) expect(isLoopbackUrl(ok)).toBe(true)
  })
  it('does not treat look-alikes as loopback', () => {
    for (const bad of ['http://localhost.evil.com/', 'http://127.0.0.1.nip.io/', 'http://evil.com/?localhost', 'file://localhost/etc']) expect(isLoopbackUrl(bad)).toBe(false)
  })
})
