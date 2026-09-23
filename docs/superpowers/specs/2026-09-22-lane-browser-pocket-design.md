# Lane Browser Pocket — design spec

Status: **draft for review** (2026-09-22). Nothing here is implemented yet.
Plan: `docs/superpowers/plans/2026-09-22-lane-browser-pocket.md`.

> One-line summary: every agent can own a **browser pocket** — a live
> Chromium page that rides with that agent's lane, shows beside it in
> Spotlight, finds that lane's own dev server, and can be driven by that
> agent (and only that agent) through a new `browser` domain on the
> built-in `agent_code` MCP server.

This spec was written from four research passes (all run 2026-09-22):
the Agent Code lane/Spotlight/pane model (read from source), a line-level
read of T3 Code's shipping preview browser (`pingdotgg/t3code`), a survey
of ~20 agent products' browser-preview UX (Cursor, Codex app, Claude Code
Desktop, Antigravity, Conductor, Superset, Emdash, VS Code, Windsurf,
Vibe Kanban, Replit, Lovable, v0, Devin, cmux…), and an Electron 43
technical pass (Electron source, VS Code's Integrated Browser, Orca). The
sources are cited inline so future-you can re-check them instead of
re-deriving them.

---

## 1. Why, and what "done" means

### 1.1 The problem

Agent Code runs many agents side by side, usually each in its own git
worktree, often each with its own dev server. Today the only way to *see*
what a lane is building is to alt-tab to a real browser, guess which
`localhost` port belongs to which worktree, and keep that mapping in your
head. Agents that want to verify UI work have no browser at all unless the
user wires up a third-party MCP (Playwright MCP, chrome-devtools-mcp) by
hand, per provider, and those drive a browser the user cannot see inside
the app.

Every comparable product shipped an answer in the last year (Codex app
in-app browser 2026-04, Claude Code Desktop Browser pane, Cursor 2.0/3.0
browser + Design Mode, Conductor 0.62 browser preview 2026-06, Superset
2026-02, Emdash, T3 Code preview, VS Code Integrated Browser GA
2026-07-01). The recurring shape is: *a browser pane scoped to the
agent's workspace, a way to point at an element and hand it to the agent,
and agent tools that drive that same visible pane.*

Agent Code's twist is the **lane grid**: many agents visible at once. No
surveyed product shows N live previews tied to N parallel agents in one
glanceable grid; Conductor explicitly chose the opposite (one instance,
hot-swap branches — its own feature is literally called "Spotlight",
0.55.0). That is the differentiator worth building.

### 1.2 Success criteria

1. From any lane, one keystroke opens a browser **attached to that lane's
   agent**, pre-pointed at the dev server that lane's processes are
   serving (no port guessing).
2. Entering Spotlight on an agent shows **agent and browser side by side**,
   and the page does **not reload** when moving between the lane grid and
   Spotlight, when lanes are inserted/removed/reordered, or when the
   stage is hidden behind Settings/Reader/Global Editor.
3. The agent in that lane can navigate, read (accessibility snapshot +
   console + failed requests), click, type, and screenshot **its own
   pocket** through MCP, while the user watches it happen, and the user
   can take over at any moment without the agent fighting back.
4. Two lanes serving `localhost:3000` and `localhost:3001` never share
   cookies or logins with each other by accident.
5. The pocket never steals keyboard focus from the user's current
   composer/terminal, never auto-pops a panel over what the user is
   doing, and every app shortcut that works in Spotlight still works
   while the browser has focus.
6. It is **off by default** (Experimental) and costs nothing — no
   polling, no webviews, no extra processes — until a pocket is opened.

### 1.3 Non-goals (v1)

- **Inheriting the user's Chrome** (cookie import, driving the real
  Chrome profile). Researched separately in this conversation; the
  pocket's partition design leaves room for a later "Import sessions"
  step (T3 Code/Claude Cowork pattern), but v1 pockets are clean profiles.
  Google sign-in inside embedded browsers is blocked by Google anyway
  (`disallowed_useragent`).
- A general-purpose browser (bookmarks, history UI, extensions, multiple
  windows). v1 is one page per pocket (see §11 D3).
- Recording/video artifacts, the remote phone companion showing pockets,
  control-SDK (`ac_*`) exposure, cloud/remote-environment port tunnels.
- Solving port collisions by *assigning* ports (Conductor-style
  `PORT` ranges). v1 *detects*; assignment is a listed follow-up (§11 D6).

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Lane** | One cell of the dispatch grid (`DispatchLane = { selectedSessionId? }`, `src/renderer/src/workspace/types.ts:327-347`). Has **no identity** of its own — it is an index into a flat row-major array. |
| **Agent session** | A `SessionMeta` in the pool (`types.ts:117-314`), keyed by `SessionId`. The durable thing a lane *shows*. |
| **Pocket** | The browser attached to one agent session. Config lives on the session; the live page lives in a host layer. Not a lane, not a session, not a pane kind. |
| **Guest** | The Chromium page itself — one Electron `<webview>` element and its `webContents`. |
| **Host layer** | The single app-root component that owns every guest element and positions it. Guests never move in the DOM. |
| **Slot** | An empty placeholder `<div>` rendered wherever a pocket should appear (inside a lane, inside Spotlight). It only publishes its rectangle. |
| **Lane process tree** | The agent's process plus its descendants, plus terminal sessions attributed to the same worktree (§7.2). Used to find "this lane's dev server". |

---

## 3. The central decision: attach the pocket to the agent session, not the lane

The user's framing — "a browser that inherits a lane… not its own lane
but attached to a lane" — is right in spirit, and the code tells us
exactly which object to attach it to.

**Why not the lane:**

- Lanes are index-keyed. `TiledDispatchLayout.tsx:362` renders
  `key={laneIndex}`; five `gridShape.ts` mutations
  (`insertLaneRightIntoGrid :313`, `removeLaneFromGrid :372`,
  `insertRowBelowInGrid :416`, `removeRowFromGrid :488`,
  `setGridShape :567`) plus the control SDK's `dispatch.configure`
  (`workspace/control/layout.ts:72-115`) all splice the array. A
  lane-keyed pocket would slide to the wrong agent on every insert.
- Persistence projects lanes down to `{ selectedSessionId }` only
  (`workspaceShape.ts:256-262`) — any new lane field is dropped on read.
- Spotlight holds a **session**, not a lane
  (`SpotlightState = { tabId, focusedSessionId }`, `types.ts:622`), and its
  pills can show sessions that are in no lane at all. A lane-keyed pocket
  could not follow into Spotlight.
- Window adoption carries the session pool but not the stage
  (`adoptWorkspace.ts:19-24`).
- The same session may be shown in two lanes (the mirror contract,
  `types.ts:334-344`). One agent → one pocket is the consistent reading of
  that contract.

**Why the session works:** `SessionMeta` fields are persisted, migrated,
adopted, project-merged, reload-all-preserved and removed-on-close **for
free** (autosave `useAutoSave.ts:134`, migrate `workspaceShape.ts:236`,
adopt `adoptWorkspace.ts:100-103`, merge `mergeProjectTabs.ts:96-98`,
removal `pool.ts:103-111`). Only two explicit allow-lists must learn the
new field: `replaceSession`'s literal (`hook/actions/session.ts:1366-1410`,
see how `agentViewModeOverride` was added at `:1403-1409`) and undo-close's
`carryDurableMeta` (`hook/actions/undoClose.ts:72-106`).

**The anti-precedent** is `Settings.dispatchColorFlags`
(`app-state/settings/types.ts:356-362`): a side map keyed by session id
that is never remapped on reload/switch, never cleaned on close, never
carried by undo. A pocket stored that way would leak and orphan the same
way. Do not copy it.

So: **"lane-based" is the user experience; "session-keyed" is the data
model.** The lane *shows* the pocket because the lane shows the session.

### 3.1 What lives where

| Kind of state | Where | Why |
|---|---|---|
| Durable config: is a pocket attached, last URL, split fraction, view state, profile id | `SessionMeta.browserPocket?: BrowserPocketConfig` | Rides every existing persistence/migration/merge/removal path. |
| Live, non-durable state: guest `webContentsId`, loading, title, favicon, nav can-go-back/forward, agent-driving flag, crash generation, last thumbnail | Renderer-only zustand slice keyed by `SessionId` (`browserPocketRuntime`) | Must never be written to disk; cleared by `workspaceWithoutSessions` and remapped with the same `idMap` used at `session.ts:1425-1436`, `:1641-1658`, `undoClose.ts:328`. |
| The guest element itself | `BrowserPocketHost` (app root) | Only way to survive layout changes without reloads (§5). |
| Debugger/CDP sessions, console/network ring buffers, control epoch | Main process `BrowserPocketController`, keyed by `webContentsId` and a `pocketId` | CDP must be attached from main; buffers must outlive renderer remounts. |
| Discovered dev-server ports per session | Main `LanePortWatcher` → pushed to renderer runtime slice | Needs `lsof`/`netstat`; renderer cannot. |

```ts
// src/renderer/src/workspace/types.ts (new)
export type BrowserPocketConfig = {
  /**
   * Stable across provider switch / reload / rewind / undo, which all MINT
   * NEW SessionIds (idRemap.ts header). The Electron partition name is
   * derived from THIS, never from the SessionId, or every reload would
   * silently log the user out of their dev app.
   */
  pocketId: string
  /** Last committed top-level URL (http/https only). Restored lazily. */
  url?: string
  /** 'open' = visible split; 'collapsed' = pocket strip only (lanes). */
  view: 'open' | 'collapsed'
  /** Agent/browser split, 0..1, remembered per session (Cursor complaint: panes too narrow). */
  split?: number
  /** Which cookie jar. v1: 'lane' (own) | 'project' (shared by the project). See §8.1 / D1. */
  profile: 'lane' | 'project'
  /** Viewport emulation; absent = fill. */
  viewport?: { mode: 'fill' } | { mode: 'preset'; preset: string; landscape?: boolean } | { mode: 'free'; width: number; height: number }
}
```

---

## 4. UI breakdown

All sketches are schematic; exact spacing follows the existing lane
chrome. Design principle from the product survey: **the pocket is
glanceable in the grid and roomy in Spotlight.** Lanes can be narrow (up
to 10 per row, `gridShape.ts:46`), so the grid must never force a
full-size browser into every lane.

### 4.1 Lane, pocket collapsed — the "pocket strip"

A 22px strip at the bottom of the lane body, under the agent view. This is
the default state after the agent (not the user) opens a pocket, and the
state a lane falls back to when it is too small for a split
(< 520px wide *and* < 420px tall).

```
┌─ lane 2 ─ fix-checkout (claude) ───────────────── ● ┐
│                                                     │
│   … agent feed / terminal …                         │
│                                                     │
├─────────────────────────────────────────────────────┤
│ ◧ :5173  localhost:5173/checkout   ● agent   ⤢  ✕  │  ← pocket strip
└─────────────────────────────────────────────────────┘
```

Strip contents, left → right:
- **◧ favicon** (or a globe glyph) — click toggles open/collapsed.
- **Port chip** `:5173` — the lane's detected dev server. If the lane
  serves more than one, `:5173 +1` opens a small menu of ports (§4.6).
  Hidden when nothing is detected.
- **URL** (truncated from the left so the path stays visible).
- **Status dot**: `● agent` (accent) while the agent is driving, `⟳`
  while loading, `!` (danger) after a load failure or crash,
  `n errors` (warning) when the console buffer has new errors since the
  user last looked. The error count is the single most useful glance
  signal the survey surfaced (Windsurf, Cursor, cmux all surface console
  errors).
- **Hover** over the strip shows a thumbnail (last `capturePage`, max
  320px wide) — a cheap way to see N lanes' UIs without opening N guests.
- **⤢** = open in Spotlight with the pocket shown. **✕** = detach pocket
  (confirm only if the agent is mid-action).

### 4.2 Lane, pocket open — the split

When the lane is big enough, the pocket opens as a split inside the lane.
Orientation is automatic: side-by-side when the lane is wider than 1.3×
its height, stacked otherwise. The divider is draggable and the fraction
is stored in `browserPocket.split`.

```
Wide lane (side by side)                  Tall lane (stacked)
┌─ lane 1 ─ auth-flow ───────────── ● ┐   ┌─ lane 3 ─ landing ──── ● ┐
│ agent view        ┃ ◀ ▶ ⟳ :3000 ⋯ │   │ agent view               │
│                   ┃───────────────│   │                          │
│                   ┃               │   ├──────────────────────────┤
│                   ┃   (page)      │   │ ◀ ▶ ⟳ :4321  /pricing ⋯ │
│                   ┃               │   │ (page)                   │
└───────────────────┸───────────────┘   └──────────────────────────┘
```

The unfocused-lane dim overlay (`TiledDispatchLayout.tsx:495-497`) cannot
cover a guest that lives in the host layer, so the host applies the same
dim to the guest itself when the owning slot reports `dimmed: true`.
Without this the grid would show bright browsers inside dimmed lanes.

### 4.3 Spotlight — agent and browser side by side

Spotlight is where the pocket earns its keep. `SpotlightView.tsx:65-73`
already renders one `renderWorkspaceLeaf(...)`; because the pocket split
is added *inside* the leaf wrapper (§5.4), Spotlight gets it with no
Spotlight-specific data. Spotlight-only affordances are layout presets:

```
┌ Spotlight  [auth-flow] [landing] [fix-checkout] ──────── Split │ Browser │ Agent ┐
├──────────────────────────────┬─────────────────────────────────────────────────┤
│ agent view (min 420px)       │ ◀ ▶ ⟳ │ localhost:3000/login        │ ◎ 📷 ⋯ │
│                              │─────────────────────────────────────────────────│
│                              │                                                 │
│                              │               (page, full height)               │
│                              │                                                 │
│  composer                    │ ● Agent is driving — clicked "Sign in"  [Take over] │
└──────────────────────────────┴─────────────────────────────────────────────────┘
```

- **Split | Browser | Agent** segmented control (right of the pills):
  Split = default 50/50 (remembered per session); Browser = pocket fills
  Spotlight and the agent shrinks to a 44px rail showing TLDR + status +
  a click-to-restore; Agent = pocket hidden (guest parked, not destroyed).
- Switching pills switches **both** agent and pocket — that is the point
  of attaching the pocket to the session. No reload for the pocket being
  left (it parks) or the one arriving (it was parked).
- A pill whose session has a pocket shows a tiny ◧ glyph.

### 4.4 The pocket chrome row (32px)

```
◀ ▶ ⟳ │ [◧ localhost:3000/login……………………]  ↗ │ ◎ │ 📷 │ ⋯
```

- Back / Forward / Reload (spinner doubles as loading, ⇧-click = hard
  reload).
- Address field: selects on focus, Esc reverts, Enter navigates; accepts
  `:5173` / `5173` shorthand → `http://localhost:5173`. http/https only.
- **↗** open current URL in the system browser (via
  `openAllowedExternalUrl`, `src/main/window/externalNavigation.ts:9`).
- **◎ Pick** — element picker (§4.7).
- **📷** screenshot → copies to clipboard and offers "Attach to agent".
- **⋯** menu: Device (Fill / iPhone 15 / Pixel 8 / iPad / 1280 / 1440 /
  custom), Appearance (System / Light / Dark), Zoom (− % +), Open
  DevTools, Profile ▸ (Lane-only / Shared with project), Clear cookies &
  storage for this pocket, Detach pocket.
- A 2px progress bar on the bottom edge while loading.

### 4.5 Empty pocket (no URL yet)

```
┌──────────────────────────────────────────────┐
│  This lane is serving                         │
│   ▸ localhost:5173   vite  (pid 81234) ← open │
│   ▸ localhost:6006   storybook                │
│                                                │
│  Recently opened here                          │
│   ▸ localhost:5173/checkout                    │
│                                                │
│  Type a URL above, or start a dev server in    │
│  this lane's terminal.                         │
└──────────────────────────────────────────────┘
```

Detected servers first (they are *this lane's*, which is the whole point),
then recents for this pocket. Mirrors T3's `PreviewEmptyState` and
Emdash's dev-server indicator, but lane-scoped.

### 4.6 Lane dev-server chip (without a pocket)

Even with no pocket attached, a lane whose process tree is listening on a
port shows a `:5173` chip in its lane header. Clicking it attaches a
pocket at that URL. This is the discovery path: the user runs `npm run
dev` (or the agent does), the chip appears, one click shows it. Mirrors
Emdash's title-bar indicator and Superset's per-workspace port list.
Only computed while the feature is enabled (§7.2 cost rules).

### 4.7 Pick an element → the lane's agent

`◎` (or ⌘⇧S while the pocket is focused — Claude Code Desktop's chord)
arms a picker inside the guest. Hover outlines elements; click selects;
⇧-click multi-selects; Esc cancels. On confirm, a chip is inserted **at
the caret** of **this session's composer draft** (never a new chat —
Cursor bug 145968; never appended at the end — Cursor bug 167268):

```
<browser-element url="http://localhost:3000/login" selector="form > button.primary"
  role="button" name="Sign in" size="320×44" />
```

plus a cropped screenshot through the existing draft-image path
(`workspace.setDraftImages`, used by `TileLeaf/useClaudeImagePaste.ts`)
for providers that accept images. Enter in the picker's optional comment
box adds to the batch; it never auto-sends (Codex bug 22719).

For terminal-surface agents (no composer), the chip text is written to
the clipboard with a toast "Element copied — paste into the agent". v1
does not type into a TUI on the user's behalf.

### 4.8 "Agent is driving" treatment

Cheap, static cues only (the survey's warning: Antigravity's animated
glow costs input latency):

- 2px accent inset border on the guest while an agent action is in
  flight or within 2s of one.
- A ghost cursor dot (host DOM, above the guest) at the last agent click
  point, fading to 35% after 700ms.
- A bottom status line in the pocket: `● Agent is driving — clicked
  "Sign in"` with **[Take over]**.
- **Take over** (or any human click/keypress in the guest) bumps the
  control epoch (§6.5): the in-flight action aborts, further `browser_*`
  mutating calls return `paused_by_user` until **[Let agent continue]**.
  Read-only calls (snapshot/screenshot/console) keep working.

### 4.9 Commands and keys

| Command | Default chord | Notes |
|---|---|---|
| Toggle Browser Pocket | ⌘⇧B | De-facto standard (Codex, Claude Desktop, Superset, Emdash, Conductor). Free in `features/command-keybindings/defaults.ts` today. Attaches if absent, then toggles open/collapsed. |
| Focus Pocket Address Bar | — (⌘L when pocket focused) | ⌘L globally is TLDR peek; only claimed inside the guest. |
| Reload Pocket | ⌘R when pocket focused | Intercepted in main `before-input-event` of the guest. |
| Pick Element for Agent | ⌘⇧S when pocket focused | |
| Open Pocket URL in Browser | — | |
| Detach Browser Pocket | — | |
| Clear Pocket Storage | — | |

Toggle Browser Pocket must be added to `SPOTLIGHT_FOCUS_MODE_COMMAND_IDS`
(`workspace/tile-tree/useKeybinds.ts:276-281`) or it silently does
nothing inside Spotlight (fail-closed allowlist). All targets resolve
through `commandTargetSessionId` (`hook/selectors/commandTargetSessionId.ts:35-60`),
which is already Spotlight-aware.

**Shortcuts while the guest has focus.** A focused `<webview>` swallows
key events; the host's `before-input-event` does not fire
(electron#14905/#14258). Main attaches `before-input-event` to each
guest's `webContents` and forwards an allow-listed set of app chords
(⌥S Spotlight, ⌘⇧B, the palette chords ⌘P and ⌘⇧P, ⌥←/→/↑/↓ lane
nav, ⌘L/⌘G peeks, Esc-when-Spotlight) to the renderer's keybinding router over IPC,
calling `preventDefault` on them. Everything else goes to the page.
Native editing chords (copy/paste/undo/select-all) are left to the page.

### 4.10 Settings

Category **Experimental** (`settingsCategories.ts`, row metadata
`status: 'experimental'`):

- **Browser pocket** — master switch, default **off**. Off ⇒ no
  commands, no chips, no port watching, `webviewTag` guard still
  installed but never used.
- **Agents can drive the browser pocket** — default for the new `browser`
  MCP domain (§6). Default **on when the master switch is on**; per-agent
  override via the existing built-in MCP toggles.
- **Open localhost links in the pocket** — route `localhost`/`127.0.0.1`
  links clicked in an agent's feed (`SafeMarkdownLink.tsx:24-31`) into
  that agent's pocket instead of the system browser. Default on.
- **Allow agents to run JavaScript in the pocket** (`browser_evaluate`) —
  default **off** (§8.4).

---

## 5. Rendering architecture: one host layer, many slots

### 5.1 Why not put `<webview>` inside the lane

Electron's own source (v43.7.4, `lib/renderer/web-view/web-view-element.ts`)
calls `detachGuest()` + `reset()` in `disconnectedCallback`: **any DOM
detach destroys the guest**; re-insertion is a fresh page. `moveBefore()`
does not help (no `connectedMoveCallback`), and React portals move DOM.
This is electron#9529, open since 2017.

In Agent Code a lane-embedded guest would therefore reload when:
lanes are inserted/removed/reordered (index keys), a session moves to
another lane, Spotlight opens (Spotlight renders a **second** leaf
instance while the stage stays mounted hidden — `MainSurface.tsx:93-142`),
and a mirrored session would run N copies. Nothing in the renderer
reparents DOM today (zero `createPortal` — verified), and xterm survives
remounts only because main keeps a replay buffer (`TerminalLeaf.tsx:377-464`);
a web page has no such buffer.

### 5.2 Why `<webview>` and not `WebContentsView`

`WebContentsView` survives any renderer layout change, but it always
paints **above** all HTML: the command palette, Radix dialogs, toasts,
pickers, and the Cmd+L/Cmd+G peeks could never cover it. VS Code handles
this by detecting overlap and swapping the native view for a screenshot
(`.github/skills/integrated-browser/SKILL.md`), plus manual bounds IPC
with its own resize-jank bugs (agent-orchestrator#5184). Agent Code is
overlay-heavy and shows *many* pockets at once; that trade is bad here.
The #518 revert (a second native window) is a different failure (OS
window layering) but points the same way: keep surfaces in the DOM.

`<webview>` is "not recommended" in the docs but **not deprecated**
(unchanged at v43.7.4), and the two closest peers — T3 Code and Orca, both
parallel-agent Electron 43 apps — ship it. We keep the guest behind a
`PocketSurface` interface so a WebContentsView backend can replace it
later without touching slots or tools.

### 5.3 The host / slot mechanism

```
App.tsx
├─ MainSurface
│   ├─ SpotlightView ─ PocketedLeaf ─ [agent leaf] + <PocketSlot sessionId=A surface="spotlight">
│   └─ RetainedWorkspaceSurface (hidden when a takeover is open)
│       └─ DispatchLayout ─ lanes ─ PocketedLeaf ─ [agent leaf] + <PocketSlot sessionId=A surface="lane" laneIndex=2>
└─ BrowserPocketHost            ← mounted ONCE, outside RetainedWorkspaceSurface
    └─ <div fixed layer> per live pocket → <webview partition=… src=…>
```

- **`PocketSlot`** renders an empty div. On mount it registers with the
  pocket surface store (`{ sessionId, slotKey, surface, dimmed }`), then
  publishes `{ rect, visible, clipRect, zIndex }` from
  `getBoundingClientRect` on ResizeObserver (slot *and* lane container),
  window resize, and captured scroll. `visible` comes from the existing
  composed visibility contexts (`WorkspaceSurfaceHiddenContext`,
  `useAgentTerminalOwnerVisible`, `AgentTerminalOwnership.tsx:29-51`), so a
  slot inside the hidden stage reports invisible without new plumbing.
- **Winner rule** (pure function, unit-tested): among visible slots for a
  session, Spotlight beats focused lane beats lowest lane index. Losing
  visible slots (mirrored lanes) render the last thumbnail with "Shown in
  Spotlight"/"Shown in lane N" — never a second live guest.
- **`BrowserPocketHost`** renders one fixed-position wrapper per *live*
  pocket and applies the winner's rect via `left/top/width/height` and
  `clip-path` from `clipRect`. Guests are keyed by `pocketId` — never by
  `SessionId` (ids change on reload) and never by lane.
- **Hidden** = parked at `left/top: -100000px`, still
  `visibility: visible` on macOS (T3: "Electron 43 can permanently blank a
  macOS webview after `visibility: hidden`"). **Never `display:none`**
  (electron#8277/#5110). A guest that must keep painting while hidden
  (agent automation lease, screenshot) is parked *inside* the window at
  `z-index:-1` behind the app, because Chromium stops compositing a
  guest that is fully off-window (T3 `hostedBrowserWebviewStyle.ts:51-63`).
- **Z-order:** the host layer sits below every overlay in
  `app/surfaces/registry.tsx` and below the palette/dialogs; that is the
  whole reason we chose `<webview>`. A click inside a guest reaches the
  host only as a `focus` event, so the host replays it as a synthetic
  `pointerdown` on `document` to close open popovers (T3 pattern).
- **Drag and drop:** between window `dragstart` and `dragend/drop`, all
  guests get `pointer-events:none` so lane drags and file drops are not
  swallowed (Orca pattern).
- **Lifetime:** a guest is created when its pocket first becomes visible
  (lazy restore after app start), released with a `setTimeout(0)`
  grace so React remount churn does not destroy it, and put to **sleep**
  after 10 minutes hidden or when more than 6 guests are live (LRU):
  destroy the guest, keep `url`, restore on next visibility. Freezing via
  CDP `Page.setWebLifecycleState` does not free GPU surfaces (Orca#19116:
  ~4 GB GPU at 10 painting hidden tabs), so sleep = destroy.
- **Crash recovery:** `render-process-gone` → bump generation, remount at
  last URL with 250ms × 2ⁿ backoff, max 3 in 30s, then show "Page
  crashed — Reload" in the pocket.
- **Zoom:** Chromium propagates the host window's zoom into guests; the
  host re-asserts each pocket's own zoom on attach and when app zoom
  changes, and never reads zoom back from the guest (T3 #12319/#10525).

### 5.4 `PocketedLeaf`

`renderWorkspaceLeaf` (`workspace/tile-tree/TileTree.tsx:33-184`) gains
one wrapper for agent-kind sessions whose meta has `browserPocket`:
it lays out `[leaf content | PocketSlot + chrome row]` per §4.2/§4.3,
or `[leaf content / pocket strip]` when collapsed. Terminal and
extension-view sessions never get pockets in v1 (a terminal's dev server
is attributed to the agent's lane instead, §7.2). Because both the lane
grid and Spotlight call `renderWorkspaceLeaf`, both get the pocket from
one code path — this is what makes "show it in Spotlight together with
the agent" nearly free.

---

## 6. Agent control: the `browser` MCP domain

### 6.1 Wiring

A new built-in domain `'browser'` on the existing `agent_code` MCP HTTP
host. That is the cheapest possible reach: the host already delivers
per-session bearer-authenticated MCP config to Claude (`--mcp-config`
temp file), Codex (`--config mcp_servers…`), OpenCode
(`OPENCODE_CONFIG_CONTENT`) and Grok (control connection) via
`src/providers/shared/runtime/builtInMcpLaunch.ts`, so **no launcher
changes**. Touch points:

- `src/mcp/shared/types.ts`: add to `BuiltInMcpDomain`,
  `BUILT_IN_MCP_DOMAINS`, `CONFIGURABLE_BUILT_IN_MCP_DOMAINS`,
  `BUILT_IN_MCP_DOMAINS_BY_PROVIDER`. **Not** in
  `CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS` in v1 (pockets hold no
  imported credentials); revisit when cookie import lands.
- `src/mcp/runtime/createBuiltInMcpServer.ts`: `if (scope.domains.includes('browser')) registerBrowserTools(server, scope, dependencies)`
  and a line in `builtInInstructions()`.
- `BuiltInMcpDependencies` (`BuiltInMcpHttpHost.ts:72-100`) gains
  `browserPockets: BrowserPocketController`, set once in
  `src/main/index.ts:1175-1210`. The MCP server object is rebuilt per
  request (`createBuiltInMcpServer.ts:193-202`), so all state lives in
  the controller, like `workflowService`.

### 6.2 Targeting: always the caller's own pocket

Every tool resolves its target from `scope.sessionId` (already present on
every request). There is no `tabId`/`sessionId` parameter in v1. This
removes T3 Code's worst class of bugs (#13051/#13064: automation reading
the wrong browser context when two clients exist) by construction. The
controller maps `sessionId → pocketId → live guest webContentsId`; the
renderer re-registers after id remaps.

If the caller has no pocket, `browser_open` asks the renderer (IPC) to
attach one in **collapsed** view (strip only — never a focus change,
never a popped panel; Cursor 145239 and Codex 32363 complaints), and the
host mounts the guest parked-behind-app so it can render. Every other
tool returns `no_pocket` with a hint to call `browser_open`.

### 6.3 Tools

| Tool | Kind | Notes |
|---|---|---|
| `browser_status` | read | url, title, loading, viewport, who is driving, detected lane ports. |
| `browser_open` | mutate | `{ url? , port?, show?: boolean }`. `port` resolves to `http://localhost:<port>`. Never navigates if already on that exact URL (Codex rule: `goto` of the open URL wipes user input). |
| `browser_navigate` | mutate | `{ url } \| { port } \| { action: 'back'\|'forward'\|'reload' }`. http/https only. |
| `browser_snapshot` | read | Text-only: url, title, an accessibility tree with refs (`- button "Sign in" [ref=e41]`), console errors + failed requests **since the last snapshot**, recent action timeline. No image by default (T3 #11295: full-res base64 PNGs in tool history broke sessions). |
| `browser_screenshot` | read | JPEG ≤1280px wide, optional `ref` crop / `fullPage`. Optional `save: true` writes to the session's scratch dir and returns the path. |
| `browser_click` | mutate | `{ ref } \| { selector } \| { x, y }`. Scroll into view → actionability (visible, enabled, hit-test) → trusted `Input.dispatchMouseEvent`. |
| `browser_type` | mutate | `{ ref, text, clear?, submit? }` via `DOM.focus` + `Input.insertText`. |
| `browser_press` | mutate | `{ key, modifiers? }` via `Input.dispatchKeyEvent` with focus emulation (below). |
| `browser_scroll` | mutate | `{ deltaY, deltaX?, ref? }`. |
| `browser_wait_for` | read | `{ text? , ref?, urlIncludes?, timeoutMs ≤ 15000 }`. |
| `browser_console` | read | `{ level?, since? }` ring buffer (200). |
| `browser_network` | read | failed + ≥400 requests ring buffer (200). |
| `browser_resize` | mutate | fill / preset / w×h. Changes CSS viewport only, never UA. |
| `browser_set_appearance` | mutate | dark / light / system (`Emulation.setEmulatedMedia`). |
| `browser_lane_ports` | read | this lane's discovered dev servers (§7). |
| `browser_evaluate` | mutate | **only registered when the setting is on** (§4.10). Runs in an isolated world; returns ≤64 KB JSON. |

Tool annotations follow MCP `readOnlyHint`/`destructiveHint`/
`openWorldHint` so provider permission UIs can auto-allow reads.

### 6.4 CDP implementation (main process)

- `BrowserPocketController` attaches `webContents.debugger.attach('1.3')`
  to each guest lazily on the first tool call, enables `Runtime`, `Log`,
  `Network` (for buffers), `Accessibility`, `Page`.
- **Snapshot:** `Accessibility.getFullAXTree` → compact Playwright-style
  YAML-ish lines, pruned to interesting roles, capped (~20k chars) with a
  "truncated" marker. `ref = e<backendDOMNodeId>`, stable for the life of
  the document. Click by ref = `DOM.scrollIntoViewIfNeeded` →
  `DOM.getContentQuads` → centre → `Input.dispatchMouseEvent` press/release.
  No Playwright dependency in v1 (see D4 for the upgrade path:
  `playwright-core ≥ 1.61` exposes `connectOverCDP(transport)` over an
  in-process transport, which VS Code uses via a Browser/Target proxy).
- **Isolation:** helper scripts run in `Page.createIsolatedWorld`, never
  the page's main world (T3 injects into the main world and trusts a
  page-spoofable `globalThis` flag — don't).
- **Focus:** never call `webview.focus()` for agent actions — that is what
  steals the user's composer focus (T3 #10980/#11577). Keyboard input uses
  `Emulation.setFocusEmulationEnabled` on the guest's own CDP session.
- **Serialisation:** one queue per pocket; every action gets a timeline
  entry and an **own deadline** (default 10s, max 15s). On timeout, only
  that pocket's debugger is detached and re-attached — never a global
  "evict the host" (T3 #12273/#12898 made every later call fail).
- **DevTools:** if the user opens DevTools on a pocket, mutating tools
  return `devtools_open` (debugger coexistence on 43.x is unverified —
  T3 refuses, VS Code coexists; verify, then relax).
- **Teardown order:** always `debugger.detach()` *before* the guest is
  destroyed (electron#53819: main-process use-after-free when a webview
  with an attached debugger is destroyed).

### 6.5 Human takeover (control epoch)

Main listens to guest `before-input-event` and `input-event`. Trusted
human mouse/keyboard input bumps the pocket's **control epoch**; the
agent's own CDP input is pre-registered as "expected" for 1s (±1px) so it
does not cancel itself (T3 `Manager.ts:1678-1714`). An in-flight action
observing an epoch change aborts with `user_took_control`. After a
takeover, mutating tools return `paused_by_user` until the user clicks
**Let agent continue** (or 60s pass with no human input — D7). Reads keep
working throughout.

---

## 7. Finding "this lane's" dev server

### 7.1 Why detection, not assignment

Frameworks disagree about `PORT` (Vite ignores it and auto-increments from
5173 unless `strictPort`), agents start servers themselves, and users
start them in terminals. Every product that *predicted* ports shipped bugs
(Claude Code #86039: panel ignores agent-started servers, binds to a dead
duplicate; #90661: launch.json read from the wrong worktree; Antigravity:
"connected to the wrong localhost port with many projects open").
Superset's model — *watch process trees, attribute listening sockets to
the owning workspace* — is the one that works with any setup.

### 7.2 Lane process tree

For an agent session S, the lane process tree is:

1. S's own PID and all descendants (Claude Code/Codex background Bash
   jobs are children of the agent process), from the existing
   `ps -axo pid,ppid` sampler (`src/main/performance/NativeProcessSampler.ts:55-84`)
   rooted at `sessionManager.getProcessTelemetryTargets`
   (`src/main/sessionManager.ts:5004-5036`).
2. Plus every **terminal** session in the same project whose
   foreground cwd (`terminalForeground.cwd`, 1 Hz,
   `src/main/sessions/terminalForeground.ts`) or spawn cwd is inside S's
   worktree (`runtime.workContext.worktreePath`, else `meta.cwd`), with
   descendants. Terminals are not formally linked to agents today
   (`dispatchTerminalPlacement`), so cwd containment is the attribution
   rule. Ties (two agents in the same directory) attribute the port to
   both, and the chip says so.

### 7.3 Scan

- macOS: `lsof -nP -a -iTCP -sTCP:LISTEN -p <pid,pid,…> -F pcn` (the `-a`
  is required to AND the filters). Measured ~40ms scoped on a 656-process
  Mac.
- Linux: `/proc/net/tcp{,6}` LISTEN rows → inode → `/proc/<pid>/fd` for
  the tree's PIDs only.
- Windows: `netstat -ano -p TCP` filtered to the tree's PIDs.
- **Only PIDs we own.** No HTTP probes to foreign listeners (T3 #8407: its
  scanner's probes crashed other apps). An owned listener is additionally
  probed once with `GET /` (1s, loopback) to label it `html` vs `api`;
  non-HTML ports stay listed but sort last.
- **When:** only while the master setting is on **and** at least one lane
  is visible; triggered by terminal-foreground command changes and agent
  tool activity, with a floor of 3s and back-off of `max(3s, 20 × last
  scan time)` (VS Code's formula); zero work when nothing is visible.
- Output-parsing fallback (VS Code's `urlFinder` regex over PTY output) is
  a follow-up for SSH/remote cwd cases (D8).

---

## 8. Security

### 8.1 Partitions and cookie isolation

- Cookies **ignore ports** (RFC 6265 §8.5). Two worktrees on
  `localhost:3000` and `localhost:3001` in one Electron session share
  every cookie; logging in on one logs out the other. This is exactly
  Claude Code #53604 (closed "not planned"). A pocket partition per lane
  fixes it.
- Partition name: `persist:ac-pocket-<pocketId>` for `profile: 'lane'`,
  `persist:ac-pocket-project-<projectId>` for `profile: 'project'`.
  Derived from `pocketId`, which survives session-id remaps (§3.1).
- Default **`lane`** (D1). "Clear cookies & storage" clears only that
  partition.
- Guests never use `defaultSession` (it carries the app's protocols,
  dictation microphone permission path, and preload registrations).

### 8.2 `will-attach-webview` (fail closed)

The main window gets `webviewTag: true` (`src/main/window/appWindow.ts:201-218`)
and, in the same change, a `will-attach-webview` handler (new
`src/main/browserPocket/guestGuard.ts`, pure policy function + thin
Electron binding) that `preventDefault()`s unless:

- `params.partition` starts with `persist:ac-pocket-`;
- `params.src` is `about:blank` or http/https.

and then forces: delete `webPreferences.preload`/`preloadURL`;
`nodeIntegration:false`, `nodeIntegrationInSubFrames:false`,
`contextIsolation:true`, `sandbox:true`, `webSecurity:true`,
`allowRunningInsecureContent:false`, `backgroundThrottling:true`,
empty `enableBlinkFeatures`. (T3 runs guests with `contextIsolation:false`
so react-grab can read the React DevTools hook; we don't need that for v1,
and the picker runs from CDP in an isolated world instead of a guest
preload.)

The main window's renderer is privileged (~153 preload IPC methods with no
frame check). A renderer XSS could now create a `<webview>`; the
fail-closed guard is what keeps that from being a Node/preload escape.

### 8.3 Guest policies (on `did-attach-webview`)

- `setWindowOpenHandler`: `target=_blank` / `window.open` to http(s) →
  load in the same pocket; everything else → deny. (OAuth popups that
  need `window.opener` → D9, v1 denies them with a toast offering "Open in
  system browser".)
- `will-navigate` / `will-redirect`: http/https only; block `file:`,
  `javascript:`, `data:` top-level, custom schemes (Emdash blocks the same
  set).
- Partition session: `setPermissionRequestHandler` **and**
  `setPermissionCheckHandler` deny everything except
  `clipboard-sanitized-write` (both handlers — async clipboard is gated by
  the check handler, T3 `BrowserSession.ts:206-211`). Electron auto-grants
  every permission when no handler is set.
- Certificates: accept self-signed certs **only** for loopback hosts and
  `*.localhost`, pinned by host + fingerprint after the user clicks
  through once; everything else uses default verification.
- Leave the User-Agent alone (rewriting it breaks Cloudflare Turnstile,
  T3 #5002).

### 8.4 Agent-facing risk

The pocket is a clean profile with no imported credentials, so prompt
injection from a page can at worst make the agent act inside a dev app —
but these agents also have shell and filesystem access, so a hostile page
could still try to talk the agent into exfiltrating local data.
Mitigations in v1: `browser_evaluate` off by default; tool results mark
page-sourced text as untrusted in the domain instructions; navigation is
http/https only. When cookie import arrives, the `browser` domain moves
into `CONFIRMATION_GATED_BUILT_IN_MCP_DOMAINS`.

---

## 9. Error handling summary

| Failure | Behaviour |
|---|---|
| Load fails (`did-fail-load`) | In-pocket error page: "Can't reach localhost:5173 — `ERR_CONNECTION_REFUSED`", Retry, and the lane's detected ports as alternatives. `browser_*` returns the error code. |
| Guest crash | Auto-remount with backoff (§5.3), then a Reload button. Debugger re-attaches lazily. |
| Tool timeout | Per-action deadline; reset that pocket's debugger only; return `timeout` with the action timeline. |
| Session id remap (reload/switch/rewind/undo) | Renderer remaps runtime slice; `pocketId` unchanged so partition, guest, and page survive; controller re-keys `sessionId → pocketId`. |
| Session closed | Guest destroyed after debugger detach; partition data kept for undo-close for the undo window, then left on disk (clearing is explicit). |
| Feature toggled off | All guests destroyed, watchers stopped, `browser` domain returns `disabled`; `SessionMeta.browserPocket` retained so toggling back on restores. |
| DevTools open | Mutating tools return `devtools_open`. |

---

## 10. Testing strategy

Honouring the repo's rules (recorded fixtures, fail-first on the real
path, no app launch in agent sessions, one full-suite run at the end):

- **Pure units:** slot winner rule; `guestGuard` policy (table of
  params → allow/deny/forced prefs); URL normaliser (`:5173` shorthand,
  scheme block-list); split-orientation rule; lsof/`/proc`/netstat parsers
  against **recorded** command output from real machines; AX-tree →
  snapshot formatter against a **recorded** `getFullAXTree` JSON from a
  real Vite app.
- **Renderer tests:** `browserPocket` survives `replaceSession` and
  undo-close (`successorRelationships`-style); removal clears runtime
  slice; Spotlight and lane both render `PocketSlot` for the same session;
  command available in Spotlight (allowlist).
- **Main tests:** controller with a fake `Debugger` (records CDP calls,
  replays recorded responses) for snapshot/click/type/timeout/epoch
  abort; teardown order detach→destroy.
- **MCP tests:** tool registration gated by domain and by the evaluate
  setting; targeting by `scope.sessionId`.
- **Manual QA checklist** (the user runs the app; agents never launch it):
  reload-free moves between grid and Spotlight; lane insert/remove with a
  live pocket; two worktrees on :3000/:3001 with separate logins; ⌥S /
  ⌘⇧B / ⌘P while the page has focus; agent click does not move composer
  focus; take-over mid-action; crash recovery (kill the guest's renderer
  process from Activity Monitor); sleep/wake after 10 min.

---

## 11. Open decisions (recommendation first)

- **D1 — default profile.** *Recommend `lane`* (own cookie jar per
  pocket; fixes the port-cookie collision). Alternative `project`
  (log in once per project, collisions return). Both are offered in the
  ⋯ menu either way.
- **D2 — where the pocket appears in a narrow lane.** *Recommend the
  22px strip + hover thumbnail* (§4.1) with auto-split only above the
  size threshold. Alternative: never split in lanes, Spotlight only.
- **D3 — tabs.** *Recommend one page per pocket in v1.* Tabs double the
  targeting model (`tabId` everywhere) and T3's tab bugs are a large
  share of its issue list. Revisit after use.
- **D4 — snapshot engine.** *Recommend raw CDP AX tree in v1*, no new
  dependency. Upgrade path: `playwright-core ≥ 1.61`
  `connectOverCDP(transport)` behind a Browser/Target proxy (VS Code
  `src/vs/platform/browserView/common/cdp/proxy.ts`) for real actionability
  checks and `aria-ref` semantics, preferably in a utility process so it
  can't load main.
- **D5 — Electron bump.** *Required*: installed is 43.1.1; the
  webview/debugger use-after-free and dangling-pointer fixes are in
  43.7.x (electron#53376, #53819, #53989 via #54089). Bump to the latest
  43.7.x as phase 0.
- **D6 — port assignment.** *Recommend detection-only in v1.* Follow-up:
  inject `AGENT_CODE_PORT` (a per-session base, Conductor-style +0..9)
  into agent and terminal spawn env, and/or Portless-style
  `<lane>.<project>.localhost` names (stable URLs, cookie isolation for
  free, Chromium resolves `*.localhost` to loopback).
- **D7 — takeover auto-resume.** *Recommend explicit "Let agent
  continue"*, with a 60s idle auto-resume. Alternative: never auto-resume.
- **D8 — output parsing.** *Recommend deferring* PTY-output URL parsing
  (VS Code `hybrid`) until SSH/remote cwds matter.
- **D9 — OAuth popups.** *Recommend deny + "Open in system browser" in
  v1*; later, T3's hardened real-popup window for http(s) `new-window`
  dispositions.
- **D10 — terminal-surface agents and the picker.** *Recommend
  clipboard + toast* in v1 rather than typing into a TUI.

---

## 12. Rough size

T3 Code's preview is ≈24k non-test LOC (desktop 8.7k, web 10.9k, server
2.3k, contracts 1.8k) — but that includes tabs, recording, PiP windows,
annotation drawing, remote environments and cookie import. The v1 scope
here (no tabs, no recording, no PiP, no import, local only) is estimated
at **6–8k LOC plus tests**, dominated by the controller (CDP), the host
layer, and the pocket chrome.

---

## 13. Sources

Codebase (paths at `origin/main` 2a5d7771): cited inline.

External:
- Electron: webview tag docs @ v43.7.4 (<https://github.com/electron/electron/blob/v43.7.4/docs/api/webview-tag.md>),
  `web-view-element.ts` disconnectedCallback, #9529, #8277, #14905,
  #36199, #53376, #53819, #53989/#54089, security checklist
  (<https://www.electronjs.org/docs/latest/tutorial/security>), debugger
  (<https://www.electronjs.org/docs/latest/api/debugger>).
- T3 Code (`pingdotgg/t3code`): `apps/web/src/browser/*`,
  `apps/desktop/src/preview/*`, `apps/server/src/mcp/toolkits/preview/tools.ts`,
  issues/PRs #3715 #5002 #5540 #6355 #8256 #8332 #8407 #10980 #11295
  #11577 #12273 #12319 #12706 #12898 #13051 #13064.
- VS Code Integrated Browser + agent browser tools GA 2026-07-01
  (<https://github.blog/changelog/2026-07-01-browser-tools-for-github-copilot-in-vs-code-are-generally-available/>),
  `.github/skills/integrated-browser/SKILL.md`, `remote.autoForwardPortsSource`.
- Orca (`stablyai/orca`) webview security + #19116.
- Claude Code: desktop docs (<https://code.claude.com/docs/en/desktop>),
  #53604, #86039, #90661.
- Codex app browser (<https://learn.chatgpt.com/docs/browser?surface=app>),
  openai/codex #20490 #22719 #23871 #27349 #32363 #42244 #43051.
- Cursor 2.0/3.0 changelogs, Design Mode docs, forum threads 145239,
  145968, 162951, 167268.
- Antigravity browser docs + recordings; Conductor 0.55/0.62/0.83
  changelogs + scripts reference; Superset ports + browser docs; Emdash
  in-app browser docs; Vibe Kanban preview docs; Portless
  (<https://github.com/vercel-labs/portless>); RFC 6265 §8.5.
