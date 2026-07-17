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

const PHONE_APP_STATE = {
  settings: DEFAULT_SETTINGS,
}

type PhoneAppState = typeof PHONE_APP_STATE

export function useAppStore<T>(selector: (state: PhoneAppState) => T): T {
  // No subscription: the snapshot is immutable on the phone, so a plain
  // selector call is a correct (and re-render-free) useSyncExternalStore.
  return selector(PHONE_APP_STATE)
}
