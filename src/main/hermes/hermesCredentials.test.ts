// Main-owned Hermes credentials (#1482): token store binding, the broker's
// refresh rules, and the browser sign-in's loopback listener.
//
// Wire shapes come from hermes-headless's recorded corpus (S1 sign-in, S14
// expiry → refresh → ticket against a real `hermes serve`); literals are only
// used where a behaviour was never recorded, and say so.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import { HermesTokenStore } from '@main/hermes/tokenStore.js'
import { HermesSignedOutError, HermesTokenBroker } from '@main/hermes/tokenBroker.js'
import { runNativeSignIn, SignInCancelledError } from '@main/hermes/nativeSignIn.js'
import { HermesConnectionService } from '@main/hermes/service.js'
import { latestRecording } from 'hermes-headless/testing/corpus'
import type { HermesTokens } from 'hermes-headless'

// Same test codec as the user-MCP secret tests: the `enc:` prefix makes an
// accidental plaintext write visible.
const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (cipher) => {
    const text = cipher.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('not ours')
    return text.slice(4)
  },
}

const URL_A = 'https://hermes-a.example'
const tokens = (overrides: Partial<HermesTokens> = {}): HermesTokens => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3_600_000,
  provider: 'basic',
  userId: 'agentcode',
  ...overrides,
})

type Exchange = { path: string; status: number; body: unknown }

/** The recorded HTTP exchanges of a scenario, request→response paired. */
function recordedExchanges(scenario: string): Exchange[] {
  const entries = latestRecording(scenario)
  const out: Exchange[] = []
  for (let index = 0; index < entries.length - 1; index += 1) {
    const request = entries[index]
    const response = entries[index + 1]
    if (request.kind !== 'http' || request.dir !== 'out' || response.kind !== 'http' || response.dir !== 'in') continue
    out.push({ path: new URL(String(request.frame.url)).pathname, status: Number(response.frame.status), body: response.frame.body })
  }
  return out
}

function replay(exchanges: Exchange[]) {
  const queue = [...exchanges]
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    calls.push({ path, init })
    const index = queue.findIndex((exchange) => exchange.path === path)
    if (index < 0) throw new Error(`no recorded exchange left for ${path}`)
    const [next] = queue.splice(index, 1)
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status })
  }
  return { fetchImpl, calls }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hermes-creds-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Races found by review a (2026-10-13). Each holds one async step open with a
// recorded response (S1 token exchange, S14 refresh) and changes the
// connection underneath it; before the fix every one of them landed.
describe('credential races (review a)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never sends a token read for the old URL to an edited one', async () => {
    const refresh = recordedExchanges('S14').find((exchange) => exchange.path === '/auth/native/refresh' && exchange.status === 200)!
    const calls: Array<{ url: string; body: string }> = []
    const hermes = new HermesConnectionService({
      stateDir: dir, codec, openExternal: () => undefined, openSocket: async () => ({}) as never,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: String(init?.body ?? '') })
        return new Response(JSON.stringify(refresh.body), { status: refresh.status })
      },
    })
    await hermes.initialize()
    const connection = await hermes.add({ name: 'VPS', baseUrl: URL_A })
    await new HermesTokenStore(join(dir, 'hermes', 'tokens'), codec).set(connection.id, URL_A, tokens({ expiresAt: 0 }))
    // Hold the token READ: it has the old URL's pair in hand when the edit lands.
    let read!: () => void
    let release!: () => void
    const readDone = new Promise<void>((resolve) => { read = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const original = HermesTokenStore.prototype.get
    vi.spyOn(HermesTokenStore.prototype, 'get').mockImplementation(async function (this: HermesTokenStore, id, url) {
      const value = await original.call(this, id, url)
      read()
      await hold
      return value
    })
    const dial = hermes.dialFor(connection.id)()
    await readDone
    await hermes.update(connection.id, { name: 'VPS', baseUrl: 'https://hermes-b.example' })
    release()
    await expect(dial).rejects.toBeInstanceOf(HermesSignedOutError)
    expect(calls.filter((call) => call.body.includes('refresh-1'))).toEqual([])
  })

  it('does not bring credentials back when a refresh finishes after Sign out', async () => {
    const refresh = recordedExchanges('S14').find((exchange) => exchange.path === '/auth/native/refresh' && exchange.status === 200)!
    let requested!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { requested = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const opened: string[] = []
    const hermes = new HermesConnectionService({
      stateDir: dir, codec, openExternal: () => undefined,
      openSocket: async (url) => { opened.push(url); return {} as never },
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/auth/native/refresh') {
          requested()
          await hold
          return new Response(JSON.stringify(refresh.body), { status: refresh.status })
        }
        // Not reached after the fix; would be the ticket mint (shape from S14).
        return new Response(JSON.stringify({ ticket: 'never', ttl_seconds: 30 }), { status: 200 })
      },
    })
    await hermes.initialize()
    const connection = await hermes.add({ name: 'VPS', baseUrl: URL_A })
    const store = new HermesTokenStore(join(dir, 'hermes', 'tokens'), codec)
    await store.set(connection.id, URL_A, tokens({ expiresAt: 0 }))
    const dial = hermes.dialFor(connection.id)()
    await started
    await hermes.signOut(connection.id)
    release()
    await expect(dial).rejects.toBeInstanceOf(HermesSignedOutError)
    expect(await store.get(connection.id, URL_A)).toBeNull()
    expect(opened).toEqual([])
    expect(hermes.get(connection.id)?.state).toBe('signed-out')
  })

  it('cancel still wins after the browser came back, while the code exchange is in flight', async () => {
    const exchange = recordedExchanges('S1').find((entry) => entry.path === '/auth/native/token' && entry.status === 200)!
    let requested!: () => void
    let release!: () => void
    let opened!: (url: string) => void
    const started = new Promise<void>((resolve) => { requested = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    const authorize = new Promise<string>((resolve) => { opened = resolve })
    const controller = new AbortController()
    const signingIn = runNativeSignIn(URL_A, {
      openExternal: opened,
      fetchImpl: async () => {
        requested()
        await hold
        return new Response(JSON.stringify(exchange.body), { status: exchange.status })
      },
    }, controller.signal)
    const parsed = new URL(await authorize)
    const redirect = String(parsed.searchParams.get('redirect_uri'))
    await fetch(`${redirect}?code=review-code&state=${parsed.searchParams.get('state')}`)
    await started
    // The callback is consumed: the listener is already closed during the exchange.
    await expect(fetch(redirect)).rejects.toThrow()
    controller.abort()
    release()
    await expect(signingIn).rejects.toBeInstanceOf(SignInCancelledError)
  })

  it('ignores a stateless error callback instead of ending the sign-in', async () => {
    let opened!: (url: string) => void
    const authorize = new Promise<string>((resolve) => { opened = resolve })
    const controller = new AbortController()
    const signingIn = runNativeSignIn(URL_A, { openExternal: opened, fetchImpl: async () => { throw new Error('not reached') } }, controller.signal)
    const redirect = String(new URL(await authorize).searchParams.get('redirect_uri'))
    expect((await fetch(`${redirect}?error=access_denied`)).status).toBe(400)
    controller.abort()
    // Ended by the cancel, not by the forged error (which would reject with auth-rejected).
    await expect(signingIn).rejects.toBeInstanceOf(SignInCancelledError)
  })

  it('treats a refused ticket mint as signed out instead of retrying forever', async () => {
    // Justified literal: no recording has a 403 on /api/auth/ws-ticket; the
    // shape is the package's documented refusal (statusError: 401/403 without
    // `session_expired` → auth-rejected).
    const store = new HermesTokenStore(dir, codec)
    await store.set('conn1', URL_A, tokens())
    const reasons: string[] = []
    const broker = new HermesTokenBroker({
      connectionId: 'conn1', baseUrl: URL_A, store,
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'forbidden' }), { status: 403 }),
      onSignedOut: (reason) => reasons.push(reason),
    })
    await expect(broker.ticket()).rejects.toBeInstanceOf(HermesSignedOutError)
    expect(await store.get('conn1', URL_A)).toBeNull()
    expect(reasons).toHaveLength(1)
  })
})

describe('HermesTokenStore', () => {
  it('encrypts at rest and returns tokens only for the URL that issued them', async () => {
    const store = new HermesTokenStore(dir, codec)
    await store.set('conn1', URL_A, tokens())
    const raw = await readFile(join(dir, 'conn1.bin'), 'utf8')
    expect(raw.startsWith('enc:')).toBe(true)
    expect(await store.get('conn1', URL_A)).toMatchObject({ accessToken: 'access-1' })
    // An edited URL (or a document/blob out of step after a crash) must never
    // send this token to another host.
    expect(await store.get('conn1', 'https://elsewhere.example')).toBeNull()
  })

  it('reads an unreadable blob as signed out instead of throwing', async () => {
    const store = new HermesTokenStore(dir, codec)
    await store.set('conn1', URL_A, tokens())
    const broken = new HermesTokenStore(dir, { ...codec, decrypt: () => { throw new Error('keychain reset') } })
    expect(await broken.get('conn1', URL_A)).toBeNull()
  })

  it('refuses a connection id that is not a safe path segment', async () => {
    const store = new HermesTokenStore(dir, codec)
    await expect(store.set('../escape', URL_A, tokens())).rejects.toThrow(/Invalid Hermes connection id/)
  })
})

describe('HermesTokenBroker (recorded S14: 401 session_expired → refresh → ticket)', () => {
  it('refreshes once on an access-expired ticket refusal and mints with the fresh token', async () => {
    const s14 = recordedExchanges('S14')
    const tail = s14.slice(s14.findIndex((exchange) => exchange.path === '/api/auth/ws-ticket' && exchange.status === 401))
    const { fetchImpl, calls } = replay(tail)
    const store = new HermesTokenStore(dir, codec)
    await store.set('conn1', URL_A, tokens())
    const broker = new HermesTokenBroker({ connectionId: 'conn1', baseUrl: URL_A, store, fetchImpl, onSignedOut: () => undefined })
    const ticket = await broker.ticket()
    expect(ticket.length).toBeGreaterThan(10)
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/ws-ticket', '/auth/native/refresh', '/api/auth/ws-ticket'])
    // The rotated pair was persisted, bound to the same URL.
    expect((await store.get('conn1', URL_A))?.provider).toBe('basic')
  })

  it('runs ONE refresh for concurrent callers (Nous rotates and reuse-detects refresh tokens)', async () => {
    let refreshes = 0
    const fetchImpl = async (input: string) => {
      const path = new URL(input).pathname
      if (path === '/auth/native/refresh') {
        refreshes += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_at: Date.now() / 1000 + 900, provider: 'basic', user_id: 'agentcode' }), { status: 200 })
      }
      return new Response(JSON.stringify({ ticket: 'ticket-xyz', ttl_seconds: 30 }), { status: 200 })
    }
    const store = new HermesTokenStore(dir, codec)
    // About to expire: inside the 60 s refresh margin.
    await store.set('conn1', URL_A, tokens({ expiresAt: Date.now() + 10_000 }))
    const broker = new HermesTokenBroker({ connectionId: 'conn1', baseUrl: URL_A, store, fetchImpl, onSignedOut: () => undefined })
    await Promise.all([broker.ticket(), broker.ticket(), broker.ticket()])
    expect(refreshes).toBe(1)
  })

  it('signs the connection out when the refresh token itself is dead', async () => {
    // Justified literal: routes.py auth_native_refresh's documented 401 (the
    // password provider's 30-day refresh tokens never expired in a recording).
    const fetchImpl = async (input: string) => new URL(input).pathname === '/auth/native/refresh'
      ? new Response(JSON.stringify({ error: 'session_expired', detail: 'Refresh token expired or invalid; start a new sign-in.' }), { status: 401 })
      : new Response('{}', { status: 500 })
    const store = new HermesTokenStore(dir, codec)
    await store.set('conn1', URL_A, tokens({ expiresAt: Date.now() - 1000 }))
    const reasons: string[] = []
    const broker = new HermesTokenBroker({ connectionId: 'conn1', baseUrl: URL_A, store, fetchImpl, onSignedOut: (reason) => reasons.push(reason) })
    await expect(broker.ticket()).rejects.toBeInstanceOf(HermesSignedOutError)
    expect(await store.get('conn1', URL_A)).toBeNull()
    expect(reasons).toHaveLength(1)
  })
})

describe('runNativeSignIn', () => {
  it('completes from the loopback redirect carrying our state, and ignores a forged one first', async () => {
    const s1 = recordedExchanges('S1')
    const { fetchImpl, calls } = replay(s1.filter((exchange) => exchange.path === '/auth/native/token'))
    let authorize = ''
    const signedIn = runNativeSignIn(URL_A, {
      fetchImpl,
      openExternal: async (url) => {
        authorize = url
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const parsed = new URL(authorize)
    expect(parsed.pathname).toBe('/auth/native/authorize')
    const redirect = new URL(String(parsed.searchParams.get('redirect_uri')))
    // RFC 8252 §8.3: a canonical loopback IP literal, never `localhost`.
    expect(redirect.hostname).toBe('127.0.0.1')
    const forged = await fetch(`${redirect.toString()}?code=attacker&state=forged`)
    expect(forged.status).toBe(400)
    const good = await fetch(`${redirect.toString()}?code=real-code&state=${parsed.searchParams.get('state')}`)
    expect(good.status).toBe(200)
    const result = await signedIn
    expect(result.provider).toBe('basic')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ code: 'real-code' })
    // The listener is gone once sign-in completed.
    await expect(fetch(redirect.toString())).rejects.toThrow()
  })

  it('stops waiting and closes the listener when cancelled', async () => {
    const controller = new AbortController()
    let authorize = ''
    const signingIn = runNativeSignIn(URL_A, { fetchImpl: async () => new Response('{}'), openExternal: (url) => { authorize = url } }, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(signingIn).rejects.toBeInstanceOf(SignInCancelledError)
    const redirect = new URL(String(new URL(authorize).searchParams.get('redirect_uri')))
    await expect(fetch(redirect.toString())).rejects.toThrow()
  })
})

describe('HermesConnectionService', () => {
  const service = () => new HermesConnectionService({ stateDir: dir, codec, openExternal: () => undefined })

  it('normalizes URLs, rejects duplicates, and signs a connection out when its URL changes', async () => {
    const hermes = service()
    await hermes.initialize()
    const added = await hermes.add({ name: 'Homelab', baseUrl: '100.64.0.1:9119/' })
    expect(added.baseUrl).toBe('http://100.64.0.1:9119')
    await expect(hermes.add({ name: 'homelab', baseUrl: 'https://other.example' })).rejects.toThrow(/already exists/)
    await expect(hermes.add({ name: 'Other', baseUrl: 'http://100.64.0.1:9119' })).rejects.toThrow(/already points at/)
    // Pretend a sign-in happened, then move the URL.
    await new HermesTokenStore(join(dir, 'hermes', 'tokens'), codec).set(added.id, added.baseUrl, tokens())
    const reloaded = service()
    await reloaded.initialize()
    expect(reloaded.get(added.id)?.state).toBe('ready')
    expect(reloaded.hasSignedInConnection()).toBe(true)
    const moved = await reloaded.update(added.id, { name: 'Homelab', baseUrl: 'https://new-host.example' })
    expect(moved.state).toBe('signed-out')
    expect(await new HermesTokenStore(join(dir, 'hermes', 'tokens'), codec).get(added.id, 'http://100.64.0.1:9119')).toBeNull()
  })

  it('never puts a credential in the connection info the renderer receives', async () => {
    const hermes = service()
    await hermes.initialize()
    const added = await hermes.add({ name: 'VPS', baseUrl: 'https://vps.example' })
    await new HermesTokenStore(join(dir, 'hermes', 'tokens'), codec).set(added.id, added.baseUrl, tokens({ accessToken: 'SECRET-ACCESS', refreshToken: 'SECRET-REFRESH' }))
    const reloaded = service()
    await reloaded.initialize()
    expect(JSON.stringify(reloaded.list())).not.toMatch(/SECRET-/)
  })
})
