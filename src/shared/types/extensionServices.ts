import { z } from 'zod'

// Service calls cross either the view's postMessage broker or the runtime's
// dedicated preload. Keep their untrusted argument grammar in one shared schema;
// a method that exists on only one transport would make the public v2 API depend
// on whether the author happened to call it from a view or from the background.
const sessionId = z.string().min(1).max(128)
const projectPath = z.string().min(1).max(1024)

export const extensionFileReadRequestSchema = z.object({
  method: z.literal('fs.readText'),
  sessionId,
  path: projectPath,
}).strict()

export const extensionServiceRequestSchema = z.discriminatedUnion('method', [
  extensionFileReadRequestSchema,
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
}
