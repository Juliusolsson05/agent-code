// Format an absolute file path for display in a tool-row header.
//
// Agents (Claude's Edit/Write, Codex's apply_patch) hand us absolute
// paths. Showing only the basename is too lossy — a repo can easily
// have a dozen files called `index.tsx` and the user can't tell which
// one is being edited. Showing the full absolute path is too noisy —
// the prefix `/Users/alice/Desktop/Development/cc-shell/` repeats on
// every single tool row.
//
// Compromise: when the path is inside the session's workspace root
// (= the pane's cwd), strip the workspace prefix and show the relative
// path. When the path is OUTSIDE the workspace — a tempfile, a file in
// another project, ~/.config/..., etc. — show the full absolute path
// so the user sees "this is not a project edit".
//
// Callers should still pass the absolute path to the `title` attribute
// of whatever they render this string in, so hover always reveals the
// unambiguous full location.

/**
 * Compute the display string for a tool-affected file path.
 *
 * @param filePath     The raw path as emitted by the agent. Usually
 *                     absolute. Empty / null / undefined returns ''.
 * @param workspaceRoot The session's cwd, or null if unknown. A null
 *                     root disables shortening — we just return the
 *                     path as-is because we have no base to compare
 *                     against.
 * @returns            A display-ready string:
 *                     - `'' `     if filePath is falsy
 *                     - relative  if filePath is inside workspaceRoot
 *                     - absolute  if filePath is outside, or
 *                                  workspaceRoot is missing
 */
export function formatToolFilePath(
  filePath: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string {
  if (!filePath) return ''
  if (!workspaceRoot) return filePath

  // Normalize trailing `/` so `/foo/bar` and `/foo/bar/` match the
  // same set of descendants. Without this, a workspaceRoot of
  // `/foo/bar/` would miss every path that starts with `/foo/bar/`
  // because the boundary check `startsWith(root + '/')` would look
  // for a double-slash.
  const root = workspaceRoot.endsWith('/')
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot

  // Exact match — rare (agent edited the directory itself? usually
  // not possible). Fall through to returning the full path; there's
  // no sensible relative form.
  if (filePath === root) return filePath

  // Inside workspace: strip the root + separator so the remainder is
  // a plain relative path like `src/foo/bar.ts`.
  if (filePath.startsWith(root + '/')) {
    return filePath.slice(root.length + 1)
  }

  // Outside workspace — keep absolute. The user WANTS to see the
  // full path here because it signals "this is not a project edit".
  return filePath
}
