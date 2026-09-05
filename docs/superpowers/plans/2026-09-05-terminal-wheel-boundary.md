# Terminal wheel boundary — #791

The real Chromium wheel probe reproduces vertical wheel input escaping a nested
terminal at its scrollback boundary. Keep xterm's normal wheel handling first;
only prevent the browser's ancestor-scroll default when vertical wheel input
reaches the terminal host unconsumed. Preserve modifier and horizontal gestures.

1. Add a disposable, bubble-phase boundary helper to all three xterm hosts.
2. Cover ordinary scrollback ownership, boundary cancellation, modifier/horizontal
   escape, and cleanup without scheduling React, repaint, or PTY work.
3. Verify with real Chromium wheel input, including alternate-screen and mouse
   reporting. Re-run affected host tests and type-checking.
4. Review and open a separate PR; no merge without final user confirmation.

This is separate from #789's atlas repair. It does not claim to reproduce every
reported scrolling problem or change providers' alternate-screen behavior.
