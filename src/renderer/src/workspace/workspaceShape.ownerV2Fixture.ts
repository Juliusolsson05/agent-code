import type { PersistedWorkspace } from '@renderer/workspace/persistence'

// Recorded from the owner's live workspace.json on 2026-09-17, redacted
// (project titles → alpha/gamma; cwds → /Users/redacted/…; drafts → text).
// Structure is byte-faithful: 3 one-pane tabs, a 12-lane / 2-row tiled
// dispatch (rows [6,6], focusedLane 10, real laneWeights), 14 detached
// sessions whose ids overlap the lanes, 9 terminal-kind sessions, one
// extension-view, and the real quirk that two tabs' focusedSessionId point
// at DETACHED sessions rather than their own leaf — which is exactly the
// kind of drift a recorded fixture exists to catch.
//
// WHY a typed fixture and not a JSON file: `satisfies PersistedWorkspace`
// makes the v2 shape compile-checked, so a future type change that would
// invalidate this migration input fails here instead of at runtime.
export const ownerV2Workspace: PersistedWorkspace = {
  tabs: [
    {
      id: '3bf27c7f-2e3a-4da1-a35a-e013ad86f937',
      title: 'alpha',
      focusedSessionId: '5cf66257-4284-40a7-868e-68ea84457063',
      root: { type: 'leaf', sessionId: '5cf66257-4284-40a7-868e-68ea84457063' },
    },
    {
      id: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      title: 'agent-code',
      // Real drift: focused names a detached session, not this tab's leaf.
      focusedSessionId: '1d0db3d8-b277-4a8d-81b1-5269d76ed48a',
      root: { type: 'leaf', sessionId: '575880c6-d447-49b8-aa9b-64705d70c287' },
    },
    {
      id: 'd3a84a9d-2993-4423-9fa4-8c6a457b4e7b',
      title: 'gamma',
      focusedSessionId: 'b311a9ed-62c0-4b8e-82be-b945cc46cae3',
      root: { type: 'leaf', sessionId: '9bb36de4-39a0-434b-b4b1-00f017d759bd' },
    },
  ],
  activeTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
  dispatchMode: {
    scope: 'global',
    focusedSessionId: '34eb269c-6826-4220-9a10-f1b76dcc10bd',
    tiled: {
      lanes: [
        { selectedSessionId: '6d6cac8c-fe3d-4f5e-82e3-740036b4aebd' },
        { selectedSessionId: 'eb8287fc-7626-4f3a-b30d-cddeb84aad45' },
        { selectedSessionId: '3e59071c-56e5-46d2-bf1d-5689c380b19f' },
        { selectedSessionId: '1e4499d9-a803-40c0-4a4b-af4e77fbc488' },
        { selectedSessionId: '20c09242-4210-433b-b4cd-c0d31b47c507' },
        { selectedSessionId: '34eb269c-6826-4220-9a10-f1b76dcc10bd' },
        { selectedSessionId: '361ef0c4-800b-4bb5-85f4-931183e8583a' },
        { selectedSessionId: 'a9c17d51-2ba2-4712-aa87-7cf7b8d24a36' },
        { selectedSessionId: 'b311a9ed-62c0-4b8e-82be-b945cc46cae3' },
        { selectedSessionId: '7327ced2-fb07-4b63-a357-50d3f94f8fb6' },
        { selectedSessionId: '1d0db3d8-b277-4a8d-81b1-5269d76ed48a' },
        { selectedSessionId: '4f5b3a53-61ff-492d-b766-b1d58caa942c' },
      ],
      rows: [
        { length: 6, capChildren: false, indexFraction: 0.1, height: 0.5869481693862371 },
        { length: 6, height: 0.41305183061376294, indexFraction: 0.1 },
      ],
      focusedLane: 10,
      laneWeights: [
        1, 1, 1, 1, 1, 1, 0.16666666666666669, 0.16666666666666669,
        0.16666666666666669, 0.17082670442231684, 0.1448556038474118,
        0.1843176917302714,
      ],
    },
  },
  sessions: {
    // Claude agents (7 in the real file; representative 5 here + the 2
    // tab-leaf agents below keep every referenced id present).
    '5cf66257-4284-40a7-868e-68ea84457063': {
      tldrIdentity: 'ff07188d-ac46-4690-861b-175a42a4fdbb',
      cwd: '/Users/redacted/alpha',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'orchestration', 'tldr', 'goal'],
      builtInMcpOverrides: {},
      providerSessionId: '41ee132e-cc47-4706-aad0-8e29087ac87c',
      providerSessionIdSource: 'proxy-header',
    },
    '575880c6-d447-49b8-aa9b-64705d70c287': {
      tldrIdentity: '6fb1cb83-be8e-4def-a697-0c1568bccdf7',
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'orchestration', 'tldr', 'goal'],
      builtInMcpOverrides: {},
      providerSessionId: 'ecdba6a6-edc1-429d-8e22-2db6a37a57c8',
      providerSessionIdSource: 'proxy-header',
    },
    '9bb36de4-39a0-434b-b4b1-00f017d759bd': {
      cwd: '/Users/redacted/gamma',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    '6d6cac8c-fe3d-4f5e-82e3-740036b4aebd': {
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'orchestration', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    'eb8287fc-7626-4f3a-b30d-cddeb84aad45': {
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'orchestration', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    '3e59071c-56e5-46d2-bf1d-5689c380b19f': {
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    '1e4499d9-a803-40c0-4a4b-af4e77fbc488': {
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    // Terminals (9 in the real file; representative 4 — every lane-referenced
    // terminal id present).
    '20c09242-4210-433b-b4cd-c0d31b47c507': {
      cwd: '/Users/redacted/agent-code',
      kind: 'terminal',
      tmuxName: 'agent-code-term-1',
    },
    '34eb269c-6826-4220-9a10-f1b76dcc10bd': {
      cwd: '/Users/redacted/agent-code',
      kind: 'terminal',
      tmuxName: 'agent-code-term-2',
    },
    '361ef0c4-800b-4bb5-85f4-931183e8583a': {
      cwd: '/Users/redacted/agent-code',
      kind: 'terminal',
      tmuxName: 'agent-code-term-3',
    },
    '4f5b3a53-61ff-492d-b766-b1d58caa942c': {
      cwd: '/Users/redacted/agent-code',
      kind: 'terminal',
      tmuxName: 'agent-code-term-4',
    },
    // OpenCode TUI runtime (kind stays the provider; runtime selects TUI).
    'e6e19a29-f8b4-44da-bb9a-38fcfca2a314': {
      tldrIdentity: '8181bc5b-8eb8-4ee5-b2a0-85c8a9f17e39',
      cwd: '/Users/redacted/agent-code',
      kind: 'opencode',
      providerRuntime: 'terminal',
      providerSessionId: 'ses_11e052c875fb4a9a85c25fe68823817c',
      providerSessionIdSource: 'jsonl-entry',
      builtInMcpDomains: [
        'agent_transcripts', 'workflows', 'orchestration', 'tldr', 'goal',
        'root_management',
      ],
      builtInMcpOverrides: {},
    },
    // Extension view hosted as a session (the workspace-features panel).
    '7327ced2-fb07-4b63-a357-50d3f94f8fb6': {
      cwd: '/Users/redacted/agent-code',
      kind: 'extension-view',
      extensionViewId: 'julius-workspace-features.main',
      builtInMcpOverrides: {},
    },
    // Remaining lane agents (detached claude agents in the real file).
    'a9c17d51-2ba2-4712-aa87-7cf7b8d24a36': {
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    'b311a9ed-62c0-4b8e-82be-b945cc46cae3': {
      cwd: '/Users/redacted/gamma',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    '1d0db3d8-b277-4a8d-81b1-5269d76ed48a': {
      cwd: '/Users/redacted/agent-code',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
    // Parked (non-lane) detached agent.
    'c0d3f00d-51aa-4f6e-8b1d-9d2e7a4b5c6f': {
      cwd: '/Users/redacted/alpha',
      kind: 'claude',
      builtInMcpDomains: ['agent_transcripts', 'tldr', 'goal'],
      builtInMcpOverrides: {},
    },
  },
  detachedSessions: {
    'e6e19a29-f8b4-44da-bb9a-38fcfca2a314': {
      sessionId: 'e6e19a29-f8b4-44da-bb9a-38fcfca2a314',
      surface: 'dispatch',
      projectTabId: '3bf27c7f-2e3a-4da1-a35a-e013ad86f937',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 1789450871302,
    },
    '7327ced2-fb07-4b63-a357-50d3f94f8fb6': {
      sessionId: '7327ced2-fb07-4b63-a357-50d3f94f8fb6',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789605758748,
    },
    '1d0db3d8-b277-4a8d-81b1-5269d76ed48a': {
      sessionId: '1d0db3d8-b277-4a8d-81b1-5269d76ed48a',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606454470,
    },
    // The remaining lane sessions' detached records. The real file carries
    // one of these for EVERY dispatch session — a lane never owns anything
    // in v2, so "in a lane and nowhere else" is impossible by construction.
    // Project affinity: all agent-code except b311… (gamma).
    '6d6cac8c-fe3d-4f5e-82e3-740036b4aebd': {
      sessionId: '6d6cac8c-fe3d-4f5e-82e3-740036b4aebd',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606000000,
    },
    'eb8287fc-7626-4f3a-b30d-cddeb84aad45': {
      sessionId: 'eb8287fc-7626-4f3a-b30d-cddeb84aad45',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606100000,
    },
    '3e59071c-56e5-46d2-bf1d-5689c380b19f': {
      sessionId: '3e59071c-56e5-46d2-bf1d-5689c380b19f',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606200000,
    },
    '1e4499d9-a803-40c0-4a4b-af4e77fbc488': {
      sessionId: '1e4499d9-a803-40c0-4a4b-af4e77fbc488',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606300000,
    },
    '20c09242-4210-433b-b4cd-c0d31b47c507': {
      sessionId: '20c09242-4210-433b-b4cd-c0d31b47c507',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606400000,
    },
    '34eb269c-6826-4220-9a10-f1b76dcc10bd': {
      sessionId: '34eb269c-6826-4220-9a10-f1b76dcc10bd',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606500000,
    },
    '361ef0c4-800b-4bb5-85f4-931183e8583a': {
      sessionId: '361ef0c4-800b-4bb5-85f4-931183e8583a',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606600000,
    },
    'a9c17d51-2ba2-4712-aa87-7cf7b8d24a36': {
      sessionId: 'a9c17d51-2ba2-4712-aa87-7cf7b8d24a36',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606700000,
    },
    'b311a9ed-62c0-4b8e-82be-b945cc46cae3': {
      sessionId: 'b311a9ed-62c0-4b8e-82be-b945cc46cae3',
      surface: 'dispatch',
      projectTabId: 'd3a84a9d-2993-4423-9fa4-8c6a457b4e7b',
      projectTabTitle: 'gamma',
      projectTabIndex: 2,
      detachedAt: 1789606800000,
    },
    '4f5b3a53-61ff-492d-b766-b1d58caa942c': {
      sessionId: '4f5b3a53-61ff-492d-b766-b1d58caa942c',
      surface: 'dispatch',
      projectTabId: 'e0224b91-da18-4b20-9cc0-da491569a6b5',
      projectTabTitle: 'agent-code',
      projectTabIndex: 1,
      detachedAt: 1789606900000,
    },
    // One parked (non-lane) detached agent: alive, owned by its project,
    // unplaced. The pool's default state.
    'c0d3f00d-51aa-4f6e-8b1d-9d2e7a4b5c6f': {
      sessionId: 'c0d3f00d-51aa-4f6e-8b1d-9d2e7a4b5c6f',
      surface: 'dispatch',
      projectTabId: '3bf27c7f-2e3a-4da1-a35a-e013ad86f937',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 1789607000000,
    },
  },
  buried: [],
  pinnedSessionIds: [],
  drafts: {
    '361ef0c4-800b-4bb5-85f4-931183e8583a': '<draft>',
    '575880c6-d447-49b8-aa9b-64705d70c287': '<draft>',
  },
}
