# Issues #180 and #181: Rendered Link Activation

## Issue Summaries

- [#180](https://github.com/Juliusolsson05/agent-code/issues/180), "Harden markdown hyperlink handling so rendered links cannot crash/navigate the Electron app": assistant/provider markdown is untrusted text, but current rendered anchors are not routed through an explicit safe activation boundary. Clicking links must never navigate the Agent Code BrowserWindow, unsupported protocols must be inert, and allowed external URLs should open outside the app through a controlled path.
- [#181](https://github.com/Juliusolsson05/agent-code/issues/181), "Open clicked file paths in Global Editor from rendered markdown/feed content": once rendered target activation is safe, local file paths in assistant/feed/transcript content should open inside the existing Global Editor rather than via browser navigation or OS `file:` handling.

These should be solved together because #180 defines the security/stability baseline and #181 is a product behavior layered on the same click/activation path. Adding a separate file-path click handler would create a second policy surface with different parsing and trust rules.

## Current Behavior And Relevant Files

Markdown rendering surfaces found in this pass:

- Main feed prose uses `ReactMarkdown` in `TextProse` and `StreamingProse`, both passing `MARKDOWN_COMPONENTS` from the feed markdown module: `src/renderer/src/features/feed/ui/markdown/Prose.tsx:22` and `src/renderer/src/features/feed/ui/markdown/Prose.tsx:47`.
- Feed markdown overrides currently cover `pre` and `code` only. There is no `a` override, so links fall through to `react-markdown`'s default anchor behavior: `src/renderer/src/features/feed/ui/markdown/MarkdownComponents.tsx:118`.
- Reader mode has a duplicated local markdown component set, also only overriding `pre` and `code`: `src/renderer/src/features/reader/ui/ReaderView.tsx:29` and `src/renderer/src/features/reader/ui/ReaderView.tsx:75`.
- Command palette command descriptions use another `ReactMarkdown` surface with only paragraph/strong overrides: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx:1300` and `src/renderer/src/features/command-palette/ui/CommandPalette.tsx:1354`.
- Debug HTML serialization is not an interactive markdown surface. `sanitizeHtml` explicitly rewrites a detached DOM snapshot for diagnostics and does not rewrite URLs: `src/renderer/src/lib/sanitizeHtml.ts:1`.

Electron boundary:

- `BrowserWindow` is configured with `contextIsolation: true` and `nodeIntegration: false`, which is good baseline isolation: `src/main/window/mainWindow.ts:86`.
- `setWindowOpenHandler` denies new windows but currently calls `shell.openExternal(url)` for any URL without protocol validation: `src/main/window/mainWindow.ts:104`.
- I did not find a `will-navigate` guard on the main `webContents`. That means defense-in-depth is incomplete if a renderer bug or default anchor behavior tries to navigate the app window itself.

Global Editor open-file path today:

- Explorer rows call `onOpenFile(entry.path)` for files: `src/renderer/src/features/editor/ui/ExplorerPane.tsx:186`.
- `GlobalEditorShell.openFileFromTree` reads through `window.api.editorReadTextFile({ root: activeCwd, path })` and then calls `useGlobalEditorStore.openFile`: `src/renderer/src/features/global-editor/ui/GlobalEditorShell.tsx:247`.
- `useGlobalEditorStore.openFile` creates or refreshes the tab buffer and marks it active: `src/renderer/src/features/global-editor/store.ts:178`.
- Main-process `editor-fs:read-text-file` validates the target with `resolveInsideRoot`, rejects directories, and reads UTF-8 text: `src/main/ipc/editorFs.ts:169`.
- `resolveInsideRoot` already contains the important root-containment guard in main, not renderer: `src/main/ipc/editorFs.ts:105`.

Useful context already available to rendered markdown:

- Feed markdown code blocks receive `sessionId` and `workspaceRoot` through `CodeRenderContext`: `src/renderer/src/features/feed/context.tsx:62`. A safe activation component can use the same context to resolve workspace-relative paths.

## Proposed Centralized Safe Activation Architecture

Create one shared renderer module for rendered-content activation, likely under `src/renderer/src/features/rendered-content/` or `src/renderer/src/lib/renderedContent/`:

- `classifyRenderedTarget(rawHref, context)` returns a discriminated result:
  - `external-url` for explicit `http:` / `https:` URLs only.
  - `local-file` for recognized absolute or workspace-relative filesystem paths that are allowed by policy.
  - `unsupported` for `javascript:`, `data:`, `file:`, custom protocols, malformed URLs, empty hrefs, and ambiguous relative links that are not accepted as file paths.
- `SafeMarkdownLink` renders the only clickable anchor/button for markdown hrefs. It must `preventDefault()` and never rely on native anchor navigation.
- A shared markdown component object should include `a: SafeMarkdownLink` and should be used by feed, streaming feed, Reader mode, and command palette markdown. Reader mode's duplicated markdown component definitions are a known consolidation point.
- External URL activation should go through an explicit preload/main IPC such as `rendered-content:open-external`, not direct `window.open`. Main should validate `http:` / `https:` again before calling `shell.openExternal`.
- Local file activation should call a renderer command/helper such as `openPathInGlobalEditor({ root, path, line, column })`. That helper should reuse `editorReadTextFile` and `useGlobalEditorStore.openFile`, and should also open the Global Editor UI via `useAppStore.getState().openGlobalEditor()`.

The important invariant is that rendered content is provider/model-controlled input. Renderer classification is UX, but main-process IPC and Electron navigation guards are the trust boundary.

## Local File Path Parsing And Opening Plan

Path recognition should be conservative:

- Accept absolute POSIX paths that are inside the session/workspace cwd after normalization.
- Accept workspace-relative paths only when `workspaceRoot` is known.
- Parse suffixes as optional `:line` or `:line:column` only when the suffix numbers are positive integers and the base path still resolves to a file.
- Do not treat arbitrary relative URLs, `./foo` inside markdown hrefs, or `../foo` as safe unless the main-process containment check confirms they stay under the workspace root.
- Treat `file://` URLs as blocked by default for #180. If product wants markdown `file://` support later, convert them into the same local-file classification only after path normalization and root containment.

Opening flow:

1. Renderer click handler gets `workspaceRoot` from context and parses the raw target.
2. For a candidate local file, call `editorReadTextFile({ root: workspaceRoot, path })`.
3. If the read succeeds, call `useGlobalEditorStore.getState().openFile({ cwd: workspaceRoot, path: result.path, text, mtimeMs })`.
4. Call `useAppStore.getState().openGlobalEditor()` so the file is visible even if the overlay was closed.
5. Add line/column support to the editor store and `MonacoFileEditor` as a focused follow-up inside the same implementation, or initially store `pendingSelection` if Monaco needs to apply it after model mount.
6. On failure, show a toast or inert/error affordance. Do not fall back to OS/browser handling.

This likely needs one small extraction from `GlobalEditorShell.openFileFromTree` so tree clicks and rendered path clicks share the same file-read-and-open behavior.

## Electron Navigation Defense In Depth

Main-process changes should be treated as mandatory even if all markdown components are fixed:

- Replace the current unconditional `shell.openExternal(url)` in `setWindowOpenHandler` with a validator that only allows `http:` and `https:` and catches malformed URLs.
- Add `webContents.on('will-navigate', event => event.preventDefault())` for all navigations except the app's own initial dev-server URL during development, if needed. In production, no in-app navigation should be allowed after `loadFile`.
- Consider also handling `will-redirect` if Electron exposes a practical event for this app's version and the dev-server exception needs redirect awareness.
- Keep external opening in main behind a small helper, for example `openAllowedExternalUrl(rawUrl)`, so window-open handling and IPC use exactly the same protocol policy.
- Add thick WHY comments explaining that model output is untrusted and that Electron navigation guards are defense in depth against future raw-anchor regressions.

## Risk Areas And Open Questions

- `react-markdown` has its own URL transform behavior, but relying on library defaults is not enough for Electron app-window navigation. We need an explicit `a` override and main-process guards.
- Reader mode duplicates feed markdown rendering. Consolidation reduces future drift but touches a user-facing surface; keep it narrow.
- Command palette descriptions are probably first-party strings, not provider-controlled, but using the same safe link component avoids a future regression if descriptions become dynamic.
- Absolute paths outside the workspace are a policy question. My recommendation is block them for rendered content in the first pass because `editor-fs` is project-root-scoped and the issue says relative paths should resolve against session/workspace cwd.
- Backticked file paths in prose are not markdown links today. Supporting them requires a remark plugin or text-node transform and has higher false-positive risk. Ship markdown href handling first unless the issue owner explicitly wants inline-code path activation in the first implementation.
- Tool result rows often avoid markdown parsing by design. If path activation is desired inside raw tool outputs, that is a separate text-linkification problem and should not be hidden inside the markdown link fix.
- Monaco jump-to-line likely needs a small editor-store shape change so selection survives async file reads and editor mount.

## Suggested Tests And Manual Verification

Automated tests:

- Add a pure test script for target classification with cases for `https://example.com`, `http://example.com`, `javascript:alert(1)`, `data:text/html,...`, `file:///tmp/a`, malformed URL text, `/abs/path`, `src/app.ts`, `src/app.ts:42`, `src/app.ts:42:10`, `../outside`, and missing `workspaceRoot`.
- Add a pure test around local path parsing so `path:line:column` only strips suffixes when the suffix is numeric.
- Add main-process helper tests for allowed external URL validation, if the helper is pure and exported.
- Add renderer-level tests or a lightweight harness check that markdown `a` components call `preventDefault` and dispatch safe activation rather than emitting native navigation.

Manual verification:

- In the feed and Reader mode, click normal `https:` links and confirm the OS browser opens while Agent Code stays on the same screen.
- Click `javascript:`, `data:`, `file:`, malformed, and custom-scheme links and confirm nothing navigates and the app does not crash.
- Click a workspace-relative file path link and confirm Global Editor opens the file.
- Click `src/file.ts:42:10` and confirm the file opens and cursor/viewport lands at the expected location once line/column support is implemented.
- Click missing files and directories and confirm a non-crashing error path.
- Run a dev build and packaged/preview build because navigation exceptions often differ between `loadURL(devServer)` and `loadFile(production)`.

## Size Estimate

Medium.

The external-link hardening alone is small: one shared link component, one main-process URL helper/IPC, and `will-navigate` defense. The combined #180/#181 implementation is medium because file activation needs shared Global Editor opening, path parsing, root containment policy, error UI, and likely Monaco line/column focus state. It should still be a contained change if it avoids broad renderer refactors and only consolidates markdown components enough to route all links through the shared safe component.
