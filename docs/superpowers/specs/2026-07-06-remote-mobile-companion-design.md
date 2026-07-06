# Remote Mobile Companion

**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan

## Problem

Agent Code is built for people who run many agents at once, but control is
pinned to the desktop. There is no way to walk away from the machine and still
watch a long-running agent, answer a permission prompt, or nudge a session with
a follow-up prompt from your phone.

We want a mobile companion: open a URL on a phone, see every session's live
output, send prompts, and answer agents' permission requests — driving the
*real* agents (not a reduced API) from your pocket. LAN by default, with an
optional public tunnel for use away from the network.

Two constraints shape the whole design:

1. **The product thesis must hold.** The phone must show the same custom React
   transcript rendering the desktop shows — not a raw terminal, not a
   second-class re-implementation that drifts. (See `README.md`, `MANIFESTO.md`.)
2. **Isolation for many contributors.** This subsystem is expected to attract
   several people working in parallel. It must live behind a hard boundary so a
   contributor can work entirely inside "remote" without touching — or
   understanding — the PTY/session core, and so remote work can never break the
   desktop.

## Solution

Introduce a **`SessionFeed`** contract — the single seam between "how the UI gets
session data + sends input" and "where that data physically comes from." The
desktop keeps working by implementing `SessionFeed` over Electron IPC. The phone
is a *second* implementation of the same contract over WebSocket. The renderer's
transcript components are fed by the contract, so both surfaces render
identically and future rendering work lands once.

On top of that seam, a main-process subsystem (`RemoteServer`) exposes the same
`SessionManager` event stream to authenticated phones over HTTP/WebSocket, with
a deliberately narrow inbound protocol (prompts and permission replies only —
no shell, no session lifecycle in v1).

### Scope for v1 (deliberate line)

Allowed from the phone: **read every session** + **send prompt** + **submit /
Enter** + **interrupt** + **reply to permission prompts** (approve/deny tool use
& folder access). NOT in v1: raw shell command execution, spawning/killing
sessions, provider switching. These are simply absent from the wire protocol, so
a stolen token cannot express them — scope is enforced by the protocol's shape,
not only by a runtime check.

## The Isolation Boundary (load-bearing)

This is the part that must not erode. The rule is a **one-way dependency wall**:

```
   core (main/*, renderer core, providers/*)  ──may be imported by──▶  remote/*
   remote/*  ──may NOT be imported by──▶  core
```

- **Core never imports from `remote/`.** There is no line anywhere in
  `sessionManager.ts`, the providers, or the desktop shell that references the
  remote subsystem. If you deleted the entire remote tree, core would still
  compile and run.
- **The wall has exactly three holes**, each tiny and explicit:
  1. `SessionFeed` — the shared contract (in `src/shared/`), imported by both
     the renderer and the remote client. This is the *only* type-level coupling.
  2. **One construction line** in `src/main/index.ts` — build `RemoteServer`
     next to `BuiltInMcpHttpHost`, hand it the existing `SessionManager`. Mirrors
     exactly how the MCP host is already wired (`index.ts:452-475`).
  3. **One feed-selection point** in the renderer — desktop picks
     `IpcSessionFeed`; the phone bundle picks `WebSocketSessionFeed`. Everything
     downstream is feed-agnostic.
- **Contributors live inside two directories:** `src/main/remote/` (server) and
  `src/remote-client/` (phone UI). Neither requires understanding PTYs, tmux, or
  provider spawn logic — only the `SessionFeed` + `SessionManager` public
  surfaces.

Why a one-way wall and not just "put it in a folder": a folder alone doesn't
stop core from growing an `import { RemoteServer }` that quietly couples the
phone feature into the session hot path. The direction of the dependency is the
invariant. If core ever needs something from remote, that's the signal to widen
`SessionFeed` or add a neutral event, not to import upward.

## Architecture

```
Phone browser ──HTTP/WS──▶  RemoteServer (main)  ──▶  SessionManager (existing, untouched)
  src/remote-client/           src/main/remote/          PTYs, transcripts, tmux
  reuses renderer's       ┌── auth (DevicePairing)            │
  transcript components   ├── scope-limited WS protocol       │
  via WebSocketSessionFeed├── subscribes to session events ◀──┘  (2nd consumer, like the
                          └── RemoteTransport (LAN | tunnel)      renderer forwarder)
```

`SessionManager` already emits every session event to a forwarder that pushes to
the renderer (`src/main/sessions/forwarder.ts`, wired at `index.ts:478`).
`RemoteServer` becomes a **second, independent subscriber** to that same stream —
it does not change how the desktop is fed. Outbound events fan out to connected
phones (filtered by each device's grants). Inbound phone messages are verified,
scope-checked, and translated into the same `SessionManager` input calls the
desktop already uses.

## Directory Structure

```
src/
  shared/
    sessionFeed/
      SessionFeed.ts         # THE contract: interface + event/message/DTO types
      types.ts               # SessionSummary, SessionEvent, InboundMessage (zod schemas)

  main/
    remote/                  # ALL main-side remote code — isolated
      RemoteServer.ts        # HTTP+WS server (modeled on BuiltInMcpHttpHost)
      SessionFeedSource.ts   # adapts SessionManager -> outbound SessionEvents
      auth/
        DevicePairing.ts     # QR/one-time-code pairing, token mint/verify
        deviceRegistry.ts    # persisted paired-device store + revocation
        secret.ts            # per-install HMAC secret (created once, on disk)
      protocol/
        messages.ts          # zod schemas for every WS message (in & out)
        scope.ts             # v1 allow-list: which inbound types are legal
      transport/
        RemoteTransport.ts   # seam: how the server becomes reachable
        LanTransport.ts      # phase 1: bind LAN interface, report URL/IP
        CloudflaredTunnel.ts # phase 2: spawn third_party/cloudflared, parse URL
    ipc/
      remote.ts              # tiny desktop<->RemoteServer control IPC (enable, QR, devices)

  renderer/
    features/
      sessionFeed/
        IpcSessionFeed.ts    # desktop impl of SessionFeed (wraps today's window.api.*)
        SessionFeedContext.tsx # provider; desktop injects IpcSessionFeed here
      remote/                # desktop "Remote" settings panel (control UI only)
        RemotePanel.tsx      # enable server, show LAN QR, tunnel toggle+QR, device list+revoke

  remote-client/             # the phone web app — its own electron-vite build target
    index.html
    main.tsx                 # mounts renderer transcript components against WebSocketSessionFeed
    WebSocketSessionFeed.ts  # phone impl of SessionFeed (WS transport + reconnect)
    pairing/                 # scan/enter code, store token
    ui/                      # thumb-friendly chrome: session switcher, prompt box, approve/deny

third_party/
  cloudflared/               # phase 2 — manifest.json + fetch/verify scripts (matches tmux/mitmproxy)

scripts/runtime-tools/
  fetch-cloudflared.mjs      # phase 2
  verify-cloudflared.mjs     # phase 2
```

## Components

### SessionFeed (the contract)
The interface every UI surface uses instead of talking to a transport directly:

```ts
interface SessionFeed {
  listSessions(): Promise<SessionSummary[]>
  subscribeSessions(cb: (list: SessionSummary[]) => void): Unsubscribe
  subscribe(sessionId: string, cb: (event: SessionEvent) => void): Unsubscribe
  sendPrompt(sessionId: string, text: string): Promise<void>
  submit(sessionId: string): Promise<void>          // Enter
  interrupt(sessionId: string): Promise<void>        // Esc/Ctrl-C equivalent
  replyToPermission(sessionId: string, reply: PermissionReply): Promise<void>
}
```

Two implementations: `IpcSessionFeed` (desktop; each method is the existing IPC
call it already makes) and `WebSocketSessionFeed` (phone; each method is a WS
message + response correlation, with reconnect/backfill).

### RemoteServer
Owns an HTTP server + WS endpoint bound via `RemoteTransport`. Serves the built
`remote-client` bundle. On WS upgrade it verifies a device token; per socket it
tracks which sessions the device may see. Subscribes once to
`SessionFeedSource` and fans events to sockets. Inbound messages are parsed by
`protocol/messages.ts`, checked against `protocol/scope.ts`, then applied to
`SessionManager`. Lifecycle mirrors `BuiltInMcpHttpHost`: constructed in
`index.ts`, `start()`/`stop()` on app ready/quit, off by default.

### DevicePairing + deviceRegistry
Pairing: desktop generates a short-lived one-time code + shows a QR encoding
`{url, code}`. Phone POSTs the code; server verifies it's live, mints an
HMAC-signed device token (per-install secret from `auth/secret.ts`), and records
the device in `deviceRegistry` (persisted under the storage-paths convention).
Every token is revocable from `RemotePanel`. Verification happens on WS upgrade
*and* on every mutating message.

### RemoteTransport (LAN now, tunnel later)
A seam so "reachability" is swappable. `LanTransport` binds the chosen interface
and reports the `http://<ip>:<port>` URL for the QR. `CloudflaredTunnel` (phase
2) spawns bundled `cloudflared`, parses the `trycloudflare.com` URL from stdout,
and reports it; the URL is ephemeral so the QR regenerates each enable.

### remote-client (phone UI)
A separate electron-vite build target (config is already multi-target — see
`electron.vite.config.ts` and the `testing/rendering` precedent). It imports the
renderer's *presentational* transcript components and drives them with
`WebSocketSessionFeed`, wrapped in mobile chrome: a session switcher, a sticky
prompt box, and big approve/deny controls for permission prompts.

## Data Flow

**Outbound (Mac → phone):** `SessionManager` event → forwarder (unchanged,
feeds desktop) **and** `SessionFeedSource` (new, feeds RemoteServer) →
per-socket grant filter → WS frame → phone's `WebSocketSessionFeed` → same React
transcript components the desktop uses.

**Inbound (phone → Mac):** phone action → WS message (token attached) →
`RemoteServer` verifies token → `protocol/scope.ts` confirms the type is in the
v1 allow-list → translated to a `SessionManager` input call (identical to the
desktop's). Unknown/out-of-scope types are rejected before reaching
`SessionManager`.

## Security Posture

- Server **off by default**; explicit enable in `RemotePanel`.
- Token required on WS upgrade **and** every mutating message.
- Pairing requires one-time physical proximity (scan the QR on the Mac's screen).
- Per-device revocation from the desktop.
- v1 protocol has no shell/lifecycle messages — a stolen token cannot open a
  shell or spawn a session because those words don't exist on the wire.
- Tunnel is a **separate** explicit toggle (off by default); ephemeral URL, QR
  regenerated each enable.
- Fully local: no Agent Code account, no cloud state. cloudflared quick tunnels
  need no account.

## Phasing

Each phase is independently useful and independently shippable.

- **Phase 0 — `SessionFeed` refactor (standalone, no user-visible change).**
  Define the contract; route the desktop renderer through `IpcSessionFeed`.
  Ships alone; de-risks everything after it. This is the decoupling the codebase
  wants regardless of the phone (aligns with provider plug-and-play, #394).
- **Phase 1 — LAN companion.** `RemoteServer` + `DevicePairing` + `remote-client`
  (v1 scope) + `RemotePanel`. Works on your Wi-Fi.
- **Phase 2 — remote tunnel.** Bundle `cloudflared` in `third_party/`, wire the
  tunnel toggle + QR.

## Testing

- **Phase 0:** unit-test the renderer against a `FakeSessionFeed` (proves the
  decoupling — renderer runs with no Electron). Desktop smoke: existing flows
  unchanged.
- **Phase 1:** `protocol/scope.ts` allow-list unit tests (out-of-scope messages
  rejected); `DevicePairing` token mint/verify/revoke unit tests;
  `WebSocketSessionFeed` ↔ `RemoteServer` integration against a real
  `SessionManager` with a fake PTY.
- **Phase 2:** `CloudflaredTunnel` URL-parse unit test against captured stdout;
  manual end-to-end over a live tunnel.

(Per repo convention, avoid adding permanent new test files in feature PRs where
possible; temporary fixtures are fine — a separate test-coverage pass is planned.)

## Non-Goals (v1)

- Raw shell execution, session spawn/kill, provider switching from the phone.
- Stable/custom tunnel domains (needs a Cloudflare account) — quick tunnel only.
- Multi-user / team access — this is one owner, their own devices.
- Native mobile apps — it's a web client.
</content>
</invoke>
