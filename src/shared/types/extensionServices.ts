import { z } from 'zod'

// Service calls cross either the view's postMessage broker or the runtime's
// dedicated preload. Keep their untrusted argument grammar in one shared schema;
// a method that exists on only one transport would make the public v2 API depend
// on whether the author happened to call it from a view or from the background.
const sessionId = z.string().min(1).max(128)
const projectPath = z.string().min(1).max(1024)
const fileVersion = z.string().min(1).max(512)

export const extensionFileReadRequestSchema = z.object({
  method: z.literal('fs.readText'),
  sessionId,
  path: projectPath,
}).strict()

export const extensionFileWriteRequestSchema = z.object({
  method: z.literal('fs.writeText'),
  sessionId,
  path: projectPath,
  // null is deliberately distinct from omission: it means "create only".
  // Replacing an existing file always requires a version returned by readText,
  // so an extension cannot unknowingly overwrite an editor or agent mutation.
  expectedVersion: fileVersion.nullable(),
  text: z.string().max(64 * 1024),
}).strict()

export const extensionNotificationRequestSchema = z.object({
  method: z.literal('notifications.show'),
  // Background notifications are intentionally short status messages. A hard
  // transport bound keeps a broken extension from turning one toast into an
  // unbounded application overlay or IPC payload.
  message: z.string().trim().min(1).max(200),
}).strict()

export const extensionServiceRequestSchema = z.discriminatedUnion('method', [
  extensionFileReadRequestSchema,
  extensionFileWriteRequestSchema,
  extensionNotificationRequestSchema,
])

export type ExtensionServiceRequest = z.infer<typeof extensionServiceRequestSchema>

/** A bounded UTF-8 file read from the project owned by `sessionId`. */
export type ExtensionTextFile = {
  /** The session target is echoed so concurrent reads remain attributable. */
  sessionId: string
  /** Normalized project-relative path. Absolute project locations never leak here. */
  path: string
  text: string
  size: number
  mtimeMs: number
  /** Opaque compare-and-swap token accepted by writeText. */
  version: string
}

/** Metadata for a safely published UTF-8 project file. */
export type ExtensionTextFileWrite = {
  sessionId: string
  path: string
  size: number
  mtimeMs: number
  /** The next opaque token required to replace this version. */
  version: string
}

export type ExtensionServiceResult = ExtensionTextFile | ExtensionTextFileWrite | void

export type ExtensionNotification = {
  extensionId: string
  message: string
}

export type ExtensionFilesApi = {
  /**
   * Read a text file from a live session's project. Requires `fs.read`.
   *
   * A background runtime has no focused pane, so the target is always explicit.
   * The host derives the project root from its main-owned session record; callers
   * cannot substitute an arbitrary absolute root.
   */
  readText(options: { sessionId: string; path: string }): Promise<ExtensionTextFile>

  /**
   * Atomically create or replace a bounded text file. Requires `fs.write`.
   * Use expectedVersion: null for create-only, or pass readText().version when
   * replacing a file. A stale token rejects without overwriting newer bytes.
   */
  writeText(options: {
    sessionId: string
    path: string
    text: string
    expectedVersion: string | null
  }): Promise<ExtensionTextFileWrite>
}

export type ExtensionNotificationsApi = {
  /** Show a short app-wide status toast. Requires `notifications.show`. */
  show(message: string): Promise<void>
}
