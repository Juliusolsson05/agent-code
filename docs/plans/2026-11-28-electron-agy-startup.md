# Restore Electron startup for the Antigravity release

## Evidence

The unpublished 0.1.11 candidate stalled at the packaged smoke step.
Starting the compiled main process under native Electron reported a missing
Terminal export from the CommonJS package @xterm/headless before app readiness.
The existing file-presence check passed on that binary.

## Changes

1. Import the CommonJS default value in the Antigravity terminal composer.
2. Start the compiled main bundle under Electron during package verification
   and fail within a bounded interval when startup fails.
3. Recheck draft-preservation behavior and the native smoke on the fixed build.
4. Run the normal signed release workflow and verify the published feed.
