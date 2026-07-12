# UI components

This directory intentionally follows the
[shadcn/ui](https://ui.shadcn.com/docs) ownership and composition model.
Agent Code uses locally owned component source, flat and predictable component
names, Tailwind classes, semantic CSS variables, and headless behavior
primitives where browser interaction details are difficult to implement
correctly.

This is a deliberate choice to adopt an industry-familiar convention instead
of inventing an Agent Code-specific component framework. Future agents should
be able to recognize a component, its file location, and its composition API
without first learning a private hierarchy of base components, factories,
registries, and wrappers.

"Follows shadcn/ui" does **not** mean that Agent Code imports shadcn's visual
theme wholesale. The component structure and naming are conventional; the
appearance remains Agent Code's and must use the semantic tokens already
defined in `src/renderer/src/styles.css` and
`src/renderer/src/app-state/settings/customAppearance.ts`.

## Directory contract

Keep this directory flat, matching the normal shadcn layout:

```text
components/
  ui/
    button.tsx
    dialog.tsx
    input.tsx
    label.tsx
    textarea.tsx
```

- Filenames are lowercase kebab-case: `alert-dialog.tsx`, not
  `AlertDialog.tsx`.
- React exports are PascalCase: `Button`, `DialogContent`, `DialogHeader`.
- Import the file directly:
  `@renderer/components/ui/dialog`. Do not add a barrel whose export graph
  hides component ownership or creates import cycles.
- Keep one shadcn-level primitive or tightly related compound family per file.
  `dialog.tsx` may export `Dialog`, `DialogContent`, `DialogHeader`,
  `DialogFooter`, `DialogTitle`, and `DialogDescription`; it must not also grow
  feature workflows or unrelated form controls.
- Components accept `className` and normal underlying element props so callers
  can compose them. Prefer composition over adding a prop for every layout a
  future feature might imagine.

## What belongs here

A component belongs in `components/ui/` when it is all of the following:

1. Provider-agnostic and feature-agnostic.
2. Reusable visual or interaction infrastructure, not business behavior.
3. Small enough that a caller can understand it from the familiar shadcn-style
   API and the source in one file.
4. The canonical implementation of a repeated UI concept.

Examples: button, dialog, input, textarea, label, field, checkbox, popover,
tooltip, separator, scroll area.

The first refactor should add only the components it consumes. A component is
not created merely because shadcn has one or because it might be useful later.

## What does not belong here

- Feature components stay in `features/<feature>/ui/`.
- Provider-specific views stay in `providers/<provider>/renderer/`.
- Workspace/pane composition stays in `workspace/`.
- Application surfaces and store wiring stay in their existing `surfaces/`
  wrappers.
- Business-specific components such as `CloseOldAgentsModal`,
  `PromptSearchModal`, or `ComposerInput` do not move here. They should compose
  primitives from this directory.
- Non-visual coordination that multiple input paths must query synchronously
  belongs in `lib/`, not inside a visual component. The app interaction
  ownership guard in `lib/interaction-ownership.ts` is consumed by
  `dialog.tsx`, global keybindings, composer routing, native-menu dispatch, and
  dictation.

The older top-level `src/renderer/src/ui/` directory is not the destination for
new primitives. Existing files there can move or remain feature utilities as
the modal refactor reaches them, but new general-purpose controls use
`components/ui/` so the convention does not split again.

## Component conventions

Use shadcn names unless Agent Code has a materially different concept:

- Button variants: `default`, `secondary`, `outline`, `ghost`, `destructive`,
  and `link` only when each has a real consumer.
- Button sizes: `default`, `xs`, `sm`, `lg`, and explicit icon sizes only when
  needed.
- Dialog composition: `Dialog` -> `DialogTrigger` + `DialogContent` ->
  `DialogHeader` / `DialogTitle` / `DialogDescription` / `DialogFooter`.
- Form controls use the conventional names `Input`, `Textarea`, `Label`, and
  `Field`; do not create private synonyms such as `BaseTextControl`,
  `FormInputShell`, or `InteractiveFieldFrame`.
- Preserve native semantics. Use real forms, labels, buttons, inputs, and
  textareas instead of recreating them with generic elements and key handlers.
- Forward refs when the underlying behavior primitive or caller needs focus
  control. Do not add imperative APIs for operations already represented by
  normal DOM behavior.

When a component is imported or adapted from shadcn/ui, keep a short provenance
comment in the source with the upstream component URL and describe only the
Agent Code-specific changes that future updates must preserve. The checked-in
file is then our source of truth; do not wrap it in another Agent Code component
solely to avoid editing locally owned code.

## Dialog-specific rule

`dialog.tsx` is based on the shadcn/Radix compound-component shape, but it
also owns Agent Code's app-modal contract:

- portal mounting;
- focus trap and focus restoration;
- accessible title and description wiring;
- Escape and outside-interaction policy;
- semantic overlay and surface tokens;
- registration with the shared app-modal input-ownership guard.

Feature modals must not add their own document-level Escape listener, focus
trap, backdrop implementation, or background-input suppression. Those are
properties of `DialogContent`, not properties each feature gets to reinterpret.
Pane-local provider prompts are a different interaction category and must not
pretend to be app-wide dialogs merely to reuse styling.

## Styling and variants

- Use the existing semantic Tailwind colors (`bg-surface`, `text-ink`,
  `border-border`, `bg-input-bg`, `text-danger`, and related tokens).
- Do not paste shadcn's default neutral palette into the app or introduce a
  second set of `background` / `foreground` / `primary` variables beside Agent
  Code's established theme schema.
- Keep variant maps close to the component. Add a variant only with a concrete
  call site.
- A small class-composition helper is acceptable when real components need it.
  Do not introduce a variant DSL, theme engine, or wrapper hierarchy in
  anticipation of future complexity.
- Preserve Agent Code's square, dense visual language. Industry-standard
  structure does not require adopting rounded cards or spacious web-dashboard
  defaults.

## Adding components from shadcn

The shadcn CLI supports Vite, Tailwind v4, aliases, and locally installed
component source. However, do not run `shadcn init` blindly in this repository:
it may introduce or rewrite global theme tokens that conflict with Agent Code's
custom appearance system.

For a new component:

1. Confirm there is an immediate consumer.
2. Inspect the upstream component and its primitive dependency.
3. If using the CLI, use its dry-run/diff workflow before writing files.
4. Install only the requested component and required behavior dependency.
5. Adapt classes to Agent Code's existing semantic tokens.
6. Remove generated infrastructure that is not needed here.
7. Add interaction tests for behavior-bearing components.

The root `components.json` points the shadcn CLI at this directory, the
renderer aliases, and `styles.css`. Treat the config as operational tooling,
not permission to run `shadcn init`: additions still require a concrete
consumer and a reviewed diff.

## Interaction ownership

Every app-wide `DialogContent` automatically mounts
`data-agent-code-interaction-owner="app"`. Global input ingress checks that
marker synchronously before it can mutate a pane:

- type-to-focus and paste-to-focus;
- Enter-to-submit routing;
- workspace shortcuts and native menu commands;
- native dictation hotkey starts.

Do not copy the marker into feature dialogs. The primitive owns it for exactly
the same lifetime as its portal and focus trap. Full-screen application
takeovers that are intentionally not dialogs (setup and new-agent placement)
may mount the marker directly because they still own the app interaction turn.

Pane-local provider strips are not dialogs and must not mount this marker.
They receive the TileLeaf's `interactionActive` state through the condition
outlet, focus their own root only for the active pane, and keep keyboard
handlers on that root. A document-global listener in an inline strip can make
a background approval answer the wrong agent and is therefore a contract
violation.

## Anti-overengineering guardrails

- No all-at-once component-library generation.
- No component is added "for completeness."
- No generic modal schema, JSON-driven form renderer, or surface factory.
- No nested `ui/base/`, `ui/core/`, `ui/primitives/`, and `ui/components/`
  taxonomies. `components/ui/` is already the primitive boundary.
- No wrapper around a wrapper when editing the locally owned component is
  clearer.
- No migration of every existing button as a prerequisite for shipping the
  modal safety work.
- Feature-specific layout remains feature-specific.
- Accessibility and input ownership are behavior contracts, not optional
  visual polish.

The success condition is intentionally boring: contributors and agents reach
for familiar names, compose a small local primitive, and keep feature logic in
the feature. If this directory starts requiring an architectural diagram to
add a button, it has violated its purpose.
