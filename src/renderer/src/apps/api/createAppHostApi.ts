import { useAppStore } from '@renderer/app-state/hooks'
// This API needs the tree traversal, not the workspace hook's compatibility
// barrel. That barrel imports the complete provider/editor UI and makes a
// standalone extension host initialize unrelated application modules.
import { isSidekickSession } from '@renderer/workspace/sessionOwnership'
import { resolveTabSessions } from '@renderer/workspace/queries'

import type { AgentCodeApiV1, JsonValue } from '@renderer/apps/api/types'
import { projectSessionStatus, sessionStatusSignature } from '@renderer/apps/api/sessionStatus'
import { CUSTOM_APPEARANCE_CSS_VARS } from '@renderer/app-state/settings/customAppearance'

// Discovering which `--theme-*` custom properties exist requires walking every
// stylesheet rule, which is O(all CSS in the app). The NAMES are fixed at build
// time — a theme change rewrites values on :root, it never invents a new token —
// so the expensive half runs once per renderer lifetime and only the cheap
// getPropertyValue lookups repeat.
let cachedTokenNames: string[] | null = null

// Tokens the host assigns at RUNTIME via root.style.setProperty, which therefore
// appear in NO stylesheet — walking document.styleSheets cannot find them however
// thorough the walk. Source of truth: app-state/settings/theme.ts (applyTheme).
// There is no automated link between the two; this comment is the link.
const RUNTIME_ONLY_TOKENS = [
  '--theme-accent',
  '--theme-accent-fg',
  '--theme-app-font',
  '--theme-font-code',
] as const

function themeTokenNames(): string[] {
  if (cachedTokenNames) return cachedTokenNames

  // A selected contributed palette can be applied inline before any stylesheet
  // declares its tokens. Seed the canonical appearance vocabulary rather than
  // letting first-call stylesheet timing permanently omit those colors from a
  // cached API snapshot. The scan still discovers additional non-color tokens.
  const names = new Set<string>([...RUNTIME_ONLY_TOKENS, ...Object.values(CUSTOM_APPEARANCE_CSS_VARS)])
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // Cross-origin stylesheet — the Google Fonts @import in styles.css is one.
      // Reading .cssRules throws SecurityError. Nothing we need is in there.
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue
      for (const prop of Array.from(rule.style)) {
        if (prop.startsWith('--theme-')) names.add(prop)
      }
    }
  }

  cachedTokenNames = Array.from(names).sort()
  return cachedTokenNames
}

export type AppHostApiDeps = {
  extensionId: string
  showToast: (message: string) => void
  /** Closes whatever surface is currently hosting this extension. */
  closeSurface: () => void
}

/**
 * Builds the `AgentCodeApiV1` instance handed to one extension.
 *
 * WHY a plain factory rather than the hook it started as: `ExtensionHost` needs
 * to construct an API for an extension at ACTIVATION time, which can happen from
 * a palette command with no component mounted — and a hook cannot be called
 * there. The React-context dependencies (toast, close) are injected instead, so
 * the same factory serves both the host and any component that needs one.
 *
 * WHY extensionId is closed over rather than passed per call: an extension must
 * not be able to name a different extension's storage namespace. In this stage
 * that is enforced by this closure being the only call site of
 * window.api.extensionStorage*. It becomes properly enforceable when each
 * extension gets its own frame and main derives the id from the sender.
 */
export function createAppHostApi(deps: AppHostApiDeps): AgentCodeApiV1 {
  const { extensionId, showToast, closeSurface } = deps

  return {
    extension: { id: extensionId, apiVersion: 1 },

    storage: {
      get: async <T extends JsonValue>(key: string): Promise<T | undefined> =>
        (await window.api.extensionStorageGet(extensionId, key)) as T | undefined,
      set: (key: string, value: JsonValue) =>
        window.api.extensionStorageSet(extensionId, key, value),
      delete: (key: string) => window.api.extensionStorageDelete(extensionId, key),
      keys: () => window.api.extensionStorageKeys(extensionId),
    },

    ui: {
      // Async despite being synchronous internally — see the ABI's note on why
      // no method here may be declared sync, however obviously sync it is.
      close: async () => {
        closeSurface()
      },
      showToast: async (message: string) => {
        showToast(message)
      },
    },

    theme: {
      tokens: async () => {
        const style = getComputedStyle(document.documentElement)
        const out: Record<string, string> = {}
        for (const name of themeTokenNames()) {
          const value = style.getPropertyValue(name).trim()
          // Skip empties rather than emitting `'--theme-x': ''`. A caller pushing
          // these into a frame would otherwise set variables to the empty string,
          // which resolves as invalid and defeats the consumer's own fallback.
          if (value) out[name] = value
        }
        return out
      },
    },

    // Tier-1 observe reads. These implementations are UNGATED here on purpose —
    // the grant check lives in the frame broker (frameHost.perform), the single
    // trusted chokepoint every frame request passes through. Curated, serializable
    // snapshots only: never the live store objects, which hold renderer handles.
    workspace: {
      observe: async () => {
        const ws = useAppStore.getState().workspaceState
        return {
          activeTabId: ws.activeTabId ?? null,
          tabIds: ws.tabs.map(tab => tab.id),
          // Sidekicks (#1493) are not part of the extension contract in v1; see
          // sessions.observe below.
          sessionCount: Object.values(ws.sessions).filter(meta => !isSidekickSession(meta)).length,
        }
      },
      // Real subscription for a same-realm caller. In the FRAME model the extension
      // calls the child's own subscribe (frameDocument), driven by the host's change
      // nudge — this impl is what satisfies the contract and would serve a same-realm
      // consumer; it is never reached through the broker (subscribe is not a request).
      subscribe: listener => useAppStore.subscribe(s => s.workspaceState, () => listener()),
    },

    sessions: {
      observe: async () => {
        const state = useAppStore.getState()
        // Sidekicks are excluded in v1 (#1493 plan §5 ruling): an extension's
        // session list has meant "the workspace's agents" since #577, and a
        // sidekick lives outside the workspace. A follow-up can add them with
        // an explicit kind so no extension mistakes one for a lane agent.
        return Object.entries(state.workspaceState.sessions).filter(([, meta]) => !isSidekickSession(meta)).map(([id, meta]) => ({
          id,
          kind: meta.kind ?? null,
          cwd: meta.cwd,
          title: meta.title ?? null,
          // Live status (#1479) lives on the RUNTIME, not the session row, so
          // it is joined here from the same store read. See sessionStatus.ts
          // for why both fields delegate to the Dispatch rules.
          ...projectSessionStatus(state.workspaceRuntimes[id]),
        }))
      },
      // The snapshot has two sources: session rows (metadata) and runtimes
      // (status). ONE selector over both, compared field by field, so a write
      // that changes both (a session added: new row AND new signature
      // segment) calls the listener once, not twice (#1479 review). The
      // runtime half is the projected signature, never the runtime map — see
      // sessionStatusSignature for why the map would fire on every token.
      // Frames do not use this: they are woken by observeNudges' pushes.
      subscribe: listener =>
        useAppStore.subscribe(
          s => ({ rows: s.workspaceState.sessions, status: sessionStatusSignature(s) }),
          () => listener(),
          { equalityFn: (a, b) => a.rows === b.rows && a.status === b.status },
        ),
    },

    panes: {
      // `leafSessionIds` is a PUBLISHED extension-SDK field name and keeps its
      // spelling, but there are no leaves (#992): it is every session filed
      // under the project, in index order. For the workspaces extensions were
      // written against — one-pane tabs with their agents parked in Dispatch —
      // this now reports the agents an extension author would have expected
      // and the old value (the tab's lone tile leaf) did not. Renamed with the
      // rest of the SDK surface in stage 7 of the plan.
      observe: async () => {
        const state = useAppStore.getState().workspaceState
        return state.tabs.map(tab => ({
          tabId: tab.id,
          leafSessionIds: resolveTabSessions(state, tab.id),
        }))
      },
      // Membership lives on the session rows now, so a session joining or
      // leaving a project changes `sessions` without touching `tabs`. Listening
      // to `tabs` alone (correct while a tab owned a tree) would miss it.
      subscribe: listener => {
        const offTabs = useAppStore.subscribe(s => s.workspaceState.tabs, () => listener())
        const offSessions = useAppStore.subscribe(s => s.workspaceState.sessions, () => listener())
        return () => { offTabs(); offSessions() }
      },
    },
  }
}
