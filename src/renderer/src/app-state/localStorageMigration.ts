import {
  APP_LOCAL_STORAGE_PREFIX,
  LEGACY_LOCAL_STORAGE_PREFIX,
} from '@shared/appIdentity'

type StorageKeyPair = {
  current: string
  legacy: string
}

export const APP_STORE_STORAGE_KEY = `${APP_LOCAL_STORAGE_PREFIX}:app-store`
export const LEGACY_APP_STORE_STORAGE_KEY = `${LEGACY_LOCAL_STORAGE_PREFIX}:app-store`
export const APP_SETTINGS_STORAGE_KEY = `${APP_LOCAL_STORAGE_PREFIX}:settings`
export const LEGACY_SETTINGS_STORAGE_KEY = `${LEGACY_LOCAL_STORAGE_PREFIX}:settings`
export const PROMPT_TEMPLATES_STORAGE_KEY = `${APP_LOCAL_STORAGE_PREFIX}.promptTemplates.v1`
export const LEGACY_PROMPT_TEMPLATES_STORAGE_KEY = `${LEGACY_LOCAL_STORAGE_PREFIX}.promptTemplates.v1`

const MIGRATED_KEYS: StorageKeyPair[] = [
  { current: APP_STORE_STORAGE_KEY, legacy: LEGACY_APP_STORE_STORAGE_KEY },
  { current: APP_SETTINGS_STORAGE_KEY, legacy: LEGACY_SETTINGS_STORAGE_KEY },
  { current: PROMPT_TEMPLATES_STORAGE_KEY, legacy: LEGACY_PROMPT_TEMPLATES_STORAGE_KEY },
]

export function migrateLegacyLocalStorageKeys(): void {
  // TEMPORARY cc-shell conversion pass:
  //
  // PR #82 intentionally copied legacy keys and kept the originals so a
  // pre-rename build could roll back cleanly. That was right while the rename
  // was fresh. This branch is deliberately different: the dev team is the only
  // legacy user base and has mostly moved to the Agent Code shape, so we want a
  // checkout where navigating the app stops finding live cc-shell state.
  //
  // Move semantics here are load-bearing for the next cleanup commit: after a
  // few launches with this code, remaining LEGACY_* readers should be removable
  // without silently stranding settings/templates under old key names.
  for (const { current, legacy } of MIGRATED_KEYS) {
    const value = window.localStorage.getItem(legacy)
    if (value !== null && window.localStorage.getItem(current) === null) {
      window.localStorage.setItem(current, value)
    }
    window.localStorage.removeItem(legacy)
  }
}
