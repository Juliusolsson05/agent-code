# Extension network origins and per-extension secrets

Issue: #1150. Consumer: Juliusolsson05/agent-code-poker#22 (LAN chat, where each
player's own app calls ElevenLabs text-to-speech with that player's own key).

## Problem

- `net.fetch` (`net.connect`) reaches literal private/loopback IPs only, and the
  frame CSP is `connect-src 'self'`. An extension cannot call one specific public
  web API.
- Nothing stores a credential. `api.storage` is plain JSON under the state
  directory.
- Pre-existing bug: the view broker (`frameProtocol`/`frameHost`) never accepted
  `net.fetch` or `service.expose`. A v2 VIEW's call to either failed the schema
  parse and was dropped, and the promise never settled. The runtime transport
  and the SDK both expose these calls. Poker's in-app LAN view uses both.
- Pre-existing bug: `frameDocument`/`runtimeDocument` read `init.method`, but
  the public SDK type `NetFetchInit` names the field `httpMethod`. An SDK
  author's POST was sent as a GET.

## Design

### Declared public origins (`net.origins`)

- **Manifest.** `"networkOrigins": ["https://api.elevenlabs.io"]` plus the
  permission `net.origins`, which pairs with it.
  - Exact origins only, 1–4 of them.
  - Each entry must equal `new URL(entry).origin` and use https.
  - The host is a DNS name: no IP literal, no `localhost`/`.local`, no
    wildcard. There is no userinfo, path, query or hash.
  - v2 only.
- **Why a declared list rather than a widened `net.connect`.** Consent must
  name what is reached. The dialog lists each origin, and the grant is bound to
  the bundle hash like every other capability, so an update that changes the
  list re-prompts. The list is data in the manifest, not a per-call argument,
  which means compromised extension code cannot add one.
- **Where the checks live.** The zod schema only makes the field optional and
  bounded. The strict per-entry grammar and the pairing rule are post-parse
  checks in `assertContributionsAreCoherent`. The ledger re-validates installed
  rows with the schema on every launch, and a tightened schema would make an
  installed extension vanish instead of failing loudly at install.
- **Routing in main (`capabilityService`).** `net.fetch` no longer has one fixed
  capability:
  - a literal private IP keeps the `net.connect` policy (`netFetch.ts`,
    unchanged except the response tail);
  - an https URL whose origin is in the VERIFIED installation's
    `networkOrigins` requires `net.origins` (`netOrigins.ts`);
  - anything else is refused, and the message names the declared list.
- **Where the origins come from.** They are read from the ledger row only when
  the bundle hash verifies. They share the per-generation grant cache, so
  revocation on publication is identical.
- **Public fetch rules.**
  - `redirect: 'error'`: a declared origin must not bounce the request, key
    header included, to an undeclared one.
  - 15 s timeout.
  - The same 256 KiB response cap.
  - Header values and sent bodies never appear in errors or logs.
- **HTTPS-only is also the DNS-rebinding defence.** A declared name that
  resolves to a LAN device cannot present a valid certificate for that name.
- **Binary bodies.** `responseType: 'base64'` returns
  `{ body: base64, bodyEncoding: 'base64' }`. Audio has to cross the JSON
  transports, and UTF-8 decoding would corrupt it. `bodyEncoding` is always
  present, so a caller can tell an old host (text only) from a new one.

### Secrets (`api.secrets`)

- **API.** `get(key) → string | null`, `set(key, value)`, `delete(key)`.
- **Tier 0.** No permission is needed, following the VS Code SecretStorage
  precedent. The namespace is the extension id that the authenticated transport
  fixed, so an extension can only read what it stored itself. A consent prompt
  would protect nothing.
- **Storage.** Electron `safeStorage` through the existing `SecretCodec`
  (keyVault). There is one 0o600 blob per key under
  `STATE_DIR/extension-secrets/<id>/`, written atomically.
- **Failure rules.**
  - The store refuses when encryption is unavailable, never falling back to
    plaintext.
  - A decrypt failure reads back as `null`.
- **Limits.** Key `^[a-zA-Z0-9._-]{1,64}$`, value 1–4096 characters, 32 keys
  per extension.
- **Uninstall deletes the directory.** This is unlike `storage`, which is
  deliberately retained. A later install with the same id from another source
  must not inherit credentials.
- **Routing.** Secrets go through `capabilityService` with a `null` (Tier 0)
  requirement, so views and runtimes share one implementation.

### Broker fixes

- `frameProtocol` accepts `net.fetch`, `service.expose` and `secrets.*`.
- In `frameHost`:
  - `net.fetch` is not pre-gated, because main picks the capability by target;
  - `service.expose` requires `net.listen`;
  - `secrets.*` are Tier 0.
- Both documents read `init.httpMethod ?? init.method`, pass `responseType`, and
  expose `secrets`.

### Consent copy

- The `net.origins` disclosure lists every origin.
- The "It has no network access." sentence is now conditional on no network
  capability being requested.

### SDK

agent-code-extension-api v0.10.0:
- the `net.origins` capability;
- `networkOrigins` on the v2 manifest;
- `NetFetchInit.responseType` and `NetFetchResult.bodyEncoding`;
- `ExtensionSecretsApi` on the v2 view and runtime APIs.

## Tests

- **Manifest:**
  - each refused origin shape;
  - the pairing rule in both directions;
  - v1 refused.
- **netOrigins with an injected `perform`:**
  - an undeclared origin is refused;
  - an exact match is required (no subdomain or port variants);
  - the redirect option is set;
  - an oversized body is refused;
  - base64 round-trips;
  - no header value appears in errors.
- **Secrets store with a fake codec:**
  - namespacing;
  - unavailable encryption is refused;
  - limits;
  - the value is never in error text;
  - decrypt failure returns `null`;
  - uninstall cleanup.
- **capabilityService routing:** private → `net.connect`; declared → `net.origins`.
- **frameProtocol:** regression for `net.fetch` and `service.expose`.

## Merge notes

Open PR #1148 edits `netFetch.ts`. This branch touches only its request type
and response tail, and adds routing in `capabilityService.perform`, so expect a
small, mechanical conflict.

## Review round (2026-09-23)

The OpenCode review found no blockers. Findings fixed:
- **Response cap after buffering.** The cap was checked only after the whole body was buffered, so a chunked response could stream into main. Both paths now read through a reader that stops at the cap.
- **Reserved headers on the public path.** The public path now refuses the host-reserved headers from #1148 too.
- **Secrets surviving removal.** Secrets survived clearing a quarantined row, or a crash mid-uninstall. The ledger now owns their lifecycle:
  - uninstall deletes them first;
  - clearing a quarantined row deletes them when no working install shares the id;
  - a first install of an id clears stale ones.
- **Trailing-dot hosts.** Origins such as `https://localhost.` are refused.
- **TLS verification pinned** by a comment and a test.

Design pass: after the review, the parent session asked for a design-rationale pass (every addition must be a general capability). The API shapes are unchanged. `responseType: 'base64'` stays, because it is the one binary encoding both transports carry: the runtime channel is ExtensionJson and cannot carry an ArrayBuffer. Limits stay fixed host limits, now documented per transport. There is no manifest minimum-host-version field; an older host refuses unknown capabilities at install, and that refusal is today's version gate.
