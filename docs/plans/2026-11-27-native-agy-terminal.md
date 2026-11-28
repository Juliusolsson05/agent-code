# Antigravity native terminal

## Outcome and evidence

An Antigravity pane in Terminal mode should accept keyboard input in the installed agy terminal interface. In 0.1.9 the provider is marked structured-only and its only registered session starts agy acp on pipes. The installed CLI offers an interactive session and supports resuming a conversation by ID.

## Change and verification

Select a PTY-backed interactive agy session for Terminal and keep the existing ACP session for the rendered view. Carry the pane's selected runtime through creation, restoration and switching. Exercise input, resize, exit, runtime selection and the rendered path with focused tests. Smoke-test the installed CLI without submitting a model request. Releasing a new signed build is separate.
