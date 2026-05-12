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
  // WHY copy instead of move: localStorage is small, and keeping the legacy
  // values makes rollback to a pre-rename build painless. The new keys become
  // authoritative as soon as Agent Code writes them; old keys are just a
  // read-once compatibility bridge for existing pre-rename installs.
  for (const { current, legacy } of MIGRATED_KEYS) {
    if (window.localStorage.getItem(current) !== null) continue
    const value = window.localStorage.getItem(legacy)
    if (value === null) continue
    window.localStorage.setItem(current, value)
  }
}
