# Browser Pocket usability

Issues: #1152 (layout/controls), #1153 (setup), #1154 (browser automation).

## Intent
Make the browser work in the actual space available. User rejects vertical stacking: use left/right when both panes fit, otherwise switch full-size Agent/Browser surfaces. Preserve mounted terminals and guests. Delegate browser editing/navigation/context menu behavior to Electron; keep only necessary app chrome. Make setup a clear single path.

## Implementation
1. Measure usable width/height; replace aspect-ratio stacking and forced Spotlight splits with bounded left/right split or full-pane presentation. Keep an explicit return to the agent and keyboard/cancellation-safe resizing.
2. Simplify browser toolbar; native context/menu actions, stop/reload, existing Chromium navigation, fit and viewport dimensions made honest. Retain guest ownership architecture to avoid session loss during layout changes.
3. Stable MCP tool catalog and instructions with runtime feature and evaluation gating. Preserve provider opt-outs after first enable. Display running-agent attachment and a direct single-reload setup action.
4. Regression tests for compact/open transitions, size boundaries, stable agent identity, native action routing, and single-client enable/disable discovery. Typecheck, relevant suites, renderer visual inspection without launching Electron, review final diff, open PR and await CI.

## Research
Electron web-embeds, webContents, NavigationHistory and MenuItem official docs; VS Code browserView navigation/tab features and toolbar overflow; current feature architecture and setup/reload implementation. Electron supplies the engine and native menus/edit roles, not an embeddable Chrome address bar. Migrating guest ownership to WebContentsView is a separate architecture change, not required to repair these concrete failures.

## Verification boundary
The running app uses the main checkout's built output. Do not launch/restart Electron or pretend branch changes are running there. Inspect real layout in an isolated renderer harness if possible; report native-runtime verification limits precisely.


## Scope correction after user feedback
The user explicitly requires an embedded browser and a substantial rebuild, not layout patches alone. Replace the bespoke automation engine with Playwright 1.63 public in-process CDP transport and AI aria snapshots. Keep the existing session/guest lifecycle ownership where it is sound; retain Chromium rendering inside Agent Code. A single-target protocol adapter must never expose other pockets or the app renderer. Action cancellation and human takeover remain authoritative across Playwright retries. Verify using an isolated real Chromium fixture without launching Electron. The initial layout/setup changes are groundwork, not completion.


## T3 Code interaction reference
Read upstream PreviewPanelShell, PreviewChromeRow, PreviewEmptyState and openPreviewSession. Adopt the coherent embedded panel beside the agent, actual container-based size limits, persistent session on collapse, discoverable local-server choices, and direct element-to-agent interaction. Narrow lanes switch full-pane surfaces and offer expansion into Spotlight; never stack agent and browser vertically. Keep settings in a native menu instead of duplicating browser menu/focus behavior in DOM overlays.

## Review resolutions
Runtime permission is rechecked after isolated-world setup. Native Stop/Reload captures the displayed operation. Deadline recovery happens even after human takeover, so unresponsive actions cannot poison the queue. Library-issued input is released on failure through Playwright APIs to clear both native and cached modifier state. Re-enabling explicitly opens a saved pocket. Regression coverage exercises these boundaries, including real Chromium cross-site frames and interrupted chords.
