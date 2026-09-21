# Extension services + scoped network capabilities — implementation plan

Issue #1109 · branch `feat/extension-services` · design: `docs/design/extension-services-and-network.md`

Each stage lands ONE capability end-to-end: shared type + schema, manifest
validation, capability union member, grant gate, broker arm (both transports:
runtime preload and view frame), SDK package mirror + dist rebuild, tests.
No stage introduces a name the others cannot enforce yet.

Test-first per stage; the negative cases (ungranted, cross-extension,
public-address, escaping paths) are the point, not coverage padding.

---

## Stage 0 — docs (this file + design)

- [x] `docs/design/extension-services-and-network.md`
- [x] `docs/plans_and_ideas/2026-09-20-extension-services-plan.md`
- Commit: `docs(extensions): design and staged plan for services + scoped network capabilities`

## Stage 1 — `service.run`: process lifecycle + RPC — DONE

**Files**

- Create `src/shared/types/extensionServicesProtocol.ts` — wire schemas for
  service lifecycle calls and the utility-process RPC envelope (NDJSON-free:
  Electron MessagePort `postMessage`, JSON bounded by `isExtensionJson`).
- Create `src/main/extensions/serviceHost.ts` — `ExtensionServiceHost`:
  spawn/stop/status/invoke, single instance per `extensionId+serviceId`,
  `onExtensionPublication` revoke → terminate, `pause()`/`dispose()` drain,
  spawn factory injected for tests (house pattern: deadline/spawn injection).
- Modify `src/shared/types/extensions.ts` — `ExtensionCapability` +=
  `'service.run'`; `ExtensionContributions.services?: { id; title?; entry }[]`;
  `EXTENSION_CAPABILITIES` mirror.
- Modify `src/main/extensions/manifest.ts` — `serviceContribution` zod
  (`id` CONTRIBUTION_ID, `title?`, `entry` ENTRY_PATH, `.strict()`, max 4);
  v1 manifest with services fails; apiVersion 2 requires entry.
- Modify `src/shared/types/extensionServices.ts` — request schemas:
  `service.start { serviceId }`, `service.stop { serviceId }`,
  `service.status { serviceId }`, `service.invoke { serviceId, method, params }`.
- Modify `src/main/extensions/capabilityService.ts` — REQUIRED_CAPABILITY
  entries (`service.*` → `service.run`); perform arms delegating to an injected
  `ExtensionServiceHost`.
- Modify `src/main/extensions/runtimeService.ts` — nothing (Tier-2 already
  routes via capabilityService).
- Modify `src/renderer/src/apps/host/frameProtocol.ts` + `frameHost.ts` —
  FrameRequest members `service.start|stop|status|invoke`, REQUIRED_CAPABILITY
  `service.run`, perform → `window.api.extensionsServiceRequest`.
- Modify `src/main/extensions/install.ts` — validate service entries resolve
  inside the bundle (same containment as `entry`).
- Modify `packages/agent-code-extension-api/src/{manifest,api,runtime}.ts` —
  mirror types; `RuntimeApiV2.services` and view-api `services`:
  `start(id) stop(id) status(id) invoke(id, method, params)`; service module
  contract `defineService` (`ServiceContext`: `ready(endpoints?)`,
  `onRequest(handler)`, `log(line)`). Rebuild `dist/`.
- Tests:
  - `manifest.test.ts`: services accepted (v2), rejected (v1, escaping entry,
    missing entry, >4).
  - `capabilityService.system.test.ts`: ungranted `service.run` rejects; grant
    via ledger row allows start/invoke/stop against a FAKE spawned service
    (injected factory: script that speaks the RPC envelope over `process.parentPort`).
  - `serviceHost` unit: revoke on publication kills instance; double-start
    returns same handle; stop is idempotent; invoke timeout rejects and stops.
  - `frameProtocol`/frameHost renderer test: frame `service.invoke` reaches
    `extensionsServiceRequest` with the grant, rejects without.

**Behavior contract**

- Start: host resolves bundle dir + entry containment, forks utilityProcess,
  waits for `ready` (bounded), exposes status `{state:'running', pid?}`.
- Service→host `ready { endpoints?: {name, port}[] }`; host→service
  `{kind:'request', id, method, params}`; service→host
  `{kind:'result', id, ok, value|error}`; service→host `{kind:'log', line}`.
- Stop: graceful `{kind:'shutdown'}` + deadline (500 ms default) then kill.
- Consistency: every reply carries the generation; a retired service's late
  result is dropped, never delivered to a new instance.

- Commit: `feat(extensions): service.run capability with host-owned process lifecycle`

## Stage 2 — `service.transport`: origin-scoped proxy — DONE (proxy landed under __bundle/<rev>/__service/… so transport URLs are generation-pinned)

**Files**

- Modify `src/main/extensions/scheme.ts` — reserve `__service/<serviceId>/…`
  path before bundle resolution; proxy method/headers/body to
  `http://127.0.0.1:<port>/<rest>` via main `net.fetch`; only when the
  extension holds `service.transport`, the service is running, and it reported
  a loopback endpoint. 404 otherwise (no existence oracle).
- Modify capability checks: proxy consults `installedExtensionCapabilities`
  per request (bundle-hash-bound, same as broker).
- Modify `packages/agent-code-extension-api` — document
  `fetch('agent-code-ext://<id>/__service/<sid>/path')` + grant in api types.
- Tests: scheme handler unit tests with injected fetch — granted + running →
  proxied; ungranted → 404; not running → 404; other-extension URL → 404;
  service reporting non-loopback endpoint → refused (policy test).

- Commit: `feat(extensions): service.transport origin-scoped service proxy`

## Stage 3 — `net.listen`: host-owned LAN exposure — DONE (one listener per extension, expose() recreates per call)

**Files**

- Create `src/main/extensions/serviceLanListener.ts` — host binds private
  interfaces (port chosen by OS under a user-visible `expose` call),
  reverse-proxies to the service loopback endpoint; closes when service stops,
  grant is revoked, or `expose(false)`.
- Modify `extensionServices.ts` — `service.expose { serviceId, lan: boolean }`
  schema; REQUIRED_CAPABILITY: `net.listen`.
- capabilityService arm → serviceHost.expose; boundary: single LAN listener per
  extension; ports recorded for Settings display (return `{ port }`).
- SDK mirror + dist; authoring docs.
- Tests: ungranted reject; expose(true) without running service reject; stop →
  listener closed (poll port); revoke (publication) → closed; proxy still
  forwards bytes (fake upstream HTTP server in-test).

- Commit: `feat(extensions): net.listen host-owned LAN exposure for services`

## Stage 4 — `net.connect`: brokered outbound fetch — DONE (global fetch in main, no electron import needed)

**Files**

- Modify `extensionServices.ts` — `net.fetch { url, method?, headers?, body? }`
  (bounded body 64 KiB, header allow-list, no streaming) → `net.connect`.
- Create `src/main/extensions/netPolicy.ts` — literal-IP private/loopback
  parser (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `::1`, `fc00::/7`, `fe80::/10`); hostnames/DNS/public → reject with
  actionable copy. Pure function, exhaustive table tests.
- capabilityService arm performs main-side `net.fetch` with 10 s timeout,
  response body cap 256 KiB.
- frameProtocol member + REQUIRED_CAPABILITY `net.connect`; SDK mirror + dist.
- Tests: policy table (each range ± public), grant gate, response cap,
  non-http scheme reject.

- Commit: `feat(extensions): net.connect brokered private-address fetch`

## Stage 5 — docs, authoring fixture, full checks

- Update `docs/extensions/authoring.md`: capabilities section incl. trust copy
  ("a service is native code with your privileges"), examples.
- Counter example or new minimal `examples/ping-service` exercising
  start/invoke/stop via `check-extension-frames.mjs` if that harness supports
  it (else unit-covered; do not fake an Electron journey).
- `npm run typecheck && npm run test` (+ system project), review diff, push,
  PR linking `Refs #1109`, issue checklist updated.

## Out of scope (recorded, not implied)

Public egress, DNS names in net.fetch, WebSocket passthrough, sandboxing
service processes, auto-start activation events for services, poker wiring
(separate repo + PR after this lands).
