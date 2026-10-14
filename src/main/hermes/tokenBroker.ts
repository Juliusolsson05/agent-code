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
//    instead of retrying a dead token forever.

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
  /** Read at every use: a URL edit must re-bind (and so sign out) at once. */
  baseUrl: () => string
  store: HermesTokenStore
  fetchImpl?: FetchLike
  now?: () => number
  /** Credentials became unusable (refresh refused): the owner marks signed-out. */
  onSignedOut: (reason: string) => void
}

export class HermesTokenBroker {
  private refreshing: Promise<HermesTokens> | null = null

  constructor(private readonly deps: TokenBrokerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async current(): Promise<HermesTokens> {
    const tokens = await this.deps.store.get(this.deps.connectionId, this.deps.baseUrl())
    if (!tokens) throw new HermesSignedOutError(this.deps.connectionId)
    return tokens
  }

  /** Refresh once, shared by every caller that asks while it runs. */
  private refresh(stale: HermesTokens): Promise<HermesTokens> {
    if (this.refreshing) return this.refreshing
    const baseUrl = this.deps.baseUrl()
    this.refreshing = refreshTokens({ baseUrl, refreshToken: stale.refreshToken, provider: stale.provider }, this.deps.fetchImpl)
      .then(async (fresh) => {
        await this.deps.store.set(this.deps.connectionId, baseUrl, fresh)
        return fresh
      })
      .catch(async (error: unknown) => {
        if (error instanceof HermesAuthError && (error.kind === 'session-expired' || error.kind === 'auth-rejected')) {
          await this.deps.store.delete(this.deps.connectionId)
          this.deps.onSignedOut(error.message)
          throw new HermesSignedOutError(this.deps.connectionId, `The Hermes sign-in expired. ${error.message}`)
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
    const baseUrl = this.deps.baseUrl()
    const token = await this.accessToken()
    try {
      return (await mintWsTicket({ baseUrl, accessToken: token }, this.deps.fetchImpl)).ticket
    } catch (error) {
      if (!(error instanceof HermesAuthError) || error.kind !== 'access-expired') throw error
      const fresh = await this.refresh(await this.current())
      return (await mintWsTicket({ baseUrl, accessToken: fresh.accessToken }, this.deps.fetchImpl)).ticket
    }
  }
}
