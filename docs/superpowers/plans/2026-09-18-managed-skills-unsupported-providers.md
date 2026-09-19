# Managed Skills: Unsupported Providers Must Not Block Spawns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a registered provider that declares `personalAgentSkills.supported === false` (grok, PR #844) from blocking every session spawn and every managed-skill operation; unsupported providers become informational.

**Architecture:** The managed-skills layer (`AgentCodeConventionsService`) treats `unsupportedProviders.length > 0` as a hard stop across three skill fleets (personal conventions, custom/product skills incl. TLDR+Goal, installed skills). The invariant "all registered providers support personal skills" broke. Fix: deployment and health consider only supported targets (`this.targets.targets`); unsupported providers surface as per-target `state: 'unsupported'` rows plus the existing snapshot field. `health === 'unsupported'` and mutation `code: 'unsupported'` survive only for the degenerate zero-supported-targets case.

**Tech Stack:** TypeScript, vitest (unit + system projects), Electron IPC unchanged (shared contract types unchanged).

Fixes #1014.

---

## Why each change is shaped this way

- **Why not give grok `supported: true` with a guessed skills folder:** `registry.main.ts` refuses to invent a native Grok skill layout (unrecorded). The managed-skills layer must tolerate an unsupported provider instead.
- **Why keep a degenerate zero-targets failure:** enabling a skill with zero deployable targets would be a silent no-op write. The existing UI contract (banner, disabled buttons, `code: 'unsupported'` message) stays meaningful for that case, so the shared result-type union is untouched.
- **Why append `unsupported` rows into the target lists:** Settings already renders per-target state rows (labels exist for `unsupported`), and health computations must skip them (`state !== 'unsupported'` filter). This replaces "replace all rows with unsupported" with "show real rows + informational rows".
- **Why `applyInstalledOperationsLocked` is the append funnel for installed skills:** every enabled-skill status rebuild flows through it (reconcile, enable, update), so one append covers all paths.

## Files

- Modify: `src/main/agentCodeConventions/AgentCodeConventionsService.ts` (gates, reconcilers, health fns)
- Modify: `src/main/agentCodeConventions/targets.test.ts` (real-registry contract now includes grok)
- Modify: `src/main/agentCodeConventions/AgentCodeConventionsService.system.test.ts` (rewrite blocked-enable test)
- Modify: `src/main/agentCodeConventions/AgentCodeCustomSkillsService.system.test.ts` (TLDR regression tests)
- Modify: `src/main/agentCodeConventions/AgentCodeInstalledSkillsService.system.test.ts` (installed regression test)
- Modify: `src/renderer/src/features/settings/ui/AgentCodeConventionsRow.tsx` (informational banner)

---

### Task 1: Conventions fleet — enable + reconcile + health

**Files:**
- Modify: `src/main/agentCodeConventions/AgentCodeConventionsService.ts` (save gate ~1145, reconcileEnabledLocked ~2030, health ~3049)
- Test: `src/main/agentCodeConventions/AgentCodeConventionsService.system.test.ts`

- [x] **Step 1: Rewrite the failing tests** — replace the test at line 428 ("blocks an all-provider enable when a registered provider is unsupported") with:

```ts
  it('deploys to supported providers when a registered provider is unsupported', async () => {
    const root = await temporaryDirectory()
    const currentTarget = target(
      'agents-standard-personal-skills',
      join(root, '.agents', 'skills'),
      ['codex'],
    )
    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({
        targets: [currentTarget],
        unsupportedProviders: ['opencode'],
      }),
    })
    await service.initialize()

    const result = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })

    expect(result).toMatchObject({ ok: true, snapshot: { enabled: true, health: 'active' } })
    expect((await stat(currentTarget.skillFile)).isFile()).toBe(true)
    expect(result.ok && result.snapshot.unsupportedProviders).toEqual(['opencode'])
    expect(result.ok && result.snapshot.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unsupported:opencode', state: 'unsupported' }),
    ]))
  })

  it('still blocks enable when no registered provider supports personal skills', async () => {
    const root = await temporaryDirectory()
    const service = new AgentCodeConventionsService({
      stateFilePath: join(root, 'state', 'conventions.json'),
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [], unsupportedProviders: ['grok'] }),
    })
    await service.initialize()

    const result = await service.save({ expectedRevision: 0, enabled: true, markdown: '# Rules' })

    expect(result).toMatchObject({
      ok: false,
      code: 'unsupported',
      snapshot: { enabled: false, health: 'unsupported' },
    })
  })
```

- [x] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run src/main/agentCodeConventions/AgentCodeConventionsService.system.test.ts --project unit`
Expected: first new test FAILS (`ok: false, code: 'unsupported'`); second PASSES (degenerate case still blocks via existing gate).

- [x] **Step 3: Implement** — in `AgentCodeConventionsService.ts`:

1. `save()` gate (~1145) — condition swap, keep the row replacement (with zero real targets the unsupported rows are the whole display):

```ts
      // Degenerate-only gate (#1014): an unsupported provider is informational —
      // skills deploy to the supported targets — but enabling with ZERO supported
      // targets would be a silent no-op write, so refuse it with the contract
      // the Settings UI already renders.
      if (request.enabled && this.targets.targets.length === 0) {
        this.targetStatuses = this.unsupportedStatuses()
        return { ok: false, code: 'unsupported', snapshot: this.snapshot() }
      }
```

2. `reconcileEnabledLocked()` (~2030) — delete the early return; append rows before the final assignment (~2126):

```ts
    // WHY appended, not replacing (#1014): unsupported providers are informational
    // per-target rows; real deployment rows must survive so health stays truthful.
    statuses.push(...this.unsupportedStatuses())
    this.targetStatuses = statuses
```

3. `health()` (~3049) — replace the body:

```ts
  private health(): AgentCodeConventionsSnapshot['health'] {
    if (this.recovery) return 'recovery-required'
    // 'unsupported' rows are informational (#1014): health is computed over the
    // deployable rows only. Degenerate zero-supported-target case keeps the
    // 'unsupported' state so Settings can still refuse a no-op enable.
    if (this.document.enabled && this.targets.targets.length === 0) return 'unsupported'
    const deployable = this.targetStatuses.filter(status => status.state !== 'unsupported')
    if (deployable.some(status => status.state === 'conflict' || status.state === 'retired')) {
      return 'conflict'
    }
    if (deployable.some(status => status.state === 'error' || status.state === 'missing')) {
      return 'degraded'
    }
    if (this.document.enabled) {
      return deployable.length > 0
        && deployable.every(status => status.state === 'installed')
        ? 'active'
        : 'degraded'
    }
    return 'disabled'
  }
```

- [x] **Step 4: Run tests to verify pass** (same command as Step 2; whole conventions service system test file must pass)

- [x] **Step 5: Commit** — `git add -A && git commit -m "fix(managed-skills): deploy conventions to supported providers when one is unsupported - Refs #1014"`

### Task 2: Custom + product skills (TLDR/Goal) — the spawn-blocking path

**Files:**
- Modify: `src/main/agentCodeConventions/AgentCodeConventionsService.ts` (prepareCustomMutation ~1807, reconcileCustomEnabledLocked ~2159, customHealth ~3031)
- Test: `src/main/agentCodeConventions/AgentCodeCustomSkillsService.system.test.ts`

- [x] **Step 1: Write the failing regression tests** — extend the harness call sites with an unsupported-provider variant (the harness builder at line 45 constructs `resolved`; add an options param):

```ts
async function harness(options: { unsupportedProviders?: AgentProviderKind[] } = {}) {
  const root = await temporaryDirectory()
  const targets = [
    target('agents-standard', join(root, '.agents', 'skills')),
    target('claude-personal', join(root, '.claude', 'skills')),
  ]
  const resolved: ResolvedAgentCodeConventionsTargets = {
    targets,
    unsupportedProviders: options.unsupportedProviders ?? [],
  }
  // ...rest unchanged
```

Add tests (import `AgentProviderKind` type from `@shared/types/providerKind.js`):

```ts
  // Regression for #1014: grok (registered, personalAgentSkills.supported:false)
  // must not stop the TLDR product skill from deploying — pre-spawn reconcile
  // throws when ensureTldrSkill() cannot reach health 'active', which killed
  // EVERY session spawn, claude/codex/opencode included.
  it('keeps TLDR deployable and active while a provider is unsupported', async () => {
    const { root, targets, service } = await harness({ unsupportedProviders: ['grok'] })
    await expect(service.ensureTldrSkill()).resolves.toBeUndefined()
    for (const targetValue of targets) {
      expect((await stat(customPath(targetValue, 'TLDR'))).isFile()).toBe(true)
    }
    const snapshot = await service.customSkillsSnapshot()
    const tldr = snapshot.skills.find(skill => skill.name === 'TLDR')
    expect(tldr?.health).toBe('active')
    expect(tldr?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unsupported:grok', state: 'unsupported' }),
    ]))
    expect(snapshot.unsupportedProviders).toEqual(['grok'])
  })

  it('survives a restart-reconcile with an unsupported provider and stays spawnable', async () => {
    const first = await harness({ unsupportedProviders: ['grok'] })
    await first.service.ensureTldrSkill()
    const stateFilePath = first.stateFilePath
    const root = first.root
    // Restart against the same state: initialize() runs the startup reconcile
    // that previously replaced TLDR's rows with unsupported rows.
    let sequence = 100
    const restarted = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({
        targets: [
          target('agents-standard', join(root, '.agents', 'skills')),
          target('claude-personal', join(root, '.claude', 'skills')),
        ],
        unsupportedProviders: ['grok'],
      }),
      operationId: () => `restart-${++sequence}`,
    })
    await restarted.initialize()
    await expect(restarted.ensureTldrSkill()).resolves.toBeUndefined()
  })

  it('still refuses TLDR when no provider supports personal skills', async () => {
    const root = await temporaryDirectory()
    const stateFilePath = join(root, 'state', 'conventions.json')
    let sequence = 0
    const service = new AgentCodeConventionsService({
      stateFilePath,
      homeDirectory: root,
      resolveTargets: async () => ({ targets: [], unsupportedProviders: ['grok'] }),
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      operationId: () => `id-${++sequence}`,
    })
    await service.initialize()
    await expect(service.ensureTldrSkill()).rejects.toThrow(
      'TLDR skill is unavailable or conflicts with an existing file. Review managed skill health in Settings.',
    )
  })
```

Note: verify the exact snapshot accessor name (`customSkillsSnapshot` vs other) against the service's public API before running; adjust to the real method that returns `AgentCodeCustomSkillsSnapshot`. Also confirm the TLDR product skill's `name` constant by reading `PRODUCT_SKILLS` in `AgentCodeConventionsService.ts` (top of file) — assert on `productSkillById`-visible name.

- [x] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run src/main/agentCodeConventions/AgentCodeCustomSkillsService.system.test.ts --project unit`
Expected: first two FAIL (ensureTldrSkill rejects / health 'unsupported'), third PASSES.

- [x] **Step 3: Implement** — in `AgentCodeConventionsService.ts`:

1. `prepareCustomMutation()` gate (~1807) — condition swap:

```ts
    if (enabled && this.targets.targets.length === 0) {
      return {
        ok: false,
        result: { ok: false, code: 'unsupported', snapshot: this.customSnapshot() },
      }
    }
```

2. `reconcileCustomEnabledLocked()` (~2159) — delete the early return; at the normalized-error exit (~2165) and the final set (~2263), append:

```ts
      this.customTargetStatuses.set(
        skill.id,
        [...targets.targets.map(target => this.customStatus(target, 'error', normalized.message)),
          ...this.customUnsupportedStatuses()],
      )
```

```ts
    // Informational rows for providers that cannot receive skills (#1014);
    // deployment rows above remain the health input.
    statuses.push(...this.customUnsupportedStatuses())
    this.customTargetStatuses.set(skill.id, statuses)
```

3. `customHealth()` (~3031) — replace body:

```ts
  private customHealth(
    skill: AgentCodeCustomSkillRecord,
    targets: AgentCodeConventionsTargetStatus[],
  ): AgentCodeCustomSkill['health'] {
    if (this.recovery) return 'recovery-required'
    if (skill.enabled && this.targets.targets.length === 0) return 'unsupported'
    const deployable = targets.filter(status => status.state !== 'unsupported')
    if (deployable.some(status => status.state === 'conflict' || status.state === 'retired')) {
      return 'conflict'
    }
    if (deployable.some(status => status.state === 'error' || status.state === 'missing')) {
      return 'degraded'
    }
    if (!skill.enabled) return 'disabled'
    return deployable.length > 0 && deployable.every(status => status.state === 'installed')
      ? 'active'
      : 'degraded'
  }
```

- [x] **Step 4: Run tests** (same file + Task 1 file; both must pass)

- [x] **Step 5: Commit** — `git commit -m "fix(managed-skills): unsupported providers no longer block TLDR/Goal product skills - Refs #1014"`

### Task 3: Installed skills fleet

**Files:**
- Modify: `src/main/agentCodeConventions/AgentCodeConventionsService.ts` (installed gate ~1400, reconcileInstalledSkillLocked ~1518, applyInstalledOperationsLocked ~1645, installedHealth ~1708)
- Test: `src/main/agentCodeConventions/AgentCodeInstalledSkillsService.system.test.ts`

- [x] **Step 1: Write the failing test** — harness takes `resolveTargets` via `resolved` (line ~92); thread an options param like Task 2, then:

```ts
  it('installs and reports active with an unsupported provider present', async () => {
    const { service } = await harness({ unsupportedProviders: ['grok'] })
    const staged = stagedPackage({ commit: 'c1', files: [{ path: 'SKILL.md', content: '# Review' }] })
    const install = await service.installDiscoveredSkill(staged)
    expect(install).toMatchObject({ ok: true })
    const snapshot = await service.installedSkillsSnapshot()
    const skill = snapshot.skills.find(item => item.name === 'review-code')
    expect(skill?.health).toBe('active')
    expect(skill?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unsupported:grok', state: 'unsupported' }),
    ]))
  })
```

Note: verify the real install API + snapshot accessor names against the service (`installDiscoveredSkill` / installed snapshot method) and the harness return shape before running; adjust names to the actual API.

- [x] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run src/main/agentCodeConventions/AgentCodeInstalledSkillsService.system.test.ts --project unit`
Expected: FAIL (`code: 'unsupported'` from the enable gate inside install).

- [x] **Step 3: Implement** — in `AgentCodeConventionsService.ts`:

1. Installed mutation gate (~1400) — condition swap to `enabled && this.targets.targets.length === 0`.
2. `reconcileInstalledSkillLocked()` (~1518) — delete the `if (skill.enabled && targets.unsupportedProviders.length > 0) { ... return }` block.
3. `applyInstalledOperationsLocked()` (~1645) — before the final set:

```ts
    // Informational rows for providers without personal-skill support (#1014).
    if (this.targets.unsupportedProviders.length > 0) {
      statuses.push(...this.installedUnsupportedStatuses())
    }
    this.installedTargetStatuses.set(skill.id, statuses)
```

4. `installedHealth()` (~1708) — in the enabled branch, drop the `unsupportedProviders` early return and filter:

```ts
    if (this.targets.targets.length === 0) return 'unsupported'
    const deployable = statuses.filter(status => status.state !== 'unsupported')
    if (deployable.some(status => status.state === 'conflict' || status.state === 'retired')) {
      return 'conflict'
    }
    if (deployable.length === 0 || deployable.some(status => status.state !== 'installed')) {
      return 'degraded'
    }
    return 'active'
```

- [x] **Step 4: Run tests; then the whole conventions directory**

Run: `NODE_ENV=test npx vitest run src/main/agentCodeConventions --project unit`
Expected: all pass (including `targets.test.ts`? No — that is Task 4; it may still fail).

- [x] **Step 5: Commit** — `git commit -m "fix(managed-skills): unsupported providers no longer block installed skills - Refs #1014"`

### Task 4: Real-registry target contract

**Files:**
- Modify: `src/main/agentCodeConventions/targets.test.ts`

- [x] **Step 1: Update the expectation** (line 15) — grok is a registered provider with `personalAgentSkills.supported: false` by design (no recorded native skill layout), so the real registry now always reports it:

```ts
    // Contract since grok (#1014): a registered provider MAY declare personal
    // agent skills unsupported; targets resolution must tolerate it — grok
    // simply never contributes a target row.
    expect(result.unsupportedProviders).toEqual(['grok'])
```

- [x] **Step 2: Run** — `NODE_ENV=test npx vitest run src/main/agentCodeConventions/targets.test.ts --project unit` → PASS.

- [x] **Step 3: Commit** — `git commit -m "test(managed-skills): accept grok in the unsupported-providers registry contract - Refs #1014"`

### Task 5: Settings banner stays informative

**Files:**
- Modify: `src/renderer/src/features/settings/ui/AgentCodeConventionsRow.tsx` (~176)

- [x] **Step 1: Widen the banner condition** — health is now 'active' when only some providers are unsupported, but the user must still see which providers cannot receive the skill:

```tsx
      {snapshot.health === 'unsupported' || snapshot.unsupportedProviders.length > 0 ? (
        <div role="status" className="rounded-slab border border-warning px-2 py-1 text-[10px] text-warning">
          Personal Agent Skills are unavailable for: {snapshot.unsupportedProviders.join(', ')}.
        </div>
      ) : null}
```

Button `disabled` conditions (`health === 'unsupported'`) stay unchanged — degenerate case only.

- [x] **Step 2: Run renderer row tests**

Run: `NODE_ENV=test npx vitest run src/renderer/src/features/settings/ui --project renderer`
Expected: pass. If a row test asserts the old banner logic, update it to the new condition (informational when providers unsupported).

- [x] **Step 3: Commit** — `git commit -m "fix(settings): show unsupported providers as an informational banner - Refs #1014"`

### Task 6: Verification

- [x] **Step 1:** `npm run typecheck` — must pass.
- [x] **Step 2:** `NODE_ENV=test npx vitest run --project unit` — full unit project must pass (regressions elsewhere e.g. sessionManager recover tests that assert 'Session failed to start' flows are unrelated but verify).
- [x] **Step 3:** Manual end-to-end in the WORKTREE: `npm run dev`, spawn a Claude/Opencode pane — session must start; Settings → managed skills shows the grok informational banner with health Active.
- [x] **Step 4:** Update this plan's checkboxes; final diff review for unrelated changes.
