// Caffeinate IPC payload contracts.
//
// WHY these live in @shared/types and not in @preload/api/types:
//   The OS-process lifecycle owner is `src/main/caffeinate/CaffeinateController.ts`
//   — a MAIN module. It used to import its own response/status types from
//   `@preload/api/types`, which inverts the dependency direction: preload is
//   the Electron renderer bridge and should ADAPT shared contracts, not be the
//   source of truth that a main implementation depends on. (It also meant a
//   `rg "@preload" src/main` hit a real layering violation.) Hoisting the pure
//   serializable shapes here lets main and preload both import from a neutral
//   boundary module; preload re-exports them so existing renderer imports keep
//   resolving.

/** Current caffeinate (keep-awake) assertion state, mirrored to the renderer. */
export type CaffeinateStatus = {
  /** macOS-only feature; false on other platforms. */
  supported: boolean
  active: boolean
  pid: number | null
  startedAt: number | null
  command: string[]
  message: string | null
}

/** Result of a start/stop/toggle command. */
export type CaffeinateCommandResult = {
  ok: boolean
  message: string
  status: CaffeinateStatus
}
