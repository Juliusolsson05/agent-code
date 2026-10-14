// Browser sign-in to a Hermes backend: RFC 8252 loopback redirect + PKCE.
//
// Hermes brokers this itself (hermes_cli/dashboard_auth native_flow.py): we
// open its /auth/native/authorize in the SYSTEM browser, the user signs in
// there (password form or Nous OAuth; Hermes picks or offers a chooser), and
// Hermes redirects to OUR one-shot loopback listener with a code we redeem
// with the PKCE verifier. Recorded end to end in hermes-headless S1.
//
// WHY the system browser and not an Electron window: OAuth providers (Nous
// Portal) rightly refuse embedded webviews, and the user's password manager
// and existing Nous session live in their browser. It is also the flow
// Hermes Desktop uses (apps/desktop/electron/native-oauth-login.ts).
//
// WHY 127.0.0.1 and an ephemeral port: Hermes rejects `localhost` and any
// non-canonical loopback authority (routes.py _validate_loopback_redirect_uri,
// RFC 8252 §8.3). Port 0 lets the OS pick a free port per attempt.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  readAuthorizationCode,
  type FetchLike,
  type HermesTokens,
} from 'hermes-headless'

// Hermes keeps a pending native authorization for 10 minutes
// (native_flow._PENDING_TTL_SECONDS = 600); waiting longer can only fail.
export const SIGN_IN_DEADLINE_MS = 10 * 60_000

const CALLBACK_PATH = '/hermes/callback'

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;padding:48px;max-width:520px;margin:auto;color:#222">` +
  `<h2>${title}</h2><p>${body}</p></body>`

export type NativeSignInDeps = {
  openExternal: (url: string) => Promise<void> | void
  fetchImpl?: FetchLike
  deadlineMs?: number
}

export class SignInCancelledError extends Error {
  constructor(message = 'Sign-in was cancelled.') {
    super(message)
    this.name = 'SignInCancelledError'
  }
}

/**
 * Run one sign-in. Resolves with the bearer pair, or rejects (timeout,
 * refusal, state mismatch, cancellation through `signal`). The loopback
 * listener is closed on every path.
 */
export async function runNativeSignIn(
  baseUrl: string,
  deps: NativeSignInDeps,
  signal?: AbortSignal,
): Promise<HermesTokens> {
  const pkce = createPkce()
  let settle!: { resolve: (url: string) => void; reject: (error: Error) => void }
  const callback = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      // Browsers probe /favicon.ico; never let a stray request end the flow.
      res.writeHead(404).end()
      return
    }
    // Only the redirect carrying OUR state may complete the flow, errors
    // included: Hermes only ever redirects here with `code` + `state`
    // (dashboard_auth/routes.py _native_redirect), so a stateless `?error=`
    // can only come from something else on this machine trying to end the
    // sign-in. A forged or stale callback gets a page and the wait continues.
    if (url.searchParams.get('state') !== pkce.state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in link expired', 'Start the sign-in again from Agent Code.'))
      return
    }
    const failed = url.searchParams.get('error')
    res.writeHead(failed ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' }).end(
      failed
        ? PAGE('Sign-in did not complete', 'You can close this tab and try again from Agent Code.')
        : PAGE('Signed in to Hermes', 'You can close this tab and return to Agent Code.'),
    )
    settle.resolve(url.toString())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const timer = setTimeout(() => settle.reject(new SignInCancelledError('Sign-in timed out after 10 minutes.')), deps.deadlineMs ?? SIGN_IN_DEADLINE_MS)
  const onAbort = () => settle.reject(new SignInCancelledError())
  signal?.addEventListener('abort', onAbort, { once: true })
  let closed: Promise<void> | null = null
  const closeListener = () => {
    closed ??= new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    return closed
  }

  try {
    await deps.openExternal(
      buildAuthorizeUrl({
        baseUrl,
        codeChallenge: pkce.challenge,
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        state: pkce.state,
      }),
    )
    const redirected = await callback
    // The one valid callback is consumed: stop listening NOW rather than
    // through the token exchange, which can take as long as the VPS does.
    void closeListener()
    const code = readAuthorizationCode(redirected, pkce.state)
    if (signal?.aborted) throw new SignInCancelledError()
    const tokens = await exchangeCode({ baseUrl, code, codeVerifier: pkce.verifier }, deps.fetchImpl)
    // Cancel must still win after the browser came back: the user clicked it
    // while the exchange was in flight, and resolving here would sign them in
    // anyway (review a #7). The code is spent either way; the tokens are
    // simply never returned.
    if (signal?.aborted) throw new SignInCancelledError()
    return tokens
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    await closeListener()
  }
}
