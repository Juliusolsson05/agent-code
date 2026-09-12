# Remove Cybersecurity Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-only command that forks the focused session into a new native rollout with the last model step (and the `cyber_policy` tail) removed, so the pane can keep chatting without Rewind-to-Prompt deleting the whole assistant turn.

**Architecture:** Reuse the rewind/duplicate transaction: read via `HostTranscriptAdapter`, slice a `ConversationDocument`, `projectNativeResume`, write a new file, `replaceSession`. The new logic is a pure Codex cut (`stripLastCodexCyberPolicyStep`) plus a thin orchestrator. The source rollout is never edited.

**Tech Stack:** TypeScript, Electron main/preload/renderer, Vitest `unit` + `renderer`, existing `agent-transcript-parser` Codex decode/project path.

**Spec:** Issue #848. Cut rule taken from rollout `01a08846-936d-7dd3-a91b-0f933d0d9f29`: last durable signal is `event_msg.task_complete.error.codex_error_info === "cyber_policy"`; last model step is the trailing reasoning + last tool-call/result batch after the previous tool-result.

## Global Constraints

- Node 24 (`.nvmrc`). Do not run renderer tests on Node 25.
- Conventional Commits. Issue #848 is `Fixes #848` on the PR, `Refs #848` on commits.
- Thick WHY comments. No new design doc; the cut rule lives next to the function.
- Do not edit the source Codex rollout. Do not change `packages/agent-transcript-parser`.
- Command title: `Remove Cybersecurity Block`. Surface: `session`. `pickerVisibility: 'advanced'`.
- Do not merge without explicit user confirmation.
- Worktree: `.worktrees/remove-cybersecurity-block` on `feat/remove-cybersecurity-block`.

## File map

- Create: `src/main/providerSwitch/codexCyberPolicy.ts` — detect + last-model-step cut
- Create: `src/main/providerSwitch/codexCyberPolicy.test.ts` — cut tests from the observed shape
- Create: `src/main/providerSwitch/stripCodexCyberPolicy.ts` — read/project/write orchestrator
- Create: `src/main/providerSwitch/stripCodexCyberPolicy.test.ts` — adapter integration like rewind
- Modify: `src/main/ipc/provider.ts` — `session:strip-codex-cyber-policy`
- Modify: `src/preload/api/provider.ts` — `stripCodexCyberPolicy`
- Modify: `src/renderer/src/workspace/hook/actions/provider.ts` — replaceSession + rewind-undo record
- Modify: `src/renderer/src/workspace/hook/index.ts` — expose the action
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.ts` — command
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts`
- Modify: `src/renderer/src/features/command-palette/catalog.test.ts`
- Modify: `src/renderer/src/features/command-palette/taxonomy.test.ts`

---

### Task 1: Pure last-model-step cut

**Files:**
- Create: `src/main/providerSwitch/codexCyberPolicy.ts`
- Test: `src/main/providerSwitch/codexCyberPolicy.test.ts`

**Interfaces:**
- Consumes: `ConversationDocument` / `ConversationEntry` from `agent-transcript-parser`
- Produces:
  - `conversationHasCodexCyberPolicyBlock(conversation): boolean`
  - `stripLastCodexCyberPolicyStep(conversation): ConversationDocument`
  - throws if provider is not `codex`, if the last `task_complete` is not `cyber_policy`, or if the cut would leave no projectable entries

- [ ] **Step 1: Write the failing tests** from the observed rollout shape (user + assistant + completed tool step + last reasoning/tool step + cyber `task_complete`). Assert the last tool-result of the earlier step remains and the last reasoning/tool cluster plus cyber event are gone. Also: assistant+tools in one generation are one step; assistant-only last step drops that assistant text; no-block throws; Claude document throws.

- [ ] **Step 2: Run tests, confirm they fail** because the module does not exist.

- [ ] **Step 3: Implement the cut.** Detection: last opaque `event_msg` whose payload `type` is `task_complete` must have `error.codex_error_info === 'cyber_policy'`. Walk semantic entries backward, skipping opaques. Collect the last model step: trailing tool-results, their matching tool-calls, then immediately preceding reasoning/assistant until a previous-step tool-result or user/developer message. Slice `[0, cutStart)`.

- [ ] **Step 4: Tests pass.**

- [ ] **Step 5: Commit** `feat(codex): strip last model step after a cyber policy block`

---

### Task 2: Orchestrator + IPC + preload

**Files:**
- Create: `src/main/providerSwitch/stripCodexCyberPolicy.ts`
- Test: `src/main/providerSwitch/stripCodexCyberPolicy.test.ts`
- Modify: `src/main/ipc/provider.ts`
- Modify: `src/preload/api/provider.ts`

**Interfaces:**
- Consumes: `getHostTranscriptAdapter`, `stripLastCodexCyberPolicyStep`
- Produces: `stripCodexCyberPolicy({ sourceProviderSessionId, cwd }) => { provider: 'codex', newProviderSessionId, newFilePath }`

- [ ] **Step 1: Failing adapter test** matching `rewindSession.test.ts`: mocks `read` / `projectNativeResume` / `write`; asserts the projected conversation is the stripped prefix; rejects Claude; does not write when projection fails; rejects when no cyber block.

- [ ] **Step 2: Implement orchestrator** (Codex-only, randomUUID target, write only after projection). Wire IPC `session:strip-codex-cyber-policy` and preload `stripCodexCyberPolicy`.

- [ ] **Step 3: Tests pass.**

- [ ] **Step 4: Commit** `feat(codex): fork a session with the cyber policy tail removed`

---

### Task 3: Command + pane replacement

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/provider.ts`
- Modify: `src/renderer/src/workspace/hook/index.ts`
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.ts`
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts`
- Modify: `src/renderer/src/features/command-palette/catalog.test.ts` (insert `remove-cybersecurity-block` immediately after `rewind-to-prompt`; sessionCommands count 29 → 30)
- Modify: `src/renderer/src/features/command-palette/taxonomy.test.ts` (advanced list)

**Interfaces:**
- Consumes: `window.api.stripCodexCyberPolicy`, `sessionActions.replaceSession`
- Produces: `removeFocusedCyberPolicyBlock()` / command id `remove-cybersecurity-block`

- [ ] **Step 1: Renderer tests** — command visible only for idle-capable Codex with `providerSessionId`; `run` calls IPC then `replaceSession` on the focused pane (not a split); Claude `when` is false; programmatic run on Claude does not call IPC.

- [ ] **Step 2: Implement action + command.** Idle guard identical to rewind. Keep the current composer draft. Record `pendingRewindUndo` so **Undo Rewind** restores the original provider session. Toast on success/failure. `when`: `kind === 'codex' && transcriptRewind && providerRuntime !== 'terminal' && providerSessionId`.

- [ ] **Step 3: Tests pass** (`sessionCommands.renderer.test.ts`, `catalog.test.ts`, `taxonomy.test.ts`).

- [ ] **Step 4: Commit** `feat(codex): add Remove Cybersecurity Block command`

---

### Task 4: Verify and open PR

- [ ] Run `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch/codexCyberPolicy.test.ts src/main/providerSwitch/stripCodexCyberPolicy.test.ts`
- [ ] Run `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/workspace/commands/sessionCommands.renderer.test.ts src/renderer/src/features/command-palette/catalog.test.ts src/renderer/src/features/command-palette/taxonomy.test.ts`
- [ ] Run `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`
- [ ] Open PR titled `feat(codex): add Remove Cybersecurity Block command` with `Fixes #848`. Do not merge.
