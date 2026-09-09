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
    // WHY this checks the METHODS and not just that the access succeeded:
    //
    // The original guard only caught a THROWN access, which is the browser
    // "storage denied" case. It did not catch storage being merely absent.
    // Under the renderer test environment (`happy-dom`) `localStorage` is
    // defined-but-undefined, so the assignment succeeded, this function
    // returned a live adapter, and every store write then died inside
    // Zustand's persist middleware with "storage.setItem is not a function".
    // That silently broke all seven agent-name reconciler tests the moment
    // they touched `useAppStore.setState`, and it would do the same to any
    // future renderer test that writes a setting.
    //
    // Returning undefined here is the documented contract for "storage is
    // unavailable" — Zustand then skips persistence entirely, which is the
    // correct behavior in a test or on a surface with no storage, rather than
    // throwing on an unrelated store action.
    //
    // Deliberately the BARE global rather than `window.localStorage`: the
    // migration suites drive this through `vi.stubGlobal('localStorage', …)`,
    // which replaces the global binding and not a `window` property. In every
    // real surface (Electron renderer, phone bundle) the two are the same
    // object anyway.
    const candidate: Storage | undefined = localStorage
    if (
      !candidate ||
      typeof candidate.getItem !== 'function' ||
      typeof candidate.setItem !== 'function' ||
      typeof candidate.removeItem !== 'function'
    ) return undefined
    storage = candidate
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
