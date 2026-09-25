# Extension services and scoped network capabilities

Status: approved in conversation 2026-09-20; implementation on `feat/extension-services` (Refs #1109).

## Problem

The extension platform can render views, touch scoped project files, and show
toasts — but nothing an extension does can outlive a frame or move a byte over
the network. Every "real tool" extension hits this wall: language servers,
dev-server launchers, device bridges, local dashboards, LAN games. The platform
needs the sidecar pattern (VS Code's most successful extension shape: spawn a
real process, talk structured RPC to it), with one deliberate difference —
VS Code grants full Node to every extension by default; we keep powers
permission-gated per extension, brokered like the existing `fs.read`/`fs.write`
tiers.

## Generality rule

These are powers, not product features. Every capability passes four gates:

1. **Naming** — `<resource>.<verb>`; no app, protocol, or scenario in the name.
2. **Consumers** — at least three believable non-poker extensions want exactly
   this shape (LSP servers, webhook receivers, SSH/remote tools, DB explorers).
3. **Shape** — the API would still make sense if Agent Code Poker did not exist.
4. **Surface** — the poker extension consumes only public API. No
   `if (extensionId === …)` anywhere in the host.

"LAN" never appears in the taxonomy. Private-address-only is v1 **broker
policy** on the network capabilities, recorded in the grant and shown in the
consent dialog — the same way `fs.write` scopes to a project rather than the
home directory. Widening to public egress later is a policy decision with its
own consent copy, not new capability names.

## Capabilities

- `service.run` — the manifest declares bundled Node service entries under
  `contributes.services`. The host owns the process (Electron `utilityProcess`):
  explicit start/stop from the extension's own runtime or view, one live
  instance per service id, terminated on update/remove/uninstall/app quit.
  Structured JSON-RPC over the utility-process port with bounded payloads.
  **Consent copy must say plainly that a service is native code running with
  the user's privileges.** The grant gates lifecycle + RPC, and — critically —
  gates the host conveniences below; it is not a sandbox claim. This is the
  VS Code trust model, scoped per extension and consented at install.
- `service.transport` — a view/runtime may talk to **its own** service only.
  `agent-code-ext://<extId>/__service/<serviceId>/<path>` is proxied by the
  host scheme handler to that service's loopback endpoint. The child CSP stays
  `connect-src 'self'`; origin isolation does the confinement, exactly like
  Chrome's `runtime.connect` to your own background page.
- `net.listen` — host-owned exposure. The service itself binds loopback and
  reports its endpoint; only when this grant exists does the host bind the
  private interface and reverse-proxy. LAN reachability is therefore a host
  gate with a kill switch (service stops → listener closes), not something the
  service process can self-grant.
- `net.connect` — brokered outbound `net.fetch` from runtime/view to
  user-entered addresses. v1 policy: literal private/loopback IPs only;
  anything else fails with an actionable error. No DNS names in v1 (a hostname
  can resolve anywhere; literal IPs are auditable in the dialog and the log).

## Why host-owned LAN exposure (net.listen) rather than "let the service bind"

A Node service process already has real network syscalls — we do not pretend to
sandbox it. What the host CAN own is the difference between "running locally"
and "reachable from the LAN": the private-interface socket lives in the host,
is created only under the grant, and dies with the service. A well-behaved
service never needs to bind non-loopback itself; the consent dialog and the
running-app network state tell the truth about who is exposed. This also gives
one place for port-collision handling and a future per-table/per-service kill
switch in Settings.

## Trust model, stated once

- Views and runtimes remain sandboxed with no raw network (existing CSP and
  session walls unchanged; the runtime session's webRequest block stays).
- A service is trusted native code, like a VS Code extension-host module. The
  install dialog enumerates `service.run` with language that says so. Users who
  decline get a Tier-0 extension that still installs.
- All brokered conveniences (transport proxy, LAN listener, outbound fetch)
  check the grant on every call and die on revoke (publication edge), matching
  `capabilityService`'s existing revocation race handling.

## Consumer mapping (proof of generality)

| Capability | LSP-style | Dev-server | Device bridge | Poker |
|---|---|---|---|---|
| `service.run` | spawn server, RPC requests | spawn bundler | spawn adb/serial daemon | spawn LAN host |
| `service.transport` | diagnostics panel | preview URL proxy | device log tail | in-app lobby |
| `net.listen` | — | share preview on LAN | — | friends join from browser |
| `net.connect` | remote analyzer | — | connect to instrument | join a friend's table |

## Staging

Each stage lands its capability name together with its schema member, grant
gate, broker arm, and boundary tests (the rule written in
`ExtensionCapability` docs):

1. Service lifecycle + RPC (`service.run`)
2. View ⇄ service transport proxy (`service.transport`)
3. Host-owned LAN listener (`net.listen`)
4. Brokered outbound fetch (`net.connect`)

SDK package types (`packages/agent-code-extension-api`) mirror each stage and
`dist/` is rebuilt in the same commit. `docs/extensions/authoring.md` gains the
capabilities and their trust implications.
