# Claude paste confirmation joins CJK hard wraps (#1292)

## Evidence
- `activeClaudeComposerText` decides a wrap was a mid-token hard cut when `previous.length >= width - 1`. That is a UTF-16 length compared with a width in cells.
- A real `@xterm/headless` row of `❯ ` plus 9 CJK characters is 20 cells but 11 characters long, so every CJK wrap reads as soft and is joined with a space. The 24-character tail needle then misses, absorption times out after 5 s, and the delivery rolls back.
- Reproduced with the existing width sweep (Ink's own `wrap-ansi` wrapping, the recorded composer chrome): a CJK prompt is missed at 85 of 121 widths, 20–140.
- With an odd free width, a wide character can't use the last cell, so a full CJK row can be one cell short.

## Change
- A local display-width helper, per grapheme cluster:
  - 2 cells: East Asian wide/fullwidth, and emoji with default emoji presentation or VS16;
  - 0 cells: combining marks and zero-width format characters;
  - 1 cell otherwise.
  Every doubt counts NARROW, because an overcount can confirm early and an undercount only times out. No new dependency; `string-width` is only transitive.
- **Superseded after review (steering q34):** the first draft cut when "the continuation's first character would not have fit". Only a FULL row (width − 1 cells) is a hard cut now. A row one cell short is ambiguous, because xterm drops trailing spaces, so it keeps its space. Odd-body-width CJK rows therefore still time out; that is the #1292 residual.

## Tests
Width sweeps for a CJK prompt and a mixed CJK + path prompt, both red on main. The existing Latin sweeps and the refusal tests stay green.
