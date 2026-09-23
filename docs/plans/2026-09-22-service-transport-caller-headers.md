# Service proxy and LAN listener: forward caller identity

Issue: #1147 (consumer: Juliusolsson05/agent-code-poker#17)

## Problem

Both host paths that reach an extension service rebuild the request headers from
`accept` and `content-type` only:

- the service proxy (`serviceTransport.ts`, the frame's `./__service/<id>/…`);
- the LAN listener (`serviceLanListener.ts`, `net.listen`).

So a service cannot authenticate callers (no `Authorization`). It also cannot
tell three kinds of caller apart: a request the host proxied from its own
frame, a LAN peer (which arrives from 127.0.0.1 because the listener dials
loopback), and a direct loopback caller.

## Contract (host side, service-agnostic)

Common to both paths: forward `authorization` in addition to `accept` and
`content-type`. Nothing else from the caller passes; cookies, arbitrary `x-*`
and caller-supplied attestation headers are still dropped.

**Service proxy** (frame → service):

- Adds `x-agent-code-transport: service`. The host is attesting that the
  request came from the owning extension's own origin. The grant and endpoint
  checks already ran, and the frame CSP is `connect-src 'self'`.
- Why a custom header and not a synthetic `Origin`: `net.fetch` runs on
  Chromium's network stack, where `Origin` is a restricted header. We cannot
  prove from source that a set value survives, and the app must not be
  launched to find out. A custom header is always delivered.
- A custom header is also the classic CSRF-proof signal. A browser page cannot
  attach it cross-origin without a CORS preflight, and the service simply
  never answers one.

**LAN listener** (LAN peer → service):

- Adds `x-agent-code-transport: lan`, `x-forwarded-for: <socket peer>` and
  `x-forwarded-host: <Host the peer used>`. It forwards the peer's `origin`
  and `sec-fetch-site` verbatim.
- The service applies its own same-origin rule against `x-forwarded-host`, and
  its own peer rule against `x-forwarded-for`. The listener still enforces its
  private-source rule first.
- Every one of these values is set by the listener from the socket and
  request line. A peer-supplied `x-forwarded-*` or `x-agent-code-transport`
  can never pass through, because the allow-list does not include them.
- The response carries these of the service's security headers back:
  `content-security-policy`, `x-content-type-options`, `referrer-policy` and
  `x-frame-options`. They only restrict the browser, so forwarding them cannot
  widen anything. Before this change, LAN browsers loaded the page without the
  service's CSP.

## Tests

- `serviceTransport.test.ts`: authorization is forwarded, the attestation is
  set, and a caller-forged attestation or `x-forwarded-*` is replaced or
  dropped.
- New `serviceLanListener.test.ts`: a real listener plus a real loopback
  upstream, driven with real HTTP. It covers the forwarded header set, a peer
  who forges the attestation or forwarding headers, and the security response
  headers.

## Verification

`npx tsc -b` plus targeted vitest under Node 24. Never launch the app:
two-device acceptance in the installed app stays with the user.
