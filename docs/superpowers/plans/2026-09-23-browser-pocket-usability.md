# Browser Pocket usability

Issues: #1152 (layout/controls), #1153 (setup).

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
