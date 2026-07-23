import {
  defineRenderShape,
  defineRenderShapeCatalog,
} from '@renderer/rendering/evidence/defineRenderShape'

// OpenCode render-shape catalog (Phase 4, PR #555).
//
// The initial PR #555 seed left this empty on purpose because the frozen bundle
// corpus had only empty-shell OpenCode fixtures. That is no longer true: the
// local 2026-07-19 OpenCode recording soak produced a first stable committed
// tool corpus through the exact Unknown Shape Inbox loop the plan requires.
//
// What is deliberately STILL absent here: semantic-tool and condition-plane
// entries. We now have the raw SSE events for those paths, but not retained
// render-shape sightings yet. Keeping them out of the catalog preserves the
// core PR #555 invariant: policy or raw transport knowledge is not permission
// to invent a reviewed shape entry. Committed tool-use/result is the first
// honest slice because the recorder already proved those exact fingerprints and
// routes in `__render_shape` sidecars.
export const OPENCODE_RENDER_SHAPES = defineRenderShapeCatalog('opencode', {
  'opencode.semantic.apply-patch.v1': defineRenderShape({
    id: 'opencode.semantic.apply-patch.v1',
    provider: 'opencode',
    fingerprints: ['fp2-9003dc12'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/apply-patch/semantic-final.json'], prefixes: [] },
    disposition: { kind: 'specialized', rendererId: 'opencode.rows.dispatch' },
    alternateDispositions: [
      {
        kind: 'generic',
        rendererId: 'shared.generic-tool',
        reason: 'A live apply_patch body without a parseable file header still stays visible on the generic semantic fallback.',
      },
    ],
    why: 'OpenCode semantic apply_patch now routes through the provider-owned code-edit wrapper once the finalized patchText closes a real file header. Non-parseable bodies still decline to the shared semantic fallback.',
  }),
  'opencode.semantic.bash.v1': defineRenderShape({
    id: 'opencode.semantic.bash.v1',
    provider: 'opencode',
    fingerprints: ['fp2-41fff07e'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/bash/semantic-final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'A finalized bash invocation is still only a shell command until the content-dependent Git classifier proves the shared command route.',
    },
    alternateDispositions: [
      { kind: 'specialized', rendererId: 'shared.command', protocolId: 'command.git' },
    ],
    why: 'OpenCode semantic bash mirrors the committed content-dependent split: generic for ordinary shell commands, shared command protocol for proved Git operations.',
  }),
  'opencode.semantic.glob.v1': defineRenderShape({
    id: 'opencode.semantic.glob.v1',
    provider: 'opencode',
    fingerprints: ['fp2-f879ddcb'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/glob/semantic-final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'OpenCode live glob is a plain structured tool invocation with no richer owned semantic view proven yet.',
    },
    why: 'Catalogued so the first OpenCode live glob shape does not remain uncatalogued the moment this branch records semantic-tool sightings.',
  }),
  'opencode.semantic.grep.v1': defineRenderShape({
    id: 'opencode.semantic.grep.v1',
    provider: 'opencode',
    fingerprints: ['fp2-6507bf37'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/grep/semantic-final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'OpenCode live grep is still just a structured search invocation and should stay generic until a richer provider-owned semantic route is proven.',
    },
    why: 'Catalogued proactively from the reducer-owned semantic shape so live OpenCode grep does not become an unknown the first time this branch records it.',
  }),
  'opencode.semantic.read.v1': defineRenderShape({
    id: 'opencode.semantic.read.v1',
    provider: 'opencode',
    fingerprints: ['fp2-1549305d', 'fp2-2140fe57', 'fp2-a7cc5373'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete', 'prefix'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: {
      final: ['rendering-shapes/opencode/read/semantic-final.json'],
      prefixes: ['rendering-shapes/opencode/read/semantic-prefix.json'],
    },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'The request row itself stays generic; the provider-owned live path is earned by the paired tagged read result, not by the invocation alone.',
    },
    alternateDispositions: [
      { kind: 'specialized', rendererId: 'opencode.rows.dispatch' },
    ],
    why: 'OpenCode live read has three honest milestones in the current reducer shape: a prefix while input is still incomplete, a finalized invocation with no result yet, and a provider-owned row once the tagged read result arrives. One catalog entry owns that family with finite alternate routes.',
  }),
  'opencode.semantic.skill.v1': defineRenderShape({
    id: 'opencode.semantic.skill.v1',
    provider: 'opencode',
    fingerprints: ['fp2-66bcff9c'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/skill/semantic-final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'The current skill live shape carries only a simple name payload and therefore remains on the shared structured semantic fallback.',
    },
    why: 'Catalogued so the first OpenCode live skill invocation is a reviewed generic semantic family instead of an uncatalogued transport shape.',
  }),
  'opencode.semantic.todowrite.v1': defineRenderShape({
    id: 'opencode.semantic.todowrite.v1',
    provider: 'opencode',
    fingerprints: ['fp2-dc7d1b61'],
    eventTypes: ['tool_use'],
    planes: ['semantic-tool'] as const,
    lifecycles: ['input-complete'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/todowrite/semantic-final.json'], prefixes: [] },
    disposition: { kind: 'specialized', rendererId: 'opencode.rows.dispatch' },
    why: 'The same evidence-backed checklist grammar that owns the committed OpenCode invocation now also owns its live semantic finalized form.',
  }),
  'opencode.tool-result.tool-result.v1': defineRenderShape({
    id: 'opencode.tool-result.tool-result.v1',
    provider: 'opencode',
    fingerprints: ['fp2-f31bc9d2'],
    eventTypes: ['tool_result'],
    planes: ['committed-tool-result'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/tool-result/final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'The base OpenCode result envelope is just text + error state until the source tool proves a richer owned result view.',
    },
    alternateDispositions: [
      { kind: 'specialized', rendererId: 'opencode.rows.dispatch' },
    ],
    why: 'OpenCode committed results all share one plain tool_result envelope today. The route depends on the paired tool: read can graduate to a provider-owned result slab, while everything else stays on the shared generic fallback.',
  }),
  'opencode.tool-use.bash.v1': defineRenderShape({
    id: 'opencode.tool-use.bash.v1',
    provider: 'opencode',
    fingerprints: ['fp2-f0f0a673'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/bash/committed.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'A bash invocation is not inherently a Git operation; unclassified commands must stay visible on the generic row.',
    },
    alternateDispositions: [
      { kind: 'specialized', rendererId: 'shared.command', protocolId: 'command.git' },
    ],
    why: 'OpenCode bash uses the same finite content-dependent split as the other providers: ordinary shell commands stay generic, while proved Git commands route through the shared command protocol.',
  }),
  'opencode.tool-use.apply-patch.v1': defineRenderShape({
    id: 'opencode.tool-use.apply-patch.v1',
    provider: 'opencode',
    fingerprints: ['fp2-ad389f5c'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/apply-patch/final.json'], prefixes: [] },
    disposition: { kind: 'specialized', rendererId: 'opencode.rows.dispatch' },
    alternateDispositions: [
      {
        kind: 'generic',
        rendererId: 'shared.generic-tool',
        reason: 'A named apply_patch envelope without a parseable file header remains visible instead of inventing an empty edit.',
      },
    ],
    why: 'OpenCode direct apply_patch now owns the same shared code-edit preview contract as the other providers once a real file header closes. Malformed or preamble-only bodies still decline honestly to the generic fallback.',
  }),
  'opencode.tool-use.glob.v1': defineRenderShape({
    id: 'opencode.tool-use.glob.v1',
    provider: 'opencode',
    fingerprints: ['fp2-edb07b48'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/glob/final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'The OpenCode glob invocation grammar is already legible on the shared structured tool row and no richer provider-owned view is proven yet.',
    },
    why: 'This is a straight committed tool-use shape with no paired provider-owned result behavior today; the shared structured row is the honest rendering contract.',
  }),
  'opencode.tool-use.grep.v1': defineRenderShape({
    id: 'opencode.tool-use.grep.v1',
    provider: 'opencode',
    fingerprints: ['fp2-00666fa5'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/grep/final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'OpenCode grep emits a plain structured query payload with no distinct owned visualization proved yet.',
    },
    why: 'Like glob, grep already reads correctly through the shared structured tool grammar and should not graduate until evidence proves a richer provider-owned route.',
  }),
  'opencode.tool-use.read.v1': defineRenderShape({
    id: 'opencode.tool-use.read.v1',
    provider: 'opencode',
    fingerprints: ['fp2-56deb4a5'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/read/final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'The invocation itself is just file-path pagination input; the richer evidence lives on the paired result renderer, not the request row.',
    },
    why: 'OpenCode read keeps the same split as Claude/Codex: the request row stays a plain structured tool invocation, while the paired result may own a specialized file/document presentation.',
  }),
  'opencode.tool-use.skill.v1': defineRenderShape({
    id: 'opencode.tool-use.skill.v1',
    provider: 'opencode',
    fingerprints: ['fp2-5b292d58'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/skill/final.json'], prefixes: [] },
    disposition: {
      kind: 'generic',
      rendererId: 'shared.generic-tool',
      reason: 'The current OpenCode skill invocation evidence is only a simple name payload; that is not enough to justify a provider-owned row.',
    },
    why: 'This shape exists in the committed corpus and must be catalogued so the evidence loop closes, but the UI contract is still the shared structured fallback until richer behavior is observed.',
  }),
  'opencode.tool-use.todowrite.v1': defineRenderShape({
    id: 'opencode.tool-use.todowrite.v1',
    provider: 'opencode',
    fingerprints: ['fp2-9e620a1d'],
    eventTypes: ['tool_use'],
    planes: ['committed-tool-use'] as const,
    lifecycles: ['durable'] as const,
    observed: {
      providerVersions: [],
      models: [],
      firstSeen: '2026-07-19',
      lastSeen: '2026-07-19',
    },
    fixtures: { final: ['rendering-shapes/opencode/todowrite/final.json'], prefixes: [] },
    disposition: { kind: 'specialized', rendererId: 'opencode.rows.dispatch' },
    why: 'The checklist grammar is fully parseable from the committed invocation payload and already has a provider-owned row. Cataloguing it turns the existing evidence-backed specialization into a reviewed permanent promise.',
  }),
})

export type OpencodeRenderShapeId = keyof typeof OPENCODE_RENDER_SHAPES
