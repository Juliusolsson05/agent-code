import type { PersistStorage, StorageValue } from 'zustand/middleware'

import type { Settings } from './types'

type PersistedSettings = { settings: Settings }

/**
 * Persist only changed settings, before paying serialization/localStorage cost.
 *
 * WHY partialize is insufficient: Zustand calls storage.setItem after EVERY
 * store action, including workspace stream ticks and setters returning the
 * previous state. partialize selects fields; it does not compare them. Putting
 * a string cache below createJSONStorage would still stringify all saved themes
 * and prompt templates for every terminal/semantic update.
 *
 * This adapter deliberately targets synchronous browser localStorage, not an
 * async storage backend. A successful setItem is our durability boundary, so a
 * quota/security error cannot poison the cache and suppress a later retry.
 * Settings writers must preserve the existing immutable-update contract.
 */
export function createSettingsStorage(): PersistStorage<PersistedSettings> | undefined {
  let storage: Storage
  try {
    storage = localStorage
  } catch {
    // Match Zustand's createJSONStorage behavior when storage is unavailable
    // during SSR/test bootstrap or denied by the browser environment.
    return undefined
  }

  let lastWritten: { name: string; value: StorageValue<PersistedSettings> } | undefined
  return {
    getItem(name) {
      // Rehydration may load an externally changed value or coerce an older
      // schema. No prior in-memory write claim may survive that boundary.
      lastWritten = undefined
      const raw = storage.getItem(name)
      return raw === null ? null : JSON.parse(raw) as StorageValue<PersistedSettings>
    },
    setItem(name, value) {
      if (
        lastWritten?.name === name &&
        lastWritten.value.version === value.version &&
        lastWritten.value.state.settings === value.state.settings
      ) return

      storage.setItem(name, JSON.stringify(value))
      lastWritten = { name, value }
    },
    removeItem(name) {
      // clearStorage followed by an otherwise unrelated UI action must be able
      // to repersist settings. Invalidate even if removal throws: an extra
      // write is safe, incorrectly believing deleted data is durable is not.
      lastWritten = undefined
      storage.removeItem(name)
    },
  }
}
