# Architecture diagram clarity

Status: Research and audit complete; implementation in progress.

## Outcome

Make the architecture reference easier to learn from. Every retained diagram
must answer a concrete reader question through relationships, ordering or
state changes that are easier to see than to explain in a table. Preserve the
large opening map, source evidence, arc42 structure and editable diagram source.

The source snapshot documented by the reference remains `6a19e4ee`. This work
changes explanation and presentation, not the architecture or application code.

## Research translated into decisions

- [C4 diagram selection](https://c4model.com/diagrams) and
  [code views](https://c4model.com/diagrams/code): retain only useful views;
  remove class inventories and graphs that duplicate a nearby table.
- [C4 notation](https://c4model.com/diagrams/notation) and
  [review checklist](https://c4model.com/diagrams/checklist): state the question
  and scope, label relationships, and explain visual notation in each asset.
- [NN/g visual design](https://www.nngroup.com/articles/principles-visual-design/):
  establish a reading order with grouping, spacing and limited emphasis.
- [W3C color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) and
  [graphical contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html):
  use labels and boundaries in addition to color; measure text and line contrast.

## Work

1. Audit all 42 views against a reader question and record the disposition below.
2. Redraw retained views with shorter labels, fewer crossings, useful failure
   branches/examples and consistent notation. Replace redundant views with the
   existing explanation or a short cross-reference.
3. Centralize a restrained visual theme and standalone title/key in the renderer.
   Keep diagram sources in Markdown and generated SVGs in the existing directory.
4. Render and inspect at ordinary Markdown width, including grayscale. Check
   links, obsolete assets, source/preview agreement and rendering determinism.
5. Open a new PR linked to the diagram-clarity issue and #100. Do not merge it
   under the approval previously given only for #897.

## Diagram audit

| Existing view | Decision | Reader question or reason |
| --- | --- | --- |
| Application overview | Redesign | Where do the visible workspace, shared services, native tools and data fit? |
| System context | Simplify | Which external systems does Agent Code depend on? |
| Container view | Redesign | Which processes communicate, and through which interfaces? |
| Source dependencies | Remove | Repository and package tables already explain dependency boundaries. |
| Renderer state | Redesign | Why can agent output update without saving the whole workspace? |
| Command admission | Remove | The prose explains the shared gateway and its checks more directly. |
| Control capabilities | Remove | Field inventory adds no insight beyond the capability contract explanation. |
| Control invocation | Focus | Why can a timed-out command be unsafe to retry? |
| Built-in MCP | Focus | How is an agent's access granted and later revoked? |
| Orchestration relationships | Replace with example | How do root, parent and child agents relate? |
| Workflow components | Simplify | What runs workflow code, and what runs each provider task? |
| Workflow lifecycle | Focus | Why is requesting cancellation different from proving it stopped? |
| Workflow synchronization | Focus | How does the UI catch up after missing an update? |
| External operator | Remove | It delegates to the already diagrammed control invocation path. |
| Remote transports | Redesign | What changes between LAN access and a Cloudflare tunnel? |
| Remote session protocol | Remove | Pairing and permitted operations are already described directly. |
| Editor file I/O | Focus | How does a save detect a file changed outside the editor? |
| Language servers | Remove | Class inventory hides the shared-server lease rule explained in prose. |
| Worktree attribution | Remove | Two simple data paths are already explained beside their source links. |
| Skill materialization | Focus | What prevents an update from overwriting a user's edited skill? |
| Dictation | Remove | Straight audio-to-text sequence repeats the adjacent explanation. |
| Vault lifecycle | Clarify | When can an authentication result unlock the vault? |
| Startup | Replace with ordered reading | Eight lifelines obscure a mostly linear initialization order. |
| Shutdown | Replace with decision flow | Which failures or unsaved work can stop quit? |
| Workspace model | Simplify | How can a recursive tile layout refer to independent session metadata? |
| Workspace recovery | Clarify | Why does a pane remain visible when its backend fails to recover? |
| Session adapters | Remove | The provider comparison table explains the useful differences. |
| Session spawn | Focus | Why must a session belong to a window before its first event? |
| Prompt delivery | Replace with decision flow | When is it safe to retry a prompt? |
| Transcript projection | Combine with provider switch | The neutral model belongs in the operation it enables. |
| Provider switch | Focus | When is the new conversation created relative to replacing the pane? |
| Terminal attachment | Remove | Repeated byte forwarding hides the ownership rule already in prose. |
| Process deployment | Combine with container view | Repeats the same process graph; retain the detailed lifetime table. |
| Build pipeline | Simplify | Which inputs must meet before a macOS package can be verified? |
| Identity ownership | Replace with example | What stays stable when a backend execution is replaced? |
| Observation ordering | Use concrete values | Which streamed updates may be combined, and which must stay ordered? |
| Session feed | Remove | Conceptual method inventory is less useful than the actual contract link. |
| Rendering pipeline | Focus | How do live and saved copies of a message become one visible row? |
| Rendering ownership model | Combine with rendering pipeline | Another field inventory obscures the duplicate-selection rule. |
| Stream phase | Clarify | Why can an agent still be busy after text streaming stops? |
| Storage roots | Remove | The adjacent location/owner/recovery table is more precise and searchable. |
| Diagnostics | Replace with evidence map | Which evidence helps investigate a crash, slowdown or feed defect? |

## Validation

Pending implementation and visual review. Application runtime tests are not
required for this documentation-only change; the documentation renderer and its
artifacts must be verified directly.
