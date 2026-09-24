# Skills official install: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the invented skill count caps. Install skills from the command people actually paste (`npx skills add owner/repo --skill x`), discovering them the way `npx skills` does. Put every managed and external skill on one Settings → Skills page with a column per provider, and let agents propose skills for the user to review.

**Spec:** `docs/superpowers/specs/2026-09-23-skills-official-install-design.md`. Read Evidence and Decisions D1–D10 first; D2 lists the corrections to the approved mockup.

**Issue:** #1161. **Status:** user-approved 2026-09-23 ("build all of this out using the agent code conventions").

**Working tree:** `.worktrees/skills-official-install`, branch `feat/skills-official-install`, based on `origin/main` `489fbb81`. Submodules are initialized and `node_modules` is symlinked. Use Node 24.

**Conventions:**
- Write thick WHY comments at every decision site.
- Use Conventional Commits with scope `skills`.
- Verify with `npx tsc -b` and targeted vitest runs once at the end.
- Never launch the app.
- Every rule in the managed-skills Warning still holds: no recursive deletion, no renderer paths, no provider symlinks, no provider-name branches in the service.

---

### Task 1: Remove count caps and add snapshot cleanup (D3, D4)
- [ ] Delete `AGENT_CODE_INSTALLED_SKILL_MAX_COUNT` and `AGENT_CODE_CUSTOM_SKILL_MAX_COUNT` and their checks, including the `persistence.ts` load reject.
- [ ] Delete the snapshot-root byte and entry constants. Raise `MAX_STAGED_DISCOVERIES` to 512.
- [ ] Remove the IPC `candidateIds` and `abandonTargets` count caps.
- [ ] `InstalledSkillPackageStore`:
  - delete `rootUsage` and the admission stop;
  - `removeIfUnreferenced` runs quarantine → recompute manifest → digest proof → verified unlink → `rmdir` deepest-first;
  - add `sweepUnreferenced(referenced)`, which covers 64-hex children and `.trash-<digest>-*` children.
- [ ] The service's `referencedSnapshotDigests()` includes records, materializations and pending previous/desired digests. Initialize sweeps under the lock, best effort, skipped in recovery.
- [ ] Tests:
  - more than 25 installed skills load without recovery;
  - removing a snapshot deletes it;
  - a tampered snapshot is left in place;
  - the sweep keeps referenced snapshots;
  - `.staging-*` is untouched.

### Task 2: Shared install-source parser (D5)
- [ ] `src/shared/skills/installSource.ts`: `tokenizeInstallCommand`, `parseSkillInstallInput` and the agent-name map.
- [ ] Tests: every documented form from the spec, pasted README lines, `--skill=a,b`, `'*'`, `--all`, unknown flags, unsupported hosts, skills.sh URLs, `@skill` and `#ref`.

### Task 3: npx-compatible discovery and lazy acquisition (D6)
- [ ] `githubSkillSource.ts`:
  - `discover(parsedSource, options)` resolves the ref and sub path, reads the tree, and selects candidate roots with the npx algorithm (root short-circuit, containers at depth 3, top-level `.<x>/skills`, marketplace paths, fallback at depth 5);
  - the per-candidate tree validation stays as today;
  - it downloads `SKILL.md` only;
  - duplicate names become notices;
  - internal skills are hidden;
  - the folder-name rule is dropped;
  - it returns `missingSkills`.
- [ ] `acquire(staged)` fetches every file with blob-ID verification and returns `StagedInstalledSkillCandidate`.
- [ ] Type changes:
  - the review candidate's files become `{ path, bytes, executable }`;
  - add `internal` and `missingSkills`;
  - add `selection`.
- [ ] Service:
  - `discoverSkills(input)` parses in main;
  - install and update acquire outside the lock;
  - `checkInstalledSkillForUpdates` acquires the one candidate to diff, then drops the bytes;
  - apply acquires again (same blob IDs).
- [ ] Update `githubSkillSource.test.ts` for the new rules, and add fixture repos that mirror anthropics/skills and vercel-labs/agent-skills layouts.

### Task 4: Per-provider choices (D7)
- [ ] Add `providers?` on both record types, with validator checks when present.
- [ ] `installedTargets` and `customTargets` filter by provider overlap.
- [ ] Add `setInstalledSkillProviders` and `setCustomSkillProviders` (disable → set → enable under the lock), plus the install request's `providers`.
- [ ] Add IPC and preload for both.
- [ ] Tests: a Codex-only skill writes only `~/.agents/skills`; switching to Claude moves it; a conflict aborts the switch.

### Task 5: Also found and lock-file provenance (D8)
- [ ] `src/main/agentSkills/skillLock.ts`: a bounded, read-only v3 parser.
- [ ] The service exposes the current personal roots through a `getPersonalSkillRoots()` projection.
- [ ] Add the `agent-code-skills:external` and `:reveal-external` IPC.
- [ ] Tests: unmanaged versus managed, symlinked `npx` installs, and lock provenance.

### Task 6: Agent `skills` MCP domain (D10)
- [ ] Record `pendingReview?`. Install with `enabled: false`. The user's enable clears it.
- [ ] `src/mcp/runtime/skillsTools.ts` provides `skills_list`, `skills_find`, `skills_add` and `skills_remove` (pending only), plus instructions.
- [ ] Wire the domain the way `mcp_servers` is wired: domain lists, launch, parent-held-only, the built-in servers grid row, the control reference, and the toast.
- [ ] Tests: the tools never enable anything, and removing a skill the user reviewed is refused.

### Task 7: Settings → Skills, Add dialog, commands (D9)
- [ ] Add the `skills` category. Move the conventions and custom rows. Retire the installed row.
- [ ] `features/skills/`:
  - `store.ts` for the snapshot and update statuses;
  - `ui/SkillsGrid.tsx`;
  - `ui/AddSkillDialog.tsx`;
  - `ui/review/*`, moved from the installed row;
  - `surfaces/`;
  - `commands/skillsCommands.ts`.
- [ ] Hidden external skills are stored in settings.
- [ ] Update the catalog test counts and the settings registry tests.
- [ ] Renderer tests: pasting a command preselects skills and providers, a provider toggle calls the IPC, and hiding an external skill works.

### Task 8: Docs and verification
- [ ] `docs/design/agent-code-conventions.md`: update the snapshot retention paragraph, the GitHub-installed packages section (sources, discovery, lazy acquisition), the provider selection, Also found, and the agent domain.
- [ ] README feature line.
- [ ] Run `npx tsc -b` and targeted vitest, then the full suite once.
- [ ] Open the PR with `Fixes #1161`. Run the review round.
