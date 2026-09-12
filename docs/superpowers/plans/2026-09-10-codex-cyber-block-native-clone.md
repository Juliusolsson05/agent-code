# Codex cyber-block native clone

**Goal:** Remove Cybersecurity Block must write a new Codex rollout that is a sliced copy of the source bytes, not a native-resume reconstruction. The reconstruction is what made session `7ef23509` unusable.

**Bug:** #869. Evidence: source `01a08846-936d-7dd3-a91b-0f933d0d9f29` had 30 `response_item.agent_message` records and array-shaped tool outputs; the fork dropped all of them because `projectNativeResume` drops opaques and re-encodes tool results as JSON strings.

**Fix:** After computing the last-model-step cut on the decoded conversation, copy raw JSONL records with `index < cutLine`, rewrite `session_meta.id`, and append a clean `task_complete` only if the prefix does not already end on one. Do not call `projectNativeResume` on this path.

**Tests:** A committed real-shaped JSONL fixture (redacted from the observed rollout) must keep `agent_message`, `inter_agent_communication_metadata`, and array tool outputs, and must drop the last tool cycle plus `cyber_policy`.

**Out of scope:** Changing rewind/duplicate. They have the same projector loss; that is a separate issue.
