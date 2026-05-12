# Issues

## 1. Streaming Render Flicker During Agent / Review Tool Output

- Status: documented only, do not solve yet
- Area: renderer state selection between semantic streaming, screen parsing, and activity/thinking fallback

### Symptom

During some agent-style outputs, the visible content flickers back and forth:

1. the streamed tool/output content renders
2. it disappears and is replaced by a thinking ticker / activity-style placeholder
3. the content comes back briefly
4. the UI repeats that cycle over and over

This is not a one-time transition. It oscillates repeatedly while the turn is still active.

### Example Shape

Observed with flows shaped like:

```text
Please review the full diff for me in this project

Agent
Review full project diff
superpowers:code-reviewer(Review full project diff)
⎿  Read(src/renderer/src/features/workspace/lib/newAgentPlacement.ts)
Search(pattern: "createProxyServer|runtimeDir|sessionKey", path: "claude-code-headless")
Search(pattern: "runtimeDir|process.cwd|timestamp|toISOString|cwd:" |path.join.*cwd", path: ...)
```

### Expected Behavior

Once concrete streamed content is visible, the renderer should not bounce back to a thinking/activity placeholder unless the content is actually gone from the authoritative live state.

### Actual Behavior

The UI appears to alternate between:

- rendered streamed content
- thinking ticker / activity fallback

even though the turn is still actively producing tool/output content.

### Likely Boundary

This likely sits at the handoff between:

- semantic live rendering
- screen-parsed fallback rendering
- activity / thinking fallback gating

Possible failure modes:

- live semantic state temporarily evaluates as absent while the session is still active
- a grouped/tool-heavy render shape is not considered “real content”, so the UI falls back to the thinking ticker
- screen and semantic paths disagree about whether the turn currently has displayable output
- agent/tool-review style rows are being replaced by a generic loading state during intermediate updates

### Notes For Future Debugging

- Repro seems easier with agent/reviewer style outputs than with simple prose-only assistant replies.
- The issue is visual instability, not missing final transcript content.
- Debug this from the renderer state machine first, not from markdown rendering.

## 2. Editor Workbench Should Be A Separate Top-Level Mode

- Status: documented only, do not solve yet
- Area: editor architecture / app shell layout

### Problem

If we add a real Monaco-based editor, it should not be bolted directly into the main agent pane/feed flow.

The current app already has page-like modes:

- normal workspace / tile tree
- reader mode
- spotlight mode
- settings

The editor should follow that pattern and live as a separate top-level editor workbench/page.

### Why This Matters

Agent panes and editor panes have different interaction models:

- agent panes are transcript-driven, streaming, and multi-surface
- editor panes want stable focus, model lifetime, save/dirty state, and keyboard ownership

Trying to force a full editor into the main agent view will create avoidable conflicts in:

- keyboard focus
- global shortcuts
- pane navigation
- command routing
- dirty/save state
- future Vim behavior

### Recommended Direction

The editor should be a separate workbench-like page/mode with:

- Monaco editor area
- file explorer/sidebar
- open-file tabs
- dirty/save state
- command palette integration

This should be routed/mounted from the app shell the same way Reader and Spotlight are routed today.

### Existing Foundation

Monaco is already in the app as a read-only rendering primitive:

- `src/renderer/src/code/CodeBlock.tsx`
- `src/renderer/src/code/monacoRuntime.ts`

That means the likely path is not "add Monaco from zero", but "promote the Monaco runtime into a full editor workbench with its own state model".

### Architecture Constraint

The editor should have its own store/model layer rather than being absorbed into `workspaceStore`.

Likely responsibilities:

- open files
- active file
- Monaco models by path
- dirty state
- cursor/view state
- save/reload behavior

### Notes

- This is a product/architecture issue first, not a rendering issue.
- A separate editor page is the cleaner path than embedding editing directly into transcript panes.

## 3. Vim Keybinds Need A Context-Aware Keybinding Layer First

- Status: documented only, do not solve yet
- Area: input architecture / editor integration

### Problem

Adding Vim keybinds before the app has a real keybinding context/focus model will create conflicts.

Right now the app already has global keybinds for:

- command palette
- pane navigation
- pane resize (should be resolved)
- workspace actions

If Vim is added naively, it will fight with:

- agent/workspace shortcuts
- editor shortcuts
- terminal focus
- command palette focus
- pane-level navigation

### Required Precondition

Before Vim mode, the app needs explicit input contexts such as:

- `editorFocus`
- `agentPaneFocus`
- `terminalFocus`
- `commandPaletteOpen`
- later `vimMode`

Key resolution should depend on context instead of assuming one global shortcut layer.

### Recommended Direction

The order should be:

1. add the editor workbench
2. add Monaco editing with proper file/model state
3. add an editor-focused command/keybinding layer
4. only then add Vim mode

### Notes

- Vim itself is not the main technical risk.
- The real risk is shortcut/focus conflict across the rest of the app.
- Monaco + Vim is reasonable, but only after input ownership is clearly defined.

## 4. Claude Input Should Support Clipboard Image Pasting With Visible UI Preview

- Status: documented only, do not solve yet
- Area: Claude composer / attachment UX

### Problem

Claude supports pasting images into input. Agent Code should support that too.

This should not just be a hidden transport feature. The UI should make the pasted image visible and obvious before send.

### Expected Behavior

When the user pastes an image into the Claude input:

- the image is captured correctly
- it is attached to the outgoing Claude request
- the composer shows a clear preview/attachment chip/card for the pasted image
- the user can confirm what image is about to be sent
- ideally the user can remove it before sending

### Why This Matters

Without visible preview, pasted-image support is easy to mistrust:

- the user cannot tell whether the paste worked
- the user cannot tell which image is attached
- accidental image send/removal is harder to reason about

### Recommended Direction

Support image paste as a first-class Claude composer feature, with:

- clipboard image detection in the input/composer flow
- attachment state in the renderer/store
- visible preview in the UI before send
- remove/clear affordance

### Notes

- This should be better than raw Claude parity in UX, not just equivalent transport support.
- The important requirement is both transport support and clear visual confirmation in the composer.

## 5. Tab Tiling Layout Should Persist Across Restart

- Status: documented only, do not solve yet
- Area: workspace persistence / tiled tabs

### Problem

Tab tiling should be persistent.

If the user arranges tabs into a tiled layout, that layout should come back after restart instead of falling back to a non-tiled/default tab state.

### Expected Behavior

The persisted workspace should restore:

- whether tab tiling was enabled
- which tabs were part of the tiled set
- tile direction/layout
- selection/focus state
- ratios/sizing where applicable

### Why This Matters

Tab tiling is part of the user’s workspace structure, not a temporary visual toggle.

If it resets on restart:

- the workspace comes back in the wrong shape
- the user loses orientation
- the feature feels unreliable compared to pane persistence

### Recommended Direction

Treat tiled-tab layout as first-class persisted workspace state, the same way pane trees and sessions are treated.

### Notes

- This issue is specifically about the persistence of the tiled tab arrangement, not just whether the tabs themselves still exist after restart.

## 6. Rendering Engine Sometimes Duplicates Assistant Output

- Status: documented only, do not solve yet
- Area: renderer / live response assembly

### Problem

The rendering engine sometimes duplicates output during a response, so the same assistant text appears twice in a row.

### Example Symptom

Observed shape:

```text
I’m adding that as another documented issue/requirement only. I’ll frame it as persistence for the tab-tiling layout itself, not just the underlying tabs, so the intended behavior is explicit.

I’m adding that as another documented issue/requirement only. I’ll frame it as persistence for the tab-tiling layout itself, not just the underlying tabs, so the intended behavior is explicit.
```

This is the same text duplicated back-to-back inside the rendered response.

### Expected Behavior

The live renderer should show each piece of assistant output once.

### Actual Behavior

The same response content is sometimes rendered multiple times during streaming or assembly.

### Likely Boundary

This likely sits somewhere in:

- live semantic turn assembly
- screen fallback assembly
- feed row derivation / merge logic
- historical entry + live streaming overlap

Possible failure modes:

- the live semantic row and the settled transcript row are both rendering the same content
- fallback and primary rendering paths are both active at once
- a streaming row is not being replaced cleanly when the final entry lands
- duplicate deltas / duplicate fold behavior are surfacing twice in the UI

### Notes For Future Debugging

- This should be debugged as a state/assembly issue, not as a typography or markdown issue.
- Pay special attention to transitions between live streaming content and finalized transcript entries.

## 7. Claude Long Messages Break Because They Are Treated As Paste

- Status: documented only, do not solve yet
- Area: Claude composer / input handling

### Problem

Claude does not work properly for long messages because long input is being handled like a paste event instead of normal message composition.

### Expected Behavior

Long user messages should be accepted and sent as normal Claude input without changing behavior just because the message is large.

### Actual Behavior

Long messages appear to trigger paste-style handling, which causes Claude input behavior to break.

### Why This Matters

This makes normal long-form prompting unreliable and turns a common usage pattern into a failure case.

### Likely Boundary

This likely sits somewhere in:

- composer input event handling
- paste detection logic
- message serialization for Claude
- attachment/clipboard pathways interfering with plain text input

### Notes For Future Debugging

- Treat this as an input classification bug, not as a Claude model bug.
- The important distinction is between genuine pasted content handling and ordinary long-text composition.

## 8. Agent Activity Rendering Should Be Prettified Instead Of Showing Raw Read/Edit/Command Payloads

- Status: documented only, do not solve yet
- Area: agent rendering / live tool activity UX

### Problem

While agents are running, the UI currently surfaces too much raw execution detail.

Examples of raw details we should avoid exposing directly in the main flow:

- full file contents from read operations
- raw bash commands
- raw edit payloads / patch-like content

### Expected Behavior

Agent activity should be rendered in a higher-level, prettified form.

The user should generally see:

- what the agent is doing
- which file or area it is working on
- a concise summary of the action

The user should not be forced to parse raw implementation payloads in the main activity flow.

### Why This Matters

Raw tool payloads make the live flow noisy and hard to follow.

Instead of reading the agent’s progress, the user ends up reading:

- file contents
- shell syntax
- raw edit details

That is too low-level for the default live experience.

### Recommended Direction

Render agent activity as summarized action rows, for example:

- reading `path/to/file.ts`
- searching `pattern` in `directory`
- editing `file.ts`
- running tests
- reviewing diff

Raw payloads should be hidden behind an expanded/debug/verbose surface rather than shown by default.

### Notes

- This is closely related to the broader rendering/task-model issue.
- The default live flow should prioritize readability and progress, not raw tool transport data.

## 9. Codex Proxy SSE Parsing Still Does Not Cover Enough Real Shapes

- Status: documented only, do not solve yet
- Area: Codex proxy parsing / SSE reverse engineering

### Problem

We are still not handling anywhere near enough real Codex SSE/proxy cases.

The current parser coverage is incomplete, which means the app cannot yet rely on the Codex proxy stream as a fully understood semantic source.

### Expected Behavior

Codex SSE/proxy parsing should cover the real event shapes well enough that:

- live rendering is trustworthy
- tool/activity state is not silently dropped
- transcript reconstruction is stable
- fallback/screen parsing is not carrying most of the load

### Actual Behavior

Parser coverage is still partial, and more reverse engineering is needed to understand and handle the full stream shape properly.

### Why This Matters

If the stream parser only handles a subset of real events:

- rendering quality regresses
- state assembly becomes fragile
- tool/activity behavior gets misclassified or lost
- downstream UI work ends up compensating for parser gaps

### Recommended Direction

Continue reverse engineering the Codex SSE/proxy stream deliberately and expand parser coverage before assuming the transport layer is “done”.

### Notes

- This is not just a polish issue; it affects the correctness of every UI surface built on top of the Codex semantic stream.
- The more incomplete the parser is, the more the app will fall back to heuristics and mismatched rendering logic.

## 10. New Turn Startup Sometimes Shows The Full Previous Response Before Live Agent Activity Begins

- Status: documented only, do not solve yet
- Area: live-turn startup / previous-response handoff

### Problem

When the user first sends a new message, there is still a weird bug where the UI shows the full previous response before the new live agent activity becomes visible.

### Expected Behavior

Once a new turn starts, the UI should transition cleanly into the new live state:

- either the new activity/thinking/tool state is visible
- or the UI is clearly waiting for the new turn

It should not appear to replay or foreground the full previous response during that handoff.

### Actual Behavior

The last completed response can remain visually dominant at the start of the next turn, until the new live agent activity finally becomes visible.

### Why This Matters

This makes the start of a turn feel confusing and incorrect:

- it looks like the old response is being shown again
- the user cannot immediately tell that the new turn has actually started
- the live state transition feels laggy or stale

### Likely Boundary

This likely sits somewhere in:

- previous-response vs live-turn selection logic
- streaming baseline / recent screen handoff
- semantic current-turn startup timing
- feed logic that decides what counts as the active in-progress row

### Notes For Future Debugging

- This is likely related to stale live-state selection rather than transcript persistence itself.
- Pay attention to the exact moment between user send and first new semantic/screen activity becoming available.

## 11. Codex And Claude Rendering Engines Are Still Too Different And Should Be Standardized Toward The Claude Model

- Status: documented only, do not solve yet
- Area: cross-provider rendering architecture

### Problem

The Codex and Claude rendering engines are still too different.

Right now they do not share a sufficiently standardized rendering model, which means the app behaves inconsistently depending on provider.

### Expected Direction

The rendering architecture should be standardized so Codex follows the same overall rendering model as Claude wherever possible.

That does not mean every provider-specific detail disappears, but the app should have one coherent rendering pipeline instead of two materially different ones.

### Why This Matters

If Codex and Claude rendering evolve separately:

- UI behavior diverges
- bugs are fixed twice
- feature parity becomes harder
- the app feels inconsistent between providers
- shared rendering improvements do not transfer cleanly

### Recommended Direction

Standardize toward the Claude-style rendering model:

- stronger semantic/state-driven rendering
- shared live-turn assembly concepts
- shared tool/activity rendering expectations
- shared fallback rules where possible

### Notes

- This is an architectural standardization issue, not just a visual consistency issue.
- Provider-specific transport differences are expected, but the UI/rendering model above them should be much closer than it is now.

## 12. Bring Back High Contrast Mode, Make It Work In Both Dark And Light, And Add A Softer Second Light Theme

- Status: documented only, do not solve yet
- Area: theming / accessibility / visual design

### Problem

We need to bring back high contrast mode, but do it in a more complete way:

- it should work for dark mode
- it should also work for light mode
- and we should add a second light mode that is easier on the eyes

### Expected Direction

Theme support should include:

- standard dark mode
- a gray/dim dark mode that is not fully black
- standard light mode
- high-contrast dark mode
- high-contrast light mode
- a softer / lower-strain light theme variant

### Why This Matters

The current theme model is too limited for:

- accessibility
- long-session readability
- user preference across very different lighting conditions

One light theme is also not enough if the default light palette is visually tiring.

### Recommended Direction

Treat theme variants as first-class supported modes rather than one-off overrides.

The theme system should support contrast and tone as deliberate dimensions, not just a single dark/light toggle.

### Notes

- This is partly an accessibility issue and partly a usability/comfort issue.
- The softer second light theme should explicitly optimize for lower eye strain rather than maximum contrast.
- The gray mode should provide a darker theme option without going all the way to a pure/fully black background.

## 13. Large Parts Of The Application Need Refactoring So The Structure Is Easier For A Human To Read And Understand

- Status: documented only, do not solve yet
- Area: overall codebase structure / maintainability

### Problem

Large parts of the application need refactoring because the structure is still too hard to read and understand as a human.

Even when behavior is technically working, the current organization can make it difficult to:

- find the real source of truth
- trace a feature end to end
- understand ownership boundaries
- safely make changes without re-learning too much local complexity

### Why This Matters

If the structure stays too hard to read:

- bugs take longer to diagnose
- features are slower to add
- architectural drift gets worse
- future contributors/agents keep re-discovering the same context

### Expected Direction

The application should be refactored so major areas have clearer boundaries and are easier to reason about as a human reader.

That likely includes:

- clearer feature/module ownership
- fewer mixed responsibilities inside large files
- more obvious state boundaries
- better naming and organization around core flows

### Notes

- This is a maintainability and comprehension issue, not just a style issue.
- The goal is not “refactor for its own sake”; the goal is making the app structurally easier to understand and change safely.

## 14. Rework Activity Detection To Rely Primarily On Proxy Status

- Status: documented only, do not solve yet
- Area: activity detection / live state

### Problem

Activity detection should be reworked to rely primarily on proxy status rather than on weaker heuristics.

### Why This Matters

When activity detection is driven by indirect or stale signals, the UI can show the wrong state:

- thinking/activity indicators at the wrong time
- stale previous output staying visible too long
- flicker between active and inactive states
- disagreement between what the model is actually doing and what the UI suggests

### Expected Direction

Proxy/semantic status should be the main source of truth for whether a session is actively working, waiting, streaming, or done.

Fallback heuristics can still exist, but they should not be the primary driver when proxy-derived state is available.

### Notes

- This is closely related to the rendering/state-selection issues already documented above.
- The goal is to reduce heuristic-driven activity behavior and make the UI follow authoritative proxy state more closely.

## 15. Completely Rework Screen Parsing And Build A Proper Test Suite For Streamed Scenarios

- Status: documented only, do not solve yet
- Area: screen parsing / test infrastructure

### Problem

Screen parsing needs a much more complete rework.

It should support far more edge cases than it does now, and we also need a proper testing setup that makes it easy to validate many different streamed-response scenarios.

### Why This Matters

Right now screen parsing is still carrying important fallback behavior, but it is too fragile:

- edge cases are easy to miss
- rendering bugs are hard to reproduce reliably
- regressions are easy to introduce
- streamed transitions are not easy to test with confidence

### Expected Direction

Screen parsing should be reworked so it handles edge cases much more deliberately and predictably.

We should also build a test suite / harness that makes it easy to test:

- different terminal/screen states
- incremental streaming transitions
- partial/incomplete responses
- tool-heavy flows
- agent/background-agent scenarios
- fallback behavior when semantic/proxy state is missing or incomplete

### Recommended Direction

Treat screen parsing as a real subsystem with:

- explicit fixtures
- reproducible streamed-state scenarios
- regression coverage for known rendering bugs
- easy ways to compare expected vs actual parsed output

### Notes

- This is both a parser-quality issue and a testing-infrastructure issue.
- The goal is not just “better parsing”; it is making screen parsing reliable enough to maintain and validate over time.

## 16. Add Token And Cost Approximations Based On SSE Streaming

- Status: documented only, do not solve yet
- Area: usage tracking / streaming telemetry

### Problem

We should add token approximations based on SSE streaming so the app can keep track of approximate usage and approximate cost while a response is still in progress.

### Why This Matters

Without live approximation, the user only gets usage/cost information after the fact, if at all.

Live estimates would make it easier to understand:

- how much usage is accumulating
- how expensive a turn is becoming
- how provider usage is trending during a session

### Expected Direction

Use SSE/streaming data to estimate:

- input tokens
- output tokens
- approximate cost

These values should be clearly treated as approximations until final provider usage is known.

### Notes

- This is especially useful during long-running streams where final accounting arrives late.
- The UI should distinguish estimated/live values from finalized values.

## 17. Rework The Settings Page

- Status: documented only, do not solve yet
- Area: settings UX / configuration surface

### Problem

The settings page should be reworked.

### Why This Matters

Settings are a core control surface for the app, and if the page is unclear or awkward it becomes harder to:

- discover available features
- understand what options actually do
- trust configuration changes
- manage more advanced behavior cleanly as the app grows

### Expected Direction

The settings page should be made clearer, better organized, and easier to use as the configuration surface expands.

### Notes

- This is intentionally broad for now and can be broken down into more specific settings-page issues later.

## 18. Solidify Command Structure With A Richer Registry, Better Metadata, And State-Neutral Naming

- Status: documented only, do not solve yet
- Area: command system / command palette / naming conventions

### Problem

The command structure should be solidified.

We need a more complete command registry with better metadata, clearer naming conventions, and better handling of stateful actions.

### Expected Direction

The command system should have a richer registry, including metadata such as:

- description
- keybinds
- clearer command identity
- better discoverability in the command palette

### Naming Requirement

Commands should be named in a way that does **not** encode current state into the command title itself.

Examples of what we should avoid:

- `toggle ...`
- `enable ...`
- `disable ...`

Instead, the command system should support official toggle-style commands with a clear state indicator shown in the UI.

The command name itself should stay state-neutral, and the UI should show whether the feature is currently on or off.

### Why This Matters

Without a stronger command structure:

- command naming drifts
- command palette behavior becomes inconsistent
- stateful actions are harder to understand
- keybind and command discoverability get worse as the app grows

### Recommended Direction

Treat commands as first-class application entities with:

- a richer registry
- standardized metadata
- explicit state handling
- consistent naming conventions

### Notes

- The important rule is that command names should describe the action domain, not bake current state into the name.
- Stateful commands should surface current state through indicators/metadata instead of through the command title itself.

## 19. Add First-Class Plan Mode Support For Both Providers

- Status: documented only, do not solve yet
- Area: provider feature parity / planning workflow

### Problem

We should add proper plan mode support for both providers.

Plan mode should not be treated as a one-provider-only feature if the product is meant to support both Claude and Codex well.

### Expected Direction

The app should support a first-class plan mode workflow across both providers, with as much shared UX and behavior as possible.

### Why This Matters

If plan mode only exists properly for one provider:

- provider parity breaks down
- the app feels inconsistent
- planning workflows become provider-dependent in a way that is harder to reason about

### Notes

- This should be treated as a product capability, not just a provider-specific implementation detail.
- Shared UX matters here even if the underlying transport/provider mechanics differ.

## 20. Fix The Ghost Queue Issue

- Status: documented only, do not solve yet
- Area: queueing / session state / live workflow behavior

### Problem

There is still a ghost queue issue that needs to be fixed.

### Why This Matters

Queue-related state that appears to exist when it should not, or persists incorrectly, creates confusing and untrustworthy workflow behavior.

### Expected Direction

Queue state should be accurate, visible only when real, and cleared cleanly when no longer active.

### Notes

- This is intentionally broad for now and should be refined with the exact ghost-queue failure mode once we document the concrete repro shape.

## 21. Fix Arrow Navigation Between Agents So It Feels Intuitive

- Status: documented only, do not solve yet
- Area: multi-agent navigation / keyboard UX

### Problem

Arrow navigation between agents is currently not intuitive.

### Why This Matters

If keyboard navigation between agents feels unclear or inconsistent:

- it is harder to move quickly between agents
- the multi-agent UI feels awkward
- keyboard-driven workflows become less reliable

### Expected Direction

Arrow navigation between agents should feel predictable and natural, especially in multi-agent contexts where keyboard movement should be fast and obvious.

### Notes

- This is a keyboard UX / interaction-design issue, not just a keybinding existence issue.

## 22. Fix Lazy Loading Properly

- Status: documented only, do not solve yet
- Area: loading strategy / performance / UI behavior

### Problem

Lazy loading still needs to be fixed properly.

### Why This Matters

If lazy loading behavior is unreliable or incomplete:

- UI loading feels inconsistent
- performance improvements do not land cleanly
- loading transitions can become buggy or confusing
- users may see missing, delayed, or unstable content

### Expected Direction

Lazy loading should behave predictably and correctly across the relevant app surfaces, with clearer loading behavior and fewer edge-case failures.

### Notes

- This is intentionally broad for now and can be refined into more specific lazy-loading issues later if needed.

## 23. Remote Compact Task Fails Because The Codex Responses Proxy Does Not Support `/v1/responses/compact`

- Status: documented only, do not solve yet
- Area: Codex proxy compatibility / remote compact flow

### Problem

There is a concrete failure when running a remote compact task through the Codex proxy:

```text
Error running remote compact task: unexpected status 404 Not Found: codex-responses-proxy: unsupported POST /v1/responses/compact, url: http://127.0.0.1:57757/v1/responses/compact
```

### Actual Behavior

The compact flow attempts to call:

- `POST /v1/responses/compact`

but the Codex responses proxy returns:

- `404 Not Found`
- `unsupported POST /v1/responses/compact`

### Why This Matters

This means the remote compact flow is not actually supported correctly through the current proxy layer, which breaks a real provider workflow instead of degrading gracefully.

### Expected Direction

Either:

- the proxy should support the compact endpoint properly

or:

- the app should detect that the endpoint is unsupported and handle it explicitly rather than failing with a raw 404 at runtime

### Notes

- Keep the exact error string above easy to grep for future debugging.

## 24. Improve Loading And Thinking Indicators In Rendering

- Status: documented only, do not solve yet
- Area: rendering UX / live-state communication

### Problem

Loading and thinking indicators in rendering need to be better.

### Why This Matters

If loading/thinking indicators are weak, unclear, or poorly timed:

- the app feels less responsive
- users cannot tell what the agent is doing
- live-state transitions become harder to interpret
- rendering bugs are more noticeable and more confusing

### Expected Direction

Loading and thinking indicators should communicate live state more clearly and feel better integrated into the rendering flow.

### Notes

- This is related to the broader rendering/activity-detection work, but worth tracking explicitly as a user-facing UX issue.

## 25. Build Full Rendering Logging And Debugging Pipelines

- Status: documented only, do not solve yet
- Area: rendering observability / debugging infrastructure

### Problem

We need full rendering logging and debugging pipelines.

### Why This Matters

Rendering bugs are currently too hard to reason about without stronger observability.

Better logging/debugging infrastructure would make it easier to inspect:

- what state the renderer believed it had
- what transport/proxy/screen inputs were received
- how those inputs were folded into render state
- why a given UI surface chose one rendering path over another

### Expected Direction

The app should have much stronger rendering observability, with enough logging/debug surfaces to trace rendering behavior end to end.

### Notes

- This is an infrastructure/debuggability issue, not just a UI issue.
- It should help with diagnosing flicker, duplication, stale state, wrong activity indicators, and other rendering bugs already documented above.

## 26. Add A `View Prompts` Command So Users Can See What An Agent Session Is About

- Status: documented only, do not solve yet
- Area: multi-agent UX / command system

### Problem

When multiple agents are running, it is easy to lose track of what a given agent session is actually about.

### Expected Direction

Add a `View Prompts` command that shows the user prompts for an agent session, so the user can quickly understand the purpose and context of that session.

### Why This Matters

In a multi-agent workflow, prompt history is often the fastest way to understand:

- why the agent exists
- what task it was given
- how it differs from other active agents

Without that, multiple sessions can blur together.

### Notes

- This should help users re-orient themselves in multi-agent workflows without digging through the full transcript.
- It fits naturally as a command/system-level affordance rather than as raw transcript browsing alone.

## 27. Some Rendering Output Is Being Incorrectly Buried Or Obscured, Including ASCII

- Status: documented only, do not solve yet
- Area: rendering fidelity / content visibility

### Problem

Some rendering output is being buried or obscured when it should be displayed directly.

One concrete example is ASCII output not rendering properly and instead appearing as a black box.

### Expected Behavior

ASCII and similar plain-text output should render visibly and faithfully in the normal output flow.

### Actual Behavior

Certain content is effectively hidden, flattened, or rendered in a way that makes it unreadable.

### Why This Matters

If output like ASCII is not rendered correctly:

- useful content becomes unreadable
- the renderer is no longer a trustworthy representation of the underlying session output
- users lose context from outputs that are meant to be seen directly

### Notes

- This is a rendering-fidelity issue, not just a styling issue.
- ASCII output is one concrete example, but the broader issue is that some content is being visually buried when it should remain legible.

## 28. Main Render Flow Should Stop Bleeding Screen Parsing Into Core Rendering

- Status: documented only, do not solve yet
- Area: rendering architecture / screen parsing boundaries

### Problem

It is still too weird that screen parsing keeps bleeding into the main render flow.

The main rendering path should not depend on screen parsing for core content rendering.

### Expected Direction

The main render flow should be driven by the proper semantic/transcript/render-state pipeline, not by screen parsing.

Screen parsing should be limited to support surfaces such as:

- command/status support rendering
- fallback/support cases
- auxiliary UI that genuinely has no better structured source

### Why This Matters

If screen parsing keeps leaking into the main renderer:

- the architecture stays fragile
- heuristics keep contaminating core rendering behavior
- semantic/proxy improvements do not fully pay off
- rendering bugs become harder to reason about because multiple truth sources stay entangled

### Notes

- This is a hard architecture-boundary issue, not just an implementation detail.
- The goal is to make screen parsing secondary/supportive, not a hidden co-owner of the main render path.

## 29. Add Pane Index Numbers And Support `Option + Number` Navigation Between Panes

- Status: documented only, do not solve yet
- Area: pane navigation / keyboard UX

### Problem

We should add index numbers for panes and support `Option + number` navigation between panes.

The pane number should also be shown in the pane header so the mapping is visible.

### Expected Direction

The UI should:

- assign visible index numbers to panes
- show the pane number in the pane header
- allow direct keyboard navigation with `Option + number`

### Why This Matters

When many panes are open, directional navigation alone can be slower and less predictable than direct targeting.

Direct numeric navigation would make it easier to:

- jump to a specific pane quickly
- keep track of pane identity
- use the app faster in multi-pane workflows

### Notes

- The important requirement is both visible numbering and matching keyboard navigation.

## 30. Audit Performance Across The Whole App And Identify What Needs To Be Resolved

- Status: documented only, do not solve yet
- Area: performance / profiling / optimization

### Problem

We should do a broad performance audit over the whole app and identify the real performance issues that need to be resolved.

### Expected Direction

This should include identifying and evaluating performance costs across major surfaces such as:

- rendering
- streaming updates
- screen parsing
- semantic folding
- pane/tab layout behavior
- editor/code rendering
- startup/rehydration
- large-session behavior

### Why This Matters

Without a deliberate performance audit:

- slow paths stay hidden until they become user-visible problems
- optimizations happen reactively instead of strategically
- regressions are easier to introduce
- the app can feel inconsistent depending on session size and workflow shape

### Notes

- This should be driven by real profiling and observation, not by guesswork alone.
- The goal is to identify concrete bottlenecks and the highest-value things to resolve first.

## 31. Add A Setting For Line Wrapping In Code Rendering Instead Of Always Forcing Horizontal Scroll

- Status: documented only, do not solve yet
- Area: code rendering / settings / readability

### Problem

In code rendering surfaces such as:

- code blocks
- read results
- edit results

we are currently letting long lines take up horizontal scroll space.

This should be controllable through a setting instead of being a fixed behavior.

### Expected Direction

Add a setting that controls whether code-oriented rendering wraps long lines or keeps horizontal scrolling.

### Why This Matters

Different users and workflows want different behavior:

- some want wrapped lines for easier reading
- some want no wrapping for exact code/layout fidelity

Making this configurable is better than hardcoding one preference for everyone.

### Notes

- This should be treated as a rendering/settings issue, not just a one-off style tweak.

## 32. Add A Developer Mode That Mirrors Active Terminals To Dispatched tmux Sessions

- Status: documented only, do not solve yet
- Area: developer workflow / terminal orchestration / testing workflow

### Problem

We should add a developer mode where active terminals mirror the dispatched tmux-backed sessions.

The goal is that we can restart/rebuild the app at any time and still keep the underlying active terminal work alive and testable.

This is specifically for internal development, not a general end-user feature.

### Expected Direction

Developer mode should make it possible for active terminal sessions to stay mirrored onto dispatched tmux sessions so development/rebuild cycles do not break the working terminal context.

### Why This Matters

Without this, development and testing workflows are more fragile:

- rebuild/restart can interrupt useful live terminal state
- testing changes becomes slower
- active workflows are harder to preserve while iterating

### Notes

- This is specifically about improving the development/testing loop, not just general terminal persistence.
- This mode should be clearly treated as an internal/developer-only capability.
- The important property is being able to restart the app while preserving and reconnecting to the active terminal work through tmux-backed dispatch sessions.

## 33. Add Native System Notifications Around Provider Switching So The Active Workflow Knows A Switch Happened

- Status: documented only, do not solve yet
- Area: provider switching / system notifications / workflow clarity

### Problem

When switching providers, we should surface a clear native system notification that makes it obvious a switch just happened:

- Claude -> Codex
- Codex -> Claude

### Expected Direction

Provider switching should trigger the system's native notification mechanism so the switch is visible and unambiguous.

The notification should make it clear which provider the app switched from and which provider it switched to.

### Why This Matters

Provider switching changes the active workflow context in a meaningful way.

If that switch is not made explicit enough:

- context can feel blurry
- the user may lose track of which provider is active
- the workflow handoff feels less trustworthy

### Notes

- This should use native system notifications rather than only in-app UI messaging.
- The goal is to make provider handoff explicit and hard to miss.
