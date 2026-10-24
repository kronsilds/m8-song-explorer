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
- **Many instruments at once**: panels that would overlap tile into extra columns deeper along the
  wall (up to three, the wall grows only for tracks that need them) and then stack downward. A panel
  keeps its column while you scroll, so the grid does not reshuffle.
- **Moving the selection** with the arrows onto a velocity / instrument / FX cell or a table turns the view and
  opens the wall; back on a note it turns back (the same rule as Follow M8).
- **Camera**: Turn and Side centre the open track's column and wall (the panel columns in use)
  and stand back as far as they need, within readable distances: the same framing for every
  track. Front centres on all the tracks and slides only as far as it takes to show the open
  one; Follow M8 and the arrows do the same when the cell leaves the screen. A drag that turns
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
  selected cell.
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
| `A` | Auto select | Selection follows the M8 cursor |
| `M` | | MIDI sync check |
| Arrows | | Move the selection |
| PageUp / PageDown | | Scroll 16 rows |
| `F` | | Bring the selection into view |
| `+` / `-` | | Zoom |
| `Enter` | Show on M8 | Walk the device to the selected cell |
| `Esc` | | Clear the selection |
| Space / Shift+Space | | Play / stop the M8, continue from the cursor |
| `?` | ? | Keys and mouse |
| `D` | | Print what the SDK reads on the M8 (screen, colours) to the console |
| | Explore song, Read theme, Follow M8, Connect M8 | See above |
| | Export / Import | Save the explored song as JSON, or load one |
| | Demo | Show the demo song |

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
reopened at start. Standalone mode has not been tried on the device yet.

`bun run test` runs the explorer against a fake M8 (`tests/fakeM8.ts`) and tests the semantics,
transpose and scales (`harmony`), the layout, playback, the MIDI sync check and the other-song
check; `bun run typecheck` and `bun run build` check the rest.

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

*Read theme* is the only action that presses Edit: on SYSTEM SETTINGS (Project row 20) and EDIT
THEME (System Settings row 7), each time only after checking the cursor row says so.

## Following playback

With **Follow M8** on, each track gets a playhead while the song plays. Positions come from
the screen: on the Song view the M8 draws a `>` just left of each track's playing chain, on a
Chain or Phrase view after the row number of the playing row (the `<` in the margin is the
cursor row). Between readings each track moves on step by step, each step lasting the ticks its
groove gives it: six (a sixteenth) with the default groove, `08 04` for a swing, `00` for a
skipped step, scaled to 24 per quarter note when the groove counts 48, 96 or 192 PPQ. The ticks
are MIDI clock ticks when the clock runs, else ticks at the tempo shown (`T>096`). The groove in
force follows the song: the project GROOVE, then each `GRV` (its track) or `GGR` (all tracks)
from the timeline row it is on. A Groove view or Project GROOVE edited on the M8 is folded in.
A playhead is drawn dim while its step inside the chain is guessed (first seen mid-chain) and
solid once a chain change or a Phrase view pins it.

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

The tracks keep their positions when the M8 leaves the Song view: a chain or phrase view only
corrects the track(s) playing what it shows, and a view with no marker (a chain or phrase nothing
plays) says nothing about the song. With the MIDI transport only Stop (`FC`) ends the song; without
it, a Song view with no marker, or a chain / phrase that should be playing by the positions known
but shows none for about a second, does.

Each reading narrows when the step on screen started (it is showing now, so it started within
the last step; right after the step before it, it started between the two readings), so the
playhead is not a poll behind. Measured on the device with the clock: about 6 one-step
corrections in 50 steps, at step boundaries.

When a track's playhead passes a note, the header of the panel of the instrument it plays
glows for a moment. It also marks where that instrument's table is: a row marker on the table
(`src/model/music/tableRun.ts`, `tablePlayback.ts`), and a cell marker over an FX lane that runs
elsewhere (its own `TIC`, or a `HOP` that only it takes). A `TBX` shows its aux table the same
way. These positions are a model, not read from the M8, so they are only as accurate as the
playhead (a table at `TIC 01` moves a row per tick, so it can be a few rows off), and tables
with no plain ticks-per-row (`TIC 00`, `FC`-`FF`) get no marker.

Table playback (taken from the manual's wording). Watched live with Follow M8 on: the table markers
hop correctly with `HOP` / `THO`, also with different `TIC` values on the tables. The row-level
accuracy against the M8's own table playhead and the rules below were not measured:

- a note starts its table at row 0 and a note off stops it; `TBL` and `TIC` on the note's own
  step pick the table and its speed (else the instrument's `TBL.TIC`); a `TIC` on a `TBX` step
  is the aux table's, which defaults to the instrument's `TBL.TIC`;
- a table tick is one MIDI clock tick (24 per quarter note, the groove's unit);
- `HOP XY` hops its own FX lane and the transpose / volume columns, X times (0 for ever), then
  runs on; `THO` hops every column; `TIC` in a lane sets that lane's speed from its row on.

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
- Names are padded with dashes to 12 characters (`NAME--------`).
- Option+Down in a phrase goes to the chain's next phrase.
- Option+Up/Down on the Table view does not step 16 tables toward the target (the explorer
  steps one by one there).
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
  only checked with a 4-row groove, where it makes no difference); how a PPQ above 24 maps onto
  the MIDI clock. `GRV` in tables and `DEL` are not followed. `GRV` from the step it is on: a
  phrase with `GRV01` on step 0 (groove 01 = one row of 96 ticks) was watched on its Phrase view
  for about 30 s with Follow M8 on and no correction was logged, but the song was also
  playing random FX, so it is a weak check.

- SCA/SCG in tables, HOP and live mode are not followed by the scale quantizing.

- Play on a cell with no chain: that the track then plays its last chain above (the SPP fits), and the SPP on a blank row below an isolated row (re-test with a check that the song is stopped before each press);
- Start (`FA`) and SPP from a Chain view (the Phrase view sends none).
