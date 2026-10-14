# Hermes: one thread with Telegram, slash commands, Copy Assistant and honest startup errors

**Status:** IN PROGRESS (owner: "write out the full plan files and then go ahead and build out the full thing", 2026-10-14). The owner did not answer §2, so every decision there is built with its default and is **UNCONFIRMED**. Tailscale phase 1 has its own plan file (`2026-10-14-tailscale-hermes-phase1.md`) and ships in this same PR (ruling in §13). Written 2026-10-14, on branch `feat/hermes-telegram-thread-and-commands` (worktree `.worktrees/hermes-telegram-thread`, branched from `origin/main` at `d0c3df99`).

**Size:** a long plan with an embedded staged decomposition. The Telegram half meets several of the skill's triggers:
- a behaviour nobody in this repo has recorded yet (a gateway-owned lane seen from `serve`);
- three sources of truth that must agree in one feed: the live WS turn stream, the durable `session.history` and turns written by another process (the Telegram gateway);
- a change that crosses repo and process boundaries (the app, the hermes-headless package, the upstream server).

So Stage 0 (recordings) comes before any feature code, and every stage below names what it produces, how it is verified, why it is separate and what real evidence it rests on.

**Repos:**
- Agent Code (this repo);
- `packages/hermes-headless` (submodule, its own PR);
- no upstream Hermes changes are required. Optional upstream reports are listed in §12.

**Approval mode:** the owner asked for this plan ("write a super long plan"). Implementation starts only after the owner reads it and answers §2. Every decision left unanswered when work starts is built with the default and marked **UNCONFIRMED** in this file and in the PR body.

---

## 0. TL;DR

The owner uses Telegram as Hermes' phone UI and wants Agent Code to be the desktop UI **for the same thread**. They also want:
- Hermes' slash commands (`/restart` named explicitly);
- Copy Assistant Message for Hermes;
- the pane to stop hiding why it failed.

They explicitly do **not** want a phone integration: no Agent Code → phone delivery work.

What ships, in order:

1. **Honest startup errors.** The pane says *why* it could not start: too-old Hermes, unreachable, signed out, refused upgrade, server restarted mid-turn. Today Agent Code's main spawn path flattens **every** Hermes failure, including its own curated sentences, into "Session failed to start" (verified, §3.1).
2. **Hermes package hardening:**
   - always `queued: true`;
   - close stale request cards at turn end;
   - ticket in a subprotocol, not the URL;
   - a typed "incompatible backend" error;
   - surfacing the events we silently drop today (notifications, `/bg` and `/btw` answers, subagent activity, review summaries, output-risk warnings).
3. **Telegram thread attach ("lane mode").** A Hermes pane can follow the owner's Telegram DM lane (`agent:main:telegram:dm:<chat_id>`). It:
   - shows the whole thread;
   - picks up phone turns within ~2 s;
   - follows `/new` and compression to the live tip;
   - holds a pane prompt while a phone turn is running, so the model never sees it twice;
   - says plainly that replies typed in Agent Code do not appear on the phone.
4. **Slash commands for Hermes.** A composer picker fed by Hermes' own `commands.catalog`, so skills and user quick-commands appear too. Commands are routed the way upstream Desktop routes them:
   - `/bg` and `/btw` → side-agent RPCs, whose answers are shown;
   - `/compress` → `session.compress`;
   - `/restart` → the dashboard's `POST /api/gateway/restart`, behind a confirmation;
   - commands Hermes marks unavailable outside a terminal → refused with Hermes' reason.
5. **Copy Assistant Message / Copy Last Response for Hermes.** Proven end to end on recorded Hermes data, including a reply that is still streaming.
6. **Tests:**
   - a v0.22.0 corpus beside the v0.21.7 one;
   - Telegram-lane recordings against upstream's real Telegram adapter and Bot API stand-in;
   - a live tier that runs against both releases;
   - a first-pane-through-the-app-path test.

**Tailscale** is a separate track (§11). It gets its own issue and plan after the owner answers its scope question. Nothing in this branch depends on it.

---

## 1. Outcome (observable end state)

When this branch is merged and the owner opens Agent Code against the VPS Hermes (v0.22.0):

**D1. A failed start says why.** The pane's error names one of these, and nothing generic is shown when the cause is known:
- signed out;
- cannot reach the server;
- the server refused the WebSocket upgrade (with the HTTP status);
- Hermes is too old (method + code);
- Hermes restarted;
- the stored conversation is gone.

**D2. "Open Hermes Telegram Thread" opens a pane on the Telegram DM lane** with its full history, including ancestors before compression.

**D3. A phone message appears in the pane** within about 2.5 s of Hermes committing it: user row first, then the reply as a finished message. Token streaming of phone turns is out of reach (§3.4).

**D4. A pane prompt sent while a phone turn is running** shows as "Waiting for Telegram…" and is sent automatically once the phone turn finishes. "Send now" and "Cancel" are offered.

**D5. Telegram `/new` or compression moves the pane to the new live tip.** `/new` shows a divider "Telegram started a new conversation"; compression is seamless. The pane never writes into an ended row.

**D6. A persistent notice in lane mode:** "Replies you send here are saved in this Telegram conversation but don't appear in the Telegram app." It links to the upstream issue. It can be collapsed, and it never blocks sending.

**D7. Typing `/` in any Hermes composer opens a command picker** from the server's catalog: built-ins, quick commands, plugin commands and skills, each with its description.
- `/bg` and `/btw` show their answer when it arrives.
- `/restart` asks "Restart the Hermes gateway? Telegram goes offline for about a minute.", then calls the dashboard restart and reports the outcome.

**D8. Copy Assistant Message / Copy Last Response** work on Hermes panes, including on the reply currently streaming.

**D9. Approval, clarify, sudo and secret cards** answered from another client (Hermes Desktop, the dashboard chat, Telegram) close when the turn ends, instead of staying up and silently swallowing a click.

**D10. Tests:**
- the hermes-headless live suite runs against pinned v0.21.7 **and** v0.22.0;
- the v0.22.0 corpus is checked in;
- the app has a startup-stage matrix and a first-pane test through the real main→renderer path.

---

## 2. Decisions for the owner (answer in chat; the default is used if unanswered and marked UNCONFIRMED)

| # | Decision | Default | Why the default |
|---|---|---|---|
| 1 | One PR (plus the package PR) for everything in §0, or split "honest errors + package hardening" into a first PR? | **One app PR + one package PR.** | The pieces touch the same files (`hermesSession.ts`, `HermesHeadless.ts`, the reconciler, the composer). Splitting coupled work into a PR stack has cost more than it saved before (memory: avoid multi-PR splits for coupled work). |
| 2 | How the pane chooses the Telegram thread. | **Auto-pick the DM lane** (chat_type `dm`, no topic, most recent activity). A small "Change thread" menu lists other Telegram lanes, such as DM topics and groups. | The owner has one DM with their bot. A picker on every open is friction. |
| 3 | Is the Telegram thread the default for a new Hermes pane? | **Yes, when the connection has a Telegram lane.** "New Separate Hermes Chat" keeps today's behaviour (a fresh `agent-code` conversation). | Owner: "when I'm using it in agent code, it just replaces what I use Telegram for." |
| 4 | Pane prompt while a phone turn runs. | **Hold it locally** as "Waiting for Telegram…", auto-send when the phone turn ends, and offer "Send now" / "Cancel". | t2 proved a send during a phone turn puts the prompt into the model's context twice (§3.4). "Send now" is the escape hatch. |
| 5 | `/new` typed in a lane pane. | **Refuse with a notice**: "/new in Agent Code would start a separate chat. To start a new Telegram conversation, type /new in Telegram. Use 'New Separate Hermes Chat' for a desktop-only chat." | The `serve` RPCs cannot reset the gateway's lane. A pane `/new` would silently leave the Telegram thread. |
| 6 | `/restart` confirmation. | **Confirm every time** (one dialog, Enter to confirm). | It takes the Telegram bot offline for about a minute (§3.5). |
| 7 | The "not on your phone" notice. | **Shown on the first lane open per connection, then collapsible to a one-line chip**, never removed. | It is a real limitation, and hiding it would mislead (owner chose option (a)). |
| 8 | Tailscale scope (§11). | **Phase 1: Agent Code connects to Hermes over the owner's tailnet** (docs, a URL helper, a reachability hint). Running or provisioning Tailscale for teams is a later, separate plan. | It is the smallest piece that delivers "premise" security for Hermes without Agent Code owning a VPN. |

---

## 3. Evidence (verified, do not re-derive)

Each fact names its source. Sources:
- **"t1"…"r8"**: the research reports in `.worktrees/hermes-agent-pane/temp/hermes-research/report-*.md` (git-ignored; consolidated in `SUMMARY.md` there).
- **"upstream v0.22.0"**: the tagged source at `temp/hermes-research/scratch-t1/src` (`e06df9c2`).
- **"vendored"**: `vendor/hermes-agent-src` (v0.21.7).

### 3.1 Why the owner saw "Session failed to start"

1. **v0.20.4 lacked `client.capabilities`** (desktop contract 6), so the handshake's first RPC answered `-32601` (r1). The VPS now runs v0.22.0 (contract 8), and all live tests and 16 Stage-0 scenarios pass there (r8).
2. **The real error never reached the screen, and the reason is in the main process, not only the renderer.** `src/main/ipc/session.ts`:
   - `launderSpawnError` (L631) → `classifySpawnFailure` (L678) returns `SESSION_START_FAILED_MESSAGE` for everything except missing-workspace, CLI-not-found, window-refused and the Claude proxy.
   - It never calls `curatedRemoteProviderMessage` (`src/shared/types/session.ts:207`).
   - So even `HERMES_SIGNED_OUT_MESSAGE` and `HERMES_UNREACHABLE_MESSAGE`, which `HermesSession.start` (L215–229) deliberately produces, are flattened on the plain spawn path.
   - The recovery path (`sessionManager.ts:2260`) and the renderer (`workspace/spawn/errorMessage.ts:49,64`) do preserve them.

   **This is a real bug (B1).** Verified by reading `classifySpawnFailure` on `origin/main` in this worktree.
3. **The journal can't tell why either.** `sessionManager.ts` writes `provider.start.end {kind, ok:false, durationMs}` (L3615) with no stage or code. The raw error goes only to `performanceService.error('session.spawn.providerStart.error')` and main stdout.
4. **Other places in the startup path that hide detail:**
   - `HermesSession.start` wraps every unclassified error as `Could not open the Hermes conversation: …` (L229). That text is then laundered.
   - `RpcConnection.open` (L149) calls `client.capabilities`, and a `-32601` there is a plain `RpcError` with no "incompatible" meaning.
   - `service.ts openWs` (L404–410) maps every 401/403 upgrade refusal to "Hermes refused the connection ticket. Sign in again." But uvicorn turns *every* pre-accept close (bad ticket 4401, Host/Origin 4403, chat disabled) into a bodiless 403 (r5). The sentence is a diagnostic trap.

### 3.2 hermes-headless today (code map; line numbers at `561975b`)

- **`HermesHeadless.prompt`** (L325–338) sends `queued: true` only when `turnInFlight`.
  - On an idle session `queued` is ignored server-side; it is read only on the busy path (`methods_prompt.py:808-826`, r4 F3).
  - In the ~1.3 s gap between the `prompt.submit` reply and `message.start`, a second client's prompt can therefore be sent without it, and `display.busy_input_mode=interrupt` (the default) **redirects the other client's turn** (r4 F3).
- **`runSlash`** (L422):
  - `/new` and `/reset` are local;
  - `/stop` interrupts and then calls `slash.exec`;
  - everything else goes to `slash.exec`, with `command.dispatch` on 4018.
  - `/bg`, `/background` and `/btw` lose their answers this way, because the slash worker prints after its capture window. Upstream Desktop moved them to `prompt.background` / `prompt.btw` (`apps/desktop/src/lib/desktop-slash-commands.ts:271-289` at v0.22.0, issues #99065, #97635, #57444).
  - `/compress` has the same problem: the worker times out on large sessions (#44456). Desktop uses `session.compress`.
- **`ConversationReconciler`:**
  - `message.complete` → `completeTurn` (L558) does **not** close open requests. Only a snapshot (`superseded`, L180), `request.cancel`, `approval.cancelled` and `session.reclaimed` close them.
  - Server `resolve_response` emits nothing to the *other* attached clients when one client answers (r4 F4).
- **Ignored events** (`contract/catalog.ts` L41): `notification.show/clear`, `review.summary`, `subagent.*`, `background.complete`, `btw.complete`, `tool.output_risk`, `connection.request/update`, `sessions.changed`, `session.control.update` and others. r4 F9 judged each; ~6 are worth handling.
- **The ticket travels as `?ticket=`** (`auth/index.ts buildWsUrl` L298). Hermes accepts `Sec-WebSocket-Protocol: hermes-gateway-v1, hermes-gateway-ticket.<t>` in **both** v0.21.7 (`vendor/hermes-agent-src/hermes_cli/web_server_chat.py:208`) and v0.22.0 (`web_server_chat.py:202-218,262-273`) (r5 F-ticket).
- **Epochs:** a reconnect compares `connection.epoch` (from `gateway.ready.replay_epoch`). A changed epoch → `reattach()` → `session.resume`. The *pane* is never told the in-flight turn died (r4 F7).

### 3.3 The Telegram lane (t1 from source, t2 live with upstream's real Telegram adapter against its Bot API stand-in)

- **Lane key:** `agent:main:telegram:dm:<chat_id>`.
  - Built by `gateway/session.py:685-727`; a DM topic appends `:<thread_id>`.
  - Time never rotates the id behind it. Only `/new`, `/reset`, `/stop` (suspension), `/resume`, `/handoff` and compression do (t1 F1c).
- **Finding the lane.**
  - WS `session.list` has no `session_key`.
  - REST `GET /api/sessions?source=telegram&order=recent&limit=…` returns every column, including `session_key`, `chat_id`, `chat_type`, `thread_id`, `ended_at`, `end_reason` and `parent_session_id` (t1 F1b).
  - `GET /api/sessions/{id}/latest-descendant` returns the compression tip as `{session_id, path, changed}` (upstream v0.22.0 `hermes_cli/web_routers/sessions.py:585-593`).
- **REST accepts our bearer token.** Verified now from source:
  - `hermes_cli/dashboard_auth/middleware.py:169-180`: "RFC 8252 native-app bearer path: the same provider-minted access token the cookie flow stores … no cookie read or set". Every gated route accepts `Authorization: Bearer <access token>`.
  - This closes t1 open question 1 *on paper*. The Stage 0 live probe confirms it on the VPS.
- **Resume and history.**
  - `session.resume {session_id}` follows compression, but **not** `/new` (`methods_session.py:823-838`; `hermes_state_compression.py:25-45`).
  - `session.history` returns the durable transcript **including ancestors**, with row ids (`contracts/sessions.py:489-499`).
- **Safety.**
  - A cross-process durable turn lease (`session_turn_leases`, lineage-root key, TTL 300 s, waiter up to 1800 s, status "Another Hermes process is using this session") serializes model turns between the gateway and `serve` (t1 F2a; t2 E measured both orders).
  - `serve` never ends a gateway-owned row (`session_lifecycle.py:311-327`; t1 F2d; t2 B).
- **Context is shared in both directions.** `serve` folds rows another process appended before each prompt (`prompt_turn.py:507-552`, upstream #42962). The gateway reloads from SQLite every turn (t1 F2, t2 B).
- **Live signal.**
  - A phone turn produces only a global, payload-free `sessions.changed`, debounced to 2 s and polled at 0.5 s (`change_watcher.py:285-301`). There is no `message.*` event.
  - `session.history` immediately returns the new rows (t2 D, `scratch-t2/run5/evidence.jsonl:2`).
  - Upstream Desktop refetches on that signal and keeps a 30 s backstop poll (5 s when `change_events` is false) (t1 F3).
- **Gap 1, no phone delivery.** Pane turns are never delivered to Telegram:
  - upstream #76767 (open, P1);
  - fix PR #76796 open;
  - feature #99127 open;
  - t2 C proved it live.

  **The owner chose not to build any phone delivery** (2026-10-14). We label the gap instead.
- **Gap 2, duplicated prompt.**
  - A pane `prompt.submit` during a running phone turn writes the pane's user row immediately, without the lease (`session_workdir.py:673-724`).
  - The waiting turn then reloads with `repair_alternation=True`, so the model saw the pane prompt **twice**: merged into the phone message, then again as the current input (t2 E, `scratch-t2/run5/evidence.jsonl:5,7`; raw rows in `08-race-after-close-db.json`).
  - **A client hold before submit avoids the observed (phone-first) order.** It cannot close a race in which the phone message lands after our check (t2 E). That residual window is milliseconds wide; §6.3 bounds it.
- **A stale id is a trap.** A pane holding a pre-`/new` id *reopens* the ended row on its next prompt (`_reopen_if_finalized`, `methods_prompt.py:593-609`). The lane then forks (t1 F2e).
- **Our turns run as `source: "agent-code"`.** Their model context lacks the Telegram session-context prompt (t1 F2f). This is accepted.

### 3.4 What the pane cannot do (ceilings, not bugs)

- No token streaming for phone turns: the gateway is another process, and there is no cross-process event bridge.
- Requests (approval, clarify) raised by a **phone** turn are answered on the phone; the pane cannot see them (t1 R9).
- No phone delivery (owner decision).

### 3.5 Slash commands

- **Catalog.** `commands.catalog {session_id}` returns:
  - `pairs` (name, description);
  - `categories`;
  - `canon` (alias → canonical);
  - `sub` (subcommands);
  - `commands[name] = {argument_mode, desktop, desktop_subcommands}`;
  - `skills`, `skill_count`, `warning`.

  Built-ins are added by `_catalog_registry` (`tui_gateway/methods_tools.py:446-459`), which **skips `gateway_only` commands**. Quick commands, plugin commands and skills come after (upstream v0.22.0 `methods_tools.py:505-539`; contract `contracts/tools_commands.py:188-229`).
- **`desktop` metadata** (`hermes_cli/commands.py` `CommandDef.desktop`):
  - `None` means offered;
  - `"hidden"` means it runs but is not listed;
  - any other string is an unavailability reason (`terminal`, `messaging`, `settings`, `advanced`, `composer-voice`).

  Desktop's offline mirror is `apps/desktop/src/lib/desktop-slash-registry.json` (v0.22.0).
- **Execution:**
  - `slash.exec {session_id, command}` runs on the session's slash worker and may reroute to `command.dispatch`, which returns a directive: `exec | alias | plugin | send | skill | prefill` (`methods_tools.py:1095-1180`).
  - `complete.slash {text, session_id}` gives ranked completions with `replace_from`.
- **`/restart` is `gateway_only=True, desktop="terminal"`** (`hermes_cli/commands.py:316-317`). It is *not* in the catalog and cannot run over `/api/ws`.
  - The dashboard exposes the same action as `POST /api/gateway/restart` (`hermes_cli/web_routers/actions.py:160-165`). That spawns `hermes gateway restart` with in-flight reuse and a 10 s coalescing cooldown (`web_server.py:947-986`).
  - Bearer-authenticated like every gated route (§3.3).
  - **Whether that spawn actually restarts the gateway inside Hostinger's s6 container is unknown (U3).**
- **Desktop's routing table** (`apps/desktop/src/lib/desktop-slash-commands.ts`, v0.22.0):
  - **actions:** `/new` (`/reset`, `/clear`), `/stop`, `/branch`, `/yolo`, `/reasoning`, `/handoff`, `/profile`, `/title`, `/help`, `/compress` (`/compact`), `/btw`, `/bg` (`/background`);
  - **rpc:** `/save` → `session.save`, `/status` → `session.status`;
  - **exec:** `/skills` (with `desktopSubcommands`);
  - **everything else offered:** `exec`;
  - **pickers:** `/model`, `/resume`.

  All of `session.title`, `session.status`, `session.save` and `session.compress` exist in v0.21.7 too (`vendor/hermes-agent-src/tui_gateway/contracts/sessions.py:320,474,486,597`).
- **Agent Code today:**
  - **There is no provider slash catalog in the app at all.** The only picker reads Claude Code's terminal screen (`SlashPickerParser`, `composerPickerKind: 'claude.slash-picker'`).
  - `useComposerKeybinds.ts:623` keeps chat-surface panes out of terminal slash mode, so a Hermes `/cmd` is submitted as text. `hermesSession.deliverPromptText` (L279) then routes it to `runSlash`, and the output appears as a notice row.
  - `HermesHeadless.completeSlash` exists, but nothing calls it.

### 3.6 Copy Assistant

- Both commands are already *enabled* for Hermes:
  - `copy-assistant-message` checks `isAgentProviderKind` (`copyAssistantCommands.ts:26-36`);
  - `copy-last-assistant` checks `sessionHasTranscript` (`paneCommands.ts:442-487`).
- Both read `runtime.entries` (committed, mapped) through `assistantEntryText`, `extractAssistantByUuid` and `assistantUuidsWithText` (`features/copy-assistant/lib/extractAssistantByUuid.ts`).
- The Hermes mapper produces assistant entries with a `text` block and uuid `hermes:<key>` (`mapper.ts:62-100`). `HermesChatFeed` puts `data-entry-uuid` on committed assistant rows (L177-180).
- **Streaming items carry no uuid** (`chatProjection.ts:137,144`), and committed rows arrive only after the post-turn `session.history` fetch (`HermesHeadless.scheduleHistoryFetch` L517). So during a turn and in the window right after it, the newest reply is neither copyable nor highlightable.
- **Root cause of the owner's report: UNKNOWN (U6).** The code is wired. Stage C0 reproduces it on recorded data before anything is changed.

---

## 4. A (what exists and is trusted) → D (§1)

**A, trusted:**
- hermes-headless#1 + agent-code #1491:
  - a chat pane over `/api/ws`;
  - native PKCE sign-in;
  - a token broker with single-flight refresh;
  - resume by stored id with a 4007 fallback;
  - a reconnect loop;
  - request cards;
  - the reconciler's live+committed merge.
- 90 package tests, 7 live (v0.21.7) and 119 app tests are green (r7). The v0.22.0 Stage-0 replay passed (r8).

**A does not establish:**
- any behaviour against a Telegram lane;
- v0.22.0 in the checked-in corpus (r8's corpus is in scratch only);
- any test of the real app startup path;
- Copy Assistant on Hermes data;
- correctness of the spawn-error surface (B1 shows it is wrong).

---

## 5. Stages (decomposition)

Stages are ordered. A stage starts only after the previous one's artifact exists and is verified.

### Stage 0: Evidence (recordings, before any feature code)

- **Produces:**
  - `packages/hermes-headless/research/corpus/v0.22.0/S*/…jsonl`: r8's 16 scenarios re-recorded through the recorder after the provenance fix below, plus the new scenarios;
  - `research/corpus/v0.22.0/T*/`: Telegram-lane scenarios;
  - a `MANIFEST.json` per release (`{release, sourceCommit, contract, scenarios[]}`);
  - `Stage 0 results` appended to §13 of this plan.
- **New scenarios** (recorded with upstream's `TelegramStandin` + the real Telegram adapter, as t2 did; `scratch-t2/experiment.mts` is the starting point):

  | Id | What it records |
  |---|---|
  | **T1 lane discovery** | phone seed message → REST `/api/sessions?source=telegram&order=recent` (with bearer) → `latest-descendant` → `session.resume` → `session.history` |
  | **T2 phone turn while attached** | `sessions.changed` → `session.history` refetch (the t2 D sequence) |
  | **T3 pane turn on the lane** | `prompt.submit` → stream → `message.complete` → history; the stand-in proves no Telegram delivery |
  | **T4 phone-first race** | phone turn running → pane `prompt.submit` → lease wait statuses → the duplicated-context request. **The negative fixture the hold must prevent.** |
  | **T5 hold then send** | phone turn running → client waits on history tail → phone turn completes → pane submit. **The positive fixture.** |
  | **T6 Telegram `/new`** | old row ended `session_reset`, new row with the same `session_key`; `sessions.changed`; the old id is still resumable (proves why we must not keep it) |
  | **T7 compression on the lane** | the tip moves; `session.resume` and `latest-descendant` both follow |
  | **T8 DM topic lane** | a second lane `…:dm:<chat>:<thread>`, to prove the auto-pick rule |

- **New non-Telegram scenarios:**

  | Id | What it records |
  |---|---|
  | **S17** | `commands.catalog` + `complete.slash` (with a quick command, a plugin-free skill and the bundled skills) |
  | **S18** | `/bg` via `prompt.background` → `background.complete` |
  | **S19** | `/btw` via `prompt.btw` → `btw.complete` |
  | **S20** | `/compress` via `session.compress` |
  | **S21** | `notification.show/clear` + `review.summary` (a memory-writing turn) + `subagent.start/complete` (a `delegate_task` turn) |
  | **S22** | two clients: client B answers an approval, client A gets `message.complete` with the card still open (the r4 F4 shape) |
  | **S23** | idle `prompt.submit` with `queued: true` vs without; must be byte-equivalent apart from ids (r4 open question 1) |
  | **S24** | a `POST /api/gateway/restart` against the local harness's gateway process (a 200 response with action pid), plus the action-status poll |
  | **S25** | v0.20.4 handshake: `client.capabilities` → `-32601`. Recorded against a v0.20.4 checkout, so B1's matrix rests on a real failure, not an invented one. r7 F8 asked for exactly this. |

- **Recorder fixes first** (r7 F3/F7):
  - `research/record-wire.mts` derives provenance from `$HERMES_LIVE_RUNTIME/SOURCE_COMMIT` instead of the hard-coded v0.21.7 note (L414);
  - it writes to `corpus/<release>/` from a `--release` flag (L25, L411);
  - `src/testing/corpus.ts latestRecording` takes a release argument, so tests never silently pick "the lexically newest file".
- **Live probe on the owner's VPS** (read-only, one call each, with the owner's existing sign-in, run from a scratch script that reads the token through the app's token store API, never printing it):
  1. `GET /api/sessions?source=telegram&order=recent&limit=20` with bearer → record which columns arrive. **Redact `chat_id` and names before anything is written**; only the column *names* and lane-key *shape* go into the plan.
  2. `GET /api/sessions/<tip>/latest-descendant`.

  Nothing else touches the VPS in Stage 0. `/api/gateway/restart` is **not** probed on the VPS (U3 is answered in Stage F, with the owner present).
- **Verified by:**
  - `research/corpus/<release>/MANIFEST.json` lists every scenario;
  - `subset.test.ts` sweeps both releases;
  - each T-scenario has an `analyze` assertion carried over from `scratch-t2/analyze.py` (list/resume, refetch, no delivery, non-overlap, duplicated input in T4 and **not** in T5).
- **Why separate:** every later stage's fixtures come from here. Building lane mode first would mean testing against my reading of t1, which is exactly the imagined-input failure the skill exists to prevent.
- **Reality check:**
  - upstream v0.22.0 source + upstream's own Telegram stand-in (t2 proved this works);
  - v0.20.4 checkout for S25;
  - two read-only VPS calls.

**Hypotheses to settle in Stage 0** (verdict in place, in §13):

- **H1:** REST `/api/sessions` accepts the native bearer token and returns `session_key` + `chat_type` + `thread_id` + `ended_at`. (Source says yes. T1 and the VPS probe decide.)
- **H2:** `queued: true` on an idle session is equivalent to a plain submit. (S23 decides; H1 of the package changes rest on it.)
- **H3:** the busy rule in §6.3 classifies every T-scenario frame correctly: busy during T2/T4's phone turn, idle after its final assistant row, idle in T3 after our own turn.
- **H4:** `session.history` after T6 `/new` on the *new* tip starts with the reset row (no ancestors). On a compression child (T7) it includes the ancestors.
- **H5:** `sessions.changed` fires for every phone commit that changes `message_count`. (t2 says yes; T2 counts it.)
- **H6:** `POST /api/gateway/restart` returns `{ok, pid, name}` and the gateway comes back (S24, local harness only).

### Stage A: Honest startup errors (app + package)

**Produces:**
- **package:** `HermesIncompatibleBackendError` (`{method, code, contract?}`), thrown by `RpcConnection.open` when the handshake's `client.capabilities` (or another first-use call) answers `-32601` or `-32602`. `open()` also closes the half-opened socket on any handshake failure (r1 H5).
- **app, `src/main/hermes/service.ts`:**
  - `openWs` maps upgrade refusals by status. 401 → "Hermes refused the sign-in for this connection. Sign in again." 403 → "Hermes refused the WebSocket (HTTP 403). This is usually the connection ticket, or the server's Host/Origin check." Plus `stage: 'ws-upgrade'` and `httpStatus`.
  - The sign-in sentence is reserved for 401 and for a broker-level refusal.
- **app, `src/providers/hermes/runtime/hermesSession.ts`:** `start()` classifies into a new shared type `RemoteStartFailure` (in `src/shared/types/session.ts`):
  - `{ stage: 'connection-missing' | 'signed-out' | 'ticket' | 'ws-upgrade' | 'ready' | 'capabilities' | 'incompatible' | 'attach' | 'unreachable' | 'unknown', code?: number, httpStatus?: number, message: string }`;
  - `message` is always one of a fixed set of curated sentences, never a raw upstream string.
  - It throws a `RemoteProviderStartError` (new class, `src/shared/errors/remoteProviderStartError.ts`) carrying it.
- **app, `src/main/ipc/session.ts`:** `classifySpawnFailure` gains a branch *before* the generic ones. `error instanceof RemoteProviderStartError` → `{signature: 'remote-start:<stage>', message: error.failure.message}`. The same branch accepts the three existing curated sentences via `curatedRemoteProviderMessage(raw)` (fixing B1 for every remote path).
- **app, `sessionManager.ts` L3615:** `provider.start.end` gains `stage` and `code` / `httpStatus` (safe enums and numbers only).
- **app, `src/renderer/src/workspace/spawn/errorMessage.ts`:** `curatedSpawnMessage` admits the new curated set (exported from `src/shared/types/session.ts` as `REMOTE_START_MESSAGES`).
- **app:** a mid-turn epoch change is shown:
  - The package emits a new `turn-lost` event `{reason: 'backend-restarted'}` when `reconnect()` sees a new epoch while `turnInFlight`. `HermesSession` turns it into a notice row: "Hermes restarted. The reply in progress was lost."
  - Prompts the server had acknowledged as `queued` and that are absent from the post-resume history become a notice "Not sent: <first 60 chars>". The draft is restored if the composer is empty.
- **app, request cards:** the sudo (120 s) and secret (300 s) cards show a countdown from the request's `timeout` field (r3 A5).

**Verified by:**
- **package system tests on S25** (real v0.20.4 recording) → `HermesIncompatibleBackendError {method:'client.capabilities', code:-32601}`, socket closed;
- **mutation:** drop the `-32601` branch → the test reports a plain `RpcError` (red);
- **app unit table** `classifySpawnFailure.remote.test.ts`: every `RemoteStartFailure.stage` round-trips to its sentence, and an unknown `Error('…token=abc…')` still becomes the generic sentence with no leak (redaction preserved);
- **app system test** `hermesSession.startFailure.system.test.ts`: drives `HermesSession.start()` with a `FakeSocket` replaying S25, a 403 upgrade, a missing `gateway.ready` and a 4007 resume, then asserts the thrown `RemoteProviderStartError.failure`;
- **renderer test:** the pane error banner text for each stage, via the real `sessionSpawnErrorMessage`;
- **B1 regression:**
  - before the fix, `classifySpawnFailure(new Error(HERMES_SIGNED_OUT_MESSAGE))` returns the generic sentence;
  - after the fix, it returns the signed-out sentence;
  - the fix is reverted once to watch it go red.

**Why separate:** independent of Telegram and slash work, and it unblocks diagnosing everything after it.

**Reality check:** S25 (real v0.20.4), the existing S1/S3/S11/S14, r5's measured 403 behaviour.

### Stage B: Package hardening (hermes-headless)

**Produces:**
- **H1, always `queued: true`** on `prompt.submit`, gated on H2's verdict. If S23 shows any difference, keep the current rule and record the evidence.
- **H3, close requests at turn end.** `completeTurn` and a turn-level `error` call `closeAllRequests('settled')`. Also close a specific request when a later stream event of the same turn arrives (`message.delta`, `tool.start`), because a blocking request implies the stream was paused.
- **H4, surface dropped events.** Each moves from IGNORED to HANDLED in `contract/catalog.ts`, with a reason:

  | Event | Becomes |
  |---|---|
  | `notification.show {key, level, text, ttl_ms}` / `notification.clear {key}` | screen-channel `notice` with replace-by-key |
  | `review.summary` | a small committed notice ("Hermes updated its memory: …") |
  | `subagent.start` / `subagent.complete` | activity text ("Delegating: <goal>") |
  | `tool.output_risk` | a warning flag on the tool row (`risk: {kind, detail}`) |
  | `connection.request` | a notice "Hermes needs you to connect <provider> in Hermes Desktop or the dashboard." |
  | `background.complete` / `btw.complete` | a new committed row kind `side-answer {task_id, kind: 'bg'\|'btw', question?, text}` that does **not** enter the main conversation (`/btw` is answered "from a snapshot … history, alternation and prompt cache stay untouched") |
  | `sessions.changed` | handled only in lane mode (Stage D) |

- **H6, ticket as subprotocol.** `buildWsUrl` drops `?ticket=`. `dial` passes `protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.<t>']`. `RpcConnection.open` asserts `socket.protocol === 'hermes-gateway-v1'` and fails with `stage: 'ws-upgrade'` otherwise. The `HermesDial` signature changes from `() => Promise<WebSocketLike>` to the same, built from `(url, protocols)` in the app's `openWs`.
- **Slash routing**, `runSlash` rewritten around a table `SLASH_ROUTES` in `src/slash/routes.ts`:

  | Command | Route |
  |---|---|
  | `new`/`reset`/`clear` | local (lane-aware, Stage D) |
  | `stop` | `session.interrupt` only; the extra `slash.exec` is dropped (Desktop does not send it) |
  | `bg`/`background` | `prompt.background` |
  | `btw` | `prompt.btw` |
  | `compress`/`compact` | `session.compress` |
  | `title <t>` | `session.title` |
  | `status` | `session.status` |
  | `save` | `session.save` |
  | everything else | `slash.exec`, then `command.dispatch` on 4018 (unchanged) |
  | `resume`, `model`, `handoff`, `profile`, `branch`, `yolo`, `reasoning` | refused by the *app* (Stage E) with a sentence, never sent |

  `SlashOutcome` gains `{kind:'side-task', taskId, sideKind}` and `{kind:'refused', reason}`.
- **Catalog API:**
  - `HermesHeadless.commandCatalog(): Promise<CommandsCatalogResult>` → `commands.catalog {session_id}`;
  - `completeSlash` kept;
  - wire types `CommandsCatalogResult`, `CommandCatalogMeta` and `CompletionItem` added to `contract/wire.ts`, copied from upstream contracts (§3.5).
- **REST client** (new, `src/rest/HermesRest.ts`):
  - `listSessions({source, order, limit})`, `latestDescendant(id)` and `restartGateway()`;
  - authenticated with the broker's access token (the app passes an `accessToken(): Promise<string>` capability; the package never owns tokens);
  - typed errors reuse `HermesAuthError` kinds.

**Verified by:**
- system tests on S18–S24 through the public facade;
- a mutation per guard (remove the `closeAllRequests('settled')` call → S22 test red; restore the `?ticket=` URL → the subprotocol assertion red);
- `subset.test.ts` over both releases with the new HANDLED set.

**Why separate:** the package is its own repo and PR. Stages D and E consume its API.

**Reality check:** S17–S25 (Stage 0) and the existing S5/S6/S7.

### Stage C: Copy Assistant on Hermes

- **C0, reproduce first.** Write `copyAssistant.hermes.renderer.test.tsx`. It drives the real chain on S4 (live + committed) and S12 (paging): reconciler → `HermesSession` events → renderer runtime → `pickerEnter` / `pickerMove` / `pickerConfirm` and `copy-last-assistant`, at three moments:
  - (a) mid-stream;
  - (b) after `message.complete` but before the history fetch lands;
  - (c) after commit.

  Record which ones fail in §13. **If all pass, stop and ask the owner what they did** (U6). Do not invent a fix.
- **Expected fix (pending C0):**
  - The picker and Copy Last Response read the **chat projection** (ledger feed items), not only `runtime.entries`.
  - `chatProjection.ts` gives a streaming assistant item a stable synthetic uuid, `hermes:live:<turnId>`. It is swapped for the committed uuid when the row commits, and the picker's selection follows the swap (`usePickerSanity` must not close it).
  - `extractAssistantByUuid` gains a sibling `extractChatItemText(items, uuid)` used by Hermes only, chosen through the provider capability `copySource: 'entries' | 'chat-projection'` (new field on renderer capabilities; Hermes sets `'chat-projection'`, everyone else defaults to `'entries'`).
- **Produces:** the capability, the projection uuid rule and the extraction function.
- **Verified by:** the C0 test going green. Mutating the live-uuid swap breaks (b).
- **Why separate:** it is independent of the lane and fully testable on existing recordings.
- **Reality check:** S4 and S12 (v0.21.7) plus the same scenarios from the v0.22.0 corpus.

### Stage D: Telegram lane mode (package + app)

**Produces, package (`src/lane/`):**
- `HermesTarget` gains `{mode: 'lane', sessionKey: string, profile?: string}`.
- **`LaneResolver`** (`src/lane/LaneResolver.ts`):
  - `resolveTip(sessionKey) → {storedSessionId, endedPrevious?: {id, endReason}}`. It calls `HermesRest.listSessions({source: 'telegram', order: 'recent', limit: 50})`, filters `session_key === key && ended_at == null`, takes the newest `started_at`, then `latestDescendant`.
  - Fallback when REST is refused (H1 false): WS `session.list`, newest `source === 'telegram'`, marked `confidence: 'heuristic'`. The app then shows "Couldn't confirm this is your Telegram DM."
  - `listLanes() → LaneSummary[]` (`{sessionKey, chatType, threadId?, displayName?, lastActiveAt, tipId}`), grouped by `session_key`.
- **`HermesHeadless` in lane mode:**
  - `start()` resolves the tip, then `attachByResume(tip)`.
  - Subscribes to `sessions.changed`: debounce 300 ms, single-flight. On each signal it re-resolves the tip:
    - **tip changed:** emit `lane-moved {from, to, reason: 'new-conversation' | 'compression' | 'switch'}` and re-resume;
    - **unchanged:** `session.history` → `applyHistory` (the existing rewrite-aware merge by row id).
  - A 30 s backstop timer runs only while attached; the app pauses it when the window is hidden.
  - **Before every `prompt()`:** re-resolve the tip; if it moved, re-resume first. This is the F2e guard against reviving an ended row.
- **Busy rule** (`src/lane/laneBusy.ts`, pure function over the history tail plus our own submitted row ids):
  - **busy** when the last visible row is:
    - a `user` row whose id is not one we submitted; or
    - a `tool` row; or
    - an `assistant` row that carries `tool_calls` with no later row;
  - **also busy** while a status text matching "Another Hermes process is using this session" was seen less than 5 s ago;
  - **otherwise idle**.
  - H3 decides whether this rule is right; the rule is changed in this file before code if Stage 0 disproves it.
- **`HermesHeadless.laneState`** is emitted as `lane {busy, since, tip}`.
- **Prompt hold:** `prompt()` in lane mode while busy returns `{status: 'held', holdId}` and does not call `prompt.submit`. The package releases holds in FIFO order on the first idle evaluation, re-resolving the tip first. `releaseHeld(holdId, {force: true})` is "Send now"; `cancelHeld(holdId)` cancels.

**Produces, app:**
- **Launch options and persistence.** `SessionSpawnOptions` gains `hermesLane?: {sessionKey: string}`, persisted on the session meta beside `remoteConnectionId` and carried across reload (`hook/actions/session.ts` L1328–1335 pattern). `HermesSession` passes `{mode: 'lane'}` when it is set.
- **Commands** (command palette, `src/renderer/src/features/hermes-chat/commands/`):
  - **"Open Hermes Telegram Thread":** auto-picks the DM lane (Decision 2) and opens a pane.
  - **"New Separate Hermes Chat":** today's behaviour.
  - **"Change Telegram Thread…":** a list from `listLanes()`.
  - Per Decision 3, the default Hermes pane choice in the provider menu becomes the Telegram thread when a lane exists.
- **IPC.** `hermes:lanes(connectionId) → LaneSummary[]` in `src/main/ipc/hermes.ts` + preload, through `HermesConnectionService.restFor(id)`. It is built like `dialFor`: the broker's `accessToken()` + `HermesRest`.
- **Pane UI** (`HermesChatFeed` + composer):
  - a header chip "Telegram · <display name>";
  - the delivery notice (D6, Decision 7);
  - the divider on `lane-moved {reason: 'new-conversation'}` (a committed notice row "Telegram started a new conversation", emitted by `HermesSession.emitBoundary` with the existing `new-conversation` reset);
  - "Hermes is replying on Telegram…" while `lane.busy`;
  - held prompts as Sending-style rows, "Waiting for Telegram…", with "Send now" / "Cancel". These reuse the pending-prompt row (PR #1183 shape: draft stays in the store, the view shows it).
- **`/new` in lane mode:** refused per Decision 5 (handled in `HermesSession.deliverPromptText` before the package).

**Verified by:**
- package system tests over T1–T8;
- the T4 replay asserts the hold engaged, so the pane's `prompt.submit` frame is sent only after the phone turn's final assistant row;
- the T5 replay asserts exactly one submit and no duplicated input;
- T6: `lane-moved` with `new-conversation`, re-resume, and no submit to the old id;
- T7: compression is a silent tip move;
- app system test `hermesSession.lane.system.test.ts` on the same recordings via `FakeSocket` + a fake `HermesRest` serving the recorded REST bodies;
- renderer tests for the chip, notice, divider and held-row actions;
- mutations: remove the pre-submit tip check → the T6 test submits to the old id (red); make `laneBusy` always false → the T4 test sends during the phone turn (red).

**Why separate:** this is the hard part and is confined to `packages/hermes-headless/src/lane/` (plus three call sites in `HermesHeadless.ts`) and `src/providers/hermes/runtime/` in the app. Nothing outside those may import `lane/`.

**Reality check:** T1–T8, plus the two VPS probes.

### Stage E: Slash commands in the composer (app)

This is the first provider-neutral composer command catalog in the app. It is shaped so OpenCode (`listCommands`, already in its package) can adopt it later. That fits #394's "commands/UI rewrite is first-class scope", but only Hermes is wired in this branch.

**Produces:**
- **Shared types** (`src/shared/composerCommands/types.ts`):
  - `ComposerCommand = {name, aliases[], description, category, argumentHint?, argumentMode?: 'options'|'text'|'mixed', subcommands?: string[], source: 'provider'|'app', availability: {kind: 'offered'} | {kind: 'hidden'} | {kind: 'unavailable', reason: string}}`.
- **Main:**
  - `AgentSession.listComposerCommands?(): Promise<ComposerCommand[]>` (optional);
  - IPC `session:composer-commands(sessionId)`, implemented by `HermesSession`. It maps `commands.catalog` + Agent Code's local Hermes commands. It is cached per attach and invalidated on a reconnect with a new epoch.
- **Local Agent Code commands for Hermes:** `/restart` (Decision 6), `source: 'app'`. More can be added in the same table.
- **Availability mapping:**
  - `desktop: null` → offered;
  - `'hidden'` → runs but is not listed;
  - otherwise → `unavailable`, with the sentence "Hermes only offers /x in its terminal app." (one sentence per reason, from upstream's reason set).
  - The app refusal list from Stage B (`resume`, `model`, `handoff`, `profile`, `branch`, `yolo`, `reasoning`) is `unavailable` with Agent Code's own sentence. For example: "/model isn't supported in Agent Code yet. Change the model in Telegram or the Hermes dashboard."
- **Renderer:**
  - **`ComposerCommandPicker`** (`src/renderer/src/features/composer-commands/`): opens when the draft is `/<token>` with no space yet, on providers whose capabilities set `composerCommands: 'catalog'`. Hermes sets it; others are unchanged.
    - Keys: Up/Down, Tab completes, Enter runs, Esc closes.
    - After a space, if the command has `subcommands`, the picker shows them.
    - Fuzzy filtering is local; there is no `complete.slash` round trip per keystroke. `complete.slash` is used only when the catalog has `warning` set (discovery failed), as a fallback.
  - **`useComposerKeybinds`:** for `composerCommands: 'catalog'` providers, Up/Down/Tab/Enter/Esc go to the picker while it is open. The Claude terminal slash mode path is untouched.
- **Execution:**
  - `HermesSession.deliverPromptText` routes:
    - local app commands → their handler;
    - `unavailable` → a notice row with the reason (never sent);
    - everything else → `headless.runSlash`.
  - `/restart` handler: a confirmation dialog (renderer, before sending), then `HermesRest.restartGateway()`, then a notice "Restarting Hermes' gateway…". The gateway's `/api/status` (`gateway_running`, unauthenticated) is polled every 2 s for up to 90 s, then "Gateway is back" or "Gateway didn't come back within 90 s. Check the server."
  - **Side answers** (`side-answer` rows from Stage B): rendered in the chat as a distinct, indented card labelled "Background task" / "Side question". They are copyable, and not part of Copy Last Response.

**Verified by:**
- **renderer tests:**
  - the picker is filled from the S17 recording;
  - keyboard behaviour;
  - unavailable commands are shown with their reason;
  - `/restart` opens the confirmation and calls the IPC only on confirm;
- **app system test:**
  - S18/S19 through `HermesSession` show a side-answer row;
  - S24 restart → notices in order;
- **mutation:** route `/btw` back to `slash.exec` → the S19 test sees no side answer (red).

**Why separate:** independent UI; it depends only on Stage B's API.

**Reality check:** S17–S20, S24.

### Stage F: Tests and the live matrix

**Produces:**
- **hermes-headless:**
  - `npm run test:live -- --release v0.21.7|v0.22.0`, with the runtime chosen by `HERMES_LIVE_RUNTIME_<REL>`;
  - a `live-matrix` workflow, `workflow_dispatch` + weekly schedule, Python 3.14, that sets up both runtimes, asserts `SOURCE_COMMIT`, asserts the executed test count is above zero and fails on skip (r7 F6);
  - the suite gains Telegram-lane live cases driven by the upstream stand-in (T2, T4/T5, T6).
- **App:**
  - **`hermesFirstPane.system.test.ts` (r7 P0):** real `HermesConnectionService` + real `HermesTokenBroker` + real `HermesTokenStore` (test codec), the real `SessionManager` spawn path and real IPC handler registration (`registerHermesIpc`, `registerSessionIpc`). It runs against a live local Hermes when the runtime is present. Otherwise it replays S1/S3/S4 through an injected socket, and the file says which mode ran.
  - It asserts:
    - the first reply is rendered once in the projection;
    - close + reopen keeps the stored id;
    - a startup failure travels to the renderer sentence (the B1 matrix end to end).
- **App metadata:** `support/upstream-versions.json` → hermes `testedReleases: ['v0.21.7', 'v0.22.0']`. The Settings compatibility text separates "compatible (contract 8)" from "tested release" (r7 F3).
- **Opt-in deployment smoke** (`HERMES_DEPLOYMENT_TEST=1`, URL + token-file path; never the app's saved credentials):
  - `/api/status`, then ticket → WSS → ready → capabilities → `session.list`. Read-only: it never prompts or restarts.
  - **U3 is answered here, with the owner present.** One `POST /api/gateway/restart` on the VPS, after a yes in chat, watching `/api/status`.

**Verified by:**
- the matrix job runs green on both releases in a dispatch run linked from the PR;
- the app first-pane test fails when B1's fix is reverted.

**Why separate:** it closes r7's P0 gaps. Stages A–E are each verified on their own; F proves they compose.

**Reality check:** the real local Hermes for both releases; the deployment smoke on the VPS.

---

## 6. Design details that matter

### 6.1 Isolation

- **package, `src/lane/`:** may be imported only by `HermesHeadless.ts`. It owns tip resolution and the busy rule. **One owner per signal:**
  - the live WS stream owns *our* turns;
  - `session.history` owns *committed* rows (ours and the phone's);
  - the lane resolver owns *which stored id is current*.

  The reconciler stays the single place that merges them, by row id (its existing rewrite-aware `applyHistory`).
- **package, `src/rest/`:** the only HTTP client besides `auth/`. It never stores tokens.
- **app:**
  - `src/providers/hermes/runtime/` is the only consumer of lane state;
  - the renderer sees lane state only through `HermesSession`'s existing channels (a new `lane` field on the `process-state` activity payload) plus committed notice rows;
  - no renderer code talks REST.
- **app, `src/renderer/src/features/composer-commands/`:** provider-neutral. Hermes specifics live in `HermesSession.listComposerCommands`.

### 6.2 Why lane mode resolves the tip so often

A pane that keeps a stored id across a Telegram `/new` reopens the ended row on its next prompt (t1 F2e, `_reopen_if_finalized`). The lane then has two live rows with one `session_key`, and Telegram and the pane silently diverge.

Resolving on open, on each `sessions.changed`, on the backstop poll and **before each submit** is the only client-side guard. It is one REST call (≤ 50 rows) plus one `latest-descendant`, both cheap. Do not "optimize" the pre-submit check away; the WHY comment at the call site will say this.

### 6.3 The busy rule and its residual race

The rule (Stage D) is computed from a **fresh** `session.history` fetched just before submit, not from the last cached tail. A phone message that lands between that fetch and our `prompt.submit` still races. The window is one RTT (~100–300 ms to the VPS); outside it, the hold is correct.

The upstream fix that would close the window is `reject_active_turn_lease=True` on the submit-time write (t1 F2c). It is listed in §12 as an upstream report, not as our work.

### 6.4 What "held" means for durability

A held prompt exists only in the app; nothing is written to Hermes. It is stored like a pending prompt (draft stays in the store; PR #1183 rule), so a renderer reload keeps it. An app quit loses it, and the pane's held row says "Not sent yet" so the user knows.

A hold that waits more than 10 minutes turns into "Still waiting for Telegram. Send now?" There is no automatic forced send: the lease would wait up to 30 min anyway, and forcing reproduces T4.

### 6.5 Sign-in and REST

`HermesConnectionService.restFor(id)` builds `HermesRest` with `accessToken: () => broker.accessToken()`. The broker's single-flight refresh covers REST too.

A REST 401 → one refresh → retry → `HermesSignedOutError`. This is the same rule as the ticket mint (`tokenBroker.ts:130`). There is no second token path.

---

## 7. Tests (summary)

| Test | Fixture provenance | Fails before the fix because |
|---|---|---|
| `classifySpawnFailure.remote.test.ts` | literals of our own curated sentences (justified: they are our templates) | B1 flattens them |
| `RpcConnection.incompatible.system.test.ts` | **S25 recording (v0.20.4)** | `-32601` is a plain `RpcError` |
| `hermesSession.startFailure.system.test.ts` | S25, recorded 403 (r5 probe shape), S3 with `gateway.ready` cut (mechanical mutation, labelled) | every stage becomes the generic sentence |
| `reconcile.requestsSettled.system.test.ts` | **S22 recording** | the card stays open after `message.complete` |
| `HermesHeadless.queued.system.test.ts` | **S23** | gated on H2; documents equivalence |
| `HermesHeadless.sideTasks.system.test.ts` | **S18, S19** | `/bg` and `/btw` answers dropped |
| `HermesHeadless.compress.system.test.ts` | **S20** | routed to `slash.exec` |
| `catalog.notifications.system.test.ts` | **S21** | events ignored |
| `auth.subprotocol.test.ts` | S1 ticket + a recorded v0.22.0 upgrade | the ticket is in the URL |
| `lane/*.system.test.ts` | **T1–T8** | no lane mode |
| `copyAssistant.hermes.renderer.test.tsx` | S4, S12 (both releases) | C0 decides |
| `hermesSession.lane.system.test.ts` | T1–T8 via `FakeSocket` + recorded REST bodies | no lane mode |
| `ComposerCommandPicker.renderer.test.tsx` | **S17** | no picker |
| `hermesFirstPane.system.test.ts` | live local Hermes or S1/S3/S4 | B1 + no app-path coverage |
| live matrix | real Hermes v0.21.7 + v0.22.0 | only v0.21.7 ever ran |

Every regression test is proven by reverting its fix once and watching it fail. The result is noted in the commit body.

---

## 8. Verification (what I will run) and the boundary (what I can't)

**Will run:**
- package `npm run check` + `test:live` on both releases;
- app `npx tsc -b`, then the full vitest suite once at the end (memory: Node 24, raw `tsc -b` is the gate, don't spam runs);
- the two read-only VPS calls in Stage 0;
- the deployment smoke (read-only) once.

**Cannot verify here, and will say so in the PR:**
- **the app itself** (memory: never launch the app);
- **the real Telegram app on the owner's phone.** Lane behaviour is proven against upstream's real Telegram adapter and Bot API stand-in, not Telegram's servers;
- **`/restart` on Hostinger's s6 container** until the owner OKs one restart in Stage F (U3);
- **long-run behaviour** (a held prompt across hours; backstop-poll cost over a day).

Manual QA the owner should do after merge:
1. Open Hermes Telegram Thread and check the history matches the phone.
2. Send a phone message and watch it appear.
3. Send from the pane during a phone reply and watch "Waiting for Telegram…".
4. `/new` in Telegram, then watch the divider.
5. `/restart` from the pane.
6. Copy Assistant on the streaming reply.

---

## 9. Unknowns

| # | Unknown | Answered by |
|---|---|---|
| U1 | Does the VPS's REST `/api/sessions` return `session_key`/`chat_type`/`thread_id` to our bearer? (H1) | Stage 0 VPS probe |
| U2 | Is idle `queued: true` exactly a plain submit? (H2) | S23 |
| U3 | Does `POST /api/gateway/restart` restart the gateway inside Hostinger's s6 image, or does killing the gateway (the container's main process) stop the container, so Docker's restart policy brings everything back, the dashboard (and the pane's socket) included? | Stage F, one owner-approved restart on the VPS. Until then `/restart`'s notice says "Telegram and possibly this pane will reconnect." |
| U4 | Does the owner's bot use DM topics? (decides the auto-pick fallback) | Stage 0 VPS probe (count lanes by shape, no content) |
| U5 | Does the busy rule hold with tool-using phone turns? (H3) | T2/T4 with a tool-calling scripted model |
| U6 | What exactly failed for the owner with Copy Assistant on Hermes? | Stage C0; if C0 is all green, ask the owner |
| U7 | Do v0.21.7 servers send `sessions.changed` with the same cadence? (lane mode on older servers) | Record T2 on v0.21.7 too; if absent, lane mode needs v0.22.0 and the app says so |
| U8 | Is the 30 s backstop poll acceptable for Hermes server load with the dashboard open elsewhere? | Upstream Desktop uses the same (t1 F3); accepted unless the owner objects |

---

## 10. Out of scope

- Delivering pane prompts or replies to the phone (owner decision). This includes cherry-picking upstream PR #76796 onto the VPS, a per-reply "send to Telegram" action and holding the bot token in Agent Code.
- `/handoff` (t1 F5: it ends the live Telegram row or strands DM topics).
- `/model` and `/resume` pickers for Hermes (refused with a sentence; possible follow-up).
- Streaming phone turns token by token (no upstream bridge).
- Answering requests raised by phone turns.
- Server config changes (the `display.platforms.telegram` split, `ws_orphan_reap_grace_s`, `/sethome`). These are suggestions for the owner, not code.
- Any Tailscale code (§11).

---

## 11. Tailscale (separate track; scope decision 8)

**Why it matters (owner):** "something that all of the teams have to use … very important when it comes to the premise." Today Hermes is reachable on the public internet through Traefik + Let's Encrypt. It is protected by the dashboard login only. Port 4860 is firewalled, but the HTTPS route is public.

**Phase 1 (proposed default):**
1. Docs + a reference entry for putting the VPS Hermes on the owner's tailnet:
   - `tailscale up` on the VPS;
   - Hermes reached at `https://<host>.<tailnet>.ts.net` via `tailscale serve --https=443 http://127.0.0.1:4860`, or the MagicDNS name;
   - then the public Traefik route is removed.
2. Agent Code Settings → Hermes:
   - recognises `*.ts.net` / `100.64.0.0/10` URLs;
   - when a connection times out on one, says "This looks like a Tailscale address. Is Tailscale connected on this Mac?" (`describeError` already names a VPN for ETIMEDOUT; this makes it specific).
3. **No Agent Code-managed VPN.** Agent Code relies on the system Tailscale client.

**Phase 2 (only if the owner wants it for teams):**
- Agent Code detects the local Tailscale status (`tailscale status --json` or the LocalAPI socket) and shows tailnet peers that run Hermes;
- possibly per-team ACL guidance.

This would get its own issue + plan.

**Not in this branch.** An issue is filed when the owner confirms decision 8.

---

## 12. Upstream reports to consider (not filed without the owner)

- `prompt.submit`'s submit-time user row should respect the durable turn lease (`reject_active_turn_lease=True`), to close the T4 duplicated-context race (t1 F2c, t2 E). The T4 recording is a ready reproduction.
- `resolve_response` should notify other attached clients when a request is answered (r4 F4).
- A comment on #99127 asking that pane-originated user messages also be delivered (t1 open question 6). This is the owner's call.

---

## 13. Stage results and execution notes

*(Filled in during execution: Stage 0 results with numbers, hypothesis verdicts H1–H6 as HOLDS / REFINED / DISPROVEN with evidence paths, a graveyard for disproven ideas, rulings, and deviations from this plan, each recorded in the same commit as the change.)*

### Ledger (the goal loop reads and updates this every pass)

**States:** todo / doing / done / blocked. GitHub wins over this file if they disagree.

| # | Item | State | Notes |
|---|---|---|---|
| L0 | Stage 0 recordings: v0.22.0 S1–S16, S17–S25, T1–T8, H1–H6 verdicts | doing | Background agent, brief `temp/hermes-build/stage0-brief.md`, report `temp/hermes-build/stage0/REPORT.md`. Review it line by line and commit its research/ + src/testing/ paths. |
| L1 | Package: `errors.ts` (HermesStartError, HermesIncompatibleBackendError); `RpcConnection.open` closes on handshake failure | doing | Code written; tests still owed (S25 once it is recorded). |
| L2 | Package: close cards at turn end; handle notification / review / subagent / tool-risk / connection / bg+btw answers; catalog moved | doing | Reconciler written. HermesHeadless must still emit `notice` / `notice-cleared` / `side-answer`. |
| L3 | Package: ticket as a subprotocol (`buildWsUrl(base)` + `wsTicketProtocols`) | doing | Package side done. App `openWs` must pass protocols and check `socket.protocol`. |
| L4 | Package: slash routes (`slash/routes.ts`) wired into `runSlash`; `commandCatalog()`; `SlashOutcome` side-task / refused | todo | |
| L5 | Package: `HermesRest` (done); lane (`lanes.ts` and `laneBusy.ts` done); lane mode in HermesHeadless (tip resolution, `sessions.changed`, backstop, holds); always `queued:true` (gated on H2); `turn-lost` on an epoch change | todo | |
| L6 | Package tests on the recordings (S17–S25, T1–T8), plus the existing tests updated for HermesStartError wrapping; `npm run check` green; live tests run on v0.21.7 + v0.22.0 | todo | |
| L7 | App Stage A: `RemoteStartFailure` stages, curated sentences, `classifySpawnFailure` fix (#1495), journal stage, `openWs` 401/403 wording, turn-lost notice, sudo/secret countdown | doing | 6473dabd4: everything except the countdown and the S25-backed system test. Proven fail-first: reverting the classify branch turns the new session.test case red. |
| L8 | App Stage C: Copy Assistant on Hermes (C0 reproduction first) | todo | |
| L9 | App Stage D: lane mode (spawn option `hermesLane`, commands, `hermes:lanes` IPC, chip / notice / divider / busy line, held prompts as a non-blocking condition, `/new` refusal) | todo | |
| L10 | App Stage E: composer command catalog + picker; `/restart` with confirmation and status polling; side-answer cards | todo | |
| L11 | Tailscale phase 1 (`tailnet.ts`, `describeError`, Settings tag + help, memory register steps) | doing | 24c362f43 code + tests; the memory register steps are still owed. |
| L12 | App tests (startup matrix, first pane, lane, picker, copy); `npx tsc -b`; full vitest once | todo | |
| L13 | Live matrix workflow in the package; `support/upstream-versions.json` tested releases | todo | |
| L14 | Read-only VPS probe (U1/U4); record the verdicts | todo | Two GETs, bearer from the app's token store, never printed. |
| L16 | Bug: the Hermes composer is very slow to type in (owner, 2026-10-14), #1499 | done | Cause: HermesChatFeed was not memoized and every bubble ran react-markdown inline, so each keystroke re-parsed every assistant message. Fail-first: 300 parses for 5 keystrokes on S12, now 0. Fix: memo + TextProse + memoized tool input. |
| L17 | Bundle bug: a reload during a turn silences the running turn. Rewrite detection fires on a resume-vs-history window mismatch, then the renderer reset gate drops every event until the next `turn_started`. | todo | Fix: detect a rewrite only inside the overlapping id range; after a reset with an open turn, re-send its turn_started and blocks. Evidence: bundle 2026-10-14T16-26-49 feed-debug #117 + proxy-semantic currentTurn null. |
| L18 | Bundle bug: every Hermes send froze the window 2–5.7 s (perf monitor 1s.jsonl, 16:15–16:26) | done | de879dcb4 lazy bodies; e999fd25b hidden Spotlight copy inert + row reuse. Windowing (LazyEntry) is not done; revisit only if still slow. | DOM 3,917 elements: tool inputs (181 KB) and reasoning (213 KB) stay mounted in closed <details>. Render bodies only when open; window long chats; L16 memo already landed. Also slowness in spotlight (agent investigating). |
| L19 | Bundle bug: Hermes' progress commentary lands in collapsed "Reasoning" (rows 402/410/423); reasoning shows raw `**` | done | e999fd25b: prose after the summary headings is shown; reasoning renders as markdown. | Show the latest commentary line in the typing row / as visible text; render reasoning as markdown. |
| L20 | Bundle bug: a dropped connection left pane d9567053 dead 10m42s until a manual reload | todo | Re-attach detached panes after a new sign-in; timeout on the ticket fetch; journal Hermes connect / reconnect / detach transitions. |
| L21 | Bundle bug: tool outputs vanish after a reload (187/206 chips "kept on server") | todo | Keep the live tool results observed per conversation in main across pane reloads (not on disk); format the JSON output. |
| L22 | Bundle bug: a prompt sent during a turn shows no queued state (`queued` status dropped in deliverPromptText) | todo | Show "Queued: Hermes answers after the current task". |
| L15 | Plan vs built walk-through; package PR, then the app PR (submodule bump + lockfile resync); one review round (2 Claude + 2 Codex reviewers); fix the findings; CI green | todo | Never merge without the owner. |

### Progress log

- 2026-10-14: performance in Spotlight and when sending fixed (de879dcb4, e999fd25b); L18/L19 done.
- 2026-10-14: the owner's debug bundle analysed: 7 real defects → L17–L22. Tailscale phase 1 landed (24c362f43).
- 2026-10-14: L7 mostly done (6473dabd4). Investigations running: the owner's debug bundle ("Hermes has a lot of issues") and slowness in spotlight.
- 2026-10-14: L16 fixed (#1499). Package b6c610e pushed: lane mode, slash routes, typed errors, events (tests pending Stage 0).
- 2026-10-14: plan + Tailscale plan committed; issues #1495–#1498 opened; Stage 0 agent started; L1/L2/L3 package code written, plus `HermesRest`, `lanes.ts` and `laneBusy.ts`.

### Rulings

- **R1: all §2 decisions default, UNCONFIRMED.** The owner asked to build without answering them. Each default is restated in the PR body under "UNCONFIRMED product calls". The cost if wrong is a small UI change per decision; none of them changes the data model.
- **R3: lane tip candidates include compression-ended rows.** `order=recent` may list a compressed lineage's ROOT, which compression ended. `pickLaneRow` therefore accepts rows that are not ended or that ended with `compression`, and `latest-descendant` walks to the tip. Every other end reason means the lane moved. T6/T7 verify this.
- **R4: cards close at turn end only, not on the next stream frame.** A spinner frame can arrive while a clarify is open, so closing on "any later frame" (the plan's optional variant) could close a live card.
- **R2: Tailscale phase 1 ships in this PR.** "Build out the full thing" covers it, and phase 1 is small and Hermes-scoped (URL recognition, connection hint, setup docs). Phase 2 (local Tailscale detection, team rollout) stays a follow-up issue. Plan: `docs/plans/2026-10-14-tailscale-hermes-phase1.md`. The cost if wrong is one reverted commit.
