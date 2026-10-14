// One connection's credentials at runtime: always hand out a ticket minted
// with a valid access token, refreshing when needed (#1482).
//
// Rules, each from a recording or Hermes' own client:
//  - Refresh is SINGLE-FLIGHT per connection. Nous OAuth refresh tokens are
//    rotated and reuse-detected (Hermes Desktop main.ts), so two concurrent
//    refreshes with the same token log the user out. (The password provider
//    does not detect reuse, recorded S1, but one implementation must be safe
//    for both.)
//  - Refresh EARLY (60 s before `expires_at`), and once more when a ticket
//    mint answers `access-expired` (recorded S14: an expired token gets 401
//    `session_expired`, one refresh, then a ticket).
//  - A refresh that answers `session-expired` / `auth-rejected` deletes the
//    tokens: the connection is signed out and every pane on it says so,
//    instead of retrying a dead token forever. A ticket mint refused the same
//    way (with a token we just validated or refreshed) means the same thing.
//  - A broker is bound to ONE base URL for its whole life and can be revoked.
//    The service revokes it on sign-out, URL edit and removal. Every network
//    call and every token write re-checks that, because those operations are
//    async: a refresh that started before Sign out must not write a fresh
//    pair afterwards (resurrecting the sign-in), and a token read for URL A
//    must never be sent to URL B after an edit (review a #1, #4). Reading the
//    URL lazily per call, as the first version did, let exactly that happen.

import {
  HermesAuthError,
  mintWsTicket,
  refreshTokens,
  type FetchLike,
  type HermesTokens,
} from 'hermes-headless'

import type { HermesTokenStore } from '@main/hermes/tokenStore.js'

const REFRESH_MARGIN_MS = 60_000

export class HermesSignedOutError extends Error {
  constructor(readonly connectionId: string, message = 'Sign in to this Hermes connection in Settings → Hermes.') {
    super(message)
    this.name = 'HermesSignedOutError'
  }
}

export type TokenBrokerDeps = {
  connectionId: string
  /** Fixed for the broker's life; a URL edit revokes this broker instead. */
  baseUrl: string
  store: HermesTokenStore
  fetchImpl?: FetchLike
  now?: () => number
  /** Credentials became unusable (refresh refused): the owner marks signed-out. */
  onSignedOut: (reason: string) => void
}

export class HermesTokenBroker {
  private refreshing: Promise<HermesTokens> | null = null
  private revoked = false

  constructor(private readonly deps: TokenBrokerDeps) {}

  /** Sign-out, URL edit or removal: nothing this broker started may land. */
  revoke(): void {
    this.revoked = true
  }

  /** Throws once revoked; call before any network use or token write. */
  assertLive(): void {
    if (this.revoked) throw new HermesSignedOutError(this.deps.connectionId)
  }

  /** The refused credentials are dead: forget them and tell the owner. */
  private async signedOut(error: HermesAuthError, message: string): Promise<never> {
    // Only while still the owner: a revoked broker's late refusal must not
    // delete whatever a newer sign-in has written since.
    if (await this.deps.store.delete(this.deps.connectionId, () => !this.revoked)) this.deps.onSignedOut(error.message)
    throw new HermesSignedOutError(this.deps.connectionId, `${message} ${error.message}`)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async current(): Promise<HermesTokens> {
    this.assertLive()
    const tokens = await this.deps.store.get(this.deps.connectionId, this.deps.baseUrl)
    this.assertLive()
    if (!tokens) throw new HermesSignedOutError(this.deps.connectionId)
    return tokens
  }

  /** Refresh once, shared by every caller that asks while it runs. */
  private refresh(stale: HermesTokens): Promise<HermesTokens> {
    if (this.refreshing) return this.refreshing
    const { baseUrl } = this.deps
    this.refreshing = Promise.resolve()
      .then(() => {
        this.assertLive()
        return refreshTokens({ baseUrl, refreshToken: stale.refreshToken, provider: stale.provider }, this.deps.fetchImpl)
      })
      .then(async (fresh) => {
        // Written only if this broker is still the owner when the write's turn
        // comes (the store serializes per connection): a Sign out, URL edit
        // or newer sign-in queued meanwhile wins, and nothing of ours lands
        // after it.
        await this.deps.store.set(this.deps.connectionId, baseUrl, fresh, () => !this.revoked)
        // Not written means revoked: this throws HermesSignedOutError then.
        this.assertLive()
        return fresh
      })
      .catch(async (error: unknown) => {
        if (error instanceof HermesAuthError && (error.kind === 'session-expired' || error.kind === 'auth-rejected')) {
          return this.signedOut(error, 'The Hermes sign-in expired.')
        }
        throw error
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  /** A valid access token, refreshed first if it is about to expire. */
  async accessToken(): Promise<string> {
    let tokens = await this.current()
    if (tokens.expiresAt - this.now() < REFRESH_MARGIN_MS) tokens = await this.refresh(tokens)
    return tokens.accessToken
  }

  /** A single-use WebSocket ticket (30 s), retrying once through a refresh. */
  async ticket(): Promise<string> {
    const { baseUrl } = this.deps
    const token = await this.accessToken()
    try {
      this.assertLive()
      return (await mintWsTicket({ baseUrl, accessToken: token }, this.deps.fetchImpl)).ticket
    } catch (error) {
      if (error instanceof HermesAuthError && (error.kind === 'session-expired' || error.kind === 'auth-rejected')) {
        // Not transient: the server refused credentials we hold. Retrying
        // with backoff would spin forever (review a #6).
        return this.signedOut(error, 'Hermes refused this sign-in.')
      }
      if (!(error instanceof HermesAuthError) || error.kind !== 'access-expired') throw error
      const fresh = await this.refresh(await this.current())
      this.assertLive()
      return (await mintWsTicket({ baseUrl, accessToken: fresh.accessToken }, this.deps.fetchImpl)).ticket
    }
  }
}
