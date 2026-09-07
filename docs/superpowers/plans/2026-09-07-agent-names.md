# Agent Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opt-in **Agent names** setting that gives every provider agent a stable, voice-friendly name from an approved ranked list of 100 (Apollo, Jasper, Beatrix, …), shows it beside the title in agent headers and the Dispatch index, and exposes the same name to the external operator MCP so "send a prompt to Apollo" resolves to exactly one stable session ID. Default off. Titles, prompts, focus and layout are unchanged by enabling it.

**Architecture:** The name allocator lives in the **main process** and owns one durable file, `~/.config/agent-code/agent-names.json`, separate from `workspace.json`. It maps an opaque *naming identity* to a name; it never sees a workspace blob, a session ID's meaning, or the setting. One `AgentNameRegistry` instance per application process serializes every allocation on a single promise tail and commits to disk (temp file + `rename`) **before** returning a name, so two windows asking at the same instant cannot both be told "Apollo" and a crash cannot publish a name that was never reserved. Allocation is monotonic and never recycled: a delayed voice request for a closed Apollo must never reach a different agent. The renderer owns *which* logical agent an identity belongs to: `SessionMeta.agentNameId` is the durable identity, it is minted once by a membership-driven reconciler after workspace restoration, and the existing replacement and rehydration paths carry it across a new local session ID. A shared pure selector turns (setting, meta, resolved map) into a name for every consumer — the header, the Dispatch row, and the workspace observation — so nothing mints a name on render.

**Why `src/main/agentNames/` and not `src/main/ipc/agentNames.ts`:** every other main-process IPC domain lives as `src/main/ipc/<domain>.ts`. This one deviates because the decomposition's isolation rule is the whole point of the module — the registry may have exactly one importer, and that importer is its own IPC adapter. Putting the adapter in `src/main/ipc/` while the registry sat elsewhere would separate the two halves of one sealed unit and invite a second importer; keeping the pair in one directory makes "nothing outside this folder touches the allocator" a statement about a directory, which Task 11 Step 2 can then check with one grep. The registration call still lives in `registerAllIpc` beside every other domain, so the wiring stays visible where a reader expects it.

What survives from the uncommitted 71-line Stage 1 sketch: the **whole approach** and most of its judgement calls. `src/shared/agentNames/names.ts` (the 100-name ranking, `normalizeAgentName`, `agentNameAt` with explicit `Apollo 2` overflow suffixes) is kept as written. In `registry.ts` the serialized promise tail, reserve-before-publish ordering, temp-file + `rename` commit with `0o600`/`0o700` modes, "a failed write must not poison the in-memory cache", "a corrupt store throws and is never overwritten", and the prototype-safe assignment write are all kept — restructured into `load`/`allocate`/`commit` with the reasoning promoted into thick WHY comments, and given the concurrency, reopen and corrupt-store tests the stage requires and the sketch has none of. In `ipc.ts` the registered-window + main-frame sender guard, the input schema and the de-duplication are kept; the registry becomes an injectable constructor argument so the guard is testable. `SessionMeta.agentNameId` is kept. The default-off setting is kept but renamed `agentNames` → `agentNamesEnabled` (a boolean called `agentNames` reads like a list, and `settings.reference` publishes these names to operators). Three things are rewritten: the preload method moves off `workspaceApi` into its own `agentNamesApi`, because the decomposition isolates this registry from workspace persistence and the sketch bolted it onto the module that owns `workspace.json`; the sketch's identity seeding inside `spawn()` is **deleted**, because `spawn` is also the replacement path's spawn and seeding there is what breaks continuity; and the replacement commit's `agentNameId` is moved to the end of the object literal, because in the sketch the following `...sessions[newId]` spread overwrites it, so a provider switch or reload silently mints a *new* spoken name — the exact failure #816 forbids.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React 19, Zustand (`persist` for settings only), Zod 4, Vitest 4 (`unit` / `renderer` / `system` projects), Tailwind v4 CSS-first tokens.

**Spec:** `docs/decomposition/agent-names.md`
**Issue:** #816
**Branch:** `feat/agent-names` (worktree `../agent-code-agent-names`), rebased onto `origin/main` `13258ffa`.

## Global Constraints

- **Node 24.** Every command in this plan runs after `source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24`.
- **Type gate is `npm run typecheck`.** It runs `tsc -p tsconfig.control-sdk.json`, builds workflow-mcp, then `tsc -b`. `electron-vite build` and `vitest` do **not** type-check, so a green test run proves nothing about types. Run it at the end of every task that changes a type.
- **Tests run per project:** `NODE_ENV=test npx vitest run --project unit <path>` or `--project renderer <path>`. Do not run the whole suite per step; Task 11 runs it once.
- **Never launch the app.** No `npm run dev`, no Electron scratch harness. Reason from source and from tests.
- **Conventional Commits with a scope**, one commit per task, e.g. `feat(workspace): …`. Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
  ```
  The PR description ends with the same two lines.
- **Never merge.** Task 11 opens the PR with `Fixes #816` and stops. No merge authorization is inherited from #812.
- **Thick WHY comments are mandatory** (`CLAUDE.md`). Explain why a shape was chosen and what would make it wrong; do not narrate what the code does.
- **The setting is default off.** `DEFAULT_SETTINGS.agentNamesEnabled === false`, and a user who never enables it must never cause a write to `agent-names.json`.
- **Names are never minted on render.** Presentation reads one already-committed assignment through the shared selector. A component may not call the IPC, derive a name from an index, or fall back to a generated string.
- **The registry is isolated.** `src/main/agentNames/registry.ts` is imported only by `src/main/agentNames/ipc.ts`. No feature, UI or MCP module may import it or its file path, and main must never parse `workspace.json` to learn about naming.
- **The registry never shares storage with `workspace.json`.** Separate file, separate writer, separate failure mode.
- **Shells get no names.** Anything that is not `isAgentProviderKind` has no identity, no name, and no badge.
- **Names stay out of token-stream updates.** Reconciliation is driven by workspace membership and identity changes only, never by transcript entries or runtime deltas.
- **No `Object.hasOwn` in renderer or shared code.** `tsconfig.web.json` targets `lib: ["ES2020", …]`, so `Object.hasOwn` does not type-check. Use `Object.prototype.hasOwnProperty.call(…)`, which is what `src/renderer/src/lib/mouseBinding.ts:142-145` and `src/renderer/src/workspace/sessionOwnership.ts:103-106` already do and explain. `src/main` is `lib: ["ES2022"]` and could use it, but no main-process code in this plan needs it.
- **Every renderer store read added by this plan must tolerate a keyless store.** `src/remote-client/vite.config.ts:46-51` aliases `@renderer/app-state/hooks` to `src/remote-client/src/stubs/appStateHooks.ts`, whose state is `{ settings }` and nothing else — and the phone renders the real `PaneHeader` (`src/remote-client/src/ui/SessionView.tsx:330`). **`tsc` cannot catch a violation:** the alias exists only in the Vite config, while `tsconfig.web.json:93` type-checks `src/remote-client/**/*` against the *real* hooks module, so a selector that reads `state.workspaceState.sessions` compiles and then throws in the phone bundle. Several renderer tests mock the store the same keyless way (`DispatchColorFlags.renderer.test.tsx:14-29`, `AgentTerminalLeaf.dimensionOwnership.renderer.test.tsx:77-87`). The repository already pins this contract — "a keyless store must degrade to the prop instead of throwing" (`PaneHeader.phoneCoupling.renderer.test.tsx:43-50`). Optional-chain the reads and default the maps.

## File map

| Path | Change | Task |
| --- | --- | --- |
| `src/shared/agentNames/names.ts` | Commit the sketch's vocabulary with expanded WHY | 1 |
| `src/shared/agentNames/names.test.ts` | Create | 1 |
| `src/main/agentNames/registry.ts` | Rewrite the sketch into `load`/`allocate`/`commit` | 2 |
| `src/main/agentNames/registry.test.ts` | Create | 2 |
| `src/main/agentNames/ipc.ts` | Rewrite the sketch with an injectable registry | 3 |
| `src/main/agentNames/ipc.test.ts` | Create | 3 |
| `src/preload/api/agentNames.ts` | Create | 3 |
| `src/preload/api/index.ts` | Modify (compose the new domain) | 3 |
| `src/preload/api/workspace.ts` | Modify (revert the sketch's misplaced method) | 3 |
| `src/main/ipc/index.ts` | Modify (register the handler) | 3 |
| `src/renderer/src/app-state/settings/types.ts` | Modify (`agentNamesEnabled`) | 4 |
| `src/renderer/src/app-state/settings/persistence.ts` | Modify (coercion) | 4 |
| `src/renderer/src/app-state/settings/persistence.test.ts` | Modify (coercion tests) | 4 |
| `src/renderer/src/features/settings/lib/settingsRegistry.ts` | Modify (toggle entry) | 4 |
| `src/renderer/src/features/settings/lib/settingsRegistry.test.ts` | Modify (registry test) | 4 |
| `src/renderer/src/workspace/types.ts` | Modify (`SessionMeta.agentNameId`) | 5 |
| `src/renderer/src/workspace/hook/actions/session.ts` | Modify (3 lifecycle sites) | 5 |
| `src/renderer/src/workspace/hook/actions/agentNameContinuity.renderer.test.tsx` | Create | 5 |
| `src/renderer/src/app-state/types.ts` | Modify (`workspaceAgentNames`) | 6 |
| `src/renderer/src/app-state/workspace/slice.ts` | Modify (setter) | 6 |
| `src/renderer/src/workspace/agentNames/selectors.ts` | Create | 6 |
| `src/renderer/src/workspace/agentNames/selectors.test.ts` | Create | 6 |
| `src/renderer/src/workspace/agentNames/useAgentName.ts` | Create | 6 |
| `src/renderer/src/workspace/agentNames/reconcile.ts` | Create | 7 |
| `src/renderer/src/workspace/agentNames/useAgentNameReconciler.ts` | Create | 7 |
| `src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx` | Create | 7 |
| `src/renderer/src/workspace/hook/index.ts` | Modify (mount the reconciler) | 7 |
| `src/renderer/src/workspace/tile-tree/AgentTitleHeader.tsx` | Modify (name badge) | 8 |
| `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx` | Modify (pass `sessionId`) | 8 |
| `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx` | Modify (pass `sessionId`) | 8 |
| `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx` | Modify (row badge) | 8 |
| `src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx` | Create | 8 |
| `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx` | Modify (keyless-store gate) | 8 |
| `src/remote-client/src/stubs/appStateHooks.ts` | Modify (comment only) | 8 |
| `src/control-sdk/catalog/workspace.ts` | Modify (`agentName` in the observation) | 9 |
| `src/renderer/src/workspace/control.ts` | Modify (fill `agentName`) | 9 |
| `src/main/control/globalCapabilities.ts` | Modify (`name` filter in `agents.search`) | 9 |
| `src/renderer/src/workspace/control/agentNames.renderer.test.ts` | Create | 9 |
| `src/renderer/src/app/controlGuide.ts` | Modify (crash course) | 10 |
| `operator-skills/agent-code-computer-execution/SKILL.md` | Modify (operator skill) | 10 |
| `src/renderer/src/control/documentation.renderer.test.ts` | Modify (documentation contract) | 10 |

---

### Task 1: Shared ranked vocabulary and its contract

**Files:**
- Modify: `src/shared/agentNames/names.ts` (exists uncommitted from the Stage 1 sketch; keep the list verbatim, expand the header comment)
- Test: `src/shared/agentNames/names.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AGENT_NAMES: readonly string[]` — exactly 100 names, ranked, `AGENT_NAMES[0] === 'Apollo'`
  - `normalizeAgentName(name: string): string`
  - `agentNameAt(index: number): string`

- [ ] **Step 0a: Repair the sketch's pre-existing type error before anything else**

The working tree inherited from the Stage 1 sketch **does not type-check today**, so every later "run `npm run typecheck`" step would fail on someone else's line and hide your own errors. Confirmed on this branch:

```
$ npm run typecheck
src/renderer/src/features/settings/lib/settingsRegistry.ts(475,33): error TS2322: Type '"live"' is not assignable to type '"immediate" | "new-session" | "reload-live-sessions" | "restart-required"'.
```

`apply: 'live'` is not a member of `SettingMetadata['apply']` (`settingsRegistry.ts:42`). Delete the whole `metadata:` line from the sketch's `agent-names` entry — the row wants exactly `DEFAULT_SETTING_METADATA` (`settingsRegistry.ts:60-64`, `{ scope: 'app', apply: 'immediate', storage: 'settings' }`), and that file's comment reserves explicit metadata for rows "where the obvious reading would have been WRONG". Task 4 rewrites this entry properly; this step only clears the error:

```bash
# in src/renderer/src/features/settings/lib/settingsRegistry.ts, delete this line
#   metadata: { scope: 'app', apply: 'live', storage: 'settings' },
npm run typecheck   # must now be clean before you write a single new line
```

Do not commit this on its own; it is folded into Task 4's commit, which rewrites the entry.

- [ ] **Step 0b: Confirm the vocabulary's provenance with the user, and stop until they answer**

Names 4–100 are attested **only** by the uncommitted sketch. They are not on `origin/main`, not in `docs/`, and not in the user's memory directory:

```bash
git grep -n -i "apollo" origin/main -- .        # (no matches)
grep -ril "jasper" docs/                        # (no matches)
```

#816 names only the first three ("beginning with Apollo, Jasper and Beatrix"), and the file's header claims the rest are user-approved. That claim cannot be verified from anything in the repository.

Print the list and ask the user to confirm it against their approved ranked list **before Step 3 commits it**:

```bash
node -e "const s=require('fs').readFileSync('src/shared/agentNames/names.ts','utf8');console.log(s.match(/'[A-Za-z]+'/g).map((n,i)=>\`\${i+1}. \${n.slice(1,-1)}\`).join('\n'))"
```

**This is a hard stop.** The order is a contract: once allocation begins, reordering the list does not rename an existing agent — it silently changes which name the *next* agent receives, so a corrected list applied later leaves the fleet permanently inconsistent with the ranking. Fixing it before the first commit costs nothing; fixing it after the first user enables the setting costs their addresses. If the user cannot produce the original, say so and let them decide whether to ratify this file as the list of record.

- [ ] **Step 1: Write the failing vocabulary contract test**

The list is data, so the test is what stops a future edit from silently changing an address a user has already learned to speak. Create `src/shared/agentNames/names.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { AGENT_NAMES, agentNameAt, normalizeAgentName } from '@shared/agentNames/names'

// WHY this file is worth its length for a constant array: these strings are
// spoken addresses. Reordering the list re-points every NEW allocation, and
// deleting an entry can make a stored assignment unreachable by name search
// while the registry still returns it. The test pins the properties the rest of
// the feature is allowed to assume: a fixed length, a fixed ranked prefix, no
// two names that sound the same, and a deterministic overflow rule.
describe('agent name vocabulary', () => {
  it('is the approved ranked list of one hundred distinct names', () => {
    expect(AGENT_NAMES).toHaveLength(100)
    expect(AGENT_NAMES.slice(0, 3)).toEqual(['Apollo', 'Jasper', 'Beatrix'])
    expect(new Set(AGENT_NAMES.map(normalizeAgentName)).size).toBe(100)
    for (const name of AGENT_NAMES) expect(name).toMatch(/^[A-Z][a-z]{1,11}$/)
  })

  it('walks the ranking in order and then adds explicit numeric suffixes', () => {
    expect([0, 1, 2].map(agentNameAt)).toEqual(['Apollo', 'Jasper', 'Beatrix'])
    expect(agentNameAt(99)).toBe(AGENT_NAMES[99])
    expect(agentNameAt(100)).toBe('Apollo 2')
    expect(agentNameAt(199)).toBe(`${AGENT_NAMES[99]} 2`)
    expect(agentNameAt(200)).toBe('Apollo 3')
  })

  it('treats spacing and case as the same spoken address but never joins the suffix', () => {
    expect(normalizeAgentName('  Apollo  ')).toBe('apollo')
    expect(normalizeAgentName('Apollo   2')).toBe('apollo 2')
    // "Apollo2" is a different token to a speech-to-text pipeline than
    // "Apollo 2"; collapsing them would let one utterance match two agents.
    expect(normalizeAgentName('Apollo2')).not.toBe(normalizeAgentName('Apollo 2'))
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24
NODE_ENV=test npx vitest run --project unit src/shared/agentNames/names.test.ts
```

**This RED is decorative and you should expect it to pass.** The vocabulary file already exists from the sketch, so there is no failing state to observe — this is the one task in the plan that inverts the usual order, because the artifact under test is pre-existing data rather than code you are about to write. Run it anyway and record the output: a green run is the evidence that the sketch's file satisfies every property the rest of the feature assumes, and a red run means the file was lost or edited between Step 0b and here and must be restored before continuing. Every later task has a genuine RED.

- [ ] **Step 3: Keep the vocabulary and promote its reasoning into the file**

Replace the header comment of `src/shared/agentNames/names.ts` with the following, leaving the 100-entry `AGENT_NAMES` array and both functions byte-identical:

```ts
// The user-approved voice vocabulary for Agent Code agents, strongest first.
//
// WHY the ORDER is part of the contract and this list is append-only: the
// registry stores the assigned STRING, not an index, but it picks new names by
// walking this ranking. Reordering therefore does not rename an existing agent
// — it silently changes which name the next agent gets, so two machines that
// disagree about this file hand out different addresses for the same workload.
// Deleting an entry is worse: an assignment already on disk keeps that name
// while `agents.search` can no longer be told about it from here.
//
// WHY names and titles are different things: a title describes the TASK ("fix
// the queue race") and the user edits it freely. A name addresses the AGENT
// DOING it and must stay legible over a voice channel, which is why these are
// short, common, phonetically distinct given names rather than anything
// generated. Never derive one from the other.
//
// WHY overflow uses an explicit " 2" suffix instead of wrapping: past 100 live
// identities the pool is exhausted, and reusing "Apollo" would make a spoken
// address ambiguous at the exact moment the workspace is busiest. "Apollo 2" is
// still sayable and still unique. Never recycle a retired name to avoid it.
export const AGENT_NAMES = [
```

Keep `normalizeAgentName` and `agentNameAt` as they are, and add above `normalizeAgentName`:

```ts
// Spoken-equivalence normalization, used for BOTH uniqueness checks in the
// registry and exact name lookup in agents.search. It deliberately does not
// strip the space before a suffix: a transcriber emits "Apollo two" as
// "Apollo 2", never as "Apollo2", so folding them together would let one
// utterance match two different agents.
```

- [ ] **Step 4: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project unit src/shared/agentNames/names.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/agentNames/names.ts src/shared/agentNames/names.test.ts
git commit -F - <<'EOF'
feat(workspace): add the approved ranked agent name vocabulary

The list is the source of NEW allocations only; the registry stores assigned
strings, so this file is append-only and its order is a contract. Overflow uses
an explicit " 2" suffix because a wrapped pool makes a spoken address ambiguous.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 2: Main-process registry with atomic persistence and serialized allocation

**Files:**
- Modify: `src/main/agentNames/registry.ts` (exists uncommitted; restructure)
- Test: `src/main/agentNames/registry.test.ts` (create)

**Interfaces:**
- Consumes: `AGENT_NAMES`, `agentNameAt`, `normalizeAgentName` from `@shared/agentNames/names.js`; `node:fs/promises`; `zod`.
- Produces:
  - `class AgentNameRegistry { constructor(path: string); resolve(identities: readonly string[]): Promise<Record<string, string>> }`

- [ ] **Step 1: Write the failing registry test against a real temp directory**

Real disk, not a mocked `fs`. The properties this stage has to prove — an allocation is on disk before it is returned, a second process sees the same assignments, an unreadable file is never overwritten — are properties of the filesystem transaction, and a mocked `rename` can only prove that the code called `rename`. The decomposition's "fault injection only at IPC/disk/clock boundaries" is honoured by corrupting the real file rather than by stubbing the module.

Create `src/main/agentNames/registry.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentNameRegistry } from '@main/agentNames/registry'

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-names-'))
  // Deliberately one level deeper than the temp root: the registry must create
  // its own parent, because STATE_DIR does not exist on a first launch.
  path = join(directory, 'state', 'agent-names.json')
})

// Seed a pre-existing store the registry did not write, so the corrupt-store
// cases exercise the real read path rather than a mocked failure.
async function seedStore(contents: string): Promise<void> {
  await mkdir(join(directory, 'state'), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function stored(): Promise<{ version: number; nextIndex: number; assignments: Record<string, string> }> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('agent name registry', () => {
  it('commits an allocation to disk before returning it', async () => {
    const registry = new AgentNameRegistry(path)

    const names = await registry.resolve(['identity-a', 'identity-b'])

    expect(names).toEqual({ 'identity-a': 'Apollo', 'identity-b': 'Jasper' })
    // WHY the file is read straight after the await rather than after a tick:
    // "reserved before published" is the whole point. If resolve() can return a
    // name that is not yet durable, a crash between the two hands the same name
    // out twice on the next launch.
    expect(await stored()).toEqual({
      version: 1,
      nextIndex: 2,
      assignments: { 'identity-a': 'Apollo', 'identity-b': 'Jasper' },
    })
  })

  it('serializes concurrent window requests so two of them never share a name', async () => {
    // Two application windows are two renderers over ONE main process, so this
    // is the real concurrency shape: two in-flight resolve() calls on one
    // instance. Without the promise tail both read the same empty state and
    // both allocate index 0.
    const registry = new AgentNameRegistry(path)

    const [left, right] = await Promise.all([
      registry.resolve(['window-left']),
      registry.resolve(['window-right']),
    ])

    expect(left['window-left']).not.toBe(right['window-right'])
    expect(new Set([left['window-left'], right['window-right']])).toEqual(new Set(['Apollo', 'Jasper']))
    const file = await stored()
    expect(file.nextIndex).toBe(2)
    expect(Object.keys(file.assignments).sort()).toEqual(['window-left', 'window-right'])
  })

  it('reopens with the same assignments and never recycles a retired name', async () => {
    await new AgentNameRegistry(path).resolve(['kept', 'closed'])

    // A fresh instance is a fresh application launch over the same file.
    const reopened = new AgentNameRegistry(path)
    expect(await reopened.resolve(['kept'])).toEqual({ kept: 'Apollo' })
    // "closed" is gone from the workspace but its name stays spent: a delayed
    // voice request for Jasper must not land on a brand new agent.
    expect(await reopened.resolve(['fresh'])).toEqual({ fresh: 'Beatrix' })
    expect((await stored()).assignments).toEqual({ kept: 'Apollo', closed: 'Jasper', fresh: 'Beatrix' })
  })

  it('uses explicit numeric suffixes once the pool is exhausted', async () => {
    const registry = new AgentNameRegistry(path)
    const identities = Array.from({ length: 101 }, (_, index) => `s${index}`)

    const names = await registry.resolve(identities)

    expect(names.s99).toBe('Kai')
    expect(names.s100).toBe('Apollo 2')
    expect(new Set(Object.values(names)).size).toBe(101)
  })

  it('refuses to overwrite an unreadable store', async () => {
    await seedStore('{ this is not json')
    const registry = new AgentNameRegistry(path)

    await expect(registry.resolve(['identity-a'])).rejects.toThrow(/unreadable/i)
    // The bytes must be exactly what was there. Rewriting a corrupt file is how
    // a user loses every spoken address they had learned.
    expect(await readFile(path, 'utf8')).toBe('{ this is not json')
    // And it must keep refusing rather than "recovering" into an empty store.
    await expect(registry.resolve(['identity-a'])).rejects.toThrow(/unreadable/i)
  })

  it('refuses a store that already contains two identities under one name', async () => {
    await seedStore(JSON.stringify({
      version: 1,
      nextIndex: 2,
      assignments: { first: 'Apollo', second: 'apollo' },
    }))

    await expect(new AgentNameRegistry(path).resolve(['third'])).rejects.toThrow(/unreadable/i)
  })

  it('cannot pollute Object.prototype through a hostile identity', async () => {
    const registry = new AgentNameRegistry(path)

    const names = await registry.resolve(['__proto__'])

    expect(Object.getOwnPropertyDescriptor(names, '__proto__')?.value).toBe('Apollo')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.keys((await stored()).assignments)).toEqual(['__proto__'])
  })

  it('keeps a "__proto__" assignment across a reopen instead of re-allocating it', async () => {
    // WHY this case earns its own test: `z.record()` DROPS a "__proto__" key.
    // Verified against the pinned zod (^4.4.3):
    //
    //   JSON.parse own keys : ['__proto__', 'normal']
    //   z.record output keys: ['normal']
    //
    // A registry that trusted zod's OUTPUT as its data would silently forget
    // this assignment on the next launch and hand that agent a second name —
    // exactly the recycling this module exists to prevent, reachable from a
    // workspace file the user can edit. The schema stays the shape gate; the
    // raw parsed object is the data.
    await new AgentNameRegistry(path).resolve(['__proto__', 'normal'])
    const before = await stored()

    const reopened = new AgentNameRegistry(path)
    const again = await reopened.resolve(['__proto__', 'normal'])

    expect(Object.getOwnPropertyDescriptor(again, '__proto__')?.value).toBe('Apollo')
    expect(again.normal).toBe('Jasper')
    // Nothing was re-allocated: the counter did not move and the file is
    // unchanged, because resolve() found both assignments already present.
    expect(await stored()).toEqual(before)
    // And the next new identity continues the ranking rather than reusing one.
    expect((await reopened.resolve(['third'])).third).toBe('Beatrix')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project unit src/main/agentNames/registry.test.ts
```

The sketch's implementation fails at least three of these: the corrupt-store cases (its `catch` re-throws a message that does not say "unreadable", and it lets a non-ENOENT read error and a schema error share one path), and — most importantly — **the `__proto__` reopen case, because the sketch reads its map out of `stateSchema.parse(...)`, which drops that key**. That last failure is the one to look at closely: it is a silent data-loss bug, not a message mismatch, and it is why Step 3 restructures `load()` around the raw parsed JSON. Record the failures.

- [ ] **Step 3: Rewrite `src/main/agentNames/registry.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

import { agentNameAt, normalizeAgentName } from '@shared/agentNames/names.js'

// WHY `nextIndex` is persisted rather than derived from the assignment count:
// deriving it would recycle a name the moment an assignment is ever removed,
// and "never recycle a spoken address" is the invariant that makes a delayed
// voice request safe. The counter only ever moves forward.
//
// WHY this schema validates but does NOT supply the assignment map: zod's
// `z.record()` silently drops a "__proto__" key (verified against zod ^4.4.3 —
// JSON.parse keeps it as an own property, zod's output does not). Reading the
// map out of zod's result would therefore forget any assignment stored under
// that identity on the next launch and re-allocate a second name for the same
// agent. Identities come from a workspace file the user can edit, so that is
// reachable, not theoretical. The schema is the SHAPE gate; `load()` takes the
// data from the raw parsed JSON.
//
// The duplicate-name check lives in `load()` for the same reason: run here it
// would inspect the map zod already pruned and miss exactly the entry that
// motivated all of this.
const stateSchema = z.object({
  version: z.literal(1),
  nextIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1_000_000),
  assignments: z.record(z.string(), z.string().trim().min(1).max(100)),
}).strict()

type RegistryState = { version: 1; nextIndex: number; assignments: Record<string, string> }

// WHY a null-prototype map instead of a plain object: identities are opaque
// strings that originate in a workspace file the user can edit. Writing
// `assignments['__proto__'] = name` on a normal object invokes the prototype
// SETTER — the assignment silently vanishes and the next call allocates a
// second name for the same identity, forever. A null-prototype map makes every
// key an ordinary data property, and also makes `assignments[identity]` safe to
// read without an Object.hasOwn dance.
function emptyAssignments(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function adoptAssignments(source: Record<string, string>): Record<string, string> {
  return Object.assign(emptyAssignments(), source)
}

/**
 * The single process-wide allocator of spoken agent names.
 *
 * WHY this lives in main and not in the renderer: a renderer-local counter
 * gives two windows the same "Apollo", and a name derived at render time
 * changes when an agent is closed or the list is re-sorted. There is exactly
 * one of these per application process, constructed by the IPC adapter, and
 * nothing else may import it — the decomposition keeps MCP and feature code
 * away from application identity on purpose.
 *
 * WHY the renderer, not this class, decides which agent keeps an identity
 * across a provider switch: only the renderer knows that a new local session ID
 * is the same logical pane. This module owns exactly one relation, identity to
 * name, and has no opinion about sessions, windows, panes or the setting.
 */
export class AgentNameRegistry {
  private state: RegistryState | undefined

  // WHY one promise tail rather than a mutex or a per-identity lock: every
  // allocation reads the whole counter and writes the whole file, so the
  // critical section is the entire operation. Two windows starting agents in
  // the same frame is the ordinary case, not the edge case, and interleaving
  // them is how both get told "Apollo".
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  resolve(identities: readonly string[]): Promise<Record<string, string>> {
    const next = this.tail.then(() => this.allocate(identities))
    // Swallow on the TAIL only. The caller still sees the rejection through
    // `next`; the tail must stay resolvable or one disk failure would wedge
    // every later request behind a permanently rejected promise.
    this.tail = next.catch(() => {})
    return next
  }

  private async load(): Promise<RegistryState> {
    if (this.state) return this.state

    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A permission or I/O error is NOT an empty registry. Starting fresh
        // here would hand out names that a readable file already owns.
        throw new Error('Agent name registry is unreadable; refusing to overwrite it', { cause: error })
      }
      this.state = { version: 1, nextIndex: 0, assignments: emptyAssignments() }
      return this.state
    }

    let assignments: Record<string, string>
    let nextIndex: number
    try {
      const json: unknown = JSON.parse(raw)
      // Validate through zod, then deliberately IGNORE its copy of the map and
      // read the raw object instead — see the schema comment for why.
      nextIndex = stateSchema.parse(json).nextIndex
      assignments = adoptAssignments((json as { assignments: Record<string, string> }).assignments)
      // The duplicate check the schema cannot do, over every key including the
      // ones zod pruned. A file mapping two identities to one name makes every
      // later lookup ambiguous with no evidence for choosing between them.
      const spoken = Object.values(assignments).map(normalizeAgentName)
      if (new Set(spoken).size !== spoken.length) throw new Error('Two identities share one spoken name')
    } catch (error) {
      // WHY this is not cached and not repaired: leaving `this.state` unset
      // means every later call re-reads and re-fails, so the user gets a
      // consistent refusal instead of a registry that silently forgot every
      // assignment. Repairing would mean choosing which of two colliding
      // identities keeps the name, and there is no evidence with which to
      // choose. The fix belongs to the user's file, not to this process.
      throw new Error('Agent name registry is unreadable; refusing to overwrite it', { cause: error })
    }

    this.state = { version: 1, nextIndex, assignments }
    return this.state
  }

  private async allocate(identities: readonly string[]): Promise<Record<string, string>> {
    const loaded = await this.load()
    // Work on a copy so a failed commit leaves the cached state untouched. If
    // we mutated in place, a write error would leave this process believing it
    // had published names that are not on disk.
    const draft: RegistryState = { ...loaded, assignments: adoptAssignments(loaded.assignments) }
    const used = new Set(Object.values(draft.assignments).map(normalizeAgentName))
    let changed = false

    for (const identity of identities) {
      if (draft.assignments[identity] !== undefined) continue
      let name = agentNameAt(draft.nextIndex++)
      // The counter alone cannot guarantee freshness: a user could have
      // hand-written "Apollo" into the file at a lower index. Skipping forward
      // is cheap and keeps the never-duplicate invariant local to this loop.
      while (used.has(normalizeAgentName(name))) name = agentNameAt(draft.nextIndex++)
      draft.assignments[identity] = name
      used.add(normalizeAgentName(name))
      changed = true
    }

    if (changed) await this.commit(draft)
    return Object.fromEntries(identities.map(identity => [identity, draft.assignments[identity]]))
  }

  private async commit(draft: RegistryState): Promise<void> {
    // 0o700/0o600: the file records which agents exist and what they are
    // called. It is not a secret, but it is this user's workspace shape and has
    // no reason to be world-readable.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    // WHY a UUID temp name rather than a fixed `.tmp` sibling: two commits can
    // overlap across an unclean shutdown, and a shared scratch path turns that
    // into an ENOENT race on rename. The unique name also means cleanup never
    // has to scan for siblings.
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({
        version: draft.version,
        nextIndex: draft.nextIndex,
        assignments: { ...draft.assignments },
      }), { mode: 0o600 })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    // Only after a successful rename. A failed persistence must not poison the
    // cache with names that were never reserved.
    this.state = draft
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project unit src/main/agentNames/registry.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/main/agentNames/registry.ts src/main/agentNames/registry.test.ts
git commit -F - <<'EOF'
feat(workspace): add the durable agent name registry

One process-wide allocator over its own file, separate from workspace.json.
Every allocation is serialized on a single promise tail and renamed into place
before it is returned, so two windows cannot both be told "Apollo" and a crash
cannot publish an unreserved name. Names are never recycled and an unreadable
store is refused rather than overwritten.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 3: Application IPC and the preload surface

**Files:**
- Modify: `src/main/agentNames/ipc.ts` (exists uncommitted; make the registry injectable)
- Test: `src/main/agentNames/ipc.test.ts` (create)
- Create: `src/preload/api/agentNames.ts`
- Modify: `src/preload/api/index.ts`
- Modify: `src/preload/api/workspace.ts` (remove the sketch's misplaced method)
- Modify: `src/main/ipc/index.ts` (the sketch's registration line stays)

**Interfaces:**
- Consumes: `AgentNameRegistry` from `@main/agentNames/registry.js`; `STATE_DIR` from `@main/storage/paths.js`; `windowIdFor` from `@main/window/windowRegistry.js`.
- Produces:
  - `AGENT_NAMES_FILE: string`
  - `registerAgentNamesIpc(registry?: AgentNameRegistry): void` handling `agent-names:resolve`
  - `agentNamesApi.resolveAgentNames(identities: string[]): Promise<Record<string, string>>` on `window.api`

- [ ] **Step 1: Write the failing IPC guard test**

Create `src/main/agentNames/ipc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import type { AgentNameRegistry } from '@main/agentNames/registry'

// vi.hoisted, because vi.mock factories are hoisted above ordinary consts and
// would otherwise hit the temporal dead zone the first time a mocked module is
// imported.
const { handlers, windowIdFor } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  windowIdFor: vi.fn<(sender: unknown) => string | null>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}))
vi.mock('@main/storage/paths.js', () => ({ STATE_DIR: '/recorded/state' }))
vi.mock('@main/window/windowRegistry.js', () => ({ windowIdFor: (sender: unknown) => windowIdFor(sender) }))

const { registerAgentNamesIpc } = await import('@main/agentNames/ipc.js')

function fakeRegistry(): { registry: AgentNameRegistry; resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(async (identities: readonly string[]) =>
    Object.fromEntries(identities.map((identity, index) => [identity, `Name${index}`])))
  return { registry: { resolve } as unknown as AgentNameRegistry, resolve }
}

function event(options: { registered: boolean; mainFrame: boolean }) {
  const sender = { mainFrame: {} }
  windowIdFor.mockReturnValue(options.registered ? 'window-one' : null)
  return { sender, senderFrame: options.mainFrame ? sender.mainFrame : {} }
}

describe('agent names IPC', () => {
  it('refuses a sender that is not a registered application window', async () => {
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: false, mainFrame: true }), ['a']))
      .rejects.toThrow(/registered application window/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a sub-frame of a registered window', async () => {
    // WHY the frame check is separate from the window check: an embedded
    // iframe (rendered content, a preview surface) shares the window's
    // WebContents. Allocating names from there would let untrusted page
    // content burn spoken addresses.
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: true, mainFrame: false }), ['a']))
      .rejects.toThrow(/registered application window/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('de-duplicates identities before allocating', async () => {
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await handler(event({ registered: true, mainFrame: true }), ['a', 'b', 'a'])

    expect(resolve).toHaveBeenCalledWith(['a', 'b'])
  })

  it('rejects a malformed request before it reaches the registry', async () => {
    const { registry, resolve } = fakeRegistry()
    registerAgentNamesIpc(registry)
    const handler = handlers.get('agent-names:resolve')!

    await expect(handler(event({ registered: true, mainFrame: true }), ['', 'b'])).rejects.toThrow()
    await expect(handler(event({ registered: true, mainFrame: true }), 'not-an-array')).rejects.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project unit src/main/agentNames/ipc.test.ts
```

Fails: `registerAgentNamesIpc` currently takes no registry argument and constructs a real one that would touch `/recorded/state`.

- [ ] **Step 3: Rewrite `src/main/agentNames/ipc.ts`**

```ts
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'

import { AgentNameRegistry } from '@main/agentNames/registry.js'
import { STATE_DIR } from '@main/storage/paths.js'
import { windowIdFor } from '@main/window/windowRegistry.js'

// WHY its own file next to workspace.json rather than a key inside it: the
// workspace file is a per-window opaque payload that main only moves bytes for,
// and it is rewritten wholesale on every autosave. Name allocation is
// application-wide, has a different writer and a different failure mode — a
// corrupt workspace costs a layout, a corrupt registry would cost every spoken
// address — so the two must not be able to take each other down.
export const AGENT_NAMES_FILE = join(STATE_DIR, 'agent-names.json')

// Bounded so a malformed or hostile renderer cannot make the allocator walk a
// huge list under the serialization tail. 10k is far past any real workspace.
const requestSchema = z.array(z.string().min(1).max(200)).max(10_000)

/**
 * The ONLY consumer of AgentNameRegistry.
 *
 * WHY the registry is a constructor default rather than a module singleton:
 * `registerAllIpc` runs exactly once per application process, so one instance
 * per call is already process-wide, and taking it as an argument is what makes
 * the sender guard testable without touching the real state directory.
 */
export function registerAgentNamesIpc(
  registry: AgentNameRegistry = new AgentNameRegistry(AGENT_NAMES_FILE),
): void {
  ipcMain.handle('agent-names:resolve', async (event, raw: unknown) => {
    // Two separate conditions on purpose: the first proves the WebContents is
    // one of our windows, the second proves the request came from the app's own
    // top-level document rather than an embedded frame it happens to host.
    if (!windowIdFor(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent names require a registered application window')
    }
    // De-duplicate before the registry so a repeated identity in one batch
    // cannot advance the counter twice.
    return registry.resolve([...new Set(requestSchema.parse(raw))])
  })
}
```

- [ ] **Step 4: Give the domain its own preload module**

Create `src/preload/api/agentNames.ts`:

```ts
import { ipcRenderer } from 'electron'

// WHY this is not a method on workspaceApi: workspaceApi is the bridge to the
// window-owned workspace.json byte mover, and the decomposition keeps name
// allocation isolated from that persistence on purpose. Grouping them would
// invite exactly the coupling the isolation rule forbids — someone would
// eventually save names "while they are already writing the workspace".
export const agentNamesApi = {
  /**
   * Reserve (or re-read) a name for each durable naming identity.
   *
   * Allocation happens in main and is committed to disk before this resolves,
   * so a returned name is already permanent. Identities are opaque to main:
   * the renderer decides which logical agent an identity belongs to.
   *
   * On failure the caller must show no name at all. There is no client-side
   * fallback: a fabricated name is worse than an absent one, because an
   * operator would speak it and reach nothing.
   */
  resolveAgentNames: (identities: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('agent-names:resolve', identities),
}
```

In `src/preload/api/workspace.ts`, delete the two lines the sketch added:

```ts
  resolveAgentNames: (identities: string[]): Promise<Record<string, string>> => ipcRenderer.invoke('agent-names:resolve', identities),

```

In `src/preload/api/index.ts`, add the import beside the other domain imports:

```ts
import { agentNamesApi } from '@preload/api/agentNames.js'
```

and add it to the composed object, immediately after `...workspaceApi,`:

```ts
  ...agentNamesApi,
```

- [ ] **Step 5: Confirm main registers the handler**

`src/main/ipc/index.ts` already carries the sketch's import and call; leave both exactly as they are:

```ts
import { registerAgentNamesIpc } from '@main/agentNames/ipc.js'
```

```ts
  registerAgentNamesIpc()
```

- [ ] **Step 6: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project unit src/main/agentNames/ipc.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/main/agentNames/ipc.ts src/main/agentNames/ipc.test.ts src/preload/api/agentNames.ts src/preload/api/index.ts src/preload/api/workspace.ts src/main/ipc/index.ts
git commit -F - <<'EOF'
feat(workspace): expose agent name allocation over application IPC

The handler admits only a registered window's main frame, de-duplicates and
bounds its input, and is the sole consumer of the registry. The preload method
gets its own domain rather than riding on workspaceApi, because name allocation
is deliberately isolated from workspace.json persistence.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 4: The default-off `agentNamesEnabled` setting

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts`
- Modify: `src/renderer/src/app-state/settings/persistence.ts`
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts`
- Test: `src/renderer/src/app-state/settings/persistence.test.ts` (modify)
- Test: `src/renderer/src/features/settings/lib/settingsRegistry.test.ts` (modify)

**Interfaces:**
- Consumes: `coerceSettings`, `DEFAULT_SETTINGS`, `getSettingsRegistry`.
- Produces: `Settings.agentNamesEnabled: boolean` (default `false`) and the `agent-names` toggle entry in the `workspace` settings category.

- [ ] **Step 1: Write the failing settings tests**

Append to `src/renderer/src/app-state/settings/persistence.test.ts`:

```ts
describe('coerceSettings agentNamesEnabled', () => {
  it('defaults to off so no user starts allocating spoken names', () => {
    // WHY this assertion is worth a test of its own: a truthy default would
    // make every existing installation write agent-names.json on first launch
    // and burn pool entries for agents whose owner never asked for names.
    expect(coerceSettings({}).agentNamesEnabled).toBe(false)
  })

  it('accepts only a real boolean true', () => {
    expect(coerceSettings({ agentNamesEnabled: true }).agentNamesEnabled).toBe(true)
    expect(coerceSettings({ agentNamesEnabled: 'true' }).agentNamesEnabled).toBe(false)
    expect(coerceSettings({ agentNamesEnabled: 1 }).agentNamesEnabled).toBe(false)
    expect(coerceSettings({ agentNamesEnabled: null }).agentNamesEnabled).toBe(false)
  })
})
```

In `src/renderer/src/features/settings/lib/settingsRegistry.test.ts`, add `settingMetadata` to the existing import from `@renderer/features/settings/lib/settingsRegistry`, then append:

```ts
describe('agent names setting', () => {
  it('is an immediate app-scoped workspace toggle that reads and writes agentNamesEnabled', async () => {
    const setting = getSettingsRegistry().find(candidate => candidate.id === 'agent-names')
    if (!setting || setting.control.type !== 'toggle') throw new Error('Missing agent-names toggle')
    expect(setting.category).toBe('workspace')
    // The resolved metadata is what operators read through settings.reference,
    // and "takes effect at once" is a real claim: enabling must name the agents
    // already on screen, not only the next session. Asserting the RESOLVED
    // value (not `setting.metadata`) keeps the row free to stay on the default.
    expect(settingMetadata(setting)).toEqual({ scope: 'app', apply: 'immediate', storage: 'settings' })
    expect(setting.control.getValue(DEFAULT_SETTINGS)).toBe(false)
    expect(setting.control.getValue({ ...DEFAULT_SETTINGS, agentNamesEnabled: true })).toBe(true)

    const onChange = vi.fn()
    const context = { settings: DEFAULT_SETTINGS, onChange } as unknown as SettingActionContext
    await setting.control.onToggle(context, true)
    expect(onChange).toHaveBeenLastCalledWith({ agentNamesEnabled: true })
    await setting.control.onToggle(context, false)
    expect(onChange).toHaveBeenLastCalledWith({ agentNamesEnabled: false })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/app-state/settings/persistence.test.ts src/renderer/src/features/settings/lib/settingsRegistry.test.ts
```

Fails: the field is named `agentNames` in the sketch, so `agentNamesEnabled` is `undefined`.

- [ ] **Step 3: Rename and document the field, and give `agentViewMode` its docs back**

The sketch inserted `agentNames: boolean` **between** the 12-line doc block that belongs to `agentViewMode` and `agentViewMode` itself, so that block currently documents the wrong field. In `src/renderer/src/app-state/settings/types.ts`:

1. **Delete** the sketch's `agentNames: boolean` line, so the block ending `…tied to the UI state that actually requested them. */` reattaches to `agentViewMode` where it belongs. Verify by eye that the line immediately after that `*/` is now `agentViewMode: AgentViewMode`.
2. **Add** the new field with its own JSDoc *after* `agentViewMode: AgentViewMode`:

```ts
  /** Opt-in stable spoken names (Apollo, Jasper, …) beside agent titles, in
   *  the Dispatch index, and in external operator observation/search.
   *
   *  WHY the field is `…Enabled` and not `agentNames`: `settings.reference`
   *  publishes these identifiers to an external operator, and a boolean called
   *  `agentNames` reads like a list of names. It is also the gate for
   *  ALLOCATION, not only for display: while it is false no identity is
   *  claimed and no name is reserved, so a user who never turns it on never
   *  writes agent-names.json. Turning it back off hides names and name lookup
   *  but keeps every assignment, so re-enabling restores the same addresses. */
  agentNamesEnabled: boolean
```

3. In `DEFAULT_SETTINGS`, replace `agentNames: false,` with:

```ts
  agentNamesEnabled: false,
```

In `src/renderer/src/app-state/settings/persistence.ts`, replace the sketch's line with:

```ts
    agentNamesEnabled: parsed.agentNamesEnabled === true,
```

- [ ] **Step 4: Point the registry entry at the renamed field**

In `src/renderer/src/features/settings/lib/settingsRegistry.ts`, replace the sketch's `agent-names` entry with:

```ts
    {
      // WHY the description spells out the retention and overflow rules: this
      // text is the only explanation an external operator gets through
      // settings.reference, and both rules are surprising. Assignments survive
      // disabling (so re-enabling does not re-address the fleet) and the pool
      // is finite (so a large workspace will legitimately see "Apollo 2").
      id: 'agent-names',
      category: 'workspace',
      title: 'Agent names',
      description: 'Show a stable spoken name such as Apollo beside agent titles and in the Dispatch index, and expose the same name to external operator search. Names are separate from titles, are never reused after an agent closes, and are retained while this is off so re-enabling restores the same names. Past 100 names, explicit numeric suffixes such as "Apollo 2" keep every address distinct. Terminals are never named.',
      keywords: ['voice', 'spoken', 'name', 'names', 'apollo', 'agent', 'mcp', 'operator', 'header', 'dispatch'],
      // No explicit `metadata`. DEFAULT_SETTING_METADATA is already exactly
      // right here — app-scoped, stored in renderer Settings, effective at
      // once — and this file reserves an explicit block for rows where that
      // obvious reading would be WRONG, so that the ones carrying metadata are
      // the ones a reader should stop at. (The sketch wrote `apply: 'live'`,
      // which is not a member of the union at all and broke the typecheck.)
      control: {
        type: 'toggle',
        getValue: settings => settings.agentNamesEnabled,
        onToggle: (ctx, value) => ctx.onChange({ agentNamesEnabled: value }),
      },
    },
```

- [ ] **Step 5: Run them and watch them pass**

```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/app-state/settings/persistence.test.ts src/renderer/src/features/settings/lib/settingsRegistry.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts src/renderer/src/app-state/settings/persistence.ts src/renderer/src/app-state/settings/persistence.test.ts src/renderer/src/features/settings/lib/settingsRegistry.ts src/renderer/src/features/settings/lib/settingsRegistry.test.ts
git commit -F - <<'EOF'
feat(settings): add the default-off Agent names toggle

The flag gates allocation as well as display, so an installation that never
enables it never writes agent-names.json. Coercion accepts only a real boolean
true, matching the other opt-in flags.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 5: Durable naming identity on `SessionMeta` and lifecycle continuity

**Files:**
- Modify: `src/renderer/src/workspace/types.ts`
- Modify: `src/renderer/src/workspace/hook/actions/session.ts` (three sites)
- Test: `src/renderer/src/workspace/hook/actions/agentNameContinuity.renderer.test.tsx` (create)

**Interfaces:**
- Consumes: existing `spawn`, `replaceSession` and bulk-reload paths in `useSessionActions`.
- Produces: `SessionMeta.agentNameId?: string`, **carried** across replacement and rehydration and **minted nowhere in this file** — the reconciler (Task 7) is the single minting site, and these three edits exist to remove the sketch's three competing ones.

- [ ] **Step 1: Write the failing continuity test**

Create `src/renderer/src/workspace/hook/actions/agentNameContinuity.renderer.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
// The 17-field WorkspaceRefs literal is exactly what this shared harness exists
// to stop each spec re-typing; its own header asks callers to use it rather
// than drift a private copy when either signature moves.
import { makeRefs, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { withoutProvisionalProviderSession } from '@renderer/workspace/providerSessionIdentity'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession: vi.fn(async () => undefined),
}))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

const predecessorId = 'local-predecessor'

function initialState(meta: Record<string, unknown>): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-a',
      title: 'recorded',
      root: { type: 'leaf' as const, sessionId: predecessorId },
      focusedSessionId: predecessorId,
    }],
    activeTabId: 'tab-a',
    sessions: { [predecessorId]: meta },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState
}

describe('spoken name identity across the agent lifecycle', () => {
  it('carries an existing identity through a provider switch and mints none on a fresh spawn', async () => {
    vi.useFakeTimers()
    const state = initialState({
      cwd: '/recorded/worktree',
      kind: 'codex',
      agentNameId: 'identity-one',
      providerSessionId: 'recorded-provider-session',
      providerSessionIdSource: 'resume-request',
      builtInMcpDomains: [],
    })
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    let runtimes: Record<SessionId, SessionRuntime> = { [predecessorId]: emptyRuntime() }
    const setRuntimes = (
      next: Record<SessionId, SessionRuntime> | ((p: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ): void => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession: vi.fn()
          .mockResolvedValueOnce({ sessionId: 'local-successor' })
          .mockResolvedValueOnce({ sessionId: 'brand-new' }),
        killOwnedSession: vi.fn(async () => false),
        ghostRead: vi.fn(async () => []),
      },
    })

    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState,
      setRuntimes,
      refs,
    ))

    await act(async () => {
      await result.current.replaceSession('/recorded/worktree', {
        kind: 'claude',
        resumeSessionId: 'recorded-provider-session',
      })
      await vi.runAllTimersAsync()
    })

    // WHY this is the sharpest assertion in the feature: replaceSession spawns
    // through the SAME spawn() the create path uses, so anything that mints an
    // identity inside spawn wins the object spread in the replacement commit
    // and the pane silently becomes a different spoken agent after a reload or
    // a provider switch.
    expect(writer.getState().sessions['local-successor']?.agentNameId).toBe('identity-one')
    expect(writer.getState().sessions[predecessorId]).toBeUndefined()

    await act(async () => {
      await result.current.spawn('/recorded/worktree', { kind: 'codex' })
      await vi.runAllTimersAsync()
    })

    // A genuinely new agent leaves identity to the reconciler, which is the one
    // place that knows the difference between "new" and "restored".
    expect(writer.getState().sessions['brand-new']?.agentNameId).toBeUndefined()
  })

  it('does not invent an identity when replacing a pane that never had one', async () => {
    // The disabled-then-enabled path: with the setting off nothing is ever
    // claimed, so a provider switch must not become a back-door minting site.
    // The successor stays unidentified and the reconciler claims it — under the
    // successor's own id — the moment the user turns names on.
    vi.useFakeTimers()
    const state = initialState({ cwd: '/recorded/worktree', kind: 'codex', builtInMcpDomains: [] })
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    let runtimes: Record<SessionId, SessionRuntime> = { [predecessorId]: emptyRuntime() }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession: vi.fn().mockResolvedValue({ sessionId: 'local-successor' }),
        killOwnedSession: vi.fn(async () => false),
        ghostRead: vi.fn(async () => []),
      },
    })

    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState,
      next => { runtimes = typeof next === 'function' ? next(runtimes) : next; refs.latestRuntimesRef.current = runtimes },
      refs,
    ))

    await act(async () => {
      await result.current.replaceSession('/recorded/worktree', { kind: 'claude' })
      await vi.runAllTimersAsync()
    })

    expect(writer.getState().sessions['local-successor']).toBeDefined()
    expect(writer.getState().sessions['local-successor']?.agentNameId).toBeUndefined()
  })

  it('preserves the identity through the metadata rebuild that bulk reload uses', () => {
    // The rehydration path (site C) carries the identity by plain spread of
    // `withoutProvisionalProviderSession(meta)` and adds no line of its own.
    // That is only correct while this helper is field-preserving, so pin the
    // property the spread depends on rather than the spread itself.
    const meta = {
      cwd: '/recorded/worktree',
      kind: 'codex' as const,
      agentNameId: 'identity-one',
      providerSessionId: 'from-proxy',
      providerSessionIdSource: 'proxy-header' as const,
    }
    const restored = withoutProvisionalProviderSession(meta)
    expect(restored.agentNameId).toBe('identity-one')
    expect(restored.providerSessionId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/hook/actions/agentNameContinuity.renderer.test.tsx
```

The first test fails against the sketch on both of its assertions: `spawn` seeds `agentNameId: sessionId`, and that seeded value then overwrites the carried identity in the replacement commit. The second test fails too — the sketch's `?? oldId` mints an identity for a pane that never had one. The third (the `withoutProvisionalProviderSession` unit case) passes today and is a regression pin, not a RED.

- [ ] **Step 3: Document the field in `src/renderer/src/workspace/types.ts`**

Replace the sketch's one-line comment on `agentNameId` with:

```ts
  /**
   * Durable identity for this agent's spoken name — NOT the name itself.
   *
   * WHY the name is not stored here: workspace.json is per-window and is
   * rewritten wholesale on every autosave, so two windows would each hold their
   * own copy of a global allocation and would drift apart on the first
   * conflicting save. This field carries only the opaque key; the main-process
   * registry owns the identity→name relation for the whole application.
   *
   * WHY it exists at all rather than using sessionId directly: a provider
   * switch, reload, rewind or crash recovery replaces the local session ID
   * while the user is looking at the same pane. Reusing sessionId would rename
   * the agent mid-conversation. This value is minted once, by the reconciler,
   * and then carried across every replacement. Duplicating an agent creates a
   * new session with no identity, so the copy correctly gets its own name.
   */
  agentNameId?: string
```

- [ ] **Step 4: Delete the seeding in `spawn` (site A)**

In `src/renderer/src/workspace/hook/actions/session.ts`, remove the first line of the `meta` object literal so it reads:

```ts
      const meta: SessionMeta = {
        ...(previousMeta ?? {}),
        cwd,
        kind,
```

and add above `const meta: SessionMeta = {`:

```ts
      // WHY spawn does NOT mint agentNameId: replaceSession spawns through this
      // same function, so a seed here lands on the SUCCESSOR and then wins the
      // spread in the replacement commit, renaming a pane that only changed
      // backends. Minting lives in one place — the reconciler — which sees the
      // restored workspace and can tell a new agent from a recovered one.
```

- [ ] **Step 5: Make the replacement commit carry the identity last (site B)**

Inside the `setState` updater in `replaceSession`, add this beside `replacementTitle` (which is read the same way and for the same reason):

```ts
        // `prev.sessions[oldId]` is still readable here: only the local
        // `sessions` copy has had oldId deleted.
        const carriedAgentNameId = prev.sessions[oldId]?.agentNameId
```

Then, in the `sessions[newId] = {` literal, delete the sketch's leading `agentNameId:` line and append this as the **final** entry, after the `replacementTitle` spread:

```ts
          // Last on purpose. `...(sessions[newId] ?? …)` earlier in this
          // literal is the successor's OWN freshly-spawned metadata, so any
          // earlier position is overwritten by it — which is exactly how the
          // sketch renamed a pane on every provider switch.
          //
          // Conditional, not `?? oldId`: this site CARRIES an identity, it
          // never creates one. If the predecessor had none — names were off,
          // or the reconciler had not run — then no name was ever allocated to
          // preserve, and inventing `oldId` here would make replacement a
          // second minting site competing with the reconciler for that
          // decision. Leaving it absent lets the reconciler claim the
          // successor under its own id, which is the same outcome by the one
          // rule the feature has.
          ...(carriedAgentNameId !== undefined ? { agentNameId: carriedAgentNameId } : {}),
```

- [ ] **Step 6: Delete the sketch's line at the rehydration site (site C) — the spread already does it**

`restoredMeta` is `withoutProvisionalProviderSession(meta)`, and that helper either returns `meta` untouched or spreads out only the two provisional provider fields (`src/renderer/src/workspace/providerSessionIdentity.ts:153-157`). So `...restoredMeta` **already carries `agentNameId`**, and the sketch's explicit line contributes nothing except its `?? oldId` — the same second minting site removed at site B. Delete the line and leave a comment in its place so the next reader does not "restore" it:

```ts
          freshSessions[newId] = {
            // `agentNameId` needs no line here: withoutProvisionalProviderSession
            // is field-preserving, so `...restoredMeta` carries the identity from
            // the pre-reload session onto its new local id. Do not add a
            // `?? oldId` fallback — a workspace with no identity has no
            // allocated name to lose, and minting here would put a second
            // author on the one decision the reconciler owns. The unit case in
            // this task's test pins the helper's field-preservation, which is
            // the only thing this spread relies on.
            ...restoredMeta,
            ...(builtInMcpDomains !== undefined ? { builtInMcpDomains } : {}),
          }
```

- [ ] **Step 7: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/hook/actions/agentNameContinuity.renderer.test.tsx
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/hook/actions
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/workspace/types.ts src/renderer/src/workspace/hook/actions/session.ts src/renderer/src/workspace/hook/actions/agentNameContinuity.renderer.test.tsx
git commit -F - <<'EOF'
feat(workspace): carry a durable naming identity across agent replacement

SessionMeta gains agentNameId, the opaque key the main registry allocates
against. spawn no longer seeds it — replaceSession spawns through the same
function, so a seed there renamed a pane on every provider switch — and the
replacement commit now sets it last so the successor's own metadata cannot
overwrite the carried identity.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 6: Renderer name store and the one shared selector

**Files:**
- Modify: `src/renderer/src/app-state/types.ts`
- Modify: `src/renderer/src/app-state/workspace/slice.ts`
- Create: `src/renderer/src/workspace/agentNames/selectors.ts`
- Create: `src/renderer/src/workspace/agentNames/useAgentName.ts`
- Test: `src/renderer/src/workspace/agentNames/selectors.test.ts` (create)

**Interfaces:**
- Consumes: `Settings.agentNamesEnabled`, `SessionMeta`, `isAgentProviderKind`, `DEFAULT_PROVIDER`.
- Produces:
  - `WorkspaceSlice.workspaceAgentNames: Record<string, string>` and `setWorkspaceAgentNames(next)`
  - `resolveAgentName(input: { enabled: boolean; meta: Pick<SessionMeta, 'kind' | 'agentNameId'> | undefined; names: Record<string, string> }): string | null`
  - `agentNameForSession(state: AppStore, sessionId: SessionId): string | null`
  - `useAgentName(sessionId: SessionId): string | null`

- [ ] **Step 1: Write the failing selector test**

Create `src/renderer/src/workspace/agentNames/selectors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { AppStore } from '@renderer/app-state/types'
import { agentNameForSession, resolveAgentName } from '@renderer/workspace/agentNames/selectors'

const names = { 'identity-one': 'Apollo' }

describe('agent name selector', () => {
  it('returns the allocated name for an enabled agent', () => {
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'identity-one' }, names }))
      .toBe('Apollo')
  })

  it('shows nothing while the setting is off, without forgetting the assignment', () => {
    expect(resolveAgentName({ enabled: false, meta: { kind: 'claude', agentNameId: 'identity-one' }, names }))
      .toBeNull()
  })

  it('never names a shell terminal', () => {
    // A terminal has no provider conversation to address, and the header
    // component it shares refuses terminal targets at the mutation boundary
    // too. Giving one a spoken name would advertise an unroutable target.
    expect(resolveAgentName({ enabled: true, meta: { kind: 'terminal', agentNameId: 'identity-one' }, names }))
      .toBeNull()
  })

  it('treats a missing provider kind as the default agent provider', () => {
    // Pre-terminal workspace blobs omit `kind`; the rest of the app reads that
    // as Claude, and naming must not disagree with placement or the same agent
    // would be addressable in search and unnamed in its header.
    expect(resolveAgentName({ enabled: true, meta: { agentNameId: 'identity-one' }, names }))
      .toBe('Apollo')
  })

  it('shows nothing before an identity is claimed or an allocation arrives', () => {
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude' }, names })).toBeNull()
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'unknown' }, names })).toBeNull()
    expect(resolveAgentName({ enabled: true, meta: undefined, names })).toBeNull()
  })

  it('never returns an inherited prototype value as a name', () => {
    // Identities come from a user-editable workspace file. Reading
    // names['constructor'] off a plain object would hand a Function to the
    // renderer and to agents.search.
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'constructor' }, names }))
      .toBeNull()
    expect(resolveAgentName({ enabled: true, meta: { kind: 'claude', agentNameId: 'toString' }, names }))
      .toBeNull()
  })

  it('degrades to no name on a store that has no workspace keys at all', () => {
    // The phone's store stub is `{ settings }` and nothing else, and the alias
    // that installs it is invisible to tsc — so this is the only compile-time
    // -adjacent gate on the shape `agentNameForSession` may assume. It must
    // return null, not throw. Several renderer specs mock the store this way
    // too, so a throw here would break tests that have nothing to do with names.
    const phoneShaped = { settings: { agentNamesEnabled: false } } as unknown as AppStore
    expect(() => agentNameForSession(phoneShaped, 'any-session')).not.toThrow()
    expect(agentNameForSession(phoneShaped, 'any-session')).toBeNull()

    const empty = {} as unknown as AppStore
    expect(() => agentNameForSession(empty, 'any-session')).not.toThrow()
    expect(agentNameForSession(empty, 'any-session')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/agentNames/selectors.test.ts
```

Fails: the module does not exist.

- [ ] **Step 3: Add the store field**

In `src/renderer/src/app-state/types.ts`, add to `WorkspaceSlice` after `workspaceTileTabs`:

```ts
  /** Allocated spoken names keyed by SessionMeta.agentNameId.
   *
   *  WHY this is store state and not a ref or a React context: three unrelated
   *  consumers read it — the pane header, the Dispatch index, and
   *  workspace.observe, which is called synchronously from main and cannot
   *  reach React state any other way. It is deliberately NOT persisted: the
   *  main registry is the source of truth and re-resolving on launch is one
   *  IPC round trip, whereas a stale localStorage copy could show a name that
   *  the registry has since assigned differently. */
  workspaceAgentNames: Record<string, string>
```

and to the setters:

```ts
  setWorkspaceAgentNames: (
    next: Record<string, string>
      | ((prev: Record<string, string>) => Record<string, string>),
  ) => void
```

In `src/renderer/src/app-state/workspace/slice.ts`, add the initial value after `workspaceTileTabs: null,`:

```ts
  workspaceAgentNames: {},
```

and the setter after `setWorkspaceTileTabs`:

```ts
  setWorkspaceAgentNames: next =>
    set(state => {
      const workspaceAgentNames = applyUpdater<Record<string, string>>(state.workspaceAgentNames, next)
      return Object.is(workspaceAgentNames, state.workspaceAgentNames) ? state : { workspaceAgentNames }
    }, false, 'workspace/setWorkspaceAgentNames'),
```

- [ ] **Step 4: Write the selector**

Create `src/renderer/src/workspace/agentNames/selectors.ts`:

```ts
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

import type { AppStore } from '@renderer/app-state/types'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'

/**
 * The one place a spoken name is derived, for every consumer.
 *
 * WHY it is a pure function taking explicit inputs rather than reading the
 * store: workspace.observe has to resolve names for BURIED agents, whose
 * metadata lives outside `state.sessions`, and a store-reading selector could
 * not answer for them. Keeping the rule pure also means the header, the
 * Dispatch row and the operator observation cannot drift into three slightly
 * different definitions of "does this agent have a name".
 *
 * WHY it returns null instead of a placeholder: presentation must never mint,
 * and an operator must never be told about an address that does not resolve.
 * "No name yet" and "names are off" are both correctly invisible.
 */
export function resolveAgentName(input: {
  enabled: boolean
  meta: Pick<SessionMeta, 'kind' | 'agentNameId'> | undefined
  names: Record<string, string>
}): string | null {
  if (!input.enabled || !input.meta) return null
  if (!isAgentProviderKind(input.meta.kind ?? DEFAULT_PROVIDER)) return null

  const identity = input.meta.agentNameId
  if (!identity) return null

  // Own-property + typeof, not `names[identity] ?? null`. Identities originate
  // in a user-editable workspace file, so `constructor` or `toString` would
  // otherwise resolve to an inherited function and be rendered as a name.
  //
  // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`:
  // tsconfig.web.json targets lib ES2020, so `Object.hasOwn` does not
  // type-check. Same reason and same form as mouseBinding.ts and
  // sessionOwnership.ts.
  if (!Object.prototype.hasOwnProperty.call(input.names, identity)) return null
  const name = input.names[identity]
  return typeof name === 'string' && name.length > 0 ? name : null
}

/**
 * WHY every read here is optional and the map is defaulted:
 *
 * The phone bundle (src/remote-client) renders the real PaneHeader — and
 * therefore AgentTitleHeader — while aliasing `@renderer/app-state/hooks` to a
 * stub whose entire state is `{ settings }` (vite.config.ts). `workspaceState`
 * and `workspaceAgentNames` simply do not exist there, so an eager
 * `state.workspaceState.sessions[id]` throws while merely BUILDING this
 * argument object, before `enabled` is ever consulted.
 *
 * `tsc` cannot catch that: the alias lives only in the Vite config, while
 * tsconfig.web.json type-checks src/remote-client against the REAL hooks
 * module, so the eager version compiles cleanly and fails at runtime on a
 * device. Several renderer specs mock the store the same keyless way. The
 * repository already states the rule this obeys — "a keyless store must
 * degrade, never throw" (PaneHeader.phoneCoupling.renderer.test.tsx).
 *
 * Degrading to null is also the correct ANSWER on the phone, not merely a
 * safe one: it has no workspace, no reconciler and no allocation, so it has
 * no names to show.
 */
export function agentNameForSession(state: AppStore, sessionId: SessionId): string | null {
  return resolveAgentName({
    enabled: state.settings?.agentNamesEnabled === true,
    meta: state.workspaceState?.sessions?.[sessionId],
    names: state.workspaceAgentNames ?? {},
  })
}
```

Create `src/renderer/src/workspace/agentNames/useAgentName.ts`:

```ts
import { useAppStore } from '@renderer/app-state/hooks'
import { agentNameForSession } from '@renderer/workspace/agentNames/selectors'
import type { SessionId } from '@renderer/workspace/types'

/**
 * WHY components subscribe here instead of receiving a prop: the two header
 * call sites and the Dispatch row all already re-render on unrelated causes,
 * and threading a name through TileLeaf/TileTree would widen prop surfaces on
 * the hot pane-render path for a string that changes roughly never. The
 * selector returns a primitive, so Zustand's default Object.is comparison is
 * exactly right and a name change is the ONLY thing that re-renders through
 * this subscription — token-stream updates never touch it.
 */
export function useAgentName(sessionId: SessionId): string | null {
  return useAppStore(state => agentNameForSession(state, sessionId))
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/agentNames/selectors.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/app-state/types.ts src/renderer/src/app-state/workspace/slice.ts src/renderer/src/workspace/agentNames/selectors.ts src/renderer/src/workspace/agentNames/useAgentName.ts src/renderer/src/workspace/agentNames/selectors.test.ts
git commit -F - <<'EOF'
feat(workspace): add the shared agent name selector and its store slice

One pure rule turns (setting, session metadata, allocated map) into a name for
the header, the Dispatch index and workspace.observe, so no consumer can invent
its own definition. The map is store state but deliberately not persisted: the
main registry is the source of truth.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 7: Membership-driven reconciliation

**Files:**
- Create: `src/renderer/src/workspace/agentNames/reconcile.ts`
- Create: `src/renderer/src/workspace/agentNames/useAgentNameReconciler.ts`
- Modify: `src/renderer/src/workspace/hook/index.ts`
- Test: `src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx` (create)

**Interfaces:**
- Consumes: `window.api.resolveAgentNames`, `WorkspaceSetState`, `WorkspaceRestoreStatus`, `setWorkspaceAgentNames`.
- Produces:
  - `claimMissingIdentities(state: WorkspaceState): WorkspaceState`
  - `agentNameIdentities(state: WorkspaceState): string[]`
  - `useAgentNameReconciler(state: WorkspaceState, setState: WorkspaceSetState, restoreStatus: WorkspaceRestoreStatus): void`

- [ ] **Step 1: Write the failing reconciler test**

Create `src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx`:

```tsx
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { resolveAgentName } from '@renderer/workspace/agentNames/selectors'
import { useAgentNameReconciler } from '@renderer/workspace/agentNames/useAgentNameReconciler'
import type { WorkspaceState } from '@renderer/workspace/types'

const initialStore = useAppStore.getState()
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  useAppStore.setState(initialStore, true)
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

function workspace(): WorkspaceState {
  return {
    tabs: [{ id: 'tab-a', title: 'recorded', root: { type: 'leaf', sessionId: 'agent-one' }, focusedSessionId: 'agent-one' }],
    activeTabId: 'tab-a',
    sessions: {
      'agent-one': { cwd: '/recorded', kind: 'claude' },
      'shell-one': { cwd: '/recorded', kind: 'terminal' },
    },
    detachedSessions: {},
    buried: [{
      id: 'buried-one',
      sessionId: 'buried-one',
      sessionMeta: { cwd: '/recorded', kind: 'codex', agentNameId: 'identity-buried' },
      buriedAt: 0,
      sourceTabId: 'tab-a',
      sourceTabTitle: 'recorded',
      sourceTabIndex: 0,
    }],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState
}

// WHY a real component with real useState instead of renderHook with a manual
// setState closure: the hook's whole job is to write into workspace state and
// then react to the state it just wrote. A hand-rolled setter that does not
// re-render would make the second effect read the pre-claim state forever, and
// the test would pass while the app allocated nothing. React's own setter has
// exactly the WorkspaceSetState shape (value or updater), so this is also a
// type-level check that the hook can be wired into the real composer.
function mount(options: { enabled: boolean; resolveAgentNames: ReturnType<typeof vi.fn> }) {
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, agentNamesEnabled: options.enabled } })
  Object.defineProperty(window, 'api', { configurable: true, value: { resolveAgentNames: options.resolveAgentNames } })

  const seen: { current: WorkspaceState } = { current: workspace() }
  // Lets a test move the workspace on while an allocation is still in flight.
  const control: { current: Dispatch<SetStateAction<WorkspaceState>> | null } = { current: null }
  function Harness() {
    const [state, setState] = useState<WorkspaceState>(seen.current)
    useEffect(() => { seen.current = state; control.current = setState }, [state])
    useAgentNameReconciler(state, setState, 'complete-restore')
    return null
  }
  const view = render(<Harness />)
  return { seen, control, rerender: () => view.rerender(<Harness />) }
}

describe('agent name reconciliation', () => {
  it('claims identities for agents only, resolves them once, and stores the names', async () => {
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, identity === 'agent-one' ? 'Apollo' : 'Jasper'])))
    const mounted = mount({ enabled: true, resolveAgentNames })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())

    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBe('agent-one')
    // A shell has no conversation to address; naming it would advertise an
    // unroutable target to a voice operator.
    expect(mounted.seen.current.sessions['shell-one'].agentNameId).toBeUndefined()
    // Buried agents keep their own metadata copy and must still resolve, or a
    // buried Apollo would come back unnamed and get a second address.
    //
    // WHY the FIRST call must already contain both: the hook derives its
    // identity list through `claimMissingIdentities(state)` rather than from
    // `state`, so on the very first render it sees `agent-one`'s
    // about-to-be-claimed identity alongside the buried agent's existing one.
    // Deriving from `state` would split this into two requests — and the
    // re-run triggered by the claim would then discard the first reply.
    // Asserting on call[0] rather than on the union is what pins that.
    expect([...resolveAgentNames.mock.calls[0][0]].sort()).toEqual(['agent-one', 'identity-buried'])
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useAppStore.getState().workspaceAgentNames)
      .toEqual({ 'agent-one': 'Apollo', 'identity-buried': 'Jasper' }))

    // Stable membership must not re-ask: allocation is the expensive, durable
    // side effect and a re-render is not a membership change.
    const callCount = resolveAgentNames.mock.calls.length
    act(() => { mounted.rerender() })
    expect(resolveAgentNames).toHaveBeenCalledTimes(callCount)
  })

  it('claims nothing and asks for nothing while the setting is off', async () => {
    const resolveAgentNames = vi.fn(async () => ({}))
    const mounted = mount({ enabled: false, resolveAgentNames })

    await act(async () => { await Promise.resolve() })

    expect(resolveAgentNames).not.toHaveBeenCalled()
    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBeUndefined()
    expect(useAppStore.getState().workspaceAgentNames).toEqual({})
  })

  it('leaves the map untouched when allocation fails', async () => {
    const resolveAgentNames = vi.fn(async () => { throw new Error('registry unreadable') })
    mount({ enabled: true, resolveAgentNames })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    // No fabrication, no placeholder, no partial write. A failed allocation is
    // simply an agent with no visible name until the next membership change.
    expect(useAppStore.getState().workspaceAgentNames).toEqual({})
  })

  it('applies a reply that arrives after the agent was replaced or closed', async () => {
    // The decomposition names this exact unknown: "assignment arriving after
    // close or replacement". Disk is slow and allocation is durable, so the
    // window between asking and answering is real, and both things that can
    // happen inside it are tested here at once.
    let release: (value: Record<string, string>) => void = () => {}
    const resolveAgentNames = vi.fn(() => new Promise<Record<string, string>>(resolve => { release = resolve }))
    const mounted = mount({ enabled: true, resolveAgentNames })
    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    const requested = [...resolveAgentNames.mock.calls[0][0]] as string[]

    // While the allocation is in flight: the live agent is replaced by a new
    // local session id CARRYING the same identity, and the buried agent is
    // closed outright.
    act(() => {
      mounted.control.current!(previous => ({
        ...previous,
        sessions: {
          'agent-two': { ...previous.sessions['agent-one'], agentNameId: 'agent-one' },
          'shell-one': previous.sessions['shell-one'],
        },
        buried: [],
      } as WorkspaceState))
    })

    await act(async () => {
      release(Object.fromEntries(requested.map(identity =>
        [identity, identity === 'agent-one' ? 'Apollo' : 'Jasper'])))
      await Promise.resolve()
    })

    const stored = useAppStore.getState().workspaceAgentNames
    const settled = mounted.seen.current

    // Keyed by identity, never by session: the successor inherits the name
    // that was allocated before its local session id existed. This is the
    // whole reason SessionMeta carries an identity instead of the name.
    expect(stored['agent-one']).toBe('Apollo')
    expect(resolveAgentName({ enabled: true, meta: settled.sessions['agent-two'], names: stored })).toBe('Apollo')

    // The closed agent's reply is recorded against its identity — the name is
    // spent and must never be handed out again — but it does NOT put the
    // session back into the workspace.
    expect(stored['identity-buried']).toBe('Jasper')
    expect(settled.sessions['agent-one']).toBeUndefined()
    expect(settled.buried).toEqual([])

    // And the late reply did not trigger a second allocation for either.
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx
```

Fails: the modules do not exist.

- [ ] **Step 3: Write the pure reconciliation rules**

Create `src/renderer/src/workspace/agentNames/reconcile.ts`:

```ts
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

function isNameable(meta: Pick<SessionMeta, 'kind'>): boolean {
  return isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)
}

/**
 * Claim a durable identity for every agent that does not have one yet.
 *
 * WHY the identity is simply the current sessionId: it is already unique in
 * this workspace and stable for as long as the pane is not replaced, and the
 * replacement paths carry it forward from there. Minting a fresh UUID would be
 * equivalent but would make a workspace file harder to read when debugging a
 * mis-addressed agent.
 *
 * WHY this runs after restoration rather than at creation: only here can we
 * tell "restored pane that already owns Apollo" from "brand new pane". The
 * create path cannot, because replaceSession spawns through it.
 */
export function claimMissingIdentities(state: WorkspaceState): WorkspaceState {
  let changed = false
  const sessions = { ...state.sessions }
  for (const [sessionId, meta] of Object.entries(state.sessions)) {
    if (!isNameable(meta) || meta.agentNameId) continue
    sessions[sessionId] = { ...meta, agentNameId: sessionId }
    changed = true
  }
  // Identity-preserving on a no-op: this runs on every workspace change, and
  // returning a fresh object each time would invalidate every downstream
  // memo in the workspace tree.
  return changed ? { ...state, sessions } : state
}

/**
 * Every identity whose name this window needs.
 *
 * WHY buried records are included: their SessionMeta lives outside
 * `state.sessions` and outlives it, and workspace.observe deliberately reports
 * them. A buried agent that resolved to no name would be re-addressed on
 * restore, which is exactly the silent re-targeting #816 forbids.
 */
export function agentNameIdentities(state: WorkspaceState): string[] {
  const identities = new Set<string>()
  for (const meta of Object.values(state.sessions)) {
    if (isNameable(meta) && meta.agentNameId) identities.add(meta.agentNameId)
  }
  for (const record of state.buried) {
    if (isNameable(record.sessionMeta) && record.sessionMeta.agentNameId) {
      identities.add(record.sessionMeta.agentNameId)
    }
  }
  return [...identities]
}
```

- [ ] **Step 4: Write the hook**

Create `src/renderer/src/workspace/agentNames/useAgentNameReconciler.ts`:

```ts
import { useEffect, useMemo, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { agentNameIdentities, claimMissingIdentities } from '@renderer/workspace/agentNames/reconcile'
import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import type { WorkspaceState } from '@renderer/workspace/types'

/**
 * The one hook that keeps naming in step with workspace membership.
 *
 * WHY membership and not the transcript: a name changes when an agent is
 * created, restored, replaced, buried or closed — never when a token arrives.
 * Driving this from runtime updates would put an IPC round trip on the
 * streaming path for a value that does not change while a model is talking.
 *
 * WHY it is gated on the setting: the flag governs ALLOCATION, not only
 * display. A user who never enables Agent names must never cause a write to
 * agent-names.json, and enabling is what assigns names to the agents that
 * already exist.
 */
export function useAgentNameReconciler(
  state: WorkspaceState,
  setState: WorkspaceSetState,
  restoreStatus: WorkspaceRestoreStatus,
): void {
  const enabled = useAppStore(store => store.settings.agentNamesEnabled)
  const names = useAppStore(store => store.workspaceAgentNames)
  const setNames = useAppStore(store => store.setWorkspaceAgentNames)

  // Identities already sent to main. Without it the effect would re-request
  // every identity on each state change until the reply lands, and a slow disk
  // would turn one membership change into a burst of allocations.
  const requestedRef = useRef(new Set<string>())

  // WHY cancellation is unmount-scoped rather than a per-effect `cancelled`
  // flag: this effect's deps include `state` and `names`, so an ordinary
  // cleanup fires on every workspace change — discarding a reply that is
  // already in flight and, because those identities stay marked as requested,
  // never asking again. That stranded them permanently on the very first
  // render, where claiming state immediately re-runs the effect.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // WHY the identity list is derived through the same claim the write effect
  // commits, instead of from `state` directly: on mount the claim has not been
  // applied yet, so reading `state` would ask for the already-identified
  // agents in one request and the just-claimed ones in a second. Running the
  // pure function here makes both effects agree within a single render, so
  // the first request is the complete one and the follow-up finds nothing
  // missing. `claimMissingIdentities` is identity-preserving on a no-op, so
  // this costs nothing once the workspace has settled.
  const identities = useMemo(
    () => (enabled && restoreStatus !== 'pending'
      ? agentNameIdentities(claimMissingIdentities(state))
      : []),
    [enabled, restoreStatus, state],
  )

  useEffect(() => {
    if (!enabled) {
      // Re-enabling should retry anything a failure left behind.
      requestedRef.current.clear()
      return
    }
    // 'pending' means bootstrap has not decided what the workspace contains.
    // Claiming identities against a half-built state would mint one for a
    // session that rehydration is about to replace.
    if (restoreStatus === 'pending') return
    // Updater form, like the sibling sanity hooks: it re-derives against the
    // freshest state in case a concurrent setState ran since this render.
    setState(claimMissingIdentities)
  }, [enabled, restoreStatus, setState, state])

  useEffect(() => {
    const missing = identities.filter(identity =>
      // Object.prototype.hasOwnProperty.call, not Object.hasOwn: lib is ES2020.
      !Object.prototype.hasOwnProperty.call(names, identity)
      && !requestedRef.current.has(identity))
    if (missing.length === 0) return
    for (const identity of missing) requestedRef.current.add(identity)

    void window.api.resolveAgentNames(missing)
      .then(resolved => {
        // Not `cancelled` — only "this window is gone". A reply that arrives
        // after the workspace moved on is still correct: it is keyed by
        // IDENTITY, so it belongs to whatever session now carries that
        // identity, and to nothing at all if the agent closed. Writing it is
        // what makes a replacement that completed mid-flight inherit its name.
        if (!mountedRef.current) return
        setNames(previous => {
          const merged = { ...previous }
          let changed = false
          for (const [identity, name] of Object.entries(resolved)) {
            if (typeof name === 'string' && name.length > 0 && merged[identity] !== name) {
              merged[identity] = name
              changed = true
            }
          }
          // Identity-preserving on a no-op so the slice's Object.is bail keeps
          // the store reference stable. Returning a fresh object every time
          // would change `names`, re-run this effect, and — with these entries
          // just cleared from requestedRef below — loop forever on a reply
          // that added nothing.
          return changed ? merged : previous
        })
      })
      // Never fabricate a name. A failed allocation is simply an agent with no
      // visible name until something changes.
      .catch(() => {})
      .finally(() => {
        // Clear on SETTLE, not only on rejection. Whatever this request
        // answered is now in `names` and will filter itself out; whatever it
        // did not answer must be free to be asked again on the next membership
        // change, rather than stranded in this set for the life of the window.
        // This does not re-run the effect on its own: on success `names`
        // changed and the recomputed `missing` is empty, and on failure no dep
        // changed at all — so a broken registry cannot become a hot loop.
        for (const identity of missing) requestedRef.current.delete(identity)
      })
  }, [identities, names, setNames])
}
```

- [ ] **Step 5: Mount it in the workspace composer**

In `src/renderer/src/workspace/hook/index.ts`, add the import beside the other workspace hook imports:

```ts
import { useAgentNameReconciler } from '@renderer/workspace/agentNames/useAgentNameReconciler'
```

and call it with the other invalidation hooks, after `usePinnedSessionIdsSanity(state, setState)`:

```ts
  // Beside the sanity hooks because it is the same kind of thing: a
  // membership-driven correction that keeps an orthogonal slice consistent
  // with the tile tree. It is last so it observes the state the sanity hooks
  // have already settled.
  useAgentNameReconciler(state, setState, restoreStatus)
```

- [ ] **Step 6: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/workspace/agentNames/reconcile.ts src/renderer/src/workspace/agentNames/useAgentNameReconciler.ts src/renderer/src/workspace/agentNames/reconciler.renderer.test.tsx src/renderer/src/workspace/hook/index.ts
git commit -F - <<'EOF'
feat(workspace): reconcile agent names from workspace membership

One hook claims a durable identity for every unnamed agent after restoration
and asks main to allocate the names it does not already hold. It is driven by
membership and identity changes only, never by token-stream updates, and a
failed allocation leaves the map untouched rather than fabricating a name.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 8: Name badges in the agent header and the Dispatch index

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/AgentTitleHeader.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`
- Modify: `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`
- Test: `src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx` (create)

**Interfaces:**
- Consumes: `useAgentName(sessionId)`.
- Produces: `AgentTitleHeader({ sessionId, title })` rendering `[data-agent-name-badge]`, and a `[data-dispatch-agent-name]` chip on every Dispatch row.

- [ ] **Step 1: Write the failing presentation test**

Create `src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx`:

```tsx
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DispatchAgentList } from '@renderer/workspace/dispatch/DispatchAgentList'
import type { DispatchAgentRow, DispatchTabGroup } from '@renderer/workspace/dispatch/dispatchSelectors'
import { AgentTitleHeader } from '@renderer/workspace/tile-tree/AgentTitleHeader'

// Mock only the Zustand transport boundary, exactly as the color-flag layout
// tests do: the real store's persist middleware is unrelated to what changes
// here, and one shared state object makes the header and the index fail
// together if they ever disagree about the selector's inputs.
const appState = vi.hoisted(() => ({
  settings: { agentNamesEnabled: true, dispatchColorFlags: {} as Record<string, string> },
  workspaceState: { sessions: {} as Record<string, { cwd: string; kind: string; agentNameId?: string }> },
  workspaceAgentNames: {} as Record<string, string>,
  workspaceRuntimes: {} as Record<string, unknown>,
  setDispatchColorFlag: vi.fn(),
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}))

const AGENT = 'session-agent'
const SHELL = 'session-shell'

function seed(): void {
  appState.settings.agentNamesEnabled = true
  appState.workspaceState.sessions = {
    [AGENT]: { cwd: '/recorded', kind: 'claude', agentNameId: 'identity-one' },
    [SHELL]: { cwd: '/recorded', kind: 'terminal', agentNameId: 'identity-two' },
  }
  appState.workspaceAgentNames = { 'identity-one': 'Apollo', 'identity-two': 'Jasper' }
}

function row(sessionId: string, label: string, kind: 'claude' | 'terminal'): DispatchAgentRow {
  return {
    key: `tab-a:grid:${sessionId}`,
    label,
    globalIndex: Number(label.slice(1)),
    tabId: 'tab-a',
    tabTitle: 'Agent Code',
    tabIndex: 0,
    sessionId,
    kind,
    title: `${label} workflow`,
    placement: 'grid',
    depth: 0,
  }
}

function group(): DispatchTabGroup {
  return {
    tab: { id: 'tab-a', title: 'Agent Code', root: { type: 'leaf', sessionId: AGENT }, focusedSessionId: AGENT },
    tabIndex: 0,
    rows: [row(AGENT, 'A1', 'claude'), row(SHELL, 'A2', 'terminal')],
  }
}

function renderIndex() {
  return render(
    <DispatchAgentList
      groups={[group()]}
      pinnedRows={[]}
      activeSessionId={AGENT}
      dispatchScope="project"
      focusSessionInTab={vi.fn()}
      showWorktreeBadges={false}
    />,
  )
}

afterEach(() => {
  appState.workspaceAgentNames = {}
  appState.workspaceState.sessions = {}
  appState.settings.dispatchColorFlags = {}
})

describe('agent name presentation', () => {
  it('shows the name beside the title in the shared agent header', () => {
    seed()
    const { container } = render(<AgentTitleHeader sessionId={AGENT} title="Investigate queue race" />)

    const badge = container.querySelector('[data-agent-name-badge="true"]')
    expect(badge).toHaveTextContent('Apollo')
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('Investigate queue race')
  })

  it('still renders the header for a named agent that has no title', () => {
    // WHY: the header previously returned null without a title. A user who
    // enabled names and never titles their agents would otherwise see nothing,
    // and the operator could address an agent the user cannot see named.
    seed()
    const { container } = render(<AgentTitleHeader sessionId={AGENT} />)
    expect(container.querySelector('[data-agent-name-badge="true"]')).toHaveTextContent('Apollo')
  })

  it('renders nothing for an untitled shell, even one with a stale identity', () => {
    seed()
    const { container } = render(<AgentTitleHeader sessionId={SHELL} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing at all while the setting is off', () => {
    seed()
    appState.settings.agentNamesEnabled = false
    const { container } = render(<AgentTitleHeader sessionId={AGENT} title="Investigate queue race" />)
    expect(container.querySelector('[data-agent-name-badge="true"]')).toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toHaveTextContent('Investigate queue race')
  })

  it('chips the name on the agent row of the Dispatch index and leaves shells bare', () => {
    seed()
    const { container } = renderIndex()

    const rows = container.querySelectorAll<HTMLElement>('[data-dispatch-row="true"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-dispatch-agent-name="true"]')).toHaveTextContent('Apollo')
    expect(rows[1].querySelector('[data-dispatch-agent-name="true"]')).toBeNull()
    // The title must keep its own truncation slot; the chip is a sibling, not
    // a prefix inside the truncating span.
    expect(rows[0]).toHaveTextContent('A1 workflow')
  })

  it('drops every Dispatch chip when the setting is off', () => {
    seed()
    appState.settings.agentNamesEnabled = false
    const { container } = renderIndex()
    expect(container.querySelectorAll('[data-dispatch-agent-name="true"]')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx
```

Fails: `AgentTitleHeader` takes no `sessionId` and renders no badge.

- [ ] **Step 3: Rewrite `AgentTitleHeader`**

```tsx
import { useAgentName } from '@renderer/workspace/agentNames/useAgentName'
import type { SessionId } from '@renderer/workspace/types'

// One visual contract for explicit agent titles and spoken agent names across
// the structured Agent surface and the raw agent-terminal surface. Plain shell
// terminals intentionally do not use this component: titles belong to provider
// agents and the command refuses terminal targets at the mutation boundary too.
// The name selector refuses them a second time, so a terminal that somehow
// mounts this still renders nothing.
//
// WHY the component subscribes rather than taking `agentName` as a prop: both
// call sites sit on the hot pane-render path and already thread a dozen props;
// see useAgentName for why a primitive subscription is cheaper than widening
// them.
export function AgentTitleHeader({ sessionId, title }: { sessionId: SessionId; title?: string }) {
  const agentName = useAgentName(sessionId)
  const visibleTitle = title?.trim()
  // WHY the guard now checks BOTH: this row used to exist only for a title, so
  // an untitled agent rendered nothing. With names on, that would hide the only
  // address a voice operator can use while the operator can still reach it.
  if (!visibleTitle && !agentName) return null

  return (
    <div
      data-agent-title-header="true"
      className="flex min-w-0 items-center gap-2 border-t border-border/70 bg-canvas px-3 py-1 font-code text-[11px] font-medium text-ink select-none"
      title={[agentName, visibleTitle].filter(Boolean).join(' — ')}
    >
      {agentName && (
        // Fixed width contribution, never truncated: the name is the thing a
        // user says out loud, so it must survive a narrow Tiled Dispatch lane
        // even when the title does not.
        <span
          data-agent-name-badge="true"
          className="flex-shrink-0 rounded-chip border border-border px-1 leading-[14px] text-[10px] font-semibold tracking-wide text-ink"
        >
          {agentName}
        </span>
      )}
      {visibleTitle && <div className="truncate">{visibleTitle}</div>}
    </div>
  )
}
```

- [ ] **Step 4: Pass `sessionId` at both header call sites**

In `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx`, replace line 136:

```tsx
      <AgentTitleHeader sessionId={sessionId} title={agentTitle} />
```

In `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`, replace line 484:

```tsx
        <AgentTitleHeader sessionId={sessionId} title={agentTitle} />
```

Both components already receive `sessionId` as a prop, and both are given the *rendered* session by their callers, which is the agent whose name the pane is showing.

- [ ] **Step 5: Chip the Dispatch row**

In `src/renderer/src/workspace/dispatch/DispatchAgentList.tsx`, add the import beside the other renderer imports:

```tsx
import { useAgentName } from '@renderer/workspace/agentNames/useAgentName'
```

In the row component, beside the other derived values (next to `const title = dispatchRowTitle(row, runtime.entries)`), add:

```tsx
  const agentName = useAgentName(row.sessionId)
```

and inside the title row's `<div className="flex items-center gap-2 min-w-0">`, immediately before `<span className="min-w-0 flex-1">`, add:

```tsx
          {agentName && (
            // WHY the chip leads the row instead of being appended to the
            // title: the index is scanned vertically, and a leading column of
            // names lines up the way the label column already does. Appending
            // would put it inside the truncating span, where the longest
            // titles would eat exactly the token the user needs to speak.
            <span
              data-dispatch-agent-name="true"
              className="flex-shrink-0 rounded-chip border border-border px-1 text-[9px] font-semibold leading-[13px] text-ink"
            >
              {agentName}
            </span>
          )}
```

This one change covers classic Dispatch, Grid Dispatch and Tiled Dispatch's lane-0 index, because all three render this same component (`DispatchLayout.tsx:138`, `TiledDispatchLayout.tsx:305`).

**`DispatchMiniList` is deliberately excluded**: it is the 46px lane strip whose own header states its contract as "index chips ([A1], [A2], ★1 …) — no titles, no activity dots, no badges", so a name has nowhere to go that would not break the one property that strip exists to provide, and the full index beside it already shows the name for the same agents. Its hover tooltip keeps the title-only text it has today.

**No isolated visual preview is attempted** for this feature, which the decomposition allows ("where practical"). The visible change is two text chips inside existing flex rows whose truncation behaviour is asserted directly in the tests below — the badge is `flex-shrink-0` and the title keeps its own truncating span — so a screenshot would add a reviewing artifact without answering a question the assertions do not.

- [ ] **Step 6: Pin the phone contract where the repository already keeps it**

`AgentTitleHeader` now calls `useAgentName` before its early return, so it reads the store on **every** `PaneHeader` render — including the phone's, which renders the real `PaneHeader` (`src/remote-client/src/ui/SessionView.tsx:330`) against a stub store of `{ settings }` only. Task 6's selector already degrades instead of throwing; this step is the regression gate, and it is the *only* one, because the stub is installed by a Vite alias that `tsc` never sees.

Append to the existing `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx`, whose other cases pin the same rule for `workspaceRuntimes`:

```tsx
  it('renders no agent name on a store with no workspace keys (phone stub shape)', () => {
    // src/remote-client aliases @renderer/app-state/hooks to a stub whose
    // state is `{ settings }` (vite.config.ts). tsconfig.web.json type-checks
    // that directory against the REAL hooks module, so a selector reading
    // state.workspaceState compiles and then throws on a device. Reproducing
    // the stub shape here is the only place that can catch it.
    useAppStore.setState({
      workspaceState: undefined as never,
      workspaceAgentNames: undefined as never,
    })
    const { container } = render(
      <PaneHeader
        sessionId="session"
        projectDir="/project"
        statusMode={false}
        isSessionLive={false}
        relatedAgentTabs={[]}
      />,
    )
    // Degrade, never throw — and with no workspace there is no name to show,
    // so the title row stays absent exactly as it is on the phone today.
    expect(container.querySelector('[data-agent-name-badge="true"]')).toBeNull()
    expect(container.querySelector('[data-agent-title-header="true"]')).toBeNull()
  })
```

Then record the coupling in the stub itself, so the next person to add a store read in the feed subtree sees it. In `src/remote-client/src/stubs/appStateHooks.ts`, append to the header comment:

```ts
// Agent names (issue #816) are a deliberate no-op here: the phone has no
// workspace state, no reconciler and no allocation, so agentNameForSession
// degrades to null and no badge renders. Note that the "fails the phone
// tsc/build loudly" claim above does NOT hold for a read whose key is simply
// missing — tsconfig.web.json checks this directory against the real hooks
// module, not against this stub — so selectors reached from the feed subtree
// must tolerate a keyless store on their own. PaneHeader.phoneCoupling is the
// test that enforces it.
```

Deliberately **not** done: widening `PHONE_APP_STATE` with empty `workspaceState` / `workspaceAgentNames` keys. They could never be non-empty on the phone, so they would assert a coupling that does not exist and would not protect the several renderer specs that mock the store the same keyless way. Tolerance in the one selector covers every caller; two fake keys cover one.

- [ ] **Step 7: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/dispatch src/renderer/src/workspace/tile-tree
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/AgentTitleHeader.tsx src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx src/renderer/src/workspace/dispatch/DispatchAgentList.tsx src/renderer/src/workspace/agentNames/presentation.renderer.test.tsx src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx src/remote-client/src/stubs/appStateHooks.ts
git commit -F - <<'EOF'
feat(workspace): show agent names in headers and the Dispatch index

The shared agent header now renders a name badge beside the title and survives
an untitled agent, and every Dispatch row leads with the same name chip, which
covers classic, grid and tiled Dispatch through the one shared index. Shells
render nothing, and the whole surface disappears when the setting is off.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 9: Operator observation and exact name lookup

**Files:**
- Modify: `src/control-sdk/catalog/workspace.ts`
- Modify: `src/renderer/src/workspace/control.ts`
- Modify: `src/main/control/globalCapabilities.ts`
- Test: `src/renderer/src/workspace/control/agentNames.renderer.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAgentName`, `claimMissingIdentities`, `normalizeAgentName`, `observeWorkspace`, `globalControlCapabilities`.
- Produces: `agentName: string | null` on every observed session, and `agents.search({ name })` exact lookup.

- [ ] **Step 1: Write the failing observation and search test**

Create `src/renderer/src/workspace/control/agentNames.renderer.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'

import { globalControlCapabilities } from '@main/control/globalCapabilities'
import { useAppStore } from '@renderer/app-state/store'
import { claimMissingIdentities } from '@renderer/workspace/agentNames/reconcile'
import { observeWorkspace } from '@renderer/workspace/control'
import type { WorkspaceState } from '@renderer/workspace/types'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

const owners = ['left', 'right'].map(windowId => ({ kind: 'window' as const, windowId, generation: 'current' }))
const context = { requestId: 'search', caller: { kind: 'external' as const, id: 'test' }, owner: { kind: 'main' as const, generation: 'main' } }

function searchOver(workspace: ReturnType<typeof observeWorkspace>) {
  const caps = globalControlCapabilities(async () => [
    ...owners.map(owner => ({ windowId: owner.windowId, owner, workspace })),
    { windowId: 'reloading', owner: null, error: 'window is reloading' },
  ])
  const capability = caps.find(cap => cap.descriptor.id === 'agents.search')!
  return (input: unknown) => capability.execute(input, context)
}

it('publishes enabled names and resolves an exact spoken name across windows', async () => {
  const fixture = JSON.parse(readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'))
  const id: string = fixture.$fixture.observed.targetSessionId
  // Claim identities the same way the running app does, from the recorded
  // workspace, so the test cannot drift from the reconciler's rule.
  const claimed = claimMissingIdentities(fixture.state as WorkspaceState)
  const identity = claimed.sessions[id].agentNameId!

  useAppStore.setState({
    workspaceState: claimed,
    workspaceTileTabs: null,
    workspaceReaderMode: null,
    workspaceSpotlight: null,
    workspaceRuntimes: {},
    workspaceAgentNames: { [identity]: 'Apollo' },
    settings: { ...useAppStore.getState().settings, agentNamesEnabled: true },
  })

  const observed = observeWorkspace(() => ({ restoreStatus: 'complete-restore' }))
  expect(observed.sessions.find(session => session.sessionId === id)?.agentName).toBe('Apollo')
  // Every other agent in the recorded workspace is unnamed, and an unnamed
  // agent must report null rather than an empty string an operator could match.
  expect(observed.sessions.filter(session => session.agentName !== null)).toHaveLength(1)

  const search = searchOver(observed)

  // The same agent is observed by two windows, so an exact name still returns
  // BOTH candidates: name lookup must not quietly resolve the ambiguity that
  // ownership handling exists to surface.
  expect(await search({ name: 'apollo' })).toMatchObject({ ok: true, value: {
    total: 2,
    items: [{ sessionId: id, owner: owners[0] }, { sessionId: id, owner: owners[1] }],
    unavailableWindows: [{ windowId: 'reloading', error: 'window is reloading' }],
  } })
  expect(await search({ name: '  APOLLO  ', windowId: 'right' })).toMatchObject({ ok: true, value: {
    total: 1, items: [{ sessionId: id, owner: owners[1] }],
  } })
  // Exact, never substring: "Apo" is not an address.
  expect(await search({ name: 'Apo' })).toMatchObject({ ok: true, value: { total: 0 } })
  // The free-text query still finds it, which is what makes a partially heard
  // name recoverable without weakening the exact filter.
  expect(await search({ query: 'apoll' })).toMatchObject({ ok: true, value: { total: 2 } })
})

it('hides names and name lookup while the setting is off', async () => {
  const fixture = JSON.parse(readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'))
  const id: string = fixture.$fixture.observed.targetSessionId
  const claimed = claimMissingIdentities(fixture.state as WorkspaceState)

  useAppStore.setState({
    workspaceState: claimed,
    workspaceTileTabs: null,
    workspaceReaderMode: null,
    workspaceSpotlight: null,
    workspaceRuntimes: {},
    workspaceAgentNames: { [claimed.sessions[id].agentNameId!]: 'Apollo' },
    settings: { ...useAppStore.getState().settings, agentNamesEnabled: false },
  })

  const observed = observeWorkspace(() => ({ restoreStatus: 'complete-restore' }))
  expect(observed.sessions.every(session => session.agentName === null)).toBe(true)
  // Disabling the feature must not disable the operator server; search still
  // answers, it simply has no names to match.
  expect(await searchOver(observed)({ name: 'Apollo' })).toMatchObject({ ok: true, value: { total: 0 } })
  expect(await searchOver(observed)({ query: '' })).toMatchObject({ ok: true })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/control/agentNames.renderer.test.ts
```

Fails: `agentName` is not in the observation schema and `agents.search` rejects an unknown `name` input.

- [ ] **Step 3: Add `agentName` to the published observation**

In `src/control-sdk/catalog/workspace.ts`, add to the `sessions` element, after `displayedTitle`:

```ts
    agentName: z.string().nullable().default(null).describe('Stable spoken name for voice operation, e.g. "Apollo". Null when the Agent names setting is off, when the agent is a terminal, or before a name has been allocated. Unlike displayLabel this does not change with layout, and it is never reused after an agent closes.'),
```

- [ ] **Step 4: Fill it in the renderer observation**

In `src/renderer/src/workspace/control.ts`, add the import:

```ts
import { resolveAgentName } from '@renderer/workspace/agentNames/selectors'
```

and extend the `identity` helper so both the label and the name come from one place, replacing its body's `return`:

```ts
    const agentName = resolveAgentName({
      // Read from the SAME store snapshot the rest of this observation uses.
      // Re-reading getState() here could interleave with a reconciliation and
      // report a name for a session whose metadata this call has not seen.
      enabled: store.settings.agentNamesEnabled,
      meta,
      names: store.workspaceAgentNames,
    })
    return { displayLabel, displayedTitle, agentName }
```

The `sessions` map already spreads `...identity(sessionId, meta)`, so `agentName` reaches the published payload with no further change — and because `identity` is called with the merged `sessions` record, buried agents are covered too.

- [ ] **Step 5: Add exact name lookup to `agents.search`**

In `src/main/control/globalCapabilities.ts`, add the import:

```ts
import { normalizeAgentName } from '@shared/agentNames/names.js'
```

Add to the input schema, immediately after `label`:

```ts
        name: z.string().trim().min(1).optional().describe('Exact spoken agent name from the Agent names setting, e.g. "Apollo" or "Apollo 2". Case-insensitive and whitespace-normalized, never a substring; use query for partial text. Names are absent while the setting is off, in which case this matches nothing. A name identifies one allocation, but several windows can observe the same agent, so every candidate is still returned — resolve to sessionId before acting.'),
```

Update the description string of the capability to mention it, replacing its final sentence:

```ts
      description: 'Find existing agents across every window/project, including related, detached and buried agents. Labels are window-local and may be ambiguous globally; all matching candidates are returned. Spoken agent names are application-wide and never recycled, but the same agent can still be observed by several windows. Results carry stable ownership for direct navigation. Incomplete windows are reported, never silently dropped.',
```

In the handler, derive the wanted name beside `query`:

```ts
        // Normalized once, outside the row loop: the same spoken-equivalence
        // rule the registry uses for uniqueness must decide a match, or a name
        // that cannot be allocated twice could still be searched for twice.
        const wantedName = input.name ? normalizeAgentName(input.name) : ''
```

and add the predicate to the row filter, immediately after the `label` clause:

```ts
          && (!wantedName || normalizeAgentName(session.agentName ?? '') === wantedName)
```

Finally add `session.agentName ?? ''` to the free-text haystack so a partially heard name is still recoverable:

```ts
          && [session.sessionId, session.title, session.displayedTitle, session.displayLabel ?? '', session.agentName ?? '', session.cwd, session.provider].some(value => value.toLocaleLowerCase().includes(query)))
```

Because `input.name` is `z.string().trim().min(1)`, a blank name is rejected at the boundary rather than silently degrading into "no filter", and an unnamed session normalizes to `''` which can never equal a non-empty `wantedName`.

- [ ] **Step 6: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/control/agentNames.renderer.test.ts
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/control
NODE_ENV=test npx vitest run --project system src/main/control/controlHost.system.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/control-sdk/catalog/workspace.ts src/renderer/src/workspace/control.ts src/main/control/globalCapabilities.ts src/renderer/src/workspace/control/agentNames.renderer.test.ts
git commit -F - <<'EOF'
feat(control): expose agent names in observation and exact operator search

Every observed session carries agentName, null while the setting is off, and
agents.search gains an exact, whitespace-normalized name filter that reuses the
registry's own equivalence rule. Ambiguity and unavailable-window reporting are
unchanged: a name still returns every candidate window, and sending still
targets a stable session ID.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 10: Crash course and operator skill text

**Files:**
- Modify: `src/renderer/src/app/controlGuide.ts`
- Modify: `operator-skills/agent-code-computer-execution/SKILL.md`
- Test: `src/renderer/src/control/documentation.renderer.test.ts` (modify)

**Interfaces:**
- Consumes: `appGuideSections`, `getSettingsRegistry` (already published through `settings.reference`).
- Produces: naming guidance in the `agent-lifecycle` crash-course section and in the operator skill's agent-selection section.

- [ ] **Step 1: Write the failing documentation contract test**

Append to `src/renderer/src/control/documentation.renderer.test.ts`, inside the existing `describe`:

```ts
  it('teaches spoken agent names in the crash course and publishes the toggle that produces them', async () => {
    // WHY the guide is asserted rather than merely written: app.describe is the
    // only thing an external operator reads before acting, and a name it does
    // not know about is a name it will never use. The settings assertion covers
    // the other half — discovering WHY an agent has no name.
    const guide = find(documentationCapabilities(), 'app.describe')
    const lifecycle = await guide.execute({ section: 'agent-lifecycle' }, context)
    if (!lifecycle.ok) throw new Error(lifecycle.error.message)
    const markdown = (lifecycle.value as { items: Array<{ markdown: string }> }).items[0].markdown
    expect(markdown).toMatch(/Agent names/)
    expect(markdown).toMatch(/agents\.search/)
    expect(markdown).toMatch(/stable session ID|sessionId/)

    const settings = find(documentationCapabilities(), 'settings.reference')
    const found = await settings.execute({ query: 'agent names' }, context)
    if (!found.ok) throw new Error(found.error.message)
    expect((found.value as { items: Array<{ id: string }> }).items.map(item => item.id)).toContain('agent-names')
  })
```

- [ ] **Step 2: Run it and watch it fail**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/control/documentation.renderer.test.ts
```

Fails on the `agent-lifecycle` markdown assertions.

- [ ] **Step 3: Extend the crash course**

In `src/renderer/src/app/controlGuide.ts`, append this paragraph to the end of the `agent-lifecycle` section's markdown template literal, before the closing backtick:

```

Agent names are an optional spoken address, off by default and toggled by the "Agent names" setting. When enabled, each provider agent gets one stable name from a fixed ranked list (Apollo, Jasper, Beatrix, …); past 100 agents the names take explicit numeric suffixes such as "Apollo 2". A name is application-wide and survives restart, reload, provider replacement and restore, so it is unlike displayLabel, which is window-local and changes with layout. It is never reused after an agent closes, so a request for a closed name resolves to nothing rather than to a different agent. Terminals never get names. Search a name with ac_agents_search {name: "Apollo"}: the match is exact and case-insensitive, not a substring, and it still returns every candidate window for that agent, so resolve to the stable session ID before acting. While the setting is off, agentName is null everywhere and a name search matches nothing; the operator server itself is unaffected.
```

- [ ] **Step 4: Extend the operator skill**

In `operator-skills/agent-code-computer-execution/SKILL.md`, insert this paragraph in the "Select the correct window and agent" section, immediately after the paragraph that begins "Use `ac_agents_search` across windows before creating an agent":

```markdown
If the user speaks a name — "send this to Apollo" — search `{name: "Apollo"}`.
The match is exact and case-insensitive, never a substring, and "Apollo 2" is a
different agent from "Apollo". A name is application-wide and stable across
restart, reload and provider replacement, unlike a window-local label, and it is
never reused after an agent closes: an empty result means that agent is gone, not
that it moved. Several windows can observe the same agent, so a name search can
still return more than one candidate; resolve to the returned `sessionId` before
sending. Empty results with `agentName: null` everywhere mean the user has not
enabled the "Agent names" setting — ask them rather than guessing at a label.
```

- [ ] **Step 5: Run it and watch it pass**

```bash
NODE_ENV=test npx vitest run --project renderer src/renderer/src/control/documentation.renderer.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/app/controlGuide.ts operator-skills/agent-code-computer-execution/SKILL.md src/renderer/src/control/documentation.renderer.test.ts
git commit -F - <<'EOF'
docs(control): teach spoken agent names to the operator

The crash course and the operator skill now explain the exact-match name
lookup, how a name differs from a window-local label, that a closed name never
resolves to a different agent, and what an all-null agentName means.

Refs #816

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

---

### Task 11: Full verification and the pull request

**Files:**
- Modify: none (verification only)
- Test: the whole suite

**Interfaces:**
- Consumes: everything above.
- Produces: a reviewable PR with `Fixes #816`, unmerged.

- [ ] **Step 1: Run the complete gate**

```bash
source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24
npm run typecheck
npm run test:contract
NODE_ENV=test npx vitest run
```

Record the exact counts.

**Establish the baseline yourself; do not trust a remembered list of "known" failures.** Before Task 1 writes anything, run `NODE_ENV=test npx vitest run` on the rebased branch and save the failing set. Only tests in *that* recorded set are pre-existing; everything else that fails here is yours. (A `hotkeyBinding.test.ts` is sometimes cited as a standing failure in this repository — there is no such file on this base, which is exactly why the baseline has to be measured rather than recalled.)

- [ ] **Step 2: Re-read the diff against the isolation rules**

```bash
git diff origin/main --stat
# The registry must have exactly one importer.
git grep -n "agentNames/registry" -- src | grep -v "src/main/agentNames/"
# No feature, UI or MCP module may know the file path.
git grep -n "agent-names.json" -- src
# Nothing outside main may reach STATE_DIR for naming.
git grep -n "AGENT_NAMES_FILE" -- src
```

The first command must return nothing; the second and third must return only `src/main/agentNames/ipc.ts`.

- [ ] **Step 3: Open the pull request**

```bash
gh auth status   # must be Juliusolsson05
git push -u origin feat/agent-names
gh pr create --title "feat(workspace): stable voice-friendly agent names" --body-file - <<'EOF'
Adds an opt-in **Agent names** setting so an external voice operator can say
"send a prompt to Apollo" and reach exactly one agent.

- A main-process registry owns one durable file separate from `workspace.json`,
  serializes allocation across windows on a single promise tail, and commits to
  disk before it returns a name. Names are never recycled; an unreadable store
  is refused rather than overwritten.
- `SessionMeta.agentNameId` is the durable identity. It is minted once by a
  membership-driven reconciler after workspace restoration and carried across
  provider replacement, reload and rehydration, so a backend swap never renames
  a pane. Duplicated agents get their own identity, and shells get none.
- One shared selector feeds the agent header, the Dispatch index (classic, grid
  and tiled) and `workspace.observe`; nothing mints a name on render, and
  reconciliation never runs on token-stream updates.
- `agents.search` gains an exact, whitespace-normalized `name` filter that
  preserves the existing ambiguity and unavailable-window reporting. Sending
  still targets stable session IDs, and disabling the feature does not disable
  the operator server.
- Default off. Disabling hides names and name lookup while retaining every
  assignment, so re-enabling restores the same addresses.

Plan: `docs/superpowers/plans/2026-09-07-agent-names.md`
Decomposition: `docs/decomposition/agent-names.md`

Fixes #816

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

- [ ] **Step 4: Stop**

Do not merge. Report the PR number and the CI result. No merge authorization is inherited from #812 or from any earlier approval.

---

## Self-review

### Spec coverage — every decomposition stage

| Decomposition item | Task |
| --- | --- |
| Stage 1 — shared ranked vocabulary and contracts | 1 |
| Stage 1 — isolated main registry, atomic persistence, serialized allocation | 2 |
| Stage 1 — "allocation is committed before names are shown" | 2, Step 1 first test |
| Stage 1 — concurrent-window allocation test | 2, Step 1 second test |
| Stage 1 — reopen / corrupt-store tests | 2, Step 1 third, fifth and sixth tests |
| Stage 1 — application IPC | 3 |
| Stage 1 — default-off setting with normal coercion / registry support | 4 |
| Stage 1 — registry storage separate from workspace persistence | 3 (`AGENT_NAMES_FILE` WHY), 11 Step 2 |
| Stage 1 — SessionMeta carries only its durable naming identity | 5 |
| Stage 2 — one membership-driven reconciliation hook | 7 |
| Stage 2 — lifecycle continuity across replacement/rehydration | 5 |
| Stage 2 — shared name selector | 6 |
| Stage 2 — header and Dispatch list integration, tiled included | 8 |
| Stage 2 — "presentation must consume one assignment, never mint on render" | 6 (pure selector), 8 (no fallback path) |
| Stage 2 — "names stay out of token-stream updates" | 7 (membership-only deps), 6 (primitive subscription) |
| Stage 3 — enabled `agentName` fields in observations | 9 |
| Stage 3 — exact name search preserving ambiguity and unavailable windows | 9 |
| Stage 3 — crash-course / skill instructions | 10 |
| Stage 3 — disabled behavior | 8 (two tests), 9 (second test) |
| Stage 3 — renderer/type/contract checks | 11 |
| Isolation — only the IPC adapter consumes the registry | 3, enforced in 11 Step 2 |
| Isolation — assignments retained when off, never auto-recycled | 2 (reopen test), 4 (setting comment), 9 (disabled test) |
| Isolation — pool overflow uses explicit numeric suffixes | 1, 2 (101-identity test) |
| Isolation — duplicates get new identities, replacement retains | 5 |
| Unknowns — bulk reload / rehydration metadata reconstruction | 5 (site C) |
| Unknowns — buried records | 7 (`agentNameIdentities`), 9 (observation covers merged buried metas) |
| Unknowns — assignment arriving after close or replacement | **7 (late-reply test)**, 2 (never recycles), 5 (identity carried) |
| Unknowns — disk failure / IPC failure must not fabricate or overwrite | 2 (corrupt-store test), 7 (failure test) |
| Unknowns — narrow headers and rows | 8 (`flex-shrink-0` badge, title keeps its own truncation slot) |
| Unknowns — main never parses workspace blobs for naming | 2, 3 (identities are opaque strings) |
| Unknowns — corrupt/foreign metadata must not bypass owner resolution | 6 (own-property guard), 9 (search still resolves through owners) |

### Spec coverage — every #816 acceptance bullet

| Acceptance bullet | Task |
| --- | --- |
| Default off; enabling assigns names to existing and new agents without changing titles, prompts, focus or layout | 4, 7 (claims on enable), 8 (badge is additive) |
| Disabling hides names and name lookup, retaining assignments | 8 (two tests), 9 (second test), 7 (map is not cleared) |
| Allocated once across windows | 2 (concurrency test) |
| Retained across restart | 2 (reopen test) |
| Retained across reload / provider replacement | 5 |
| Retained across restore | 5 (site C spread carries it), 7 (the reconciler claims `sessionId` for a workspace saved before this feature, once, after restoration) |
| Distinct names for genuinely new / duplicated agents | 5 (`spawn` mints nothing → reconciler mints a new identity), 2 (monotonic counter) |
| Never silently recycle a closed agent's address | 2 (reopen test third assertion) |
| Beyond the pool, explicit numeric suffixes | 1, 2 |
| Prominent readable name beside the title in structured **and native** agent headers | 8 (`PaneHeader` and `AgentTerminalLeaf` share `AgentTitleHeader`) |
| Name in the Dispatch agent list, including tiled layouts | 8 (one component serves classic, grid and tiled) |
| Shell terminals do not get names | 6 (selector), 7 (reconciler), 8 (test) |
| Operator observations/search expose the same names with documented name-to-ID lookup | 9, 10 |
| Ambiguity and unavailable-window checks preserved | 9 (test asserts two candidates and `unavailableWindows`) |
| Sending still targets stable IDs; disabling does not disable the operator server | 9 (second test), 10 (skill text) |
| Allocation isolated from MCP and from opaque workspace persistence | 3, 11 Step 2 |
| Preserve current panes / conversation | 5 (no change to spawn payloads; the continuity test asserts the existing replacement behavior still holds) |
| Verify durability, concurrency, replacement continuity, toggle visibility, real search/UI contracts | 2, 5, 8, 9, 11 |

### Placeholder scan

Every task states exact file paths, exact interfaces, and shows the literal code for both the test and the implementation. There is no "TBD", no "add validation", no "similar to Task N", and no step that only describes a change. Four places deserve a note:

- **Task 1 Step 0b shows no code because it is not a code step.** It is a hard stop that hands the vocabulary to the user for ratification. It cannot be automated away and must not be skipped; the reason it cannot wait until after Task 1 commits is stated in the step.
- Task 1 Step 2's first run is expected to pass rather than fail, because the vocabulary file already exists uncommitted from the Stage 1 sketch. The step says so explicitly rather than pretending otherwise: a green result is the evidence that the sketch's list satisfies the properties the feature assumes, and a red one means the file was lost or edited since Step 0b and must be restored. Every other task has a genuine RED.
- Task 5 Steps 4–6 are edits to three sites in one long existing function. Each step quotes enough surrounding lines to locate the site unambiguously, and Step 1's test fails on exactly those three sites if any is missed.
- Task 10 edits prose. The exact paragraphs are given verbatim; the only judgement left to the implementer is where the anchor sentence sits, which each step names.

### Type consistency across tasks

- `AgentNameRegistry.resolve(identities: readonly string[]): Promise<Record<string, string>>` is produced in Task 2 and consumed with the same signature in Task 3 (the test's fake registry matches it) and over IPC in Task 3's preload (`string[]` widens correctly into `readonly string[]`).
- `Settings.agentNamesEnabled: boolean` is produced in Task 4 and read in Tasks 6, 7, 8 and 9. No task still refers to the sketch's `settings.agentNames`; Task 4 Step 3 is the rename and it is the only definition.
- `SessionMeta.agentNameId?: string` is produced in Task 5 and consumed in Tasks 6 (`Pick<SessionMeta, 'kind' | 'agentNameId'>`), 7 and 9. Optional everywhere; no consumer asserts it.
- `WorkspaceSlice.workspaceAgentNames: Record<string, string>` is produced in Task 6 and consumed in Tasks 7 and 9. `AppStore` is `SettingsSlice & UiShellSlice & WorkspaceSlice`, so `agentNameForSession(state: AppStore, …)` compiles against both the real store and the observation's `useAppStore.getState()`.
- `resolveAgentName` takes `meta: Pick<SessionMeta, 'kind' | 'agentNameId'> | undefined`, which accepts both `state.sessions[id]` (Task 6) and a buried record's `sessionMeta` merged into the observation's `sessions` record (Task 9) without a cast.
- `agentName: z.string().nullable().default(null)` in Task 9 means the SDK type is `string | null` after parse and `string | null | undefined` on input, so the renderer's `resolveAgentName` return type (`string | null`) satisfies it, and `session.agentName ?? ''` in the main handler is total.
- `useAgentName(sessionId: SessionId): string | null` (Task 6) is the only React-facing surface; Task 8's components consume exactly that and pass `SessionId`, which both `PaneHeader` and `AgentTerminalLeaf` already hold as a prop of that type.
- `agentNameForSession` declares `state: AppStore` but reads every field optionally. That is deliberate and the two are not in conflict: the type describes the desktop store, which always has the keys, while the optional reads describe the *runtime* shapes the module is reachable from — the phone stub and keyless test mocks — which `tsc` cannot see because their alias is Vite-only. Removing the optionality would type-check and ship a crash.
- No renderer or shared module in this plan uses `Object.hasOwn`; both own-property checks (`selectors.ts`, `useAgentNameReconciler.ts`) use `Object.prototype.hasOwnProperty.call`, matching `mouseBinding.ts:142-145`. `src/main/agentNames/registry.ts` needs no own-property check at all: its map is null-prototype, so plain `!== undefined` is safe there.
- The `agent-names` settings row carries **no** `metadata` field, so `settingMetadata(setting)` resolves it to `DEFAULT_SETTING_METADATA`. Task 4's assertion is written against the resolved value, not `setting.metadata`, so it does not re-break if the row later needs an explicit block.

### Corrections applied in fix round 1

Seven defects were found in review and corrected here; four would have failed at runtime or at the type gate.

| ID | Defect | Correction |
| --- | --- | --- |
| C1 | The shared selector read `state.workspaceState.sessions[…]` eagerly, and `AgentTitleHeader` calls it before its early return — so the phone bundle (real `PaneHeader`, `{ settings }`-only stub store) would throw, invisibly to `tsc`. Two existing renderer specs mock the store the same way. | Optional reads plus a defaulted map in `agentNameForSession` (Task 6), two keyless cases in the selector unit test, and a phone-coupling render gate appended where the repository already keeps that contract (Task 8 Step 6). |
| C2 | `Object.hasOwn` in two renderer modules does not type-check under `lib: ES2020`. | `Object.prototype.hasOwnProperty.call` in both, matching the two existing precedents, plus a Global Constraint. |
| C3 | The reconciler's IO effect returned a `cancelled` cleanup while depending on `state` and `names`, so the mount-time claim immediately discarded the first in-flight reply whose identities stayed marked as requested — permanently stranding them. Task 7's own assertions could not have passed. | Cancellation is unmount-scoped; identities derive through `claimMissingIdentities(state)` so the first request is already complete; `requestedRef` clears on settle; the merge is identity-preserving so an empty reply cannot loop. The test now also asserts exactly one call and says why. |
| C4 | `apply: 'live'` is not a member of `SettingMetadata['apply']`; inherited from the sketch, so the tree was **already** type-broken and every "run typecheck" step would have failed before any new code. | Task 1 Step 0a repairs it first; Task 4 drops the explicit `metadata` entirely and asserts the resolved default. |
| I1 | The decomposition unknown "assignment arriving after close or replacement" had no test. | Task 7 gains a deferred-reply case covering both at once, asserting the name lands on the identity and does not resurrect the closed session. |
| I2 | Sites B and C minted identity with `?? oldId`, contradicting the plan's own "the reconciler is the sole minter". | Both now carry conditionally; site C's line is deleted outright (the spread already carries it) and a unit case pins the field-preservation it relies on. |
| I3 | The vocabulary's provenance was a report concern, not a step. | Task 1 Step 0b is a hard stop that prints the list for the user to ratify, with the reason it cannot wait. |

One further defect was found while verifying I3's neighbourhood and is corrected in Task 2: **`z.record()` drops a `__proto__` key** (verified against zod ^4.4.3 — `JSON.parse` keeps it, zod's output does not). Reading the assignment map out of `stateSchema.parse(...)`, as both the sketch and the first draft of this plan did, would silently forget that assignment on reopen and allocate the agent a second name — the exact recycling the registry exists to prevent, reachable from a user-editable workspace file. `load()` now validates with zod and takes its data from the raw parsed JSON, the duplicate-name check moved out of the schema's `refine` (which would have inspected the pruned map), and a reopen round-trip test was added.
