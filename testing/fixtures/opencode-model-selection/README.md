# OpenCode model selection fixtures (B18)

Recorded on the owner's machine on 2026-09-19 with OpenCode 1.18.30. They drive the provider-switch target model tests in `src/main/providerSwitch/transcriptEngine.test.ts`.

| File | Source |
|---|---|
| `model.json` | `~/.local/state/opencode/model.json`, verbatim. OpenCode's own record of recently used models (`recent`, newest first), favourites and per-model variants. It contains model ids only; nothing identifying. |
| `opencode-models.txt` | The stdout of `opencode models`, verbatim: the models this install offers, in catalog order. Its first line (`opencode/big-pickle`) is the model the old fallback pinned. |

Do not edit these files to fit a test. Re-record both from the same machine at the same time, because the recents are only meaningful against the catalog they were recorded with.
