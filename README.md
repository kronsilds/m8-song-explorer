# M8 Song Explorer

A yam8d external app (or a standalone page) that reads a whole M8 song through the SDK (song → chains → phrases →
instruments → tables) and shows it as a 3D tracker:

- **Front**: the eight tracks side by side, every step of the song from top to bottom (note and
  instrument), with the chain and phrase numbers as a tree in each track's gutter. Song rows are
  aligned across tracks, the way they start together on the device.
- **Turn the view** (drag, or key `2`): the focused track opens a wall hinged on its right edge.
  First the rest of each step (velocity, instrument, FX1–FX3) row for row, then the panels of the
  instruments and tables the track uses, linked to the steps that use them (`I` column, `INS`,
  `TBL`, `TBX`).
- **Instrument and table panels** are sticky: a panel stays on screen (held near the top of the
  view) while the rows that use it are on screen, and leaves when they scroll away. A track has
  one panel per instrument (`I` column, `INS`) and per table (`TBL`, `TBX`) it uses; links are
  drawn from the places on screen that point at a panel on screen, the selected place's links
  thick.
- **Instrument face**: an instrument's panel turns over (around its left edge, so its links stay
  put) to show the instrument itself: the Instrument view's rows where the device puts them, a bar
  after each level (PAN and DETUNE from the middle, FM operator levels as a meter under them), and
  on its right four modulator cards placed as on the Inst. Mods view (MOD1 / MOD2, MOD3 / MOD4),
  each with its type, the shape of its envelope, LFO or tracking range in the slot's colour, its
  destination and its values. The face is as tall as a table and spans two panel columns. A
  parameter a modulator drives (its DEST) gets a mark in that colour under its bar. The
  panel turns out of the wall to face the front, and its table crossfades into the instrument
  face, by itself while the M8 shows that instrument (Instrument or Inst. Mods view), and
  back when it leaves; the `INST ›` / `‹ TABLE` tab above the panel, or key `I`, turns it by
  hand. Every value is a cell: the Selection panel explains it as the SDK reads it on the device,
  with what modulates it, or the whole modulator for a modulator value. With Auto select the M8
  cursor's value is selected as it moves.
- **Table cells** in the Selection panel also say how the table plays (`src/model/music/tableWalk.ts`):
  its speed (the `TIC` the song starts it at most often, in rows per step and in ms at the
  project tempo), what starts it (notes, `TBX` steps, which tracks), where the selected cell's
  column goes after the note (`loops rows 0–3, 4 ticks, 83 ms per pass`, or `plays rows 0–F once
  and stops on row F`), a `Not played` line when that column never reaches the row, and the
  chord its N column spells (`0 +3 +7 +12 st: minor chord`) with the notes it makes from the
  first note that starts it (only on a scale that lets every note through, since the N column
  may count scale steps on other scales). It follows the table playback rules below.
- **Many instruments at once**: panels that would overlap tile into extra columns deeper along the
  wall (up to four, the wall grows only for tracks that need them) and then stack downward. A
  panel's column says how far away it is used: on screen or close in the first column, further
  uses deeper along the wall, and panels used far away show only their title lines while there is
  room. A panel keeps its column while you scroll (a margin stops it changing band at every
  phrase of a fast song), so the grid does not reshuffle; zooming far enough lays it out afresh.
  When room runs short, panels used far from the view fold to their title lines first; the
  selected panel, the ones linked from the selected step and the one under the M8 cursor never
  fold. A table card opens and folds with an eased height, and the panels below it move with it.
- **Trim tables** (Options panel, on by default): a table shows its rows down to the last one with
  a transpose, volume or FX command (down to the selected or M8 cursor row), and an empty table
  only its title lines. Off shows all 16 rows.
- **Moving the selection** with the arrows onto a velocity / instrument / FX cell or a table turns the view and
  opens the wall; back on a note it turns back (the same rule as Follow M8).
- **Camera**: Turn and Side centre the open track's column and wall (the panel columns in use)
  and stand back as far as they need, within readable distances: the same framing for every
  track. Front centres on all the tracks and slides only as far as it takes to show the open
  one; Follow M8 and the arrows do the same when the cell leaves the screen, landing the cell just
  under the track headers (which stay clear of the top bar, even when it wraps onto more rows in
  a narrow window). A drag that turns
  the view opens the track it starts on and turns around it, bringing it to the middle. Panning
  moves parallel to the tracks, so the zoom never changes. Turned, each track has its stretch of
  the pan, from where it is centred to halfway to its neighbours (longer when part of its wall is
  off screen); panning out of it opens the neighbour, the same either way. Ctrl+wheel zooms toward
  the pointer.
- **Chain transpose and scales**: a phrase a chain row transposes shows the transpose under its
  number in the tree (`+5`, `-12`), and its notes as played in the transpose colour: the written
  note moved by the chain and project TRANSPOSE, then brought up into the track's scale (the M8
  does so for written notes too: a note the scale does not let through shows in its own colour,
  not the transpose colour, when only the scale moved it). **Played notes** (`T`) switches back
  to the notes as written. Instruments with `TRANSP.` OFF keep their
  notes. The track's scale is the project SCALE (with its Scale view KEY) until an `SCA` on the
  track or an `SCG` on any track changes it (`SCA XY`: key X, scale Y). The Selection panel shows
  the track scale, what a note plays (`D-4 (F-4 -2, scale +1) · 4th of A MINOR`) and its scale
  detune; a written note only the scale moved (no transpose) is titled `Note E-4 → F-4 (scale)` and
  gets a `Quantized` line saying it is not in the scale; when the scale lets every note through it guesses the key the phrase's notes fit
  (`fits C major`) instead.
- **Semantics**: clicking any cell shows what it means (the panel is a tab on the right edge:
  hover to open it, click the tab or Pin to keep it open). The cell is drawn on a screen the way the M8
  draws it and the SDK reads it as if the device cursor were on it, so FX values, REP lanes,
  relative commands and ARP intervals are explained as on the device.
- **Device theme**: colours come from the M8. The background, title and cursor colours are read from
  any screen; *Read theme* opens System Settings › Theme and takes the 13 exact colours; the colour
  of each column is learnt from the screens read while exploring.
- **Space** plays / stops the M8 from the explorer (Shift+Space continues from the cursor).
- **MIDI sync check**: after an exploration (or with key **M**) the explorer opens Project ›
  MIDI SETTINGS and reads SYNC OUT. When it is not CLK+TRANSP+SPP it asks whether to set it
  (Edit held + Right on the value, checked after each step). The change stays in the loaded
  song until you save it on the M8.
- **Sticky track headers**: the track title, its instrument and the column names stay at the top
  of the view while the song scrolls under them (on the wall too, on one line with the front).
- **Mute / solo** buttons (`M` `S`) in each track header hold the M8's MIDI notes through Web
  MIDI to its USB MIDI port: a held note mutes or solos, its release ends it. Notes 12-19 mute
  tracks 1-8, 20-27 solo them, on CC MAP CHAN (picked in *CC MAP CH*, 11 by default as on the
  M8). The M8 does not report mutes back, so the buttons show the notes held from here; leaving
  the page releases them. In yam8d the External Apps iframe allows `midi`.
- **Another song loaded**: when the M8 shows another song than the one explored (another name on
  the Project view, or many different cells on the Song view), live updates, device markers and
  playheads pause until you explore it (or go back to the explored song).
- **Follow M8** highlights (and follows) every place of the song the M8 cursor is on, and edits made
  on the device are folded back into the view (the song, chains, phrases, tables, instruments and modulators, grooves, scales and the Project view's TRANSPOSE, GROOVE and SCALE). **Show on M8** (`Enter`) walks the device to the
  selected cell. The place followed is in the song cell the M8 came from: on a Phrase view, the
  repeat its `<` marks when the phrase plays more than once in the chain (Option+Up/Down moves
  along). It moves along with Option+Left/Right on a Chain or Phrase view (the same song row on
  the other track) and Option+Up/Down on a Chain view (the track's next chain in the song).
  The cursor is read 30 ms after the M8 stops drawing, and at least every 100 ms while it keeps
  drawing (a held key, notes on the cursor row while the song plays). Edits are folded in only
  once the screen has been quiet for 140 ms, so a half-drawn screen never reaches the saved song
  (`src/app/syncScheduler.ts`).
- **Auto select** (`A`) makes the selection follow the M8 cursor, so the Selection panel explains
  what the cursor is on. Reaching the velocity / instrument / FX columns of a phrase, a table or an instrument
  turns the view to the wall; back on a note, chain or song cell it turns back (also while the
  song plays). A click wins until the M8 cursor moves again.

## Keys and buttons

| Key | Button | Does |
|---|---|---|
| `0`, Home | All | Whole song, all tracks |
| `1` | Front | Tracker view |
| `2` | Turn | Turn to see FX and tables |
| `3` | Side | Face the open wall square |
| `E` | Open all | Open the walls of every track |
| `X` | Dramatic | Skewed, tilted camera angles for front, turn, side and the turns toward a wall |
| `T` | Played notes | Notes show what they play (transpose colour; scale colour when only the scale moved them) |
| `I` | `INST ›` tab | Turn the selected instrument panel over (table / instrument) |
| | Trim tables | Tables show only rows with content (Options panel) |
| `A` | Auto select | Selection follows the M8 cursor |
| `M` | | MIDI sync check |
| `P` | | Jump to where the song plays (the playhead furthest down) |
| Arrows | | Move the selection; the view scrolls about 4/5 of a page when the cursor leaves it |
| Shift + Up / Down | | Move a whole phrase (same step in the previous / next phrase of the track) |
| Shift + Left / Right | | Same cell (row and column) in the previous / next track |
| PageUp / PageDown | | Scroll 16 rows |
| `F` | | Bring the selection into view |
| `+` / `-` | | Zoom |
| `Enter` | Show on M8 | Walk the device to the selected cell |
| `Esc` | | Clear the selection |
| Space / Shift+Space | | Play / stop the M8, continue from the cursor |
| `?` | ? | Keys and mouse; double click saves the debug log |
| `D` | | Print what the SDK reads on the M8 (screen, colours) to the console |
| | Explore song, Read theme, Follow M8, Connect M8 | See above |
| | Export / Import | Save the explored song as JSON, or load one (Options panel) |
| | Demo | Show the demo song (Options panel) |

The settings used less often (Dramatic, Played notes, Trim tables, Read theme, CC MAP CH, song
file) are in the OPTIONS panel, a tab on the left edge: hover to open it, click the tab to keep
it open.

## Run it

```bash
bun install          # installs the published @yam8d/m8-sdk from npm
bun run dev          # http://localhost:5176/
```

To try unpublished SDK changes from yam8d, set the dependency to `file:../yam8d/packages/m8-sdk`,
run `bun run build:sdk` in yam8d, then `bun install` here.

In yam8d, add `http://localhost:5176/` under External Apps. Opened on its own the page shows the
last explored song (or a demo song) and runs the SDK in standalone mode: **Connect M8** connects
to the device from the page (Web Serial, WebUSB or Web MIDI) and plays its USB audio. Only one
page can hold the M8, so disconnect it in yam8d first. A device the page was granted before is
reopened at start. Standalone mode has been tried on the device and works.

`bun run test` runs the explorer against a fake M8 (`tests/fakeM8.ts`) and tests the semantics,
transpose and scales (`harmony`), the layout, playback, the MIDI sync check, the other-song
check and the debug log; `bun run typecheck` and `bun run build` check the rest. `bun run lint`
runs Biome; `bun run format` runs Biome (lint fixes, imports), then `scripts/alignObjects.ts`.
Do not format the code with another formatter: the object layout (one property per line, colons
aligned on the longest key, no trailing comma) is applied by that script, and Biome's own
formatter is off because it would undo it.

## Code layout

Layers, each importing only from the ones above it: `src/model/` (plain data and pure
functions: the song, timeline, columns, screens, selection, harmony, grooves, debug log) →
`src/m8/` (the device: `port.ts`, `driver.ts`, `screen/`, `tasks/`, `playback.ts`,
`semantics.ts`, `midiControl.ts`) → `src/scene/` (three.js: `layout.ts`, `world.ts`, `track/`,
`input/`, `markers/`, `camera/`) and `src/ui/` (DOM: `hud.ts`, song and debug files) →
`src/app/` (`ExplorerApp` and its helpers) → `src/main.ts`.

## How the exploration moves

Only arrows, Shift+arrows and Option+arrows are sent, never Edit or Play (Option+Left/Right is not
used on the Song view, where it solos tracks):

1. Song view, Option+Up to row 00, then Option+Down page by page (all 256 rows).
2. Each chain from its first song cell: Shift+Right; each phrase the chain plays (up to its first
   empty row) from its chain row with Shift+Right, or Option+Down from the phrase above it while
   the device agrees; Shift+Left back.
3. Instrument view, Option+Left/Right (±1) and Option+Up/Down (±16) to each instrument used, read
   the whole view, Shift+Right to its table and back, Shift+Up to its Inst. Mods view and back
   (Shift+Down returns to the view the Mods view was entered from).
4. Table view for the tables only reached through TBL/TBX.
5. Scale view (the Project view's SCALE first, read along with TRANSPOSE and the key at the
   start) and Option+Left/Right to each scale `SCA` / `SCG` point at: the 12 intervals (EN,
   OFFSET), KEY and NAME.
6. Groove view (the Project view's GROOVE first) and Option+Left/Right to each groove `GRV` /
   `GGR` point at: the ticks of each row and the PPQ.

A view counts as drawn when two reads in a row match (the `>` play markers aside). A view that does
not get there ends the item with a warning that says whether it never passed the fully-drawn check
or kept changing, and the run's log holds the screen at that moment. An instrument of type NONE has
no modulators and its Inst. Mods view is an empty page, so the exploration does not open it.
(Exploring a playing song first showed this as a timeout on a NONE instrument; the dots the M8
draws under the bars of the Mods view while playing are rectangles and never reach the screen text.)

When it is done (not when cancelled) and after the MIDI sync check, the M8 is left on the Song view with
the cursor on the first cell (row 00, track 1), so Play starts from the top.

*Read theme* is the only action that presses Edit: on SYSTEM SETTINGS (Project row 20) and EDIT
THEME (System Settings row 7), each time only after checking the cursor row says so.

## Following playback

With **Follow M8** on, each track gets a playhead while the song plays. Positions come from
the screen: on the Song view the M8 draws a `>` just left of each track's playing chain, on a
Chain or Phrase view after the row number of the playing row. Between readings each track moves on step by step, each step lasting the ticks its
groove gives it: six (a sixteenth) with the default groove, `08 04` for a swing, `00` for a
skipped step, scaled to 24 per quarter note when the groove counts 48, 96 or 192 PPQ. The ticks
are MIDI clock ticks when the clock runs, else ticks at the tempo shown (`T>096`). The groove in
force follows the song as it plays: the project GROOVE, then each `GRV` (its track) or `GGR` (all
tracks) from the step it is on, whose own length it already sets (unless a `CHA` on the step
leaves it out: X for the FX left of the `CHA`, Y right of it), along the path the tracks take
through their HOPs, so a `GRV` on a step a HOP skips changes nothing (`src/model/music/groove.ts`
walks the tracks side by side from each block's first row; a step keeps the groove it first plays
with). A Groove view or Project GROOVE edited on the M8 is folded in.
A playhead is drawn dim while its step inside the chain is guessed (first seen mid-chain) and
solid once a chain change or a Phrase view pins it.

A phrase can play more than once in its chain, and its Phrase view looks the same for every
repeat. The M8 marks the chain position, the chain row it shows the phrase of, with a `<` in the
margin of the step row with that number, and while the song plays a second `<` on the chain row
playing when that is another one. So on a Phrase view the track the M8 is on is placed on the chain
row playing, whichever repeat (or other phrase) it is, with or without MIDI: the only mark, or the
one that is not the view's. A second mark with no play marker (another phrase plays) still places
it, keeps the song counted as playing, and its absence while the track should be on another row of
that chain says the song stopped.

Play on a Phrase view plays that phrase alone, over and over, sends no MIDI transport and shows one
mark. So a track loops its phrase, at the chain position the `<` marks, when playing starts on a
Phrase view without a MIDI Start (the read before showed that view without a marker, or the first
marker is on the phrase's first beat), or, with no MIDI transport running, when the marker starts
the phrase over while one mark stays where it was (the song coming to the same phrase at the same
position on the next song row looks the same and is not taken for a loop). Without MIDI, Shift+Play
there looks the same at first, so it starts as a loop: the second mark that appears when the song
goes on to the next row ends it, as does a reading of the track elsewhere. Shift+Play on a Chain or Phrase view continues
the song at the chain position: the MIDI Song Position then counts the chain rows before it, and
every track starts at that chain row. The play markers a read still shows just after a MIDI Stop
are ignored, so they do not start a ghost playhead.

The M8 cursor follows the chain position too (of two marks, the one it knew, or after a key the
nearer to it): a key press on the M8 or a change of the marks between two screen reads makes the
explorer read the screen again, since moving between two repeats of a phrase changes nothing else. Before any Song view has been seen (after a reload), a Chain or Phrase view
whose item is in one song cell only gives the song row and track.

A HOP in a phrase acts as the track reaches its step (`src/model/music/playPath.ts`). `HOP 0Y`
sends the track to row Y of the next phrase, the way the song would go on: the chain's next
phrase, or after the chain's last phrase the next song row's chain (back to the start of the run
at an empty cell); its own step never plays. `HOP XY` with X above 0 sends it back to row Y of
its own phrase, X times; then its own step plays like any other and the phrase runs on, and the
next time the track gets there it hops X times again (`HOP 32` on step 3 plays step 2 four times,
every time round). `HOP FF` stops the track there: its playhead goes away. Readings measure along
the same path, from where the track was as the reading's window opens, so a Phrase view after a
HOP narrows the position instead of restarting it, and a step the track comes back to (a chain
looping on itself, a HOP back) is matched with its latest time round. A Chain view whose marked
row is the phrase the track already walks changes nothing (HOPs can keep a track in a phrase
without its first step coming round again). A step played again is jumped to at once, not glided
back to, and counts as a new step: its note lights its instrument again and starts its table.

The view follows the playhead furthest down the song, a third of the way down the view. A track
that loops a chain of its own (an empty cell under it) while the others go on stays behind, and
does not hold the view back. A track whose playhead is out of sight glows in its column, beating
with it: under its header when it plays above the view, at the bottom when it plays below. The
glow shows with Follow M8 off too, and **P** jumps the view to the furthest playhead.

MIDI needs SYNC OUT set in the M8's MIDI Settings, a setting stored in each song (check it in
the song you load). yam8d forwards it to the app, or the standalone page opens the M8's MIDI
input itself (either way the browser asks once for Web MIDI permission). With
CLK+TRANSP+SPP, measured on the device:

- the clock (`F8`) runs all the time, even while stopped;
- Play sends the Song Position Pointer then Continue (`F2 40 03` = 448, then `FB`, for Play on
  song row 07). Every track has its own playhead and loops its own run of chains: an empty `--`
  cell ends the run and the track goes back to the run's first chain, so a block of chains between
  empty cells is an isolated loop. The position counts steps from the
  start of the *cursor track's* run, so it does not say which row plays: the song row the cursor
  is on does. Every track is placed on its last chain at or above that row (a track with an empty
  cell there plays the one above it), its first step on the next clock tick;
- Stop sends `FC`.

The clock is the time base; the screen markers keep checking where each track is (HOP, grooves,
chains of different lengths).

A clock that goes silent for 2 s (SYNC OUT set to OFF, another song loaded) is dropped: positions go
back to the tempo the Song / Chain / Phrase view shows. Before this the last clock's tempo kept
running the playheads (140 BPM on a song at 120: a one-step correction every half second).

The tracks keep their positions when the M8 leaves the Song view: a chain or phrase view only
corrects the track(s) playing what it shows, and a view with no marker (a chain or phrase nothing
plays) says nothing about the song. With the MIDI transport only Stop (`FC`) ends the song; without
it, a Song view with no marker, or a chain / phrase that should be playing by the positions known
but shows none for about a second, does.

Each reading narrows when the step on screen started (it is showing now, so it started within
the last step; right after the step before it, it started between the two readings), so the
playhead is not a poll behind. Measured on the device with the clock: about 6 one-step
corrections in 50 steps, at step boundaries.

When a step with a note starts, the header of the panel of the instrument it plays glows for a
moment. It also marks where that instrument's table is: a row marker on the table
(`src/model/music/tableRun.ts`, `tablePlayback.ts`), and a cell marker over an FX lane that runs
elsewhere (its own `TIC`, or a `HOP` that only it takes). A `TBX` shows its aux table the same
way. The tables follow the tracker's steps, not the drawn playhead, so a HOP or a loop that plays
a step again starts its note's table again. At `TIC 00` a table moves one row per note the
instrument plays, and a `THO` on the note's step sends it to its row. Tables in a map mode
(`FC`-`FF`) get no marker.

Some steps are left to chance: `CHA XY` plays the note, and the FX left of it, X times in 15 (the
FX right of it Y times), and an `RND` under a `THO` (the command last used in its lane) sends the
table to a random row (`RNL`: the command left of it). The M8's track panel, right of most views,
shows the note each track plays: the explorer reads it, and a note that changes says the chance
step played (its instrument glows, its table moves). The note does not say the row (the scale
quantizes it, a `TSP` on another track moves it), so a table sent to a random row loses its row
marker until the M8's Table view shows that table: its markers, one per column, place it
exactly. A table a chance note may or may not have moved (no note change could tell) is drawn
fainter.

Table playback, from the manual, the TM8C guide ("Working with tables") and the device:

- a note starts its table at row 0 (or the row a `THO` on its step names) and a note off stops it;
  `TBL` and `TIC` on the note's own step pick the table and its speed (else the instrument's
  `TBL.TIC`); a `TIC` on a `TBX` step is the aux table's, which defaults to the instrument's
  `TBL.TIC`;
- a table tick is one MIDI clock tick (24 per quarter note, the groove's unit);
- `TIC 00`: every column moves a row per note, and the note does not restart the table (device);
- `HOP XY` hops its own FX lane, X times (0 for ever), then runs on; the transpose / volume
  columns are FX1's (they move at FX1's speed, with FX1's HOPs: TM8C, and on the device a table
  with `HOP 01` in FX1 and FX2 kept its N column on row 1); `THO` hops every column; `TIC` in a
  lane sets that lane's speed from its row on;
- from the TM8C guide: a `HOP` row takes no time; `HOP X0` onto its own row stops that column
  there (a table that plays once); `REP XX` in a lane plays the command above it XX more times, so
  the lane stays XX rows of time on the `REP` row.

## Debug log

A double click on the **?** button saves `m8-explorer-debug-<song>-<date>-<time>.json`, to attach to a
bug report. It has three parts with three lifetimes (`src/model/debugLog.ts`):

- **Global state**, read at the moment of the export (`global`): `environment` (browser, frame, SDK
  version), `permissions` (Web MIDI with and without SysEx, audio input, Web Serial and WebUSB
  grants, the frame's permission policy, the MIDI ports the browser lists when MIDI is already
  granted: nothing is asked for), `connection` (through yam8d or standalone, serial / USB / MIDI,
  audio, device model), `midi` (SYNC OUT, CC MAP CHAN and SONG ROW CUE CHAN of the song, whether
  SYNC OUT is the CLK+TRANSP+SPP the playheads need, the mute / solo output), `playback` (time base,
  MIDI clock enabled or refused, clock events, tempo and gaps, totals), `song` (sizes, project
  settings, the grooves the song plays with and which are not plain 6-6 sixteenths with what points
  at them, the exploration's warnings), `settings` and `handshake`.
- **Exploration runs, device tasks and problems**, kept for the whole session: the last 5 runs of
  *Explore song* (`exploration`: phases with their time, what the driver said while it went, the
  warnings, the counts it ended with, cancelled or failed), the MIDI sync checks and theme reads
  (`deviceTasks`), and `problems` (errors, warning notices, a failing screen read or sync, a refused
  MIDI clock, storage that cannot be written), each counted once with its first and last time.
- **Rolling events** (`events`, the last 400, `eventsDropped` says how many left): user activity and
  playback. Play pressed (`play-key`) and the start (`play-start`: from the MIDI transport or the
  screen, the cursor's song row and track, the view, Follow M8 and Auto select, the time base, and
  per track the chain, whether its position is exact and how its step lengths differ from 6 ticks),
  `transport` messages, `clock-gap`, `tempo`, `no-clock-while-playing`, `drift` (a phrase view
  showed another step than predicted: track, song row, predicted and shown step, difference, step
  length, time since the start), `reanchor` (a track's position restarted), `phrase-loop` (a track
  began or stopped looping one phrase, and why), `play-stop` (why, how
  long, the corrections of that stretch), `long-task` (main thread stalls while playing),
  `visibility` (a background tab slows the page), Follow M8 / Auto select, `device-view` (the view
  the M8 moved to, not every cursor move), `device-edit` (an edit made on the M8 folded in),
  `other-song`, `connection`, mute / solo and channel changes, show on M8, toolbar actions and
  notices. Bursts of drifts and gaps are thinned out (`suppressed` counts what was left out).

`public/debug-log-analyzer.html` (served at `/debug-log-analyzer.html`) reads such a file (open it in a browser, drop the log on it): a
green / amber / red light per check (permissions, connection, the MIDI clock link, song, each
exploration with its own MIDI sync & clock card, each play with its corrections, problems), a timeline and the raw events. Everything
stays in the page; "Copy summary" gives a text version to paste into a bug report.

## Device facts (Model:02, firmware 6.5, checked live)

- Track mute / solo over MIDI (2026-10-17, CC MAP CHAN 11): a held note 12-19 mutes track 1-8
  (`M1`..`M8` next to the track list), 20-27 solos it (`S1`..; the other tracks then show `M`),
  note off ends it. Notes 28-31 do nothing visible.

- Transport over MIDI (SYNC OUT CLK+TRANSP+SPP): Play on song row 00 sent `F2 00 00` + `FB`, on
  row 08 `F2 00 04` (= 512 = 8 x 64) + `FB`; Stop sent `FC`. Play and Stop from a Phrase view
  (live play) sent no transport byte at all, only the clock: no `FA`, no SPP, no `FC`. So only
  the Song view's Play and Stop reach the MIDI transport.
- Shift+Play (continue from the cursor) sends the same `F2` + `FB`. Every track has its own
  playhead and loops its own run of chains: a row of `--` cells stops the tracks that reach it
  and each goes back to the first chain of its run, so a block of chains between blank rows is an
  isolated loop, and a single chain row between blank rows loops on itself. Play on a blank row
  plays each track's last chain above it. The position counts steps from the start of the *cursor
  track's* run up to the cursor row, and a cell without a chain counts the whole run, so it does not
  say which row plays. Measured with the cursor in the track 1 column, in a song whose chains are
  all 8 phrases (128 steps) and where track 1 has chains on rows 2B, 2C, 2E-31, 33 and none on
  20-2A, 2D, 32, 34-37: row 07 sent 896, row 20 and the empty cells 29 and 2A below the run sent
  4096 (the run's length), 2B 0, 2C 128, 2D 256, 2E 0, 2F 128 ... 32 512, 33 0. Rows 34-37 (blank,
  below the isolated row 33) gave nothing or 128: most likely a Play press that toggled the song
  off after a stop press that did not register, 128 being the length of row 33. The song had no
  `GRV` / `GGR` and groove 00 was 6,6 at PPQ 24, so a groove does not explain the positions.
- The explorer places tracks from the cursor row, not from the position
  (`PlaybackTracker.transportStart`). Tested with a fake song and live (cursor in the track 1
  column, Follow M8 on):
  - row 2C (a chain on every track): SPP 128, the M8 marked all 8 tracks on row 2C and the explorer
    drew a playhead on all 8;
  - row 2B (start of the run): SPP 0, the M8 marked all 8 tracks and the explorer drew all 8;
  - row 29 (only track 7 has a chain there): SPP 4096; the M8 marked track 7 on row 29, and its note
    monitor showed tracks 4 and 6 sounding too, so those play their last chain above; the explorer
    drew playheads on the other tracks, but their song-view markers were not on screen, so their
    exact rows were not compared;
  - row 2A (no chain on any track): SPP 4096; the M8 marked tracks 1-6 and 8 on row 1F (their last
    chain above) and track 7 on row 29; the explorer placed the tracks on the same rows (track 7's
    row 29 was off screen);
  - row 27 (no chains at all) and 20-2A: SPP 4096.
  A held arrow key repeats on the M8: use presses of about 20 ms to move one row.

- Scale quantizing (a throwaway song, scale 00 with only C, E and G ON, chain TRANSPOSE raised
  on a phrase note C-4, read on the M8's note monitor): +1 played E-4, +2 E-4, +5 G-4, +8 C-5, so
  a note outside the scale plays as the next scale note above it (not the nearest), across the
  octave too. Edit+Right on a phrase note in that scale went from C-4 straight to E-4: note entry
  is quantized as well, so written notes are always in the scale. In the Scale view an Edit tap on
  an EN cell toggles ON / `--`. Further checks in the same song (2026-10-24, note monitor):
  - KEY D with the C, E, G mask: the Scale view rows read D, F#, A, so the key rotates the mask;
  - a written E-4 with no transpose played F#4 in that scale: the M8 quantizes written notes at
    play time as well (the explorer now does too);
  - project TRANSPOSE +3 on that E-4 played A-4 (E-4 + 3 = G-4, then up into the scale): project
    transpose adds, then the scale applies;
  - instrument TRANSP. OFF (the M8 shows "TRANSPOSE & SCALE DISABLED"): the written E-4 played E-4.
  - `SCA 31` on step 0 of the phrase (the M8 prints "TRACK KEY: D# SCALE: MAJOR" when the value is
    set; scale 01 was a MAJOR scale in that song): the written E-4 played F-4 (next note of D#
    major), so the digits are key then scale, and an `SCA` applies to the note on its own step;
  - instrument types: MIDI OUT shows PORT `00MIDI+USB`, CHANNEL `01`, BANK:PG `---:--` and CCA-CCJ
    rows `CCA CC:VAL  000:20` (value at x 12, a level bar drawn after it); EXTERNAL shows INPUT
    `00LINE-IN STEREO`, PORT `01MIDI+USB`, CHANNEL, BANK:PG, CCA-CCD `001:--` at x 4 and the mixer
    column; the explorer's parser reads both. Changing an instrument's TYPE asks "LOSE CHANGES TO
    INSTRUMENT? OK CANCEL";
  - entering an FX command: hold Edit and press Up / Down to open the command picker (SEQUENCER FX,
    CURRENT INSTRUMENT, INSTRUMENT MODS, MIXER/EFFECTS, with a help line for the selected command),
    pick with the arrows and release Edit; Edit+Right on a value steps it, Edit+Up adds 16.
  Scale offsets (detune): the Scale view's OFFSET column has a semitone cell and a cents cell per
  note (`00.00`); Edit+Up on the semitone cell adds 12 (not 16), Edit+Right adds 1. The whole
  semitones of the offset of the note the scale lets through are added to the note after the
  quantizing, and the note monitor shows the sum: with a scale of C, E, G at C+1, E+1, G+0, a C-5
  under SCA 00 showed C#5; under SCA 10 (key C#: C#+1, F+1, G#+0) it was quantized up to C#5 and
  showed D-5; under a scale 01 with C at +3 it showed D#5. The cents are not tested. A first try
  with an F offset of `01.00` showed no change; that one is unexplained. Entering a note with
  Edit+Right / Edit+Left steps through the scale's enabled notes (C, E, G ...), not semitones.
  While the song plays, the Scale view draws a `>` on the row of the note being played
  (`D >ON 00.00`), and it comes and goes with the notes; the reader skips it and the "screen is
  drawn" check ignores `>`. Before that, exploring a playing song gave "scales not read".
- Theme View (System Settings > EDIT THEME): the MODE row reads `R G B` or `H S V`; an Edit tap on
  that cell switches between them, and the screen only redraws on the next key press. In HSV mode each colour row shows hue,
  saturation and value as hex bytes (`TEXT:TITLES 17 6A EA` is `EA BE 88` in RGB); the SDK's
  conversion matches the RGB view to within a few units (the hue is one byte), checked on the
  twelve colours of one theme (`tests/theme.test.ts`). The `◂ ▸` cell right of it moves every
  colour at once (Edit+Right: titles, markers and meters shifted a few units; Edit+Left undid it).
- Content rows start on screen row 6; row 5 holds column headers.
- Phrase titles can end with `^` as well as `*` (`PHRASE 27^`).
- The Phrase view draws a `<` in the margin (screen column 0) of the step row whose number is its
  chain position: row 3 when it shows the phrase of chain row 3 (the Chain view has none). Option+Up/Down
  moves it from repeat to repeat of a phrase; the cursor and its text stay the same, so only a
  screen read sees it. While the song plays, a second `<` marks the chain row playing when that is
  another row, whatever phrase it holds: from row 3 of chain 42 the marks read `3,4` (phrase 42
  playing, no play marker), `3,5`, `0,3`, `1,3`, `2,3`, then `3` alone, a phrase each. Play on the
  Phrase view plays that phrase alone: one mark, which stays. Stopped: one mark. Seen 2026-10-28 on
  ECHODARKOD, with and without MIDI.
- Shift+Play on a Phrase view sends Continue with a Song Position that counts the chain rows
  before the chain position too (48 from chain row 3 of song row 00), and every track starts at
  that chain row (track 8's chain played rows 3, then the next song row). Play there sends no
  transport and plays the phrase alone, over and over.
- HOP 00 on step 8 of phrase 10 (its chain alone on song row 0C): the play marker cycles steps 0-7
  and never shows step 8, so the HOP's own step does not play.
- Counted HOPs (GEN_INTERMIS, 2026-10-28, 120 BPM, `GRV 01` = 192 ticks a step, 4 s): phrase 06
  alone in its chain played step 0 seven times (HOP 60 on step 1: 28 s), then step 1 itself, step
  2 four times (HOP 32 on step 3), step 3, step 4 four times (HOP 34), step 5, and HOP 02 on step 6
  sent it to step 2: a 40 s loop where HOP 32 and HOP 34 hop three times on every pass.
- A counted HOP stays in its phrase: phrase 07, alone in chain 07 on song row 00 with chain FE on
  row 01, did HOP 24 twice back to its own step 4 (the Song view kept the track on row 00), then
  steps 5, 6 x16 (HOP F6), 7, 8, 9 x5 (HOP 49), A, B, then `GRV 00` on step C made steps C-F 6 ticks
  each, and chain FE's 144 steps took 18 s before row 00 came round again.
- On a test song (2026-10-29, 120 BPM, track 1: chain 00 = phrases 00 and 01, chain 01 on the next
  song row): `HOP 14` on step C of phrase 00 (the chain's first phrase) sent the track back to step
  4 of phrase 00, once (the Chain view marked row 0 for 3 s); `HOP 04` on step 8 of phrase 01 (the
  chain's last) sent it to chain 01 on the next song row (no Chain 00 marker for 1.5 s: 12 steps
  from row 4), then chain 00 started over from its first step.
- A `CHA` gates a `GRV` like any FX: `GRV 01` right of `CHA F0` never played (steps stayed 123 ms),
  right of `CHA FF` it always did (246 ms steps with groove 01 = 12 ticks).
- `TIC 00` with `THO 05` on a note's step: the table went to row 5 (the note added no row), and the
  next note moved it to 6: 5, 6, 5, 6 with `HOP 00` looping the two steps.
- A `GRV` sets its own step's length: step 0 with `GRV 01` lasted 4 s from the start.
- `TIC 00`: the Table view's markers moved one row per note the instrument played (every 125 ms),
  each column on its own: N, FX1 and FX2 stayed on row 1 (row 2 has `HOP 01` in FX1 and FX2), FX3
  went 2, 3 ... F, 0, 1. The explorer's model of that table matched 109 of 121 Table view reads,
  the others one row ahead for one read (the screen shows a step a little after it starts). A random `THO` (`RND 0F` under `THO 00`, with `CHA 64`) moved all
  columns together to a new row at irregular times.
- The Table view marks each column's row with a `>` before it (screen columns 2, 8, 14, 20 for N,
  FX1, FX2, FX3). Play on a Table view plays that phrase alone and sends no transport.
- The track panel (screen rows 7-14, `1 G#3` from column 34) shows the note each track plays, with
  its table's transpose, quantized by the scale (rows 6 and 9 of a table transposing 0-F showed +5
  and +8) and moved by `TSP` on another track (track 2 showed F-3 in the song, G#3 with its phrase
  played alone). It changed within about 70 ms of each chance note that played (12 of 12 checked
  against the Table view).
- A Phrase view shows the play marker whenever its phrase plays on that track, whatever the repeat
  (rows 5, 0, 1 and 2 of chain 42 while its view mark was on 3). Play there starts the phrase from its
  top (the cursor was on step 5). Option+Left/Right shows the other track's phrase at that track's
  own chain position.
- Names are padded with dashes to 12 characters (`NAME--------`).
- Option+Down in a phrase goes to the chain's next phrase.
- Option+Up/Down steps 16 on the Instrument and Table views, but not the same way round: Option+Down
  is +16 on instruments and Option+Up is +16 on tables (log of 2026-10-26: Option+Down went from
  table 14 to 04). An earlier exploration took that for "big steps do not work" and stepped one
  table at a time. The explorer starts with those keys, and if a big step goes the other way (or
  wraps round by 16) it swaps them once; only another miss turns big steps off.
- Shift+Right from the Instrument view once stayed on the Instrument view; the explorer
  retries from the TYPE row.

- Project SCALE byte (`20D CHROMATIC`): the high digit is the key (0 = C, 1 = C#, 2 = D ... B =
  B) and the low digit the scale number (0-F), as in `SCA XY`. The Scale view lists its 12 rows
  from the key (D, D#, E ... for key D) and stores the scale as intervals from it; scales can be
  custom or loaded, so the exploration reads the Scale view of the project's scale, of every
  scale `SCA` / `SCG` point at and of the ones Hypersynth instruments pick.
- Phrase to Scale / Groove: from a note cell Shift+Up opens the Groove view (and once more the
  Scale view); with the cursor on an `SCA` or `GRV` cell it opens the scale or groove that
  command points at, and Shift+Down then returns to the phrase. The exploration parks the cursor
  on the note column when yam8d's route loops there.
- Scale view: `KEY   C` under the title, then `C  ON 00.00` ... `B  ON 00.00`; a note out of the
  scale reads `C# -- -- --` (drawn near the background colour); then TUNE, NAME, LOAD/SAVE.
  Option+Left/Right steps the scales. Scales 00 and 01 both showed KEY C (the manual calls KEY
  global). The Project view's SCALE row carries the key: `00C CHROMATIC`.
- An exploration with the Scale view step ran on a song with project scale 00 CHROMATIC, key C
  and no SCA/SCG, so quantizing was not exercised.
- Groove view: title `GROOVE 00`, headers `TIC PPQ SWING` on row 5, then rows `0 07 24 58.3%`,
  `1 05`, `2 08    61.5%`, `3 05`, `4 --` ...: ticks at x 2, PPQ on row 0 only, swing on the even
  rows. The Project view's GROOVE row reads `00DEFAULT`. An exploration read both (a song with
  groove 00 = 07 05 08 05).
- Playback with that groove, MIDI clock, ~20 s on a Phrase view at 120 BPM: 2 one-step
  corrections with the groove's step lengths, 34 with plain sixteenths.
- Titles can carry an indicator after the number: `CHAIN 0B*` (the manual: `*` means used
  elsewhere in the chain or song), `PHRASE 27^`. It is not part of the id.
- The M8 once missed a Shift+Right from a chain row (the same press by hand opened the phrase):
  view moves between Song, Chain, Phrase, Instrument and Table are pressed again (twice at most)
  while the screen still shows the view they were pressed on.
- Read theme: the route (Project row 20 SYSTEM SETTINGS, System Settings row 7 EDIT THEME) and
  the Theme View parse work (13 colours, RGB, theme name). Column colours learnt while exploring
  are dropped once the device shows another background (they belonged to the previous theme).

- Instrument view (all 7 types captured 2026-10-21 by creating an instrument and stepping TYPE):
  TYPE / NAME / `TRANSP. ON   TBL.TIC 01   EQ --` on rows 2-4 under the title, parameters from row
  6. Left labels at x 0 with values at x 8 (MIDI OUT: x 12; EXTERNAL's CCs `CCA 001:--`: x 4); the
  mixer column AMP LIM PAN DRY MFX DEL REV has its label at x 18 and value at x 22 (SAMPLER's
  FILTER / CUTOFF / RES rows have none). FM rows hold four operator columns at x 8, 14, 20, 26;
  operator D ends at x 30, LOAD SAVE at x 30, and the track panel starts at screen column 34. The
  types read `WAVSYNTH`, `MACROSYN`, `SAMPLER`, `FMSYNTH`, `HYPERSYN`, `MIDI OUT`, `EXTERNAL`
  (Edit+Right from NONE: that order, stopping at EXTERNAL).
- Inst. Mods view (Shift+Up from the Instrument view): MOD1 and MOD3 side by side from row 2, MOD2
  and MOD4 from row 10; labels at x 0 / 16, values at x 5 / 21 (`MOD2 01ADSR ENV MOD4 03LFO`).
  Rows under MODn: AHD ENV DEST AMT ATK HOLD DEC; ADSR ENV DEST AMT ATK DEC SUS REL; DRUM ENV DEST
  AMT PEAK BODY DEC; LFO DEST AMT OSC TRIG FREQ; TRIG ENV DEST AMT ATK HOLD DEC SRC
  (`SRC  00WAVSYNTH`); TRACKING DEST AMT SRC LVAL HVAL. A new instrument has AHD, AHD, LFO, LFO,
  all DEST OFF. An exploration with the Mods step ran on a song with 4 instruments, with no warnings.
  A song of 26 SAMPLER instruments showed DEST `01VOLUME` (no Instrument view row of that name, so
  the face marks no parameter), `03LOOP ST`, `06CUTOFF`; OSC `00TRI`, `03RAMP UP`, `09DRUNK`; TRIG
  `00FREE`, `01RETRIG`; and a TRIG ENV / TRACKING SRC that shows a name (`02002_PADS`), not a type.
- SAMPLER with a sample loaded (2026-10-24): row 6 reads `SAMPLE  000_SAMPLE-NAME- EDIT`
  (the name at x 8, up to 16 characters, then ` EDIT`; empty it is `SAMPLE  LOAD             REC.`).
  `instrumentCells` makes one cell from x 8 whose text includes the ` EDIT` label. The rest of the
  SAMPLER layout matches the captured fixture (SLICE `01FILE`, PLAY `02FWDLOOP`, LIM `06POST:W1`).
  An exploration of that song read its 11 instruments, 11 tables and the groove with no warnings.
  It had no `GRV` / `GGR` / `SCA` / `SCG`, and table `HOP` (5), `THO` (3) and `TIC` (3).

## Not yet checked on a device

- Modulator drawings follow the manual's description, not the M8's output: the DRUM ENV outline
  (PEAK's duck), envelope times drawn in proportion to their tick values, the LFO rate (FREQ in
  steps; the tick-rate shapes taken as names ending in `T`), TRIG ENV drawn like AHD (the manual
  calls it bipolar). DEST and OSC names beyond the ones seen.

- Grooves: that a groove restarts at each phrase (step s plays groove row s modulo the loop:
  only checked with 1- and 4-row grooves, where it makes no difference); how a PPQ above 24 maps
  onto the MIDI clock. `GRV` in tables and `DEL` are not followed.

- SCA/SCG in tables, HOP and live mode are not followed by the scale quantizing.

- Play on a Phrase view: what a HOP does in a phrase played alone (taken as going to row Y of the
  same phrase).

- HOP in a phrase: how the hop counts keep when a track leaves a phrase by another way (another
  HOP, a chain end) and comes back; whether a `CHA` gates a HOP as it gates a `GRV` (taken as not).
- `CHA` with a chance between 0 and F on a step's `GRV` / `GGR`: the groove change is taken as
  happening when the chance is 8 in 15 or more.

- Tables: the TM8C rules above (`HOP` onto its own row, `REP` as a row count); whether a `TBX`
  table starts at `TIC 06` (TM8C) or at the instrument's
  `TBL.TIC` (the model); whether the N column counts scale steps on a scale other than
  chromatic (TM8C). `DEL` in a table is not followed.

- Play on a cell with no chain: that the track then plays its last chain above (the SPP fits), and the SPP on a blank row below an isolated row (re-test with a check that the song is stopped before each press);
- Start (`FA`) and SPP from a Chain view (the Phrase view sends none).
