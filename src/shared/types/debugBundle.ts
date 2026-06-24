// Debug bundle IPC payload contract.
//
// WHY shared (and not imported from main storage): the bundle is built in the
// renderer (collect feed/proxy/HTML surfaces), shipped over IPC, and written +
// validated by `src/main/storage/debugBundle.ts`. The serializable request /
// result shape and the filesystem behavior are two different concerns. This
// file owns ONLY the shape; main storage keeps owning path validation and the
// `files[].content` opacity rule. Previously the shape was duplicated in
// preload `api/types.ts` and main `debugBundle.ts` (with a comment claiming the
// duplication was forced by tsconfig contexts — both contexts already import
// `@shared/*`, so the duplication was avoidable).
//
// INVARIANT: `files` is opaque to main — main writes `content` verbatim and
// must not parse it. `name` is a bundle-relative path only; main rejects
// absolute paths and `..` segments. Do not move that validation into this type.

export type DebugBundleFile = {
  /** Path relative to the bundle folder. Validated portable-relative in main. */
  name: string
  /** Text content. Binary is unsupported (every debug surface is text/JSON). */
  content: string
}

export type SaveDebugBundleParams = {
  sessionId: string
  kind?: string | null
  reason?: string | null
  cwd?: string | null
  providerSessionId?: string | null
  files: DebugBundleFile[]
}

export type SaveDebugBundleResult = {
  /** Absolute path of the created bundle folder. */
  bundlePath: string
}
