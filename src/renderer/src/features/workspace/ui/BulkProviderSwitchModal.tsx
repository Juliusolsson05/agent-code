import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { relativeTime } from '@renderer/lib/relativeTime'
import { cwdBasename, pluralAgents, providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { UsageProviderKind } from '@shared/types/usage'
import { useUsageHeaderSnapshot } from '@renderer/features/usage/hooks/useUsageHeaderSnapshot'
import { formatReset, providerLabel as usageProviderLabel } from '@renderer/features/usage/model/formatUsage'
import { deriveProviderExhaustion } from '@shared/usage/exhaustion'
import { estimateLiveEntriesBytes } from '@renderer/session-runtime/liveEntryWindow'
import { isLimitIdle } from '@renderer/workspace/hook/actions/providerSwitchCore'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

// Switch Agents modal — bulk provider switch + remembered-batch return.
//
// Structurally a sibling of CloseOldAgentsModal (same two-pane scope/preview
// shape), but the operation is a reversible round-trip rather than a
// destructive cleanup:
//   - Top half: pick a DIRECTION and SCOPE, preview the affected agents, switch.
//   - Top banner (only when a batch is remembered): send the most recent batch
//     back to its origin provider. This is the ONLY return affordance — there
//     is no command-palette entry or keybind for it.
//
// Unlike Close Old Agents there is no time threshold and no "include running"
// toggle: the trigger for this feature is "I hit a usage limit, get everyone
// off this provider", so every source-kind agent is eligible. We still SHOW how
// many are mid-turn and will be skipped, so the choice is informed.

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

type ScopeMode = 'all' | 'selected'

type AgentRow = {
  sessionId: SessionId
  tabId: string
  tabTitle: string
  tabIndex: number
  kind: AgentProviderKind
  cwd: string
  cwdBase: string
  isLive: boolean
}

type ProjectRow = {
  cwd: string
  cwdBase: string
  total: number
}

type SwitchDirection = {
  key: string
  source: AgentProviderKind
  target: AgentProviderKind
}

const SWITCH_DIRECTIONS: SwitchDirection[] = AGENT_PROVIDER_KINDS.flatMap(source => (
  getProviderFeatures(source).switchTargets.map(target => ({
    key: `${source}:${target}`,
    source,
    target,
  }))
))

function providerLabel(kind: AgentProviderKind): string {
  // Registry-derived (#394 phase 4).
  return getRendererProviderCapabilities(kind).shortLabel
}

/** One stable reference to stand in for the runtimes map while the modal is
 *  closed, so memos that read it are not invalidated by every runtime tick in
 *  the app. Module scope, never mutated. */
const NO_RUNTIMES: Workspace['runtimes'] = {}

/** Above this many estimated characters, a Claude-bound batch gets arrival
 *  compaction ticked by default (spec §Renderer).
 *
 *  WHY a character estimate and not a token count: the renderer has no
 *  tokenizer and the transaction's own budget is expressed in characters
 *  (agent-transcript-parser's contextBudget). WHY 150,000: that is the spec's
 *  line, chosen as the size where an imported conversation reliably crowds the
 *  target's first turns. It is a DEFAULT, not a gate — the checkbox is right
 *  there, and getting it wrong costs the user one click.
 *
 *  The estimate is taken over the live entry window, which the ingest path caps
 *  at 32 MB — three orders of magnitude above this threshold, so the window is
 *  never the reason a conversation looks small. A trimmed pane can still
 *  under-report (its oldest entries live only on disk); erring toward "no
 *  compaction" is the right side to be wrong on, since compaction spends the
 *  target's quota. */
const ARRIVAL_COMPACTION_CHARACTERS = 150_000

/** The remedy offered when only ONE model family is exhausted. Claude-only by
 *  design (spec §Renderer): Codex's model switch is backend-driven and has no
 *  equivalent slash command to deliver.
 *
 *  WHY a hard-coded family and not a picker: this row exists to make the cheap
 *  remedy one click away when the expensive one (translating every transcript)
 *  is unnecessary. Claude's own `/model` picker is one keystroke further for
 *  anyone who wants a different family, and hard-coding it here keeps this
 *  modal out of the business of enumerating provider models. */
const CLAUDE_MODEL_SWITCH_PROMPT = '/model sonnet'

/** The family `CLAUDE_MODEL_SWITCH_PROMPT` would move agents ONTO. Used to
 *  suppress the offer when that family is the exhausted one — "switch to
 *  Sonnet" is not a remedy for "the Sonnet week is full". */
const CLAUDE_MODEL_SWITCH_FAMILY = /sonnet/i

/** "Codex 5h at 100%" rather than "Codex: Codex 5h at 100%".
 *
 *  Provider normalizers name some windows after the provider and some after a
 *  model family, so prefixing unconditionally reads fine for
 *  "Claude: Current week (Opus)" and badly for "Codex: Codex 5h". The prefix is
 *  what makes the line self-contained when the label does not already say who
 *  it is about; when it does, repeating it is noise. */
function exhaustionHeadline(item: { provider: UsageProviderKind; label: string }): string {
  const name = usageProviderLabel(item.provider)
  return item.label.toLowerCase().includes(name.toLowerCase())
    ? item.label
    : `${name}: ${item.label}`
}

export function BulkProviderSwitchModal({ open, workspace, onClose }: Props) {
  // Every user-overridable default in this modal is stored as "the user's
  // choice, or null for none yet" and resolved against a DERIVED default at
  // render time.
  //
  // WHY not the obvious `useState(default)` + effect that re-seeds it: the
  // defaults depend on the usage snapshot, which arrives from an IPC poll AFTER
  // the modal has mounted, and on the direction, which the user can change
  // while it is open. A seeding effect would have to distinguish "the default
  // moved" from "the user set this", and every version of that logic either
  // stomps a deliberate choice or freezes on whatever was known at mount (the
  // snapshot is usually still null then, so it would freeze on the wrong
  // value). Resolving at render has neither failure mode and needs no effect.
  const [directionChoice, setDirectionChoice] = useState<string | null>(null)
  const [compactOnArrivalChoice, setCompactOnArrivalChoice] = useState<boolean | null>(null)
  const [compactOnSourceChoice, setCompactOnSourceChoice] = useState(false)
  // Arms the second click that actually spends source quota. Never persisted
  // across a policy change — see the reset in the checkbox/direction handlers.
  const [sourceConfirmArmed, setSourceConfirmArmed] = useState(false)
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(() => new Set())
  const [projectFilter, setProjectFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  // Refs so the open-reset effect can see the live values without depending on
  // them — depending on them would re-run the reset the moment a loop ended.
  const busyRef = useRef(busy)
  busyRef.current = busy
  const switchingModelRef = useRef(switchingModel)
  switchingModelRef.current = switchingModel
  /**
   * The exact panes the source-compaction confirmation named.
   *
   * WHY a snapshot instead of re-reading `matchingRows` on the confirmed
   * click: the confirmation is armed on the first click and consumed on the
   * second, and every MANUAL way of changing the set (direction, scope,
   * project toggle, select-all, clear, filter) disarms it. But `matchingRows`
   * is a memo over live workspace state and changes on its own — an agent
   * spawning, or one that was mid-turn going idle, silently joins the set
   * between the two clicks. The user then confirms "compact 3 agents on Codex
   * first" and four agents get their live history rewritten. Confirming a set
   * has to mean confirming THAT set.
   */
  const [confirmedSessionIds, setConfirmedSessionIds] = useState<string[] | null>(null)
  // Live status (mid-turn) can change while the modal sits open. Re-tick every
  // 10s so the ⚠ skip count stays honest, matching Close Old Agents.
  const [nowTick, setNowTick] = useState(0)
  const { showToast } = useGlobalToast()

  // Read-only quota signal. It picks defaults and NEVER gates: the usage
  // endpoint can be stale, wrong, or unreachable, and this feature exists
  // precisely for people whose provider is misbehaving (see the header of
  // shared/usage/exhaustion.ts).
  //
  // Gated on `open` because this modal is a PERMANENT surface — the registry
  // renders every surface for the life of the app and passes `open` as a prop
  // (app/surfaces/registry.tsx). An ungated call here polled the usage IPC
  // every 60 s forever, for a modal nobody had opened, even with the usage
  // header switched off.
  const { snapshot } = useUsageHeaderSnapshot(open)
  const exhaustion = useMemo(
    () => (snapshot?.providers ?? []).map(deriveProviderExhaustion),
    [snapshot],
  )
  const exhaustedProviders = useMemo(
    () => exhaustion.filter(item => item.exhausted),
    [exhaustion],
  )

  // The old two-provider modal could derive source by negating target. With
  // OpenCode there are six directed edges, so the selected value must preserve
  // both ends. Codex→Claude stays the familiar fallback; a single exhausted
  // provider overrides it, because "get everyone off THAT provider" is the
  // reason this modal was opened. Two exhausted providers deliberately fall
  // back: moving agents from one full provider to another full one helps
  // nobody, so the user has to say what they want.
  const defaultDirectionKey = useMemo(() => {
    if (exhaustedProviders.length !== 1) return 'codex:claude'
    const exhaustedSource = exhaustedProviders[0].provider
    return SWITCH_DIRECTIONS.find(item => item.source === exhaustedSource)?.key ?? 'codex:claude'
  }, [exhaustedProviders])
  const directionKey = directionChoice ?? defaultDirectionKey

  const direction = SWITCH_DIRECTIONS.find(item => item.key === directionKey) ?? {
    key: 'codex:claude',
    source: 'codex' as const,
    target: 'claude' as const,
  }
  const { source, target } = direction
  const sourceExhaustion = exhaustion.find(item => item.provider === source) ?? null
  const sourceExhausted = sourceExhaustion?.exhausted === true

  useEffect(() => {
    if (!open) return
    // Never reset over a loop that is still running. `open` is store state, so
    // `closeBulkProviderSwitch` from a command or another surface can close
    // this modal even while the guards above refuse Escape; reopening then ran
    // this effect and cleared the very flag that single-flights the loop,
    // letting a second batch start against the same panes. Both flags are
    // cleared by their own `finally`, so skipping the reset here cannot strand
    // them.
    if (busyRef.current || switchingModelRef.current) return
    setDirectionChoice(null)
    setCompactOnArrivalChoice(null)
    setCompactOnSourceChoice(false)
    setSourceConfirmArmed(false)
    setConfirmedSessionIds(null)
    setScopeMode('all')
    setSelectedProjects(new Set())
    setProjectFilter('')
    setBusy(false)
    setSwitchingModel(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNowTick(t => t + 1), 10_000)
    return () => window.clearInterval(id)
  }, [open])

  const batch = workspace.state.lastProviderSwitchBatch ?? null

  const agentRows = useMemo<AgentRow[]>(() => {
    // A closed Dialog still mounts these hooks. Gate only the invisible
    // preview, so in-flight switch state and callbacks keep their lifetime.
    // Runtime ticks should spend their budget on visible panes, not this list.
    if (!open) return []
    void nowTick
    const rows: AgentRow[] = []
    const seen = new Set<SessionId>()

    workspace.state.tabs.forEach((tab: Tab, tabIndex: number) => {
      for (const sessionId of resolveTabSessions(workspace.state, tab.id)) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)

        const meta = workspace.state.sessions[sessionId]
        if (!meta) continue
        const kind = meta.kind ?? DEFAULT_PROVIDER
        // Only source-provider agents are switchable to the target. Terminals
        // (kind 'terminal') are excluded by this same check.
        if (kind !== source) continue

        const runtime = workspace.runtimes[sessionId]
        const running = runtime?.sessionStatus === 'running'
        const streaming = runtime?.streamPhase != null && runtime.streamPhase !== 'idle'
        // An agent parked on a usage limit still reads as running (the provider
        // keeps its process and paints a wait banner), but the switch core will
        // accept it — see isLimitIdle. Counting it as mid-turn here would tell
        // the user their most stuck agents are the ones that cannot be rescued,
        // which is exactly backwards.
        //
        // DIVERGENCE from the task brief, deliberate: the brief specified
        // `processActive && !isLimitIdle`. `sessionStatus === 'running'` is
        // CLOSER to the guard it must predict — deriveSessionStatus folds
        // processActive AND a live semantic turn, and the guard refuses on
        // either, so processActive alone would under-report a pane whose only
        // liveness signal is a streaming turn and promise a switch the core
        // then refuses.
        //
        // It is NOT exact, in both directions, and neither gap is worth a
        // second predicate:
        //   - over-reports when `awaitingAssistant` alone makes the status
        //     'running' (an optimistic submit the provider has not answered
        //     yet); the guard would allow that switch, so the preview is
        //     pessimistic and the agent simply stays listed as mid-turn.
        //   - under-reports when `semantic.currentTurn` exists but has ENDED
        //     (endedAt set): the status derivation ignores it, the guard's
        //     `?? semantic.currentTurn` truthiness check does not, so the core
        //     can still refuse a row this preview called idle. That row reports
        //     its own failure in the batch summary.
        // Both would need the guard itself to expose one predicate; the honest
        // fix is to move the whole "is this switchable" question into
        // providerSwitchCore, not to grow a second copy here.
        const limitParked = runtime ? isLimitIdle(runtime) : false

        rows.push({
          sessionId,
          tabId: tab.id,
          tabTitle: tab.title,
          tabIndex,
          kind,
          cwd: meta.cwd,
          cwdBase: cwdBasename(meta.cwd),
          isLive: Boolean((running || streaming) && !limitParked),
        })
      }
    })

    rows.sort((a, b) => {
      if (a.cwdBase !== b.cwdBase) return a.cwdBase.localeCompare(b.cwdBase)
      return a.tabIndex - b.tabIndex
    })
    return rows
  }, [open, workspace.runtimes, workspace.state, source, nowTick])

  const matchingRows = useMemo(() => {
    if (scopeMode === 'all') return agentRows
    return agentRows.filter(row => selectedProjects.has(row.cwd))
  }, [agentRows, scopeMode, selectedProjects])

  const projects = useMemo<ProjectRow[]>(() => {
    const byProject = new Map<string, ProjectRow>()
    for (const row of agentRows) {
      const existing = byProject.get(row.cwd)
      if (existing) existing.total += 1
      else byProject.set(row.cwd, { cwd: row.cwd, cwdBase: row.cwdBase, total: 1 })
    }
    return Array.from(byProject.values()).sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total
      return a.cwdBase.localeCompare(b.cwdBase)
    })
  }, [agentRows])

  const filteredProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase()
    if (!query) return projects
    return projects.filter(
      project =>
        project.cwd.toLowerCase().includes(query) ||
        project.cwdBase.toLowerCase().includes(query),
    )
  }, [projectFilter, projects])

  const midTurnCount = matchingRows.filter(row => row.isLive).length
  const selectedCount = selectedProjects.size

  // Biggest conversation in the batch, not the sum: arrival compaction runs
  // per agent, so the question is whether ANY single pane will land oversized.
  //
  // This modal is a permanently mounted surface (see the usage hook gate
  // above), and `workspace.runtimes` is one of the highest-churn references in
  // the app — which is what makes the dependency choice below load-bearing
  // rather than cosmetic.
  // WHY this is keyed on the session ids and reads runtimes through a REF:
  //
  // Gating on `open` stopped the walk while the modal is closed, but while it
  // is OPEN the number is derived from `workspace.runtimes` — which the
  // comment directly above names "one of the highest-churn references in the
  // app". Every streaming tick from any pane re-walked up to 2000 entries for
  // every matching row, to produce a single threshold comparison that defaults
  // one checkbox.
  //
  // Depending on `matchingRows` instead is NOT sufficient and a first attempt
  // that did only that changed nothing: `agentRows` lists `workspace.runtimes`
  // in its own deps, so `matchingRows` is a fresh array on every tick too. The
  // dependency has to be the thing that actually decides the answer, which is
  // WHICH sessions match — not the identity of the array listing them, and not
  // the identity of the runtime map. Joining the ids is O(rows) per render
  // against O(rows x entries) for the walk.
  //
  // The estimate can therefore lag a pane's growth within one open session.
  // That is acceptable and deliberate: it only picks the default state of a
  // checkbox the user can see and toggle, and it is re-derived every time the
  // modal opens.
  const runtimesRef = useRef(workspace.runtimes)
  runtimesRef.current = workspace.runtimes
  const matchingRowsRef = useRef(matchingRows)
  matchingRowsRef.current = matchingRows
  const matchingSessionKey = matchingRows.map(row => row.sessionId).join('\u0000')
  const largestSourceEstimate = useMemo(() => {
    if (!open) return 0
    const runtimes = runtimesRef.current
    let largest = 0
    for (const row of matchingRowsRef.current) {
      const runtime = runtimes[row.sessionId]
      if (!runtime) continue
      const estimate = estimateLiveEntriesBytes(runtime.entries)
      if (estimate > largest) largest = estimate
    }
    return largest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchingSessionKey, open])

  // Claude is the only target with a compaction the renderer can drive
  // (compactAfterSwitch reports every other kind as a no-op), so the checkbox
  // is not shown at all for Codex/OpenCode destinations.
  const arrivalCompactionOffered = target === 'claude'
  const compactOnArrival = arrivalCompactionOffered
    && (compactOnArrivalChoice ?? largestSourceEstimate > ARRIVAL_COMPACTION_CHARACTERS)
  // A checked box on an exhausted source must not survive as policy. The
  // transaction would ask that provider for a turn it cannot answer, and the
  // switch would fail for the exact reason the user opened this modal.
  const compactOnSource = compactOnSourceChoice && !sourceExhausted
  // The family-scoped remedy: another model on the SAME provider, no transcript
  // translation at all. Only offered when the blocking window is family-scoped
  // — an account-wide window at 100% means no Claude model will answer, and
  // offering a model switch there would waste the user's time.
  const familyScopedLimit =
    source === 'claude' && sourceExhaustion?.exhausted === true && sourceExhaustion.scope === 'model-family'
  // ...and the exhausted family is not the one the command would move agents
  // to. `/model sonnet` cannot rescue a full Sonnet week, and offering it would
  // send a batch of agents at the wall they are already standing at.
  const modelSwitchWouldLandOnExhaustedFamily =
    familyScopedLimit && CLAUDE_MODEL_SWITCH_FAMILY.test(sourceExhaustion?.label ?? '')
  const modelSwitchOffered = familyScopedLimit && !modelSwitchWouldLandOnExhaustedFamily

  // Every one of these changes WHICH agents the armed second click would
  // compact. A confirmation is for one specific set on one specific source, so
  // changing the set disarms it — otherwise a user who confirms three agents
  // and then ticks a fourth project spends quota on agents they never saw named
  // in the confirmation.
  const toggleProject = useCallback((cwd: string) => {
    setSourceConfirmArmed(false)
    setConfirmedSessionIds(null)
    setSelectedProjects(prev => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }, [])

  const selectAllProjects = useCallback(() => {
    setSourceConfirmArmed(false)
    setConfirmedSessionIds(null)
    setSelectedProjects(new Set(projects.map(project => project.cwd)))
  }, [projects])

  const clearProjects = useCallback(() => {
    setSourceConfirmArmed(false)
    setConfirmedSessionIds(null)
    setSelectedProjects(new Set())
  }, [])

  const changeScopeMode = useCallback((mode: ScopeMode) => {
    setSourceConfirmArmed(false)
    setConfirmedSessionIds(null)
    setScopeMode(mode)
  }, [])

  const changeProjectFilter = useCallback((value: string) => {
    // The filter cannot change membership in 'all' scope, but in 'selected'
    // scope it hides rows the user is choosing from; disarm either way rather
    // than depend on that distinction staying true.
    setSourceConfirmArmed(false)
    setConfirmedSessionIds(null)
    setProjectFilter(value)
  }, [])

  const runSwitch = useCallback(async () => {
    // `locked`, not `busy`: runModelSwitch sets only `switchingModel`, so
    // guarding on `busy` alone let a Switch start on top of an in-flight
    // /model fan-out over the same panes — the very race the sequential loop
    // exists to prevent, and the one the close guards below already cover.
    if (matchingRows.length === 0 || lockedRef.current) return
    // One confirmation for the whole batch, in the modal, replacing main's
    // per-agent native dialog (spec §Renderer). It is required only on the
    // opt-in source path: that is the branch that rewrites live history and
    // spends the source provider's quota. The default path costs the source
    // nothing and is confirmed by the button press itself.
    if (compactOnSource && !sourceConfirmArmed) {
      setSourceConfirmArmed(true)
      setConfirmedSessionIds(matchingRows.map(row => row.sessionId))
      return
    }
    // The confirmed set wins over the live one whenever a confirmation was
    // required. Panes that closed in between are skipped by the action itself,
    // which re-reads meta per iteration, so a stale id is harmless — an
    // UNCONFIRMED id is not.
    const sessionIds = compactOnSource && confirmedSessionIds
      ? confirmedSessionIds
      : matchingRows.map(row => row.sessionId)
    setBusy(true)
    try {
      await workspace.switchAgentsToProvider(
        sessionIds,
        target,
        {
          allowSourceTurns: compactOnSource,
          compactOnArrival,
          // Identical to allowSourceTurns by construction: the modal never
          // enables the source path without the confirmation above, and main
          // ignores this flag unless allowSourceTurns is set. It stays a
          // separate field because the two answer different questions
          // ("may you?" vs "did a human say yes?") and main's dialog skip
          // must key on the second.
          sourceCompactionConfirmed: compactOnSource,
        },
      )
      onClose()
    } finally {
      setBusy(false)
    }
  }, [busy, compactOnArrival, compactOnSource, confirmedSessionIds, matchingRows, onClose, sourceConfirmArmed, target, workspace])

  const runModelSwitch = useCallback(async () => {
    if (matchingRows.length === 0 || lockedRef.current) return
    setSwitchingModel(true)
    let delivered = 0
    let failed = 0
    // The provider's own words for the FIRST failure. A count alone ("2
    // failed") is unactionable — prompt delivery fails for reasons the user can
    // usually fix (the pane is mid-turn, the process died, a dialog is up), and
    // the message is where that lives. The first one is enough: a batch that
    // fails usually fails the same way N times.
    let firstFailure: string | null = null
    try {
      // Sequential like the switch loop, and for a weaker reason: these are
      // independent prompt deliveries, but a burst of PTY writes across many
      // panes is exactly the shape that has produced delivery races before.
      // A handful of agents is not worth the risk of parallelism.
      for (const row of matchingRows) {
        const result = await window.api.deliverPrompt(row.sessionId, CLAUDE_MODEL_SWITCH_PROMPT)
        if (result.ok) {
          delivered += 1
        } else {
          failed += 1
          if (firstFailure === null) firstFailure = result.message
        }
      }
    } catch (error) {
      // WHY this catch exists: the loop had try/finally and no catch, so a
      // REJECTED deliverPrompt (a dead IPC channel, a preload shape mismatch)
      // aborted the batch mid-way while the `finally` still ran. The count was
      // not wrong about what it claimed — `delivered` only ever incremented
      // after `result.ok` — but the toast said "Sent /model … to 3 agents"
      // with no failure note at all, so every agent the loop never reached
      // simply vanished from the report. Silence about an agent reads as
      // "nothing to say", not as "never attempted".
      // Clamped so the report can never claim more agents than the batch had:
      // the loop aborted, so everything not already counted is unattempted,
      // and at minimum the one that rejected must show up.
      const remaining = matchingRows.length - delivered - failed
      failed += remaining > 0 ? remaining : 1
      if (firstFailure === null) {
        firstFailure = error instanceof Error && error.message.length > 0
          ? error.message
          : 'Prompt delivery failed'
      }
    } finally {
      setSwitchingModel(false)
      const failureNote = failed > 0
        ? ` (${failed} failed${firstFailure ? `: ${firstFailure}` : ''})`
        : ''
      showToast(`Sent ${CLAUDE_MODEL_SWITCH_PROMPT} to ${pluralAgents(delivered)}${failureNote}`)
    }
  }, [busy, matchingRows, showToast, switchingModel])

  const runReturn = useCallback(async () => {
    // Same reason as runSwitch: a Return must not start under an in-flight
    // /model fan-out.
    if (lockedRef.current) return
    setBusy(true)
    try {
      // Intentionally NOT closing the modal: the banner clears itself when
      // workspace state updates, giving the user visible confirmation the batch
      // was returned without yanking the modal out from under them.
      await workspace.returnLastProviderSwitchBatch()
    } finally {
      setBusy(false)
    }
  }, [busy, workspace])

  // Block every close path (Escape, backdrop, Esc button) while a switch/return
  // loop is in flight. The loop's re-entrancy guard is the local `busy` flag,
  // which resets to false on remount — so if the modal could close and reopen
  // mid-loop, a second bulk operation could start concurrently against the same
  // replaceSession mutation paths. Refusing to close while busy keeps `busy` the
  // authoritative single-flight guard without lifting it into workspace state.
  // WHY `switchingModel` counts as locked too:
  //
  // `runModelSwitch` sets only `switchingModel`, and every close guard keyed on
  // `busy` alone. Escape during the sequential /model loop was therefore
  // allowed, the reset effect below cleared `switchingModel` on reopen, and a
  // second click started a second loop that interleaved PTY writes on panes
  // that had already received the prompt. That is precisely the race the
  // sequential loop exists to prevent. `open` is store-owned, so
  // `closeBulkProviderSwitch` from anywhere else bypasses this guard for
  // `busy` as well — see the reset effect, which is the second half of the fix.
  const locked = busy || switchingModel
  // Read by the run guards, which must see the live value without taking
  // `locked` as a dependency and re-creating every callback on each toggle.
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const requestClose = useCallback(() => {
    if (locked) return
    onClose()
  }, [locked, onClose])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) requestClose()
      }}
    >
      <DialogContent
        className="flex max-h-[86vh] w-[min(860px,94vw)] flex-col overflow-hidden"
        onEscapeKeyDown={event => {
          if (locked) event.preventDefault()
        }}
        onPointerDownOutside={event => {
          // WHY an in-flight batch cannot be dismissed: the old overlay kept
          // this single-flight operation visible until it settled. Preventing
          // Radix's outside close preserves that contract while still letting
          // the primitive own all normal dismissal behavior.
          if (locked) event.preventDefault()
        }}
      >
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>Switch Agents to Another Provider</DialogTitle>
              <DialogDescription>
                Move a batch of agents between Claude, Codex, and OpenCode — e.g. when you
                hit a usage limit. History is translated; the originals stay native.
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={requestClose}
              disabled={locked}
              className="rounded-control px-2 py-1 text-[10px] border border-border text-ink-dim hover:text-ink hover:border-border-hi disabled:opacity-50"
            >
              Esc
            </button>
          </div>

          {batch && (
            <div className="rounded-slab mt-3 flex items-center justify-between gap-3 border border-border bg-canvas px-3 py-2">
              <div className="min-w-0 text-[11px] text-ink-dim">
                <span className="text-ink">↩ Last batch</span> — {batch.agents.length} agent
                {batch.agents.length === 1 ? '' : 's'} · {providerLabel(batch.sourceKind)} →{' '}
                {providerLabel(batch.targetKind)} · {relativeTime(batch.switchedAt)}
              </div>
              <button
                type="button"
                onClick={() => void runReturn()}
                disabled={locked}
                className="rounded-control flex-shrink-0 px-2.5 py-1 text-[11px] border border-accent/60 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
              >
                {busy ? 'Working…' : `Return ${batch.agents.length}`}
              </button>
            </div>
          )}

          {exhaustedProviders.length > 0 && (
            <div className="rounded-slab mt-3 border border-danger/50 bg-danger/10 px-3 py-2">
              {exhaustedProviders.map(item => (
                // One line per exhausted provider, rendered as a single text
                // node so the whole claim ("who, how full, until when") is one
                // readable sentence rather than three spans a screen reader has
                // to reassemble.
                <div key={item.provider} className="text-[11px] text-ink">
                  {`${exhaustionHeadline(item)} at 100%${
                    item.resetsAt ? `, ${formatReset(item.resetsAt) ?? 'reset time unknown'}` : ''
                  }`}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)] gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted">
                Switch
              </label>
              <div className="mt-1">
                <select
                  value={directionKey}
                  onChange={e => {
                    setDirectionChoice(e.target.value)
                    // A confirmation is for one specific batch on one specific
                    // source. Changing direction changes whose quota would be
                    // spent, so the armed second click must not carry over.
                    setSourceConfirmArmed(false)
                    setConfirmedSessionIds(null)
                  }}
                  className="rounded-control px-2 py-1.5 bg-canvas border border-border text-[12px] text-ink outline-none focus:border-accent"
                >
                  {SWITCH_DIRECTIONS.map(item => (
                    <option key={item.key} value={item.key}>
                      {providerLabel(item.source)} → {providerLabel(item.target)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">Project scope</div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => changeScopeMode('all')}
                  className={`rounded-control px-2.5 py-1.5 text-[11px] border ${
                    scopeMode === 'all'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-ink-dim hover:text-ink hover:border-border-hi'
                  }`}
                >
                  All projects
                </button>
                <button
                  type="button"
                  onClick={() => changeScopeMode('selected')}
                  className={`rounded-control px-2.5 py-1.5 text-[11px] border ${
                    scopeMode === 'selected'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-ink-dim hover:text-ink hover:border-border-hi'
                  }`}
                >
                  Selected projects
                </button>
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {arrivalCompactionOffered && (
              <label className="flex items-start gap-2 text-[11px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={compactOnArrival}
                  onChange={e => setCompactOnArrivalChoice(e.target.checked)}
                  className="mt-0.5 accent-current"
                />
                <span>
                  Compact on arrival with {providerLabel(target)}
                  <span className="text-muted">
                    {' '}— spends {providerLabel(target)} quota, not {providerLabel(source)}&apos;s
                  </span>
                </span>
              </label>
            )}

            <label
              className="flex items-start gap-2 text-[11px] text-ink-dim"
              // The reason travels on the label, not only the input: a disabled
              // input is not hoverable in every browser, and a checkbox the user
              // cannot tick with no stated reason reads as a bug.
              title={sourceExhausted ? 'Source provider is exhausted' : undefined}
            >
              <input
                type="checkbox"
                checked={compactOnSource}
                disabled={sourceExhausted}
                onChange={e => {
                  setCompactOnSourceChoice(e.target.checked)
                  setSourceConfirmArmed(false)
                  setConfirmedSessionIds(null)
                }}
                className="mt-0.5 accent-current disabled:opacity-50"
              />
              <span className={sourceExhausted ? 'text-muted' : undefined}>
                Compact on source first (uses {providerLabel(source)} quota)
                {sourceExhausted && (
                  <span className="text-muted"> — {providerLabel(source)} is exhausted</span>
                )}
              </span>
            </label>

            {sourceConfirmArmed && compactOnSource && (
              <div className="rounded-slab border border-warning/50 bg-warning/10 px-3 py-2 text-[11px] text-ink">
                {`Compact ${pluralAgents(matchingRows.length)} on ${providerLabel(source)} first — this rewrites their live history and uses ${providerLabel(source)} quota.`}
              </div>
            )}

            {modelSwitchWouldLandOnExhaustedFamily && (
              <div className="text-[11px] text-muted">
                {`A model switch would not help: the exhausted window is the family this would move agents to (${sourceExhaustion?.label ?? ''}). Pick another model in the pane, or switch provider.`}
              </div>
            )}

            {modelSwitchOffered && (
              // The cheap remedy, offered only when the exhausted window is
              // family-scoped: another model on the SAME provider costs no
              // transcript translation at all.
              <div className="rounded-slab mt-1 flex items-center justify-between gap-3 border border-border bg-canvas px-3 py-2">
                <div className="min-w-0 text-[11px] text-ink-dim">
                  Only one {providerLabel(source)} model family is exhausted — a model switch
                  keeps every agent where it is.
                </div>
                <button
                  type="button"
                  onClick={() => void runModelSwitch()}
                  disabled={locked || matchingRows.length === 0}
                  className="rounded-control flex-shrink-0 px-2.5 py-1 text-[11px] border border-accent/60 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
                >
                  {switchingModel
                    ? 'Sending…'
                    : `Switch ${pluralAgents(matchingRows.length)} to another ${providerLabel(source)} model`}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border flex flex-col">
            <div className="flex-shrink-0 px-3 py-2 border-b border-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-ink">Projects</div>
                {scopeMode === 'selected' && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={selectAllProjects}
                      className="px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                    >
                      all
                    </button>
                    <button
                      type="button"
                      onClick={clearProjects}
                      className="px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                    >
                      clear
                    </button>
                  </div>
                )}
              </div>
              {scopeMode === 'selected' && projects.length > 8 && (
                <input
                  type="text"
                  value={projectFilter}
                  onChange={e => changeProjectFilter(e.target.value)}
                  placeholder="Filter projects"
                  className="rounded-control mt-2 w-full px-2 py-1 bg-canvas border border-border text-[11px] text-ink outline-none focus:border-accent"
                />
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {projects.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-muted">
                  No {providerLabel(source)} agents.
                </div>
              ) : (
                filteredProjects.map(project => {
                  const selected = selectedProjects.has(project.cwd)
                  const disabled = scopeMode === 'all'
                  return (
                    <label
                      key={project.cwd}
                      className={`
                        flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0
                        ${disabled ? 'text-ink-dim' : 'cursor-pointer hover:bg-surface-hi'}
                      `}
                    >
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={scopeMode === 'all' || selected}
                        onChange={() => toggleProject(project.cwd)}
                        className="mt-0.5 accent-current disabled:opacity-50"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] text-ink truncate">
                          {project.cwdBase}
                        </span>
                        <span className="block text-[10px] text-muted truncate">{project.cwd}</span>
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted tabular-nums">
                        {project.total}
                      </span>
                    </label>
                  )
                })
              )}
            </div>
          </div>

          <div className="min-h-0 flex flex-col">
            <div className="flex-shrink-0 px-4 py-2 border-b border-border flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] text-ink">
                  Will switch · {matchingRows.length} agent{matchingRows.length === 1 ? '' : 's'}
                </div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {matchingRows.length === 0
                    ? `No ${providerLabel(source)} agents to switch.`
                    : `These ${providerLabel(source)} agents will become ${providerLabel(target)} agents.`}
                </div>
              </div>
              {scopeMode === 'selected' && (
                <div className="text-[10px] text-muted">{selectedCount} selected</div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {matchingRows.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-muted">
                  No {providerLabel(source)} agents match the current scope.
                </div>
              ) : (
                matchingRows.map(row => (
                  <div
                    key={row.sessionId}
                    className="flex items-start gap-3 px-4 py-2.5 border-b border-border last:border-b-0"
                  >
                    <div className="flex-shrink-0 w-[72px] flex items-center gap-2">
                      <span className={row.isLive ? 'text-warning' : 'text-muted'}>
                        {providerGlyph(row.kind)}
                      </span>
                      <span className="text-[11px] uppercase tracking-wider text-muted">
                        {row.kind}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-ink truncate">{row.cwdBase}</div>
                      <div className="mt-0.5 text-[10px] text-muted truncate">
                        tab {row.tabIndex + 1} · {row.tabTitle} · {row.cwd}
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-[110px] text-right">
                      {row.isLive ? (
                        <div className="text-[11px] text-warning">working</div>
                      ) : (
                        <div className="text-[11px] text-ink-dim">idle</div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-border px-4 py-3 flex items-center justify-between gap-3">
          <div className="text-[10px] text-muted">
            {midTurnCount > 0
              ? `⚠ ${midTurnCount} of ${matchingRows.length} are mid-turn and will be skipped until idle; agents stopped by a usage limit are included.`
              : 'Terminals are never switched.'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={locked}
              className="rounded-control px-3 py-1.5 text-[11px] border border-border text-ink-dim hover:text-ink hover:border-border-hi disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void runSwitch()}
              // `locked`, matching the handler: with `busy` alone the button
              // stayed enabled during a /model fan-out while runSwitch refused
              // the click, so it looked available and did nothing.
              disabled={locked || matchingRows.length === 0}
              className={`rounded-control
                px-3 py-1.5 text-[11px] border
                ${matchingRows.length > 0
                  ? 'border-accent/60 bg-accent/10 text-accent hover:bg-accent/20'
                  : 'border-border text-muted opacity-60 cursor-not-allowed'}
              `}
            >
              {busy
                ? 'Switching…'
                : sourceConfirmArmed && compactOnSource
                  // The armed label names the expensive half of what the click
                  // does. "Switch N to Claude" would hide the fact that the
                  // press also spends the source provider's quota.
                  ? `Compact ${pluralAgents(matchingRows.length)} on ${providerLabel(source)} and switch`
                  : `Switch ${pluralAgents(matchingRows.length)} to ${providerLabel(target)}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
