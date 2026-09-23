# Managed-skill pre-spawn gate: shrink the blast radius (#1133)

## Problem

`SessionManager.spawnWithId` runs `beforeAgentSessionStart(options)` before
every agent spawn. That hook (wired in `src/main/index.ts`) runs the managed
skills `audit()` and then `ensureTldrSkill()` / `ensureGoalSkill()` for the
requested reporting domains. On a throw, the manager journals
`conventions.pre_spawn_reconcile.error` and then:

```ts
if (hasReportingDomain(options.builtInMcpDomains)) throw error
```

Almost every pane has TLDR or Goal enabled, so one managed-skill failure turns
into "no agent in any provider can start". Recovery then journals
`recover.failed code=start-failed` with no cause, so the journal cannot say why
the start failed.

## Evidence

From the issue's incident journals:

| Run | Build | Reconcile errors | Message |
|---|---|---|---|
| `2026-09-18T00-49-30…77c310` | `0b744b88` (pre-grok) | 17 | `TLDR skill deployment failed` (cause unknown) |
| `2026-09-19T04-09-36…9e113a` | post-#844 | 15 | `TLDR skill is unavailable or conflicts…` (#1014) |
| `2026-09-19T04-13-05…fddcd2` | post-#844 | 15 | same (#1014) |

On Sept 19, every reconcile error is followed at `seq+1`, in the same
millisecond, by `recover.failed` (15/15 and 14/14). #1017 and #1037 fixed
specific ways a skill could fail (unsupported providers, discovery errors). The
Sept 18 cluster predates grok and #1017 does not explain it. This change fixes
the blast radius for any future cause.

## Decided behavior (user-accepted default, can be changed)

1. A pre-spawn reconcile failure no longer aborts a spawn, whatever domains are
   requested. The agent launches without the broken managed skill. The TLDR
   and Goal MCP servers still deliver their own server instructions, so the
   session loses the skill's guidance, not the capability.
2. The failure is visible: a warning names the skill and points to
   Settings › Agents › Custom Skills, where TLDR/Goal health already shows.
3. `recover.failed` carries a typed `cause` from a closed enum. Raw exception
   text still stays out of IPC.

## Approach

### Hook contract (main)

- The pre-spawn hook resolves to a list of per-step failures
  (`{ skill: 'conventions' | 'tldr' | 'goal'; error }`) instead of throwing on
  the first failure. New `AgentCodeManagedSkillsService.prepareForAgentSpawn`
  runs the audit and each requested product skill **independently**. Before,
  a failed audit or TLDR skipped Goal as well.
- `SessionManager` stays the policy owner. It journals each failure under the
  existing `conventions.pre_spawn_reconcile.error` name, with a `skill` field,
  so existing triage greps keep working. It never rethrows. If the hook itself
  throws, which is unexpected, every requested reporting skill is treated as
  unavailable, so the warning still fires.
- For requested reporting skills that failed, the manager emits
  `managed-skills-unavailable` `{ sessionId, skills }`.

### Warning channel (renderer)

Existing channels, by fit:

- Provider conditions: interactive, provider-specific TUI states. Wrong shape.
- Pane toast (`showPaneToast`): renderer-driven only. It would also show on
  every restoring pane.
- `session:*` routed channels: session-window routing quarantines events for
  unowned ids and records routing gaps. A skill warning for a main-initiated
  spawn would show up as a false routing gap.
- **GlobalToast**: app-wide, click-to-dismiss, and already fed by a main→renderer
  push (`extensions:notification`). Managed-skill health is app-wide, not
  per-pane, so this fits best.

Decision: the forwarder broadcasts `managed-skills:unavailable { skills }` to
all windows. Preload exposes `onManagedSkillsUnavailable`, and
`GlobalToastProvider` subscribes and shows a long (10 s), dismissible toast.
The message comes from a pure `managedSkillsUnavailableMessage(skills)`.
When a whole workspace restores, the single-slot toast collapses N identical
warnings into one.

Persistent state stays in Settings (custom-skill health rows). The toast only
points there.

### `recover.failed` cause

`SESSION_START_FAILURE_CAUSES` in `src/shared/lifecycle/events.ts`:

- `missing-workspace`: `MissingWorkspaceDirectoryError`.
- `cli-not-found`: new `ProviderCliNotFoundError`. Its message is unchanged,
  because the renderer's spawn-error text reads it.
- `provider-launch`: the provider's `start()` threw. The manager tags the
  error through a WeakMap and does not wrap it, because callers and tests
  depend on the original error's identity and message.
- `unknown`: anything else.

`conventions-gate` is deliberately **not** a value. After this change the gate
cannot fail a start, so the value would never be emitted. The reconcile
failure is still in the journal as `conventions.pre_spawn_reconcile.error`.

## Tests

- `src/main/sessionManager.wake.test.ts`: the two tests that asserted the old
  abort (TLDR / Goal) now assert the new contract. The spawn resolves, the
  provider session is created, the MCP token is **not** revoked, and
  `managed-skills-unavailable` names the skill. A hook that throws outright
  still spawns and warns for the requested reporting skills. All of these fail on
  origin/main.
- `src/main/sessionManager.lifecycle.test.ts` (the diagnostic-stream suite):
  `recover.failed` carries `cause: 'missing-workspace'` / `'cli-not-found'` /
  `'provider-launch'` / `'unknown'`, and a provider start error's text does not
  appear in the event. These fail on origin/main because there is no cause.
- `AgentCodeCustomSkillsService.system.test.ts`: `prepareForAgentSpawn`
  reports a TLDR failure (a user-owned file in the way) and still prepares
  Goal. On main a TLDR failure skipped Goal.
- `src/main/sessions/forwarder.test.ts`: the warning is broadcast with domain
  names only.
- `src/shared/types/tldr.test.ts`: `managedSkillsUnavailableMessage` names the
  skill(s) in a fixed order and points to Settings.

## Verification

Once at the end: `npx tsc -b` and the touched vitest files, on Node 24.
