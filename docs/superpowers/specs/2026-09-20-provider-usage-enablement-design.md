# Provider enablement + multi-provider usage — design

Status: draft for review · Date: 2026-09-20 · Branch: `feat/provider-usage-enablement`

## Problem

The usage modal, header indicator, and exhaustion-driven provider-switch
suggestions are hardcoded to Claude + Codex (`UsageProviderKind` is an
`Extract<AgentProviderKind, 'claude' | 'codex'>`, and `usageService.ts`
fetches exactly two readers). Meanwhile the app registers five provider kinds
— Claude, Codex, OpenCode (structured), OpenCode Terminal, Grok — so a Grok
user has no quota visibility and no way to stop Grok from appearing in every
picker, and a z.ai GLM Coding Plan consumed through OpenCode has no usage
surface at all.

Three needs, one design:

1. **Provider enablement settings** — turn providers off so they stop
   appearing as alternatives; defaults come from what is actually installed.
2. **More usage sources** — Grok subscription usage and z.ai coding-plan
   usage (read through the user's OpenCode credential, per its selected
   usage source).
3. **A usage modal that scales** past two sections.

## Decisions (from the brainstorm, user-approved)

| Question | Decision |
| --- | --- |
| Where does OFF apply? | **Everywhere**: new-agent pickers, single/bulk provider-switch menus, fleet bulk actions, usage modal + header. Running sessions are untouched — this is a visibility/spawn filter, not a kill switch. |
| Default state for new users | **Auto-detect**: enabled iff the provider's CLI is detected on PATH at first read; an explicit user toggle pins the value; Reset restores detection. |
| Usage coverage this iteration | Grok reader + z.ai via OpenCode. OpenCode itself has no single-quota concept (BYO keys); its settings expose *which* configured provider's usage to show. |
| How z.ai integrates | **Via OpenCode only** — not a new agent provider kind. |
| Architecture | **Usage-source registry** (Approach A) — a small main-process registry in `src/main/usage/`, not fields on the big provider registries. |
| Modal layout | **Rail + detail pane** (Layout 2). |

## Contracts

### UsageSourceId

`UsageProviderKind` (src/shared/types/usage.ts:3) generalizes to:

```ts
type UsageSourceId = 'claude' | 'codex' | 'grok' | 'opencode:zai'
```

The snapshot shape is otherwise unchanged. `providers[]` carries one entry
per *active* source. `deriveProviderExhaustion` (src/shared/usage/exhaustion.ts)
keeps working per entry; disabled sources are absent from the snapshot, so
`BulkProviderSwitchModal` cannot suggest them.

Rows: both z.ai windows and the Grok credits window are `all-models` scope —
exhaustion on them legitimately means "switch provider". The Grok per-product
percentages, if shown, are `model-family`-scoped detail rows.

### Provider enablement state (main-owned)

Per agent kind (claude, codex, grok, opencode, opencode-terminal):

```ts
type ProviderEnablement = { enabled: boolean; source: 'detected' | 'user' }
type OpencodeUsageSource = 'none' | 'zai'
```

- Stored as main-owned setup state; the settings rows front it via the
  existing `storage: 'setup'` metadata pattern (settingsRegistry.ts).
- First read runs PATH detection (`which`-equivalent against the app's spawn
  binaries) and records `source: 'detected'`. A user toggle records
  `source: 'user'`. Reset clears the entry back to detection.
- Detection never overrides a `user` value — a user with Grok installed but
  unwanted keeps it hidden after reinstalls.

### Why main-owned, not renderer Settings

`usageService` (main) composes fetches from this state, and renderer pickers
filter on it; both processes need the same answer across window reloads. The
`storage: 'setup'` precedent exists precisely for rows whose truth lives in
main.

## Settings surface

New **Providers** category:

- One row per agent kind: toggle + detection hint ("not detected on PATH").
  Metadata: `scope: 'app'`, `apply: 'new-session'` — toggling does not touch
  running agents; copy must say so.
- The OpenCode row gains a **usage source** dropdown: `none | z.ai`
  (extensible registry; greyed out with an explanatory hint when OpenCode is
  disabled or no `zai-coding-plan` credential exists).

Surfaces that must filter on enablement (exhaustive list to verify in the
plan against `AGENT_PROVIDER_KINDS` consumers): new-agent provider pickers,
provider switch (single session + bulk), fleet bulk actions, saved-session
pickers where the provider is preselected, usage modal + header indicator.

## Main: usage-source registry

`src/main/usage/registry.ts` maps `UsageSourceId` →
`{ label, sourceLabel, read(): Promise<UsageProviderSnapshot> }`.
`usageService.getUsageSnapshot` composes the active list:

- `claude`, `codex`, `grok` when their agent kind is enabled,
- `opencode:zai` when OpenCode is enabled **and** the OpenCode usage source
  is `zai`.

Existing invariants preserved: per-source failure isolation (one stale token
never hides another provider's row), 30 s TTL cache, in-flight coalescing,
`force` semantics. Disabled ⇒ never fetched (not an error row).

## Readers

### claude / codex — unchanged

`readClaudeUsage` (Claude Code Keychain) and `readCodexUsage`
(`~/.codex/auth.json`) keep working as registry entries.

### grok — SuperGrok subscription billing

Endpoint verified against the installed Grok Build 1.0.30 binary (base URL
present in `strings`) and the maintained reference implementation
(ai-usagebar `src/supergrok/`, captured 2026-05..09):

- `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
- Headers: `Authorization: Bearer <key>` **plus**
  `X-XAI-Token-Auth: xai-grok-cli` (the token-auth header is required;
  without it the proxy reports "no auth context").
- `<key>` = the first non-empty `key` in `~/.grok/auth.json` (issuer-prefixed
  client map → login records). File is 0600; treat as read-only.

Response (camelCase): `subscriptionTier`, `config.creditUsagePercent`,
`config.currentPeriod { type, start, end }`, `config.productUsage[]
{ product, usagePercent }`, optional prepaid/on-demand cent fields. Mapping:
plan = tier; primary row = credit usage percent with reset = period end;
product rows as optional `model-family` detail.

**Expiry model (verified live 2026-09-20):** the local login's `key` JWT had
`expires_at: 2026-09-20T12:18:39Z`; with it past, the endpoint returns 401
"Invalid or expired credentials". The CLI refreshes `auth.json` itself via
its refresh token whenever a Grok session runs. Therefore the reader:

1. Checks `expires_at` (ISO string in the login record) before the request.
2. If expired: returns an **error row** — "Grok login expired — start any
   Grok session to refresh it." Self-heals: the header poller retries every
   60 s and the next Grok session refreshes the file. No reimplementation of
   the OIDC refresh; **never write `auth.json`** (it is the CLI's property;
   same policy as the reference implementation).

### opencode:zai — GLM Coding Plan quota (verified live)

- `GET https://api.z.ai/api/monitor/usage/quota/limit`
- Header: `Authorization: <KEY>` — the raw key, **no `Bearer` prefix**
  (verified: `Bearer …` returns 401). Key = `~/.local/share/opencode/auth.json`
  → `zai-coding-plan` → `.key` (OpenCode `/connect` → "Z.AI Coding Plan").

Verified response (live capture, 2026-09-20, redacted-none):

```json
{ "code": 200, "msg": "Operation successful", "success": true,
  "data": { "level": "max", "limits": [
    { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 28000,
      "currentValue": 118, "remaining": 27881, "percentage": 1,
      "nextResetTime": 1789962887570 },
    { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 140000,
      "currentValue": 92781, "remaining": 47218, "percentage": 66,
      "nextResetTime": 1790028489981 } ] } }
```

Mapping rules (from the reference implementation's captured evidence):

- `unit: 3` = 5-hour window, `unit: 6` = 7-day window. **Classify by `unit`,
  never by array position** — z.ai may reorder `limits`.
- `nextResetTime` is epoch ms. Plan = `data.level`.
- Both rows are `all-models` scope.
- `TIME_LIMIT` entries (monthly MCP ceiling) may appear; include as a detail
  row if present.
- **Inner-failure envelope:** HTTP 200 with `success: false` + non-200 `code`
  is a failure (verified shape: `{"code":500,"msg":"404 NOT_FOUND",…}` on
  wrong paths). Must surface as an error row, never as an empty-usage plan.
- An unclassifiable layout (`unit` values we cannot name) is drift → error
  row, not a guess.

### Security rules for both readers (non-negotiable)

- One read-only HTTPS request per source per fetch; keys live only in memory
  and the `Authorization` header.
- Keys are never logged, cached to disk, echoed in sanitized errors, or sent
  anywhere except the documented host above.
- Credential files (`~/.grok/auth.json`, opencode `auth.json`) are read-only;
  size-capped reads (≤ 2 MiB) like the reference implementation.

## Modal redesign (rail + detail)

```
┌─ Usage ──────────────────────────────────────────────────────┐
│ fetched 12:02 (cached)                        [refresh][close]│
│ ┌───────────────┐ ┌──────────────────────────────────────────┐│
│ │ Claude    62% │ │ Grok                       plan: SuperGrok││
│ │ Codex     31% │ │ xAI subscription                         ││
│ │ Grok  ⚠  88% │ │                                          ││
│ │ z.ai     66% │ │ Credits (current period)                 ││
│ │               │ │ ▓▓▓▓▓▓▓▓░░ 88%   resets <period end>     ││
│ │               │ │ Grok Build 90% · Grok 71% (product rows) ││
│ └───────────────┘ └──────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────┘
```

- Rail: one row per active source — severity dot, label, headline percent
  (the max row percent); ⚠ on warning/critical. Keyboard-navigable
  (↑/↓ + Enter), selection persists per open.
- Detail pane: full rows (label, bar, percent, reset, detail), plan line,
  spend pills (spend/extra/credits) — reuses `UsageProviderSection` row
  rendering where practical.
- Loading: per-source skeleton driven by the **known active-source list**
  (from a new `getUsageSources()` preload call), replacing today's
  fabricated `status: 'error'` "Loading…" rows (`LoadingSnapshot` in
  UsageModal.tsx).
- Subtitle: dynamic — "4 providers · fetched 12:02 (cached)".
- Empty state (every source disabled): link to the new Providers settings
  category.
- Header indicator: unchanged contract (`useUsageHeaderSnapshot`), chips per
  active source; the 60 s poll and visibility gating stay as-is.

## Error handling

- Per-source isolation is preserved end-to-end; a source's error renders in
  its rail row (muted dot + "!" badge) and its detail pane.
- Disabled ≠ error — disabled sources simply do not appear.
- `scope: 'unknown'` remains honest-non-exhaustion (unchanged).
- Grok expired-login error is actionable copy, not a generic failure.
- z.ai inner-failure envelopes are errors (above).

## Testing

- **Unit**: registry composition from enablement + opencode source; detection
  defaults + user-override pinning + reset; z.ai `unit` classification
  (order-shuffled fixtures, inner-failure envelope, unclassifiable layout);
  grok `expires_at` branch.
- **Renderer**: rail/detail rendering, keyboard nav, loading skeleton, empty
  state, chips.
- **System**: readers against captured fixtures. z.ai: redacted capture from
  the live response above (values only, no key material). Grok: capture
  during PR 2 with a freshly refreshed login (fixture only stores the
  response body).
- **Contract**: an exhaustiveness test mirroring `providerFeatures.test.ts`
  — every registered usage source is reachable from some setting combination
  and every `AGENT_PROVIDER_KINDS` entry has enablement state.

## Delivery phasing

Separate issues/PRs (created when implementation starts):

1. **Settings + enablement + registry-backed service + modal redesign.**
   Ships with Claude + Codex live; grok/z.ai rows appear in PR 2/3.
2. **Grok reader** — app-side reader + captured fixture. No submodule
   change needed (billing is read from auth.json + HTTPS, not from
   grok-code-headless). 
3. **OpenCode usage-source selector + z.ai reader** — settings dropdown,
   reader + captured fixture.
4. *(follow-up issue, out of scope)* additional OpenCode usage providers in
   the selector (e.g. kimi via its `/coding/v1/usages` endpoint) — the
   `opencode:<id>` id scheme leaves room.

## Risks & drift

- Both new endpoints are **undocumented** (z.ai monitor API; grok
  cli-chat-proxy billing). They are the same transports the CLIs themselves
  use, but upstream can move them. Mitigations: strict schema validation
  with honest error rows (never silent zeros), captured fixtures so drift
  fails tests loudly, and a note in `support/upstream-versions.json` review
  for the grok path (CLI strings can be re-checked by the upstream-watch
  workflow).
- Grok `key` expiry between sessions is expected behavior, not a bug; the
  copy must teach the remedy.
- The Brave Search API key used during the research spike is **not** stored
  anywhere in this repo (it was exhausted/over-limit during the session and
  is dead anyway); no secret material enters git.

## Provenance

- z.ai live verification: 200 response captured 2026-09-20 against
  `api.z.ai/api/monitor/usage/quota/limit` with the local opencode
  `zai-coding-plan` key (raw-header auth). Bearer variant → 401.
- Endpoint discovery reference: `akitaonrails/ai-usagebar` `src/zai/`,
  `src/supergrok/` (MIT), which documents the no-Bearer quirk, `unit`
  classification, inner-failure envelope, and the grok billing transport +
  required `X-XAI-Token-Auth` header.
- Grok base URL cross-checked in the installed grok 1.0.30 Mach-O binary
  (`strings` → `cli-chat-proxy.grok.com/v1`).
- z.ai plan semantics (5h + weekly credit windows, tiers): docs.z.ai
  `/devpack/overview`.
- OpenCode credential storage: opencode.ai/docs/providers (Credentials →
  `~/.local/share/opencode/auth.json`); verified locally
  (`zai-coding-plan -> {type, key}`).
