# Choose the desktop dictation microphone

Issue: #902

Status: Implemented; PR review and CI pending.

## Outcome

Settings → Dictation offers Audio Input Device with the existing automatic
built-in preference, system default, and actual connected microphones. The
preference survives restart and controls the next composer or terminal dictation
recording, including keyboard and mouse triggers.

## Implementation

1. Persist an optional device ID and display label as one setting. Missing/invalid
   values keep automatic selection; a disconnected explicit choice remains saved.
2. Extract the existing audio-selection policy into the voice-dictation feature.
   Explicit devices use exact constraints; system default bypasses built-in
   preference. Preserve local device diagnostics and explain unavailable or
   denied microphones in actionable language.
3. Add an accessible settings selector with current device enumeration, refresh,
   hotplug updates, and an explicit permission action when names are hidden.
   Temporary permission streams must stop even if the settings row unmounts.
4. Read the latest setting at recording start, leaving an in-flight recording
   untouched. Use the same selection policy for microphone prewarming.
5. Cover saved settings, device selection, hotplug/permission UI, and the actual
   shared recording hook. Keep package APIs and phone microphone capture outside
   scope; this preference belongs to the desktop host.

## Verification

Run focused deterministic tests, type checking, the complete deterministic
repository check, and review the final diff. Open a linked PR and inspect CI.
Hardware verification requires a real headset/closed-lid session and must not be
claimed from mocked browser-media tests.

## Verification results

- 74 tests passed across the focused settings/recorder suites and the separately
  retried Claude prompt-acceptance suite; type checking passed.
- Application build and required-entry-point verification passed.
- The full deterministic run passed 3,274 tests but hit the existing image
  provenance dependency on rotated personal history (#901) and a transient
  Electron installation race. The latter suite passed after installation
  completed; no unrelated production or fixture code was changed.
- Visually inspected the actual settings row in an isolated Chrome preview with
  a mocked device inventory and changed the selection from USB Headset to
  AirPods Pro. This verifies UI behavior, not physical microphone capture.
- Review added immediate permission-stream release on unmount and protection
  against stale device enumeration erasing a permission error, with coverage.
