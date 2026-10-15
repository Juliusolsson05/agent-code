# Hermes: choose which messaging thread a pane follows (#1501)

Size: short plan. Known shape: the lane machinery (#1496) already follows any
gateway routing key; this adds the choice.

## Outcome

A "Change Telegram Thread…" command on a Hermes pane opens a picker listing
every messaging thread on that pane's Hermes server (the plain DM, DM topics,
groups) plus "Separate chat". Choosing one reopens the pane on that thread; the
choice persists in `SessionMeta.hermesLaneKey` and survives Reload Agent.

## Evidence (verified, do not re-derive)

- `HermesHeadless.listLanes(rest)` → `LaneSummary[]` (sessionKey, platform,
  chatType, threadId, displayName, headId, lastActiveAt), most recent first.
- Recorded T8 (v0.22.0) has two lanes with the SAME displayName "Tester":
  `agent:main:telegram:dm:111` (threadId null) and
  `agent:main:telegram:dm:111:7` (threadId "7"). Labels must therefore say
  which thread, not only whose.
- `HermesSession` gives `hermesLaneKey` precedence over `resumeSessionId`; with
  neither it creates a new conversation.
- `replaceSession` currently re-applies `oldMeta.hermesLaneKey` AFTER the
  caller's options, so a caller cannot change or drop the lane today.

## Change

1. `shared/hermes/types.ts`: `HermesLaneChoice` (LaneSummary minus headId) and
   `HermesLaneListing = { ok: true; lanes } | { ok: false; error }`.
2. `HermesConnectionService.listLanes(id)` → `HermesLaneListing`; never throws.
   IPC `hermes:list-lanes`, preload `hermesListLanes(id)`.
3. `replaceSession` opts `hermesLaneKey?: string | null`: a string follows that
   lane, `null` makes a separate chat (`hermesLane: 'none'`), omitted keeps
   today's carry.
4. UI store `hermesThreadPickerSessionId` + open/close; surface registered;
   palette `ui.openHermesThreadPicker`.
5. `HermesThreadPickerModal`: loads lanes on open; rows = Separate chat + lanes
   (label from `laneLabel()`), current marked; Enter/click replaces the pane
   via `replaceSession(cwd, { targetSessionId, hermesLaneKey, newConversation: true })`.
6. Command `hermes-change-thread` ("Change Telegram Thread…"), only for a
   Hermes pane with a connection.

## Tests

- `laneLabel` / `laneChoices` on the recorded T8 listing (summarizeLanes of the
  real REST body): the two "Tester" lanes get distinct labels; the current lane
  is marked. Fails before: no such function.
- `service.listLanes` returns `{ ok:false }` when REST rejects (no throw), and
  the recorded lanes without `headId` when it resolves.
- `replaceSession` lane override: the spawn receives the chosen key, and `null`
  spawns with `hermesLane: 'none'` and no key. Fails before: carry overrides it.

## Verification boundary

No app launch (standing rule). The picker's rendering and the real pane swap
against a live Hermes are not exercised here; tsc on both projects + scoped
vitest.

## Out of scope

Choosing the lane at pane creation (the split commands keep default/none).
