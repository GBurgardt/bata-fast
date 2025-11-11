# console ux plan

## guiding principles
- whisper, don't shout: only surface information that helps the person decide or feel progress. everything else stays in debug mode.
- single line intents: every moment in the flow should answer exactly one question ("what should i do?", "is it working?", "where is my file?").
- lowercase, calm tone: short verbs, no punctuation noise, no ids, no brackets.
- temporal rhythm: micro-pauses (spinners / breathing lines) should feel intentional. nothing should flicker or scroll off.

## tooling choices
- **enquirer** for prompts. it already supports input and list selections with minimal chrome and is easy to theme down to lowercase prompts.
- **nanospinner** for ambient progress messages. it's subtle, frame-based, and easy to pause/resume when longer steps happen.
- **log-update** to keep status areas tidy (e.g., rewriting the same line while yt-dlp runs).
- **colorette** instead of full chalk gradients to keep color accents quiet (muted cyan/gray/white palette).
- **wrap-ansi** to ensure lines stay inside 80 cols regardless of terminal size.
- optional future layer: ink/blessed for layouts. for now enquirer + controlled output gives enough craft without pulling in react runtime.

## typography + ergonomics
- recommend monos with generous counters (ibm plex mono, jetbrains mono, sf mono, recursion) and disable bold smoothing if possible.
- keep maximum line length 68–72 chars so prompts never wrap awkwardly.
- prefer single blank lines between sections; never stack multiple newlines.

## flow blueprint
1. **greeting**  
   - show a single line: `what do you feel like hearing?`  
   - hint below in faint gray: `type an artist, song, or mood`.
2. **results**  
   - after youtube search completes, render up to five options as:  
     `1 • charly garcía — los dinosaurios · 4m18s`  
   - user selects by number via enquirer select; no video ids, no urls.
3. **download**  
   - once a choice is made, freeze the list, then show spinner line:  
     `finding the cleanest source…` → `pulling audio…`  
   - while yt-dlp runs, capture stdout silently; display only friendly states via log-update (e.g., `grabbing audio (42%)` by parsing progress when available; fall back to ellipsis animation).
4. **processing**  
   - after audio saved: `sending to the studio…` spinner while uploading + job creation.  
   - poll job quietly; update status line at most every 2–3 seconds (`ai is separating drums…`).
5. **results + playback**  
   - when stems arrive: `ready. ${n} drum takes found.`  
   - if >1 stem, prompt: `want to blend them into one take? (y/n)` with default `y`.  
   - playback prompt: `press enter to listen, ctrl+c to stop anytime.`
6. **completion**  
   - final line: `done. saved to downloads/${slug}.`  
   - optional follow-up: `open the folder now? (y/n)`; only show path if they choose yes or request details.

## copy deck (all lowercase)
- searching states: `looking for it…`, `found a few takes.`
- download states: `pulling audio…`, `tidying the file…`
- processing states: `sending to the studio…`, `ai is isolating drums…`, `wrapping up…`
- success: `ready. saved to downloads/<file>.`
- errors (examples):  
  - network: `couldn't reach youtube. check your connection and try again.`  
  - moises job: `the studio couldn't finish that take. try another source.`  
  - ffmpeg missing: `need ffmpeg installed to combine stems.`

## debug philosophy
- `--debug` surfaces a collapsible section per major step with timestamps, uuid, raw command lines, and unfiltered stdout/stderr.
- default mode only exposes debug copy when explicitly requested (e.g., pressing `d` during a step could reveal details later).

## next steps
1. wire enquirer/nanospinner/log-update scaffold.  
2. wrap current youtube/downloader/moises functions inside the new experience shell.  
3. iterate on timings + copy while running the real workflow.
