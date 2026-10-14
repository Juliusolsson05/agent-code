# The Hermes connection card (#1514)

**Size:** short plan. The shape is known: a new card on the existing condition path, beside the approval, clarify, sudo and secret cards.

## Outcome
When Hermes' `manage_connections` needs an account or an MCP server set up, the Hermes pane shows a card above the composer instead of a dead-end sentence. The card offers, as each service needs:
- the service and Hermes' setup text;
- **Open sign-in**, when a link was minted;
- the values an install needs;
- **Skip** and **Continue without it**;
- a countdown to Hermes' deadline.

## Evidence (verified)
- Recorded against Hermes v0.22.0 (hermes-headless#3, `research/corpus`):
  - **S26:** `n8n-official` asks for `N8N_MCP_SERVER_URL`;
  - **S27:** `airtable` OAuth.

  Each recording carries `connection.request`, `connection.respond` and `connection.update` frames, then settles.
- Every frame carries the full snapshot. The answer goes through `connection.respond` with the conversation's runtime session as owner.
- **Not recordable locally:** the hosted-connector `connect_url`, which Nous' gateway mints for a real account. Its card path is tested on a mechanical mutation of S26 into that shape (Hermes' `Target.snapshot`).

## Change
- **Package** (hermes-headless#3): `connection-operation` event and `respondConnection()`.
- **`HermesSession`:** keeps open operations by `opId`. A `hermes.connection` condition is built by `connectionConditionRecord`. `resolveCondition` handles `HERMES_CONNECTION_RESPOND` through `validateConnectionAnswer`, which refuses:
  - unknown or resolved rows;
  - credential names the row did not ask for;
  - empty required values;
  - settled operations.
- **View:** `hermesConnectionView` in `renderer/conditions/views.tsx`.
- **Registration:** policy, attention kinds and state type.

## Tests
- **Session:** recorded S26.
- **View:** recorded S26, plus the hosted mutation.

Each fails on the pre-change source (checked by reverting it).

## Verification boundary
- The app was not launched.
- The real hosted sign-in leg was not run: there is no Nous account in tests.

## Review round (one round, two reviewers)

### Fixed
- **A F1 (high): account-owned updates.** Hermes broadcasts account-owned `connection.update` frames to every socket. They are now dropped in the package, so other panes no longer get phantom cards.
- **A F2 / B F2: dead approve buttons.** Approve is offered only where Hermes acts on it (`connectionRowApprovable`):
  - pending mcp/plugin/skill rows get Install, Enable or Authorize;
  - failed or expired rows get Try again;
  - connectors never get approve;
  - `initiated` rows with no link read "working…".

  Recorded **S28** (an approved OAuth install: `initiated` with no link, then `failed`) pins this.
- **A F3: remote OAuth.** The doc comment and test name are corrected. A catalog OAuth link now carries a note: it finishes on the Hermes host, so on a VPS use `hermes mcp login <name>`.
- **A F4 / B F4: reconnects.** `pending_connection` from every resume or activate snapshot replaces the held operations. There is also a backstop that drops a card 5 s after its deadline. The newest operation is the one drawn.
- **A F5: replays.** Settled op ids are remembered, so a replayed old snapshot cannot reopen a card.
- **A F6.** `resolved` falls back to Hermes' rule.
- **B F1 (high): catalog plugins and skills.** Their tier, scan and `repo@sha` are shown. A failed scan gets no install button.
- **B F3: links.** `connect_url` is http(s) only, in the package and again at the click.
- **B F5: tests.** The resolved/settled validator, stale snapshots, sign-out, reconnect sync, secret masking, a blocked link and the plugin scan are now tested. 10 mutants were checked and all are caught.
- **B F6–F10: polish.**
  - the draft is kept until the row moves on, and buttons are disabled while sending;
  - a secret default is never pre-filled;
  - the visible prompt is the accessible name, required fields are marked, and a disabled hint is shown;
  - the title is derived from what is asked, and the link is shown and selectable;
  - `isDecline` keys on the action id;
  - duplicate rows are refused.

### Still not recordable here
- **Hosted connector link (Nous-minted).** Its card path is tested on a mechanical mutation of S26.
- **Successful OAuth authorization URL.** This local runtime lacks HTTP-transport MCP, so S28 fails before a link is minted.
