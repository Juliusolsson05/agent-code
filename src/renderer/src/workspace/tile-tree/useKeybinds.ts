import { createTldrHoldController, dismissTldr, observeTldrHoldRelease, useTldrView } from '@renderer/features/tldr/viewState'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { dismissGoalLoop, useGoalLoopView } from '@renderer/features/goal-loop/viewState'
import { useEffect, useMemo, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { deriveExtensionKeybindings } from '@renderer/apps/host/derive'
import type { BindingContext, CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'
import { keybindingFromEvent } from '@renderer/features/command-keybindings/normalize'
import { commandOwnsOpenSurface } from '@renderer/features/command-palette/surfaceOwnership'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { getEffectiveAgentSurface, isAgentKind } from '@renderer/workspace/agentDisplayMode'
import { selectVisibleDispatchRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { enumerateCodeBlockIds } from '@renderer/features/copy-code-block/lib/enumerateCodeBlocks'
import { getCodeBlockCode } from '@renderer/features/copy-code-block/lib/codeBlockRegistry'
import { isMacosTextEditingChord } from '@renderer/features/command-keybindings/reservations'
import { focusRowByLabel } from '@renderer/workspace/dispatch/laneKeyboard'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Keybinds: global window-level listeners. The handler is attached to
// `document` in a single useEffect, which captures the key BEFORE the
// focused input element sees it (via `capture: true`). That's necessary
// because all the keybinds fire while an input is focused — without
// capture, the input would swallow them.
//
// Keybind scheme. The DEFAULT chords live in
// features/command-keybindings/defaults.ts, which is the source of truth; this
// header records only what the table cannot say. Until #992 it listed the
// tile-tree chords (pane navigation, split resize, fn-alt directional resize,
// cmd-w collapsing the tree). Those commands are gone, and so is their list.
//
//   cmd-1..9        fill the focused lane from the index (row N). Press a
//                   second digit while cmd is still held to reach rows
//                   10..99, preserving digit order (cmd-1 then 2 → 12).
//   alt-arrows, alt-h/j/k/l
//                   the lane grammar: ⌥↑/↓ walk the index, ⌥←/→ move lane
//                   focus. Registered, rebindable commands, not an inline
//                   branch.
//   alt-backspace   Clear Lane. Yields to any text field that owns the target,
//                   so delete-word keeps working in the composer.
//
// RESERVED: Option+Shift+Arrow. On macOS it is the system shortcut for
// word-by-word text selection, which every text field in the app relies on,
// the composer included. No default may bind it, and the router must never
// treat ⌥⇧-arrows as a lane arrow (the old inline Dispatch branch did, and
// swallowed word selection). check:keybindings only knows this app's own
// bindings, so a green run does NOT prove a chord is free of an OS meaning;
// this note is the record.


function isTextEditingTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit'
  }
  return el.isContentEditable
}

const BLOCKED_META_CODES = new Set([
  'BracketLeft',
  'BracketRight',
  'KeyE',
  'KeyP',
  'KeyR',
  'KeyT',
  'KeyW',
])

const BLOCKED_ALT_CODES = new Set([
  // Clear Lane (⌥⌫, #992). Listed so a modal surface and the fullscreen
  // Global Editor swallow it outside text fields, the same as every other
  // Option chord this router owns. Without it, ⌥⌫ in fullscreen editor
  // chrome fell through and emptied the HIDDEN focused lane (#1013 review B).
  // A text field is exempt below, so delete-word keeps working in inputs.
  'Backspace',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Equal',
  'Home',
  'KeyC',
  'KeyD',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyT',
  'KeyW',
  'Minus',
  'PageDown',
  'PageUp',
])

export function shouldPreventOwnedApplicationShortcut(event: KeyboardEvent): boolean {
  // WHY this is an allow-list of Agent Code chords instead of "any Cmd/Alt":
  // a modal input still needs native editing shortcuts (Cmd+C/V/X/A/Z) and
  // macOS Option-based character entry. The earlier per-modal bailout blocked
  // every modified key, which happened to protect the workspace but also made
  // legitimate form editing inert. Suppress only chords this router owns.
  if (event.metaKey) {
    if (/^Digit[0-9]$/.test(event.code)) return true
    if (event.altKey && /^Digit[1-9]$/.test(event.code)) return true
    return BLOCKED_META_CODES.has(event.code)
  }
  if (!event.altKey) return false
  // Option is also macOS's text-composition modifier. While an app-owned
  // surface has an editable target, Option+C may produce "ç" and Option+Arrow
  // performs native word navigation/selection. The ownership gate already
  // prevents the workspace router from acting; preventing the browser default
  // here would only break the modal's legitimate editing behavior.
  if (isTextEditingTarget(event.target)) return false
  if (/^Digit[0-9]$/.test(event.code)) return true
  return BLOCKED_ALT_CODES.has(event.code)
}

function renderedAgentSurfaceIsVisible(
  workspace: Workspace,
  agentViewMode: string,
  sessionId: string,
): boolean {
  const meta = workspace.state.sessions[sessionId]
  const kind = meta?.kind
  if (!isAgentKind(kind)) return false
  return (
    getEffectiveAgentSurface({
      kind,
      providerRuntime: meta?.providerRuntime,
      mode: agentViewMode === 'terminal' || agentViewMode === 'hybrid' ? agentViewMode : 'agent',
      runtime: workspace.getRuntime(sessionId),
    }) === 'rendered'
  )
}

/**
 * Commands whose chord is owned by a surface OTHER than this router, and which
 * must therefore never be dispatched from here.
 *
 * This is a DENY-list, not an allow-list, and the difference is the whole
 * lesson of the first attempt. That version enumerated 24 routable ids while
 * Settings offered bindings for all 98 commands, so 74 rows persisted a chord,
 * displayed it, reserved it against every other command in the collision
 * checker — and did nothing when pressed. A hand-maintained allow-list cannot
 * stay in step with a growing catalog, and it silently disagreed with the
 * generated provider commands too.
 *
 * Deny-listing inverts the failure: forget an entry here and a chord is routed
 * that should have been left to the editor, which is visible immediately,
 * rather than a binding that quietly never fires.
 */
const SURFACE_OWNED_COMMAND_IDS: ReadonlySet<string> = new Set([
  // Monaco and the EditorWorkbench own ⌘S inside editor chrome, where the
  // routed path never runs (the editor guard returns before routing). Listing
  // it is belt-and-braces so a future guard change cannot hand Save to the
  // workspace router.
  'save-editor-file',
])

/**
 * Which binding contexts are live for THIS event.
 *
 * The first attempt matched on chord alone and ignored `BindingContext`
 * entirely, which killed Dispatch navigation: ⌥J resolved to the grid-context
 * `nav-down`, got preventDefault-ed, and was then refused by admission — so the
 * Dispatch handler below never ran and the selection never moved.
 *
 * Returning a SET rather than a single context is what makes that correct:
 * several contexts are genuinely live at once ('global' always, plus exactly
 * one of grid/dispatch, plus 'feed' only when a rendered feed is focused and
 * the user is not typing).
 *
 * `grid` and `dispatch` are LAYOUT contexts: they say which workspace surface
 * owns the keyboard. While the GLOBAL EDITOR owns the target it owns the
 * keyboard, so neither is live (#697).
 *
 * Read "editor" here literally: `editorOwnsTarget` matches only
 * `[data-global-editor-input-owner]`, stamped by MonacoFileEditor and
 * EditorWorkbench. The agent COMPOSER is also a text editor and deliberately
 * keeps grid/dispatch live — navigating rows and lanes while a composer has
 * focus is Dispatch's core workflow, not a bug. Chords that must survive in the
 * composer are protected by the reservation table instead. They used to stay live, and the router
 * preventDefault()s whatever it matches — so any workspace chord was swallowed
 * mid-keystroke while the user was typing into Monaco, and the editor never saw
 * the key. Cmd+Alt+Down moved Dispatch row focus instead of adding a cursor.
 *
 * WHY that mattered beyond the one chord: it forced every dispatch binding to
 * be unique against the ENTIRE app plus macOS plus Monaco, rather than just
 * against other dispatch bindings. Two attempts at a row-focus chord collided
 * (Alt+Shift+Arrow with macOS word selection, Cmd+Alt+Arrow with Monaco's
 * multi-cursor) purely because of that. Gating here reopens the space the
 * context system was supposed to provide in the first place.
 *
 * `global` deliberately stays live: top-level app commands are not workspace
 * navigation, and a user typing in a file still expects them to work.
 */
export function activeBindingContexts(input: {
  editorOwnsTarget: boolean
  feedFocused: boolean
}): ReadonlySet<BindingContext> {
  // `dispatchMode` was a parameter until #992 stage 5: it chose between the
  // 'grid' and 'dispatch' contexts, and both the parameter and 'grid' died
  // with the tile grid. The stage is the workspace, so the layout context is
  // simply live whenever the global editor does not own the target.
  const contexts = new Set<BindingContext>(['global'])
  if (!input.editorOwnsTarget) contexts.add('dispatch')
  if (input.editorOwnsTarget) contexts.add('editor')
  if (input.feedFocused) contexts.add('feed')
  return contexts
}

/**
 * The command id a keyboard event should invoke, or null.
 *
 * Built from EFFECTIVE bindings (shipped defaults overlaid with the user's
 * overrides), so the chord the palette displays and the chord that runs are the
 * same fact and a Settings edit changes real behaviour.
 *
 * `bindingIndex` is precomputed by the caller: resolving it here meant
 * rebuilding the default table and re-normalizing ~30 strings on EVERY keydown,
 * including ordinary typing.
 */
function routedCommandForEvent(
  event: KeyboardEvent,
  bindingIndex: ReadonlyMap<string, { commandId: string; context: BindingContext }[]>,
  activeContexts: ReadonlySet<BindingContext>,
  options: { textEditingTarget: boolean } = { textEditingTarget: false },
): string | null {
  const binding = keybindingFromEvent(event)
  if (!binding) return null
  // The runtime half of the macOS text-editing reservation (#992): these
  // chords belong to the OS wherever text is editable, so a binding — any
  // binding, in any context — must not receive them while a text field owns
  // the target. Clear Lane on ⌥⌫ is why this exists (delete-word is the most
  // load-bearing Option chord in a composer); the static table alone claimed
  // OS ownership without enforcing it, which is how Alt+Shift+Arrow broke
  // composer selection for years while the checker stayed green.
  if (options.textEditingTarget && isMacosTextEditingChord(binding)) return null
  for (const entry of bindingIndex.get(binding) ?? []) {
    if (SURFACE_OWNED_COMMAND_IDS.has(entry.commandId)) continue
    if (!activeContexts.has(entry.context)) continue
    return entry.commandId
  }
  return null
}

/** The only context a chord may fire in while a surface owns the interaction.
 *  See the exemption in the handler for why this is not the live context set. */
const GLOBAL_CONTEXT_ONLY: ReadonlySet<BindingContext> = new Set<BindingContext>(['global'])

/** Spotlight renders a real TileLeaf, so its visible feed retains feed-scoped
 *  commands even though the hidden Grid/Dispatch layout does not. */
const GLOBAL_AND_FEED_CONTEXTS: ReadonlySet<BindingContext> = new Set<BindingContext>([
  'global',
  'feed',
])

// WHY these are explicit fail-closed ownership lists instead of every command
// in the admitted contexts: `global` includes tab, pane, split, and layout
// mutations whose targets remain hidden behind a focus takeover. Reader has no
// interactive TileLeaf, so only its dismissal and the Command Palette entry
// point belong to its visible surface. Spotlight does render a TileLeaf; Tail
// and Jump Latest therefore act on content the user can actually see. A future
// command must make the same visible-owner case before crossing this boundary.
const READER_FOCUS_MODE_COMMAND_IDS: ReadonlySet<string> = new Set([
  'toggle-reader-mode',
  'open-command-palette',
])
const SPOTLIGHT_FOCUS_MODE_COMMAND_IDS: ReadonlySet<string> = new Set([
  'toggle-spotlight',
  'open-command-palette',
  'toggle-tail',
  'jump-latest-message',
])

/** Chord -> candidate commands, built once per override change. */
function buildBindingIndex(
  overrides: Record<string, string[]>,
  // Extension-contributed defaults, concatenated onto the shipped table. A user
  // override still wins (resolveEffectiveKeybindings applies overrides on top of
  // whatever defaults it is handed), so this is the ONE site that actually makes
  // an extension's declared chord fire — the editor/sheet/palette only display it.
  extensionDefaults: CommandBindingDefault[],
): Map<string, { commandId: string; context: BindingContext }[]> {
  const index = new Map<string, { commandId: string; context: BindingContext }[]>()
  // Extension declarations join the shipped defaults before resolution, so a
  // user's persisted override can replace either source through one contract.
  // Customized entries then lead the candidate list: a later Agent Code release
  // may ship a default on a chord the user already assigned (#936), and install
  // order must not silently take that explicit choice away.
  const effective = resolveEffectiveKeybindings(overrides, [
    ...buildDefaultKeybindings(),
    ...extensionDefaults,
  ])
  for (const entry of [...effective.filter(item => item.customized), ...effective.filter(item => !item.customized)]) {
    for (const binding of entry.bindings) {
      const list = index.get(binding) ?? []
      list.push({ commandId: entry.commandId, context: entry.context })
      index.set(binding, list)
    }
  }
  return index
}

/**
 * Any Monaco editor, not just the global editor's.
 *
 * WHY the class and not only `[data-global-editor-input-owner]` (#1045 Codex
 * review): a transcript code block is a real Monaco instance created by
 * lib/code/CodeBlock.tsx, and it carries no global-editor marker. It still
 * owns Cmd+Shift+G as Find Previous — Monaco binds that action on read-only
 * editors too — so a guard that only knew the global editor let the goal-loop
 * overlay latch over a code block in the ordinary feed and swallow every key
 * after it. `.monaco-editor` is Monaco's own root class, so this covers every
 * instance the app mounts, present and future.
 */
const MONACO_TARGET_SELECTOR = '[data-global-editor-input-owner], .monaco-editor'

export function useKeybinds(
  workspace: Workspace,
): void {
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const requestCommandInvocation = useAppStore(state => state.requestCommandInvocation)
  const commandKeybindingOverrides = useAppStore(
    state => state.settings.commandKeybindingOverrides,
  )
  const installedExtensions = useAppStore(state => state.installedExtensions)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  // The placement overlay is opened from TWO independent flows:
  // - newAgentPlacementOpen: the new-agent kind picker
  // - linkedAgentParentId: linked-agent kind picker
  // usePlacementOverlay unifies them and closes them together. We must
  // subscribe to both here — an earlier revision only checked
  // newAgentPlacementOpen, so cmd+W / cmd+1..9 / alt+d still
  // mutated the workspace under the sibling overlay mode before the
  // overlay's own listener could stop propagation. See PR #75 review.
  // (A third flow, attach-detached-to-grid, died with the tile tree in #992.)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  const closeLinkedAgent = useAppStore(state => state.closeLinkedAgent)
  // Reorder Tabs and Pin Agents are modal overlays with their own
  // internal onKeyDown handlers. Without bailing out here, the
  // global capture-phase handler still fires cmd+1..9 / cmd+t /
  // alt+d / cmd+W underneath the modal — which mutates the
  // workspace while the user is in a "transient draft" UI that
  // promises Escape-cancellation. Mirror the placement bailout:
  // consume Escape, swallow shortcut chords, drop everything else.
  const reorderTabsOpen = useAppStore(state => state.reorderTabsOpen)
  const closeReorderTabs = useAppStore(state => state.closeReorderTabs)
  const pinAgentsOpen = useAppStore(state => state.pinAgentsOpen)
  const closePinAgents = useAppStore(state => state.closePinAgents)

  // Extension keybinding defaults, derived from installed manifests (no bundle
  // import). Recomputed only when the installed set changes, so an install/remove
  // makes a contributed chord start/stop firing without a reload.
  //
  // ── THE `?? []` IS NOT DEFENSIVE NOISE ──
  // This hook owns the global keydown router: if it throws during render, the
  // application has no keyboard at all, and it throws before anything can catch
  // it usefully. That is the same shape as the persist-version bug that
  // black-screened launch twice (#249) — a store slice that was expected to exist
  // and did not. Extension state is the newest slice and the one most likely to be
  // absent from a partially-restored or partially-mocked store, so the core
  // keyboard path degrades to "no contributed chords" instead of taking the app
  // down with it. Nothing else in this hook has an opinion about extensions.
  const extensionKeybindings = useMemo(
    () => deriveExtensionKeybindings(installedExtensions ?? []),
    [installedExtensions],
  )

  // Built once per override change, not per keystroke. Resolving inside the
  // handler meant rebuilding the default table and re-normalizing ~30 strings
  // on every keydown, including ordinary typing.
  const bindingIndex = useMemo(
    () => buildBindingIndex(commandKeybindingOverrides, extensionKeybindings),
    [commandKeybindingOverrides, extensionKeybindings],
  )

  useEffect(() => {
    if (!installedExtensions?.length) return
    // Main must suppress Chromium/menu defaults synchronously for owned chords
    // inside extension documents. Mirror the existing resolver's grammar, while
    // command/context admission still runs through this hook after forwarding.
    // Feed/editor-only bindings are not meaningful in an extension document.
    //
    // OS text-editing chords (⌥⌫, the Shift-selection chords) are NEVER
    // forwarded (#1013 review B). Main captures a forwarded chord natively,
    // and the event re-dispatched to this document targets the <iframe>, so
    // isTextEditingTarget cannot see that an input inside the extension had
    // focus. ⌥⌫ in an extension's text field then cleared the lane instead of
    // deleting a word. The host yields these chords to text fields
    // (routedCommandForEvent), and an extension frame cannot say whether it
    // has one, so it keeps them.
    // ('grid' was a context here until the tile tree died with #992.)
    const bindings = [...bindingIndex].filter(([binding, entries]) => !isMacosTextEditingChord(binding) && entries.some(entry =>
      !SURFACE_OWNED_COMMAND_IDS.has(entry.commandId) && ['global', 'dispatch'].includes(entry.context),
    )).map(([binding]) => binding)
    // These are the fixed workspace interactions below, not palette commands.
    // The number-row continuation includes zero (two-digit index rows).
    for (let digit = 0; digit <= 9; digit++) bindings.push(`Cmd+${digit}`, `Cmd+Alt+${digit}`)
    // The fn+alt+arrow / alt+= / alt+- resize chords were forwarded here until
    // the tile tree died (#992); nothing resizes splits any more.
    const modal = [...bindingIndex].filter(([, entries]) => entries.some(entry => ['open-command-palette', 'close-pane'].includes(entry.commandId))).map(([binding]) => binding)
    // Suppress native window-close defaults even when the user unbinds pane
    // close. The existing modal gate decides whether there is an app action.
    modal.push('Cmd+W', 'Cmd+Shift+W')
    void window.api.extensionsSetInputBindings({ pane: [...new Set(bindings)], modal: [...new Set(modal)] }).catch(error => console.warn('[extensions] native input configuration failed:', error))
    return () => { void window.api.extensionsSetInputBindings({ pane: [], modal: [] }).catch(() => {}) }
  }, [bindingIndex, installedExtensions?.length])

  const tldrHoldRef = useRef<ReturnType<typeof createTldrHoldController> | null>(null)
  // WHY the blind-watcher case reaches a TOAST and not just the journal
  // (#1066 review finding 1): a packaged user never reads a console line or a
  // debug bundle, and the peek quietly changing which key releases it is
  // exactly the kind of thing that reads as "broken" with no explanation.
  // `useDictationHotkeySync` set this precedent for the sibling failure —
  // main journals it, the toast is the surface the user actually looks at —
  // and the first version of this fix copied only main's half.
  //
  // Fired at most once per hook instance, from a signal main only sends after
  // corroborating the permission, so a fast tap cannot toast.
  const { showToast } = useGlobalToast()
  const warnedUnobservableRef = useRef(false)
  if (!tldrHoldRef.current) {
    tldrHoldRef.current = createTldrHoldController(undefined, observeTldrHoldRelease, () => {
      if (warnedUnobservableRef.current) return
      warnedUnobservableRef.current = true
      showToast(
        'Hold-to-peek cannot watch the keyboard, so the peek now follows the Command key '
        + 'instead of the letter. Grant Agent Code Accessibility permission in System '
        + 'Settings → Privacy & Security → Accessibility to restore it.',
        12000,
      )
    })
  }
  // Workspace membership/focus can change during a hold. Keep the gesture
  // alive across handler re-registration; only actual key release, blur or
  // hook unmount ends it.
  useEffect(() => () => { tldrHoldRef.current?.release(); dismissTldr() }, [])
  useEffect(() => {
    let pendingDispatchDigit: number | null = null
    let pendingDispatchDigitTimer: number | null = null

    const clearPendingDispatchDigit = () => {
      pendingDispatchDigit = null
      if (pendingDispatchDigitTimer !== null) {
        window.clearTimeout(pendingDispatchDigitTimer)
        pendingDispatchDigitTimer = null
      }
    }

    const rememberDispatchDigit = (digit: number) => {
      pendingDispatchDigit = digit
      if (pendingDispatchDigitTimer !== null) {
        window.clearTimeout(pendingDispatchDigitTimer)
      }
      pendingDispatchDigitTimer = window.setTimeout(() => {
        pendingDispatchDigit = null
        pendingDispatchDigitTimer = null
      }, 650)
    }

    const tldrHold = tldrHoldRef.current!
    const handler = (e: KeyboardEvent) => {
      const tldrView = useTldrView.getState()
      // WHY a latch needs a MOUNTED overlay to own input (#1027), exactly like
      // the goal-loop latch below (#1021): the latch is one app-wide flag, but
      // an overlay exists only inside a visible TldrPane. There is none in a
      // terminal-only tab or in Spotlight on a shell, and TldrOverlay renders
      // nothing in a pane hidden by Reader, Settings or the fullscreen editor.
      // Running TLDR or Goal from the palette there showed nothing and froze
      // all typing until Escape. Input ownership follows the mounted DOM
      // (lib/interaction-ownership.ts). A latch with nothing mounted is
      // stale: drop it and route this key normally.
      //
      // A HELD peek is exempt: it lasts only while the key is physically
      // down, and the keyup listener ends it however the gate behaves.
      if (tldrView.latched && !tldrView.held && document.querySelector('[data-tldr-overlay],[data-goal-overlay]') == null) {
        dismissTldr()
      } else if (tldrView.held || tldrView.latched) {
        // The dimmed composer must never receive typing, including repeated
        // Option-letter chords after a user rebinds this command. Release is
        // handled by the independent keyup listener, even while this gate owns
        // all keydown input.
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') {
          tldrHold.release()
          dismissTldr()
        }
        return
      }
      // The goal loop overlay is a latched blocking surface that stamps the
      // interaction-owner marker, so the router's ownership branch below would
      // swallow every chord — including goal-loop-preview itself, which is not
      // in SURFACE_OWNER_FLAGS (its latch lives in a feature store, not
      // uiShell). Dismiss here instead, before that gate, exactly like the
      // TLDR latch above: Escape and the toggle chord are the exits.
      //
      // WHY the gate requires the overlay to be MOUNTED, not just the latch
      // (#1021): the latch is one app-wide store flag, but an overlay exists
      // only where a GoalLoopPane is mounted, and none is mounted in a
      // terminal-only or empty tab. Gating on the flag alone swallowed every
      // key with nothing on screen, including the palette chord, the composer
      // and the terminal. The owner hit exactly that: "I cannot type anything,
      // I can basically do nothing." lib/interaction-ownership.ts is the
      // contract: input ownership follows the mounted DOM, never store state.
      // A latch with no mounted overlay is stale by definition, so drop it and
      // route this key normally rather than leave it armed for the next
      // surface to trip over.
      if (useGoalLoopView.getState().latched) {
        if (document.querySelector('[data-goal-loop-overlay]') == null) {
          dismissGoalLoop()
          // The toggle chord on a stale latch means "turn it off". Letting it
          // fall through would run goal-loop-preview again and RE-arm the
          // latch with nothing to show, so every press in a terminal-only tab
          // flipped an invisible flag that a later mouse tab switch then
          // turned into an overlay out of nowhere (#1021 review).
          //
          // ...unless editor chrome owns the target: the chord is Monaco's
          // Find Previous there (#1045 review), and the latch is already off,
          // so consuming the key would cost one find per stale latch and buy
          // nothing. Falling through leaves it to the editor, which is what
          // the routed path below does for the same reason.
          const editorOwnsStaleChord =
            e.target instanceof Element && e.target.closest(MONACO_TARGET_SELECTOR) !== null
          if (!editorOwnsStaleChord && routedCommandForEvent(e, bindingIndex, GLOBAL_CONTEXT_ONLY) === 'goal-loop-preview') {
            e.preventDefault()
            e.stopPropagation()
            return
          }
        } else {
          e.preventDefault()
          e.stopPropagation()
          // The toggle chord comes from the binding index rather than a
          // hardcoded chord literal. Otherwise rebinding goal-loop-preview
          // (#1007 moved it off ⌘⇧Y, which macOS reserves for the New Sticky
          // Note service) would silently remove the chord exit and leave
          // Escape as the only way out.
          // GLOBAL_CONTEXT_ONLY for the same reason as the ownership branch
          // below: an overlay owns the screen, so only an app-wide chord can
          // mean "dismiss the thing in front of me".
          if (e.key === 'Escape' || routedCommandForEvent(e, bindingIndex, GLOBAL_CONTEXT_ONLY) === 'goal-loop-preview') {
            dismissGoalLoop()
          }
          return
        }
      }
      const cmd = e.metaKey
      const alt = e.altKey
      const shift = e.shiftKey
      const k = e.key

      // App-owned dialogs/takeovers get the whole interaction turn. This gate
      // must precede every workspace shortcut because the listener runs in
      // capture phase, before a focused modal control can stop propagation.
      // Do not stop propagation here: the owning surface still needs Escape,
      // Enter, arrows, and normal form input. Only prevent browser/Electron
      // defaults for chords that Agent Code itself claims (Cmd+W is the
      // important one — otherwise macOS closes the window after we return).
      if (hasAppInteractionOwner()) {
        // ONE exemption: the chord that owns the surface currently holding the
        // interaction. Pressing ⌘⇧U while Usage is up is unambiguously "dismiss
        // Usage" — it cannot be a stray shortcut leaking into a modal, because
        // the modal is the thing this command controls.
        //
        // Without this, every toggle written in a command body is unreachable
        // by keyboard: the second press never gets past this gate, so the
        // command's `run` is never called. That is why ⌥R Reader and ⌥S
        // Spotlight round-trip today while ⌘⇧U does not — the former render
        // inline and stamp no owner marker, the latter is a Radix dialog. The
        // difference was never in the commands.
        //
        // Context is deliberately 'global' only. A surface owns the screen, so
        // a grid- or dispatch-scoped binding has no business firing underneath
        // it; only an app-wide chord can mean "dismiss the thing in front of
        // me".
        const dismissCommandId = routedCommandForEvent(e, bindingIndex, GLOBAL_CONTEXT_ONLY)
        const extensionModal = e.target instanceof HTMLIFrameElement && e.target.dataset.extensionShell === 'modal'
        if (extensionModal && dismissCommandId === 'close-pane') {
          e.preventDefault()
          // This is a host DOM event on the owned iframe element. It closes the
          // modal surface, never the workspace pane hidden underneath it.
          e.target.dispatchEvent(new Event('agent-code-extension-close'))
          return
        }
        if (extensionModal && dismissCommandId === 'open-command-palette') {
          e.preventDefault()
          requestCommandInvocation(dismissCommandId, 'keybinding')
          return
        }
        if (dismissCommandId && commandOwnsOpenSurface(dismissCommandId, useAppStore.getState())) {
          e.preventDefault()
          requestCommandInvocation(dismissCommandId, 'keybinding')
          return
        }
        if (shouldPreventOwnedApplicationShortcut(e)) e.preventDefault()
        return
      }
      // Unified placement-overlay predicate — matches App.tsx's
      // `placementOverlayOpen` so create, attach, and linked-agent
      // modes share one keyboard bailout.
      const placementOverlayOpen =
        newAgentPlacementOpen || linkedAgentParentId !== null

      // Placement overlay (create-new, attach-detached, or linked
      // agent) and the two draft modals (reorder / pin) all share
      // the same shape:
      // a transient UI with its own onKeyDown that owns Enter /
      // Space / Arrow / j / k, plus Escape-to-cancel. Three things
      // we must do here in the global capture handler:
      //   1. Consume Escape so it closes the modal even when the
      //      modal's inner div has lost focus.
      //   2. preventDefault on shortcut chords (cmd / alt). Without
      //      this, returning early stops Agent Code's handler but
      //      not the macOS / Electron defaults — cmd+W would still
      //      close the window, cmd+T would still open a new tab in
      //      Electron, alt+number cycles tab focus on some setups.
      //      preventDefault on chords blocks those defaults while
      //      still letting the event bubble to the modal's React
      //      onKeyDown for navigation keys.
      //   3. Drop unmodified keys (j/k/Space/Enter/etc) — the
      //      modal's own onKeyDown handles those via React bubble.
      if (placementOverlayOpen || reorderTabsOpen || pinAgentsOpen) {
        if (k === 'Escape') {
          e.preventDefault()
          if (newAgentPlacementOpen) closeNewAgentPlacement()
          if (linkedAgentParentId !== null) closeLinkedAgent()
          if (reorderTabsOpen) closeReorderTabs()
          if (pinAgentsOpen) closePinAgents()
          return
        }
        if (cmd || alt) {
          e.preventDefault()
        }
        return
      }

      const eventElement = e.target instanceof Element ? e.target : null
      const editorOwnsTarget = Boolean(eventElement?.closest('[data-global-editor-input-owner]'))
      if (editorOwnsTarget) {
        const monacoOwnsTarget = Boolean(eventElement?.closest('[data-global-editor-monaco]'))
        // On macOS Option is a text-composition modifier (⌥D → ∂, etc.). Every
        // unclaimed Option chord must remain in the editor surface; falling
        // through can split/close/navigate the hidden workspace while the user
        // is simply typing into Monaco.
        if (alt && !cmd) return
        const plainEditorCommand = cmd && !shift && !alt && ['s', 'w', '[', ']'].includes(k)
        if (plainEditorCommand) {
          // Monaco and EditorWorkbench handle save/close in bubble phase. The
          // remaining chords have no useful native meaning in editor chrome;
          // suppress browser history/navigation there while still allowing
          // Monaco's own keybinding service to consume them.
          if (!monacoOwnsTarget && (k === '[' || k === ']')) {
            e.preventDefault()
          }
          return
        }
      }
      const fullscreenEditorOwnsWorkspace =
        useAppStore.getState().globalEditorOpen && useGlobalEditorStore.getState().editorFullscreen
      const hiddenWorkspaceShortcut =
        (cmd && !alt && e.code === 'KeyW') ||
        (alt && !cmd && shouldPreventOwnedApplicationShortcut(e))
      if (
        fullscreenEditorOwnsWorkspace &&
        !editorOwnsTarget &&
        hiddenWorkspaceShortcut
      ) {
        // Fullscreen deliberately hides the workspace, but the workspace's
        // global capture router remains mounted. Swallow its destructive pane
        // grammar when focus sits in app chrome outside the workbench. This
        // MUST use the same finite allow-list as the router: blanket-swallowing
        // Alt also captures OS chords such as Alt+F4/Alt+Tab on Windows/Linux,
        // even though Agent Code has no action to protect for those keys.
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // --- Copy Assistant picker (Up/Down/Enter/Esc) ---
      //
      // Active when the focused pane's runtime has assistantPicker set.
      // Capture all four keys here so the focused composer doesn't
      // receive them. Picker dismisses on Enter (after copy) and Esc
      // (without copy); arrow keys move the selection. Lives BEFORE
      // the Spotlight Esc handler so picker-Esc wins when both modes
      // are active (shouldn't happen — picker is feed-only — but the
      // ordering keeps the intent local).
      const focusedSessionId = commandTargetSessionId(workspace)
      const renderedPickerSurfaceVisible = focusedSessionId
        ? renderedAgentSurfaceIsVisible(workspace, agentViewMode, focusedSessionId) &&
          !workspace.spotlight &&
          workspace.readerMode === null &&
          !settingsPageOpen
        : false
      const picker = focusedSessionId ? workspace.runtimes[focusedSessionId]?.assistantPicker : null
      if (picker && focusedSessionId && renderedPickerSurfaceVisible) {
        if (k === 'ArrowUp') {
          e.preventDefault()
          workspace.pickerMove(focusedSessionId, -1)
          return
        }
        if (k === 'ArrowDown') {
          e.preventDefault()
          workspace.pickerMove(focusedSessionId, +1)
          return
        }
        if (k === 'Enter') {
          e.preventDefault()
          void workspace.pickerConfirm(focusedSessionId)
          return
        }
        if (k === 'Escape') {
          e.preventDefault()
          workspace.pickerCancel(focusedSessionId)
          return
        }
        // Other keys fall through — typing into the composer doesn't
        // cancel the picker. If we want "any keystroke cancels",
        // that's a one-line follow-up.
      }

      // --- Copy Code Block picker (Up/Down/Enter/Esc) ---
      //
      // Parallel to the Copy Assistant picker above, but the ordered
      // list of selectable items is enumerated from the DOM, not the
      // transcript: code blocks have no transcript identity, so
      // `enumerateCodeBlockIds` reads `[data-code-block-id]` nodes
      // within the focused pane in document order. The store only
      // parks the current `selectedId`. Only one picker is ever
      // active at a time (each command toggles its own), so this
      // block and the assistant block can't both fire.
      const cbPicker = focusedSessionId
        ? workspace.runtimes[focusedSessionId]?.codeBlockPicker
        : null
      if (cbPicker && focusedSessionId && renderedPickerSurfaceVisible) {
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          e.preventDefault()
          const ids = enumerateCodeBlockIds(focusedSessionId)
          if (ids.length === 0) {
            // Every block unmounted under the picker — close it
            // rather than leave a selection pointing at nothing.
            workspace.setCodeBlockPicker(focusedSessionId, null)
            return
          }
          const cur = ids.indexOf(cbPicker.selectedId)
          // Down = toward newer (document order runs oldest→newest,
          // so the last id is the most recent block). If the selected
          // block vanished mid-pick, snap to the newest available —
          // same recovery the assistant picker does for a stale uuid.
          const dir = k === 'ArrowDown' ? 1 : -1
          const nextIdx =
            cur === -1 ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, cur + dir))
          workspace.setCodeBlockPicker(focusedSessionId, {
            selectedId: ids[nextIdx],
          })
          return
        }
        if (k === 'Enter') {
          e.preventDefault()
          const code = getCodeBlockCode(cbPicker.selectedId)
          // Clear the picker first so the UI returns to normal even
          // if the clipboard write rejects (mirrors pickerConfirm).
          workspace.setCodeBlockPicker(focusedSessionId, null)
          if (code == null) {
            workspace.showPaneToast(focusedSessionId, 'Nothing to copy')
          } else {
            void navigator.clipboard.writeText(code).then(
              () => workspace.showPaneToast(focusedSessionId, 'Copied code block'),
              () => workspace.showPaneToast(focusedSessionId, 'Clipboard write failed'),
            )
          }
          return
        }
        if (k === 'Escape') {
          e.preventDefault()
          workspace.setCodeBlockPicker(focusedSessionId, null)
          return
        }
        // Other keys fall through, same as the assistant picker.
      }

      if (k === 'Escape' && workspace.spotlight && !fullscreenEditorOwnsWorkspace) {
        e.preventDefault()
        workspace.toggleSpotlight()
        return
      }

      // Esc also exits Reader Mode. Same one-key dismiss pattern as
      // Spotlight — both are read-only "fullscreen" overlays the user
      // expects to bail out of with Escape.
      if (k === 'Escape' && workspace.readerMode && !fullscreenEditorOwnsWorkspace) {
        e.preventDefault()
        workspace.toggleReaderMode()
        return
      }

      if (k === 'Escape' && settingsPageOpen) {
        e.preventDefault()
        closeSettingsPage()
        return
      }

      // The goal loop overlay is not a hold gesture, so it does not share the
      // TLDR hold path below — but it shares that path's editor rule, and for
      // the same reason: Monaco owns Cmd+Shift+G as Find Previous exactly as it
      // owns Cmd+G as Find Next and Cmd+L as Select Line (#1045 review
      // reproduced the collision — the overlay latched on top of Monaco's find,
      // and the latch gate then swallowed every keystroke until Escape).
      // Yielding means returning WITHOUT preventDefault, so the editor's own
      // handler still runs.
      const editorOwnsRoutedCommand = (commandId: string | null): boolean =>
        commandId === 'goal-loop-preview'
        && (fullscreenEditorOwnsWorkspace || (eventElement?.closest(MONACO_TARGET_SELECTOR) ?? null) !== null)

      const handleTldrHold = (commandId: string | null): boolean => {
        // Goal (#936) shares TLDR's synchronous hold path, including the
        // Spotlight admission below and the editor yield: Monaco owns Cmd+G as
        // Find Next exactly as it owns Cmd+L as Select Line.
        const preview = commandId === 'tldr-preview' ? 'tldr' : commandId === 'goal-preview' ? 'goal' : null
        if (!preview) return false
        // The editor owns Select Line, including after a rebind. Both ordinary
        // panes and Spotlight must start synchronously: queueing the palette
        // toggle could reopen the preview after keyup, leaving it latched.
        if (!editorOwnsTarget && !fullscreenEditorOwnsWorkspace) {
          e.preventDefault()
          e.stopPropagation()
          tldrHold.start(e, preview)
        }
        return true
      }

      // Reader and Spotlight are inline full-screen takeovers rather than
      // Radix dialogs, so they deliberately do not stamp the DOM interaction-
      // owner marker handled at the top of this router. Their workspace state
      // remains live underneath them, though, and that makes the ordinary
      // grid/Dispatch contexts a lie while either takeover is visible: the
      // user cannot see the pane or row those shortcuts would mutate.
      //
      // WHY this gate lives before BOTH configured commands and the legacy
      // Dispatch grammar: Reader's Option+Arrow listener calls
      // preventDefault(), but another capture listener on the same document
      // still runs. Checking defaultPrevented or stopping propagation would
      // make correctness depend on React effect/listener registration order.
      // This router instead declines ownership structurally, while leaving the
      // event propagating so Reader's own older/newer handler can consume it.
      //
      // Admission is intentionally narrower than context matching. Reader
      // keeps its palette entry point because Reply to Selection is designed
      // to be invoked from that palette. Spotlight additionally keeps the
      // session/feed commands owned by its mounted TileLeaf. Everything else
      // still returns before hidden layout grammars. Escape is handled above.
      const focusModeCommandIds = workspace.readerMode
        ? READER_FOCUS_MODE_COMMAND_IDS
        : workspace.spotlight
          ? SPOTLIGHT_FOCUS_MODE_COMMAND_IDS
          : null
      if (focusModeCommandIds) {
        const focusModeContexts = workspace.spotlight
          && focusedSessionId
          && renderedAgentSurfaceIsVisible(workspace, agentViewMode, focusedSessionId)
          && !isTextEditingTarget(e.target)
          ? GLOBAL_AND_FEED_CONTEXTS
          : GLOBAL_CONTEXT_ONLY
        const focusModeCommandId = routedCommandForEvent(
          e,
          bindingIndex,
          focusModeContexts,
        )
        // Spotlight owns a mounted agent pane and its TLDR overlay. Reader
        // does not, so it keeps its existing narrow shortcut admission. This
        // special path shares the hold controller, not the async toggle list.
        if (workspace.spotlight && !workspace.readerMode && handleTldrHold(focusModeCommandId)) return
        if (focusModeCommandId && focusModeCommandIds.has(focusModeCommandId)) {
          e.preventDefault()
          requestCommandInvocation(focusModeCommandId, 'keybinding')
          return
        }
        if (shouldPreventOwnedApplicationShortcut(e)) e.preventDefault()
        return
      }

      // --- Configured command bindings ---
      //
      // POSITION IS THE FIX. This used to sit near the top of the handler,
      // above the editor-ownership guard and above every legacy chord branch,
      // which produced three regressions at once: ⌘W inside Monaco killed the
      // agent pane behind the editor, bare End in a composer scrolled the feed
      // instead of moving the caret, and ⌘[ / ⌘] stole Monaco's indent.
      //
      // Everything that OWNS an interaction now runs first — app modals,
      // placement overlays, editor chrome, the assistant/code-block pickers,
      // and Escape. Only then do configured bindings get a look.
      //
      // What remains BELOW is contextual interaction that is deliberately not a
      // command: numbered tab/Dispatch selection, the tiled-resize
      // continuation, Dispatch row/lane movement, and split resizing. Those are
      // reached because the context filter refuses to match a grid-context
      // binding while Dispatch owns the layout, so ⌥J falls through to the
      // Dispatch handler instead of being swallowed and refused.
      const activeContexts = activeBindingContexts({
        // The stage is the workspace (#992): the layout context is always
        // 'dispatch' now — the 'grid' it alternated with and the
        // `dispatchMode` flag that chose both died with the tile tree.
        editorOwnsTarget,
        // 'feed' is live only when a rendered feed is focused AND the user is
        // not typing — which is what keeps bare End as a caret key in every
        // composer while still jumping the feed elsewhere.
        feedFocused: Boolean(
          focusedSessionId
          && renderedAgentSurfaceIsVisible(workspace, agentViewMode, focusedSessionId)
          && !isTextEditingTarget(e.target),
        ),
      })
      const routedCommandId = routedCommandForEvent(e, bindingIndex, activeContexts, {
        textEditingTarget: isTextEditingTarget(e.target),
      })
      if (handleTldrHold(routedCommandId)) return
      if (editorOwnsRoutedCommand(routedCommandId)) return
      if (routedCommandId) {
        e.preventDefault()
        requestCommandInvocation(routedCommandId, 'keybinding')
        return
      }

      // --- CMD: tab management ---
      if (cmd && alt && !shift) {
        const digit = digitFromKeyboardEvent(e)
        if (digit !== null) {
          e.preventDefault()
          workspace.activateTabByIndex(digit - 1)
          return
        }
      }

      // --- CMD: tab management ---
      if (cmd && !alt) {
        // In the unified layout the numbered command grammar is always
        // "session row N" — the lane grid is the only workspace. Tab
        // switching remains available via cmd-[ / ]. The row labels keep
        // their project letter (A/B/C) for orientation, but the numeric
        // suffix is global in the visible index.
        {
          const digit = digitFromKeyboardEvent(e, {
            includeZero: pendingDispatchDigit !== null,
          })
          if (digit !== null) {
            e.preventDefault()
            if (!e.repeat) {
              // cmd-N fills the FOCUSED LANE. Row index semantics come from
              // buildVisibleDispatchRows via focusedLaneRowScopedRows, exactly as
              // the visible chips do.
              const selectRow = (index: number) => focusRowByLabel(workspace, index)
              const combined =
                pendingDispatchDigit !== null ? pendingDispatchDigit * 10 + digit : null
              if (combined !== null && combined >= 10 && combined <= 99) {
                selectRow(combined - 1)
                clearPendingDispatchDigit()
              } else if (digit > 0) {
                selectRow(digit - 1)
                rememberDispatchDigit(digit)
              }
            }
            return
          }
        }
        // A plain "cmd-1..9 → tab index" branch used to follow. It became
        // unreachable the day the lane grid became the only workspace: the row
        // grammar above consumes every digit. Projects keep ⌘⌥1..9.
      }

      // The lane arrows (⌥↑/↓ index walk, ⌥←/→ lane focus, ⌥H/J/K/L
      // aliases) lived here as an inline `alt && !cmd` branch from #687 until
      // the unified layout re-homed keyboard (#992 stage 5, the debt #681
      // §7.1 filed). They are registered commands now — rebindable, visible
      // in the shortcuts surface, routed by the binding table above — so the
      // branch is gone. Two things the branch used to do are worth recording:
      //
      // 1. It consumed Alt+Shift+Arrow as if it were the bare arrow (the
      //    `alt && !cmd` test never checked shift), silently breaking macOS
      //    word-selection in every composer. The binding grammar is
      //    exact-match, so registering the BARE chords fixed that by accident
      //    of correctness rather than by a guard someone could remove.
      //
      // 2. Split resizing (fn+alt+arrow, alt+= / alt+-) lived under the same
      //    branch until the tile tree died. RESERVED-CHORD RECORD, kept
      //    because it is the only place the fact is written down and
      //    check:keybindings cannot see it: Option+Shift+Arrow is the macOS
      //    system shortcut for word-by-word text selection and is load-bearing
      //    for every text field in the app (including our composer). It was
      //    tried for directional resize, broke selection, and was replaced by
      //    fn+alt+arrow. Never bind it. (The runtime yield in
      //    routedCommandForEvent enforces this family for registered chords
      //    too — see isMacosTextEditingChord.)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      tldrHold.keyUp(e)
      if (e.key === 'Meta') {
        clearPendingDispatchDigit()
      }
    }

    const onBlur = () => {
      tldrHold.release()
      dismissTldr()
      // Same as the TLDR latch: a blocking overlay must not survive the
      // user leaving the window. Switching apps and coming back is a common
      // way to try to "unstick" an app, and before #1021 it did nothing here.
      dismissGoalLoop()
      clearPendingDispatchDigit()
    }

    // capture: true — run BEFORE focused input sees the key. Without
    // this, the input would consume keys like 'd', 'h', etc. before
    // our handler fires.
    document.addEventListener('keydown', handler, { capture: true })
    document.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    const onVisibility = () => { if (document.hidden) onBlur() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearPendingDispatchDigit()
      document.removeEventListener('keydown', handler, { capture: true })
      document.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [
    agentViewMode,
    closeSettingsPage,
    closeNewAgentPlacement,
    closeLinkedAgent,
    closeReorderTabs,
    closePinAgents,
    linkedAgentParentId,
    newAgentPlacementOpen,
    pinAgentsOpen,
    reorderTabsOpen,
    settingsPageOpen,
    workspace,
  ])
}

function digitFromKeyboardEvent(
  e: KeyboardEvent,
  options: { includeZero?: boolean } = {},
): number | null {
  if (options.includeZero && e.code === 'Digit0') return 0
  if (/^Digit[1-9]$/.test(e.code)) {
    return Number(e.code.slice('Digit'.length))
  }
  if (options.includeZero && e.key === '0') return 0
  const digit = parseInt(e.key, 10)
  return !Number.isNaN(digit) && digit >= 1 && digit <= 9 ? digit : null
}


// ---- Lane-grid keybind helpers ----
//
// Dispatch selection targets the FOCUSED LANE and writes through
// selectTiledLaneSession, so cmd-N / arrows fill the focused lane
// (duplicates across lanes are allowed) — and wake a hibernated agent
// first, which the raw lane writer never did (#690).
//
// The classic-Dispatch companions (focusDispatchRowByIndex,
// moveDispatchSelection — single-focus, no lanes) were deleted with the
// classic layout: with the lane grid as the only workspace there is no
// surface left for single-focus selection to act on.


