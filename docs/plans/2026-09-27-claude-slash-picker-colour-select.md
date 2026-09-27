# Claude slash picker: a colour-only selection change republishes the picker (#1253)

## Problem
`detectSlashPicker` reads the selected row from relative foreground colour. `HeadlessTerminal.scheduleFlush` gates emission on the `plain` + `recent` TEXT only, so arrowing through the picker, which changes only the highlight colour, emits no `screen` frame. `ClaudeCodeHeadless` never reparses the picker, and `claude.slash-picker` keeps the old selected row until the text changes. This predates #1236. Also, nothing pins the producer: replacing `slashPicker: this.pickerState` with an empty picker survived every picker suite.

## Constraint (why the gate is text-only)
Serialising cell attributes on every flush is the 60 Hz snapshot churn that once pinned main at ~80% CPU (agent-code#390; the gate's own comment). The fix must not make the common frame attribute-aware.

## Decisions (defaults)
- **Only while a picker is visible** (the last parsed state had one), the gate also compares a picker-selection signature: which picker row carries the selected colour, read from the live grid for the picker's rows only (a handful of cells). With no picker, the hot path is unchanged.
- **Evidence first:** record a real Claude picker PTY sequence into `packages/claude-code-headless/testing/fixtures/`:
  1. open with `/`;
  2. filter;
  3. arrow down twice (colour-only changes);
  4. Esc.

  Drive the `claude` CLI directly in a PTY, not the Agent Code app. No model call is made, but decode and redact the whole fixture before committing it.
- **Tests:** a real-frame test on the recording asserts the `conditions` snapshots through open → filtered → selection moved (colour only) → closed. The producer is pinned, so an empty picker in the evaluator input fails.

## Out of scope
Attribute-aware gating for anything else. The composer styling-flip case stays covered by the prompt gate's bounded staleness.
