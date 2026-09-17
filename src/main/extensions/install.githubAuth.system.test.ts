import { afterEach, describe, expect, it, vi } from 'vitest'

import { installExtension } from '@main/extensions/install.js'

// SYSTEM tier: the real installExtension pipeline with a stubbed global fetch
// and an injected credential resolver (the InstallOptions DI seam, in the
// ConsentPrompt tradition). The unit suite covers resolveGitHubCliToken's
// failure logic and githubApiHeaders' shape; THIS file proves the integration
// the user actually depends on — that the credential reaches the wire on both
// api.github.com calls, that a 401 degrades to one anonymous retry instead of
// failing, and that the disabled setting resolves NOTHING.
//
// Every tarball download here 404s by construction: these tests stop caring
// the moment the API requests have been observed, so no fixture archive is
// needed, and a failed download means the pipeline never touches the
// filesystem or the ledger.

type RecordedRequest = { url: string; headers: Record<string, string> }

function stubNetwork(responses: Array<{ match: RegExp; status: number; body?: string }>): RecordedRequest[] {
  const recorded: RecordedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const target = String(url)
    recorded.push({ url: target, headers: { ...(init?.headers ?? {}) } })
    const response = responses.find(candidate => candidate.match.test(target))
    return new Response(response?.body ?? '{}', { status: response?.status ?? 404 })
  }))
  return recorded
}

function apiCalls(recorded: RecordedRequest[]): RecordedRequest[] {
  return recorded.filter(request => request.url.includes('api.github.com'))
}

// A distinctive value so a leaked credential would be unmistakable in a
// failure diff.
const TOKEN = 'gho_test_token_marker'

describe('installExtension — GitHub CLI credential wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('sends the bearer token on the release probe and the metadata call', async () => {
    const recorded = stubNetwork([{ match: /api\.github\.com/, status: 404, body: '{}' }])
    const resolve = vi.fn(async () => TOKEN)

    await installExtension('owner/repo', undefined, {
      githubCliAuth: true,
      resolveCredential: resolve,
    }).catch(() => {
      // 404 metadata fails the install; the observed requests are the point.
    })

    expect(resolve).toHaveBeenCalledTimes(1)
    const calls = apiCalls(recorded)
    // The release probe runs first; with it 404ing (no releases / not found),
    // the metadata call follows. Both must carry the credential.
    expect(calls.length).toBe(2)
    expect(calls[0].url).toContain('/releases/latest')
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('retries anonymously exactly once when the credential earns a 401', async () => {
    const recorded = stubNetwork([{ match: /api\.github\.com/, status: 401, body: '{}' }])
    const resolve = vi.fn(async () => TOKEN)

    await expect(installExtension('owner/repo', undefined, {
      githubCliAuth: true,
      resolveCredential: resolve,
    })).rejects.toThrow(/401/)

    const calls = apiCalls(recorded)
    // The retry applies at EACH api.github.com endpoint: the release probe
    // (bearer, then anonymous) and, both having failed, the metadata call
    // (bearer, then anonymous) — four requests before the terminal error.
    expect(calls.length).toBe(4)
    // Order: release probe (bearer, anonymous retry), then — both having
    // failed — the metadata call (bearer, anonymous retry).
    expect(calls[0].url).toContain('/releases/latest')
    expect(calls[1].url).toContain('/releases/latest')
    expect(calls[2].url).not.toContain('/releases/latest')
    expect(calls[3].url).not.toContain('/releases/latest')
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[2].headers.authorization).toBe(`Bearer ${TOKEN}`)
    // Each retry must be truly anonymous — no empty-bearer footgun.
    expect(calls[1].headers.authorization).toBeUndefined()
    expect(calls[3].headers.authorization).toBeUndefined()
  })

  it('resolves no credential at all when the option is disabled', async () => {
    const recorded = stubNetwork([{ match: /api\.github\.com/, status: 404, body: '{}' }])
    const resolve = vi.fn(async () => TOKEN)

    await installExtension('owner/repo', undefined, {
      githubCliAuth: false,
      resolveCredential: resolve,
    }).catch(() => {})

    expect(resolve).not.toHaveBeenCalled()
    for (const call of apiCalls(recorded)) {
      expect(call.headers.authorization).toBeUndefined()
    }
  })

  it('proceeds anonymously when resolution itself yields nothing', async () => {
    const recorded = stubNetwork([{ match: /api\.github\.com/, status: 404, body: '{}' }])
    const resolve = vi.fn(async () => null)

    await installExtension('owner/repo', undefined, {
      resolveCredential: resolve,
    }).catch(() => {})

    expect(resolve).toHaveBeenCalledTimes(1)
    for (const call of apiCalls(recorded)) {
      expect(call.headers.authorization).toBeUndefined()
    }
  })
})
