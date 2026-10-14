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
