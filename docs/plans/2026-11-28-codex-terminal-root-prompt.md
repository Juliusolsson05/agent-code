# Deliver to an empty native Codex pane at narrow widths

## Reproduction and source

The same installed 0.172.0 PTY at 40 columns refuses delivery before writing.
An empty 120-column pane accepts one transport write. Both refuse a typed draft.
The app uses the same provider delivery code for both display modes. Terminal
view fits the PTY to the tile. In the verified narrow footer the CLI retains
its agents shortcut and omits its shortcuts label.

## Changes and checks

1. Protect the observed empty and drafted footer shapes at the parser boundary.
2. Update the pinned parser with only the verified dedicated-footer rule.
3. Exercise normal provider delivery with a disposable native CLI and local-only
   model endpoint. Check writes, readback and draft preservation.
4. Keep caller, transport, modal and settled-frame guards intact.
