import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'

// Phone substitute for @renderer/app-state/hooks (aliased in
// vite.config.ts). The feed subtree touches the app store in exactly ONE
// place so renderer modules can consume settings without importing desktop
// serves a frozen default-settings snapshot through the same selector
// call shape instead of dragging the zustand store (and its persistence,
// keybinds, panel state…) into the bundle.
//
// If a desktop refactor adds more store reads inside the feed subtree,
// the selector below keeps compiling as long as the read is under
// `settings` or another key present here; anything else fails the phone
// tsc/build loudly — the correct signal to either widen this snapshot or
// question the new coupling.
//
// Agent names (issue #816) are a deliberate no-op here: the phone has no
// workspace state, no reconciler and no allocation, so agentNameForSession
// degrades to null and no badge renders. Note that the "fails the phone
// tsc/build loudly" claim above does NOT hold for a read whose key is simply
// missing — tsconfig.web.json checks this directory against the real hooks
// module, not against this stub — so selectors reached from the feed subtree
// must tolerate a keyless store on their own. PaneHeader.phoneCoupling is the
// test that enforces it.

const PHONE_APP_STATE = {
  settings: DEFAULT_SETTINGS,
}

type PhoneAppState = typeof PHONE_APP_STATE

export function useAppStore<T>(selector: (state: PhoneAppState) => T): T {
  // No subscription: the snapshot is immutable on the phone, so a plain
  // selector call is a correct (and re-render-free) useSyncExternalStore.
  return selector(PHONE_APP_STATE)
}
