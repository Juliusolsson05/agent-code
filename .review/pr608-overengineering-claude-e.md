# PR608 overengineering (Claude E) (claude)

sessionId: ceb09d5f-785d-48d7-a77c-c67fcdca1933

---

Verified before writing: `tsc -p tsconfig.node.json` → 0, `tsc -p tsconfig.web.json` → 0, targeted `vitest --maxWorkers=4` over all new suites → 0, `npm run check:keybindings` → 0. **Everything is green.** That matters, because several findings below are broken behaviour that the new tests structurally cannot catch.

---

# Blocking — broken, not merely overengineered

### 1. The Agent Management MCP `close_agent` tool is now permanently denied
`src/main/agentManagement/AgentManagementBridge.ts:265` refuses every close unless `closeGrants.consume()` succeeds. `issueCloseGrant` (`:240`) has **zero production callers** — the only four call sites are in `AgentManagementBridge.test.ts`. There is no IPC handler, no renderer confirmation, no user action wired. Default DENY + nothing that ever grants = the tool always throws.

`revokeCloseGrantsForSession` (`:245`) has zero callers *anywhere*, including tests — so the commit message's "Grants are revoked in BOTH directions when a session goes away" describes code that never runs. `CloseGrantStore.peek` and `.size` are test-only too.

This is worse than the prose gate it replaced: the model now receives a confident *"no user authorization for this agent"* for closes the user explicitly asked for. Either wire a real issuer or revert the commit.

### 2. Phase 5's headline capability gate is on the wrong command
- `sessionCommands.ts:85` — **`view-prompts`** is gated on `getProviderFeatures(kind).switchTargets.length > 0`, carrying a comment about "the explicit switch EDGE list". View Prompts is a read-only transcript modal; the plan's own provider table gives OpenCode *"View Prompts / rendered feed actions: Yes where feed/history exists"*.
- `sessionCommands.ts:895` — **`switch-provider`** still reads `isAgentProviderKind(kind)`, the exact High-severity defect Phase 5 exists to kill. OpenCode still gets Switch Provider offered.

The comment at `:82-84` plainly belongs at `:895`. Tests stay green because `providerFeatures.test.ts` only asserts the capability table, never which command consumes it.

Related: `savedSessionListing` is declared, tested, and **read by nothing** — `resume-session` (`tabCommands.ts:51-58`) still has no `when` at all, so the Resume-on-OpenCode defect is untouched. And `duplicate-agent`'s `run` (`:821`) re-checks with `isAgentProviderKind` while its `when` uses `transcriptDuplicate`, under a comment claiming it "mirrors the `when` predicate". It does not.

### 3. `ROUTED_COMMAND_IDS` sells bindings the router will never fire
`useKeybinds.ts:181` hand-lists 24 ids. `CommandKeybindingsRow.tsx:99-111` renders a binding row for **every** catalog command with a category (~98). So a user can bind ⌘⌥R to `reload-agent`, see the chip in Settings, have `check:keybindings` reserve the chord against everything else — and press it forever with nothing happening.

That is precisely the defect class `normalize.ts:109-115` rejects `Cmd++` to prevent: *"a binding the Settings UI would happily store and display while the runtime could never match it."* The PR built the guard and then shipped the bug at a larger scale.

It also hard-codes `codex-vertical`/`codex-horizontal`, which `defaults.ts:145-153` *derives* from `AGENT_PROVIDER_KINDS`. Add a provider with a `splitShortcutKey` and you get a generated default, a Settings row, a reservation — and a dead chord.

**Fix:** delete the set. Route whatever has a matching effective binding, minus a small explicit deny-list for editor-context chords (`save-editor-file`). Derived, not enumerated.

### 4. `closeGrant.ts` is committed as a binary file
A literal NUL byte at line 55 — `` `${caller}\x00${target}` `` was written as the raw byte instead of the escape. `git diff`, `git show`, `git blame` and GitHub's diff view all refuse to render it. **The file is literally unreviewable in the PR.** Use `\x00` as an escape, or a separator that isn't a control character.

### 5. Orphaned docstring now misdocuments a live field
`app-state/settings/types.ts:344-355`. Deleting `dispatchProjectTerminal` took its closing `*/` with it, so a 12-line comment about a removed Dispatch terminal swallows `autoSendPromptSuggestion`'s `/**` and reads as that field's documentation. Compiles fine. The plan explicitly required removing the stale project-terminal comments.

---

# Speculative generality — code with no caller

### 6. `resolveInvocation.ts` (205 lines) has zero product consumers
Nothing imports it outside `resolveInvocation.test.ts` (230 lines). It drags with it four `CommandDef` fields **no command sets** — `targetKind`, `risk`, `unavailableReason` — plus the `CommandTarget` / `CommandAvailability` / `ResolvedCommandInvocation` types. Its own docstring (`:132-151`) concedes it does not do the thing it exists for. Inside it, `resolveCommandTarget`'s `'document'` case returns `{kind:'none'}` under a comment saying no consumer exists, and `targetStillValid`'s `'document'` branch is unreachable by construction.

Keeping an unused pinning authority *and* 98 commands that ignore it is the worst of the three options, because the next reader will assume targets are pinned. Delete it, or wire the palette through it — not both.

### 7. `CommandState.truth` is required and read by nobody
`types.ts:22,30`. `describeCommandState` never touches it; nothing else does either. Four product call sites author it. Delete until something actually renders persisted-vs-effective.

### 8. Dead parameters and dead exports
- `resolve.ts:96-107` — `contextForCommand`, with a long docstring about a TDZ cycle. **No caller passes it.** The one place it would matter, `CommandKeybindingsRow.tsx:181`, hardcodes `context: 'global'` — the exact case the docstring argues against.
- `resolve.ts:178` — `setCommandKeybindings`'s `defaults` param is unused in the body; all four call sites pass it.
- `closeConfirmation.ts:103` `grantStillMatches` — test-only (`narrowGrantToCurrent` is the one in use).
- `resolve.ts:146` `effectiveBindingsFor` — test-only.
- `featureCapabilities.ts:59` `NO_PROVIDER_FEATURES` — exported "so a caller can compare against it"; no caller does.
- `closeConfirmation.ts:175` `isSessionLiveForClose` is a one-line wrapper around the private `isLive` in the same file. Just export `isLive`.
- `CommandKeybindingsRow.tsx:76` — `syntaxError` is only ever set to `null`. The error banner at `:275-277` can never render.
- `commandState.ts:126` — `label: openClosed ? 'Mixed' : 'Mixed'`.

### 9. `CloseConfirmationRequest.reason` is unread, wrong, and misused
The dialog branches only on `'running'` (`CloseConfirmationDialog.tsx:50`); `'cascade'` vs `'bulk'` is never read. The discriminator at `closeConfirmation.ts:81` keys on **liveness**, not on cascade-ness, so the value is wrong anyway — and its `targets.length > 1` clause is always true, since the single-target case returned above. Then `pane.ts:1773` passes `reason: 'running'` for the Kill Buried confirmation, so killing an **idle** buried session shows *"Close a working agent?"*. Collapse to `'running' | 'multi'` and let `summary` carry the copy.

### 10. `CloseConfirmationSurface.tsx` — 8 lines whose body is `<CloseConfirmationDialog />`
Register the dialog in `modalSurfaces` directly. This is the `ui/README.md` guardrail verbatim: *"No wrapper around a wrapper."*

---

# Guards that cannot fire

| Location | Why it can't fire |
|---|---|
| `check-command-keybindings.mts:149-153` (check 8) | `contextsOverlap(a, a)` returns `true` at `defaults.ts:49` before reaching the matrix. Dead check. |
| `check-command-keybindings.mts:115` | `approved.reason.trim().length < 40` — a magic prose-length threshold in CI, validating a literal against itself. This is the CI grep-lock the house style forbids. Same for `owners.length < 2`. |
| `check-command-keybindings.mts:135-144` + `keybindingBaseline.test.ts:318-320` | `'shortcut' in command` — TypeScript already rejects `shortcut:` on a `CommandDef` literal. Two runtime copies of a compile-time guarantee. |
| `catalog.ts:146-147` | `VALID_SURFACES`/`VALID_TIERS` duplicate the TS unions. Justified by "a future extension-contributed command" — which the plan puts explicitly out of scope. |
| `taxonomy.test.ts:43-57` | The `known` category Set restates `CommandCategory`; the filter can never be non-empty. |
| `registry.ts:70-73` | `assertNever` returning `false` "for a value that reached us across a boundary TypeScript could not check (a persisted blob, a generated command)" — `surface` is only ever an in-repo literal. The exhaustive switch is right; keep it, but drop the fictional boundary from the comment. |

Also: `registry.ts:167-169` throws on an empty description *inside a render path* — the exact failure `catalog.ts:98-102` says it moved to a test. Now both exist; drop the throw (opportunistic cleanup, in blast radius).

Not flagging: the `visited` set in `expandSessionCloseTargets` (`:218`). A cycle is impossible given `linkedParentId` is set to an existing parent at creation, but it's two lines of standard BFS hygiene and reads as intentional. Fine.

---

# Unscalable lists — which are unavoidable, which aren't

**Genuinely unavoidable, keep as-is:**
- `RETIRED_BUILT_IN_COMMAND_IDS` / `RETIRED_SETTINGS_KEYS` (`persistence.ts:227,255`) — cannot be derived from absence; the reasoning about downgrades and uninstalled extensions is correct.
- `RESERVED_INTERACTIONS` (`reservations.ts:39`) — these live in Electron's role table, Monaco, and hand-written handlers. Nothing can derive them. It is also the highest-rot-risk list in the PR, and its own docstring says so.
- `APPROVED_OVERLAPS` — keyed by owner *pair*, deliberately awkward to extend. Correct design.
- `NATIVE_MENU_COMMAND_IDS` — a cross-process contract, with `catalog.test.ts` asserting the subset relation. Correct.
- The ordered 98-ID catalog snapshot — registration order is user-visible.

**Should be derived:**
- `ROUTED_COMMAND_IDS` — see #3.
- `VALID_SURFACES` / `VALID_TIERS` / taxonomy's `known` — the type system already holds them.
- `CommandKeybindingsRow.tsx:38-58` — `CATEGORY_LABELS` is an exhaustive `Record`, but `CATEGORY_ORDER: CommandCategory[]` is not. Add a category and it silently vanishes from Settings. Derive the order from `Object.keys(CATEGORY_LABELS)`, or make it a fixed-length tuple.
- `CommandDef.category` is still optional, with `taxonomy.test.ts:37-41` enforcing totality at runtime. All 98 declare it by the end of the branch — the "independently revertable commits" argument doesn't survive a branch that merges as one unit. Make it required, delete the test.

**Module-level mutable state — both defensible, both worth a note:**
- `executeCommand.ts:114` `inFlight` — the palette-vs-menu argument is right. But it is keyed on command id only, so with target pinning unfinished (#6) it cannot tell "reload agent A" from "reload agent B". Don't let anyone read it as a safety property.
- `closeConfirmationBroker.ts:27-29` — the "a promise can't live in zustand" reasoning is sound. The single global resolver auto-declines a first request when a second arrives (`:58`); better than hanging, but it silently discards a user intent. Worth a toast.

---

# Tests that raise a count

**11. `keybindingBaseline.test.ts` (390 lines).** The `describe('recorded authority drift (pre-migration history)')` block (`:339-390`) tests the file's own `BINDING_BASELINE` literal **against itself** — `underReported`, `gaps`, `editorOwned`, `undisclosed` all filter a const declared 280 lines above and assert the result. No product code is exercised. They can only fail if someone edits the table, in which case they fail for no reason. (`:340`'s comment says "exactly the six commands" and asserts five — nobody re-read it.) The file's original load-bearing assertion compared the table to `CommandDef.shortcut`, which this PR deleted; `:281-292` admits the assertion was "inverted".

Genuinely valuable: `:280-311` (historical chords survive in the effective set) and `:313-321`. Keep those ~40 lines; delete the 200-line table and the history block.

**12. `providerFeatures.test.ts`** — 6 tests, 3 redundant. "leaves OpenCode unavailable for every unsupported operation" is a strict subset of "matches the plan table exactly". "requires every agent provider to declare all five capabilities" restates `Record<AgentProviderKind, ProviderFeatureCapabilities>`, which already fails compilation — and its comment points at the wrong enforcement site.

**13. Volume.** 16 new test files, ~3,300 lines, in a feature PR. At minimum the suites covering deleted-or-unused code (`resolveInvocation.test.ts`, most of `keybindingBaseline.test.ts`) should leave with it.

---

# Performance

**14. `useKeybinds.ts:216-227`** — every keydown reaching the router calls `buildDefaultKeybindings()` (rebuilds the array, walks `AGENT_PROVIDER_KINDS`, hits `getRendererProviderCapabilities`, normalizes ~30 strings) plus `resolveEffectiveKeybindings` (builds a Map), then linear-scans. Per keystroke, capture phase, globally. Hoist into a `useMemo` on `commandKeybindingOverrides` and use a `Map<Keybinding, commandId>`.

**15. `uiShell/slice.ts:60-65`** — `requestCommandInvocation` sets `commandPaletteOpen: true` for **every** routed chord. It inherits the native-menu justification ("a menu click is rare and intentional"), but ⌥H/⌥J/⌥K/⌥L pane focus is among the most-repeated gestures in the app, and each press now mounts `OpenCommandPalette`, assembles ~76 workspace actions, builds the full registry, runs the command, unmounts. Issue #494 existed specifically to stop paying that cost while the palette is closed. Measure before merge; at minimum navigation and split chords should bypass the palette.

---

# What is good, and should not be touched

The catalog/registry split (`catalog.ts`) earns its keep — four real consumers, and it structurally fixes the native-menu defect. `pickerVisibility.ts` is shared by palette and Settings and found a genuine duplicate-rule bug in the process. `normalize.ts`'s physical-code reasoning is correct and load-bearing on macOS, and the Numpad exclusion is a real case, not a hypothetical. The `executeCommand.ts` gateway has four consumers and fixes a real defect. `commandState.ts` is consumed by the palette badge. `closeConfirmation.ts`'s policy and expansion are consumed by `pane.ts`, `tab.ts`, and `CloseOldAgentsModal`. The retired-keys persistence policy and the derivation of provider split chords from the provider registry (`defaults.ts:145-153`) are exactly right.

---

# Should anything be DELETED before merge?

**Yes — four things.**

1. **`resolveInvocation.ts` + `resolveInvocation.test.ts` + the four unused `CommandDef` fields** (`targetKind`, `risk`, `unavailableReason`) and the `CommandTarget`/`CommandAvailability`/`ResolvedCommandInvocation` types. 435 lines with no product consumer, whose own docstring says it doesn't do its job. It reads as a completed safety guarantee and is not one.

2. **`ROUTED_COMMAND_IDS`** (`useKeybinds.ts:181`). Not deferred — deleted and replaced with derivation. Leaving it means shipping a Settings editor that assigns chords which cannot fire, in the PR whose stated purpose is making displayed and running bindings the same fact.

3. **The `BINDING_BASELINE` table and the `recorded authority drift` block** in `keybindingBaseline.test.ts` (~250 of 390 lines). Keep the two assertions that touch product code.

4. **`check-command-keybindings.mts` checks 6, 7, and 8** (`:110-153`). One can never fire, one is a prose-length grep lock, one duplicates a compiler guarantee.

**And one decision, not a deletion:** the close-grant commit (`55e57322`). As shipped it disables `close_agent` outright. Either land the grant issuer in this PR or revert the commit — do not merge the enforcement half alone.
