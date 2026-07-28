import { useAppStore } from '@renderer/app-state/hooks'
import { collectLeaves } from '@renderer/workspace/workspaceStore'

import type { AgentCodeApiV1, JsonValue } from '@renderer/apps/api/types'

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

  const names = new Set<string>(RUNTIME_ONLY_TOKENS)
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
          sessionCount: Object.keys(ws.sessions).length,
        }
      },
      // Real subscription for a same-realm caller. In the FRAME model the extension
      // calls the child's own subscribe (frameDocument), driven by the host's change
      // nudge — this impl is what satisfies the contract and would serve a same-realm
      // consumer; it is never reached through the broker (subscribe is not a request).
      subscribe: listener => useAppStore.subscribe(s => s.workspaceState, () => listener()),
    },

    sessions: {
      observe: async () =>
        Object.entries(useAppStore.getState().workspaceState.sessions).map(([id, meta]) => ({
          id,
          kind: meta.kind ?? null,
          cwd: meta.cwd,
          title: meta.title ?? null,
        })),
      subscribe: listener =>
        useAppStore.subscribe(s => s.workspaceState.sessions, () => listener()),
    },

    panes: {
      observe: async () =>
        useAppStore.getState().workspaceState.tabs.map(tab => ({
          tabId: tab.id,
          leafSessionIds: [...collectLeaves(tab.root)],
        })),
      subscribe: listener => useAppStore.subscribe(s => s.workspaceState.tabs, () => listener()),
    },
  }
}
