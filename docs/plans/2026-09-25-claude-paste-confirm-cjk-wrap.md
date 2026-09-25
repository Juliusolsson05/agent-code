# Claude paste confirmation joins CJK hard wraps (#1292)

## Evidence
- `activeClaudeComposerText` decides a wrap was a mid-token hard cut when `previous.length >= width - 1`. That is a UTF-16 length compared with a width in cells.
- A real `@xterm/headless` row of `❯ ` plus 9 CJK characters is 20 cells but 11 characters long, so every CJK wrap reads as soft and is joined with a space. The 24-character tail needle then misses, absorption times out after 5 s, and the delivery rolls back.
- Reproduced with the existing width sweep (Ink's own `wrap-ansi` wrapping, the recorded composer chrome): a CJK prompt is missed at 85 of 121 widths, 20–140.
- With an odd free width, a wide character can't use the last cell, so a full CJK row can be one cell short.

## Change
- A local display-width helper: East Asian wide/fullwidth and emoji count 2 cells, combining marks count 0. No new dependency; `string-width` is only transitive.
- The rule becomes: the break was a hard cut if the continuation's first character would not have fit on the previous line. For Latin text this is exactly the old rule (width − 1).

## Tests
Width sweeps for a CJK prompt and a mixed CJK + path prompt, both red on main. The existing Latin sweeps and the refusal tests stay green.
