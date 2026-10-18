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
- **Many instruments at once**: panels that would overlap tile into extra columns deeper along the
  wall (up to three, the wall grows only for tracks that need them) and then stack downward. A panel
  keeps its column while you scroll, so the grid does not reshuffle.
- **Moving the selection** with the arrows onto a velocity / instrument / FX cell or a table turns the view and
  opens the wall; back on a note it turns back (the same rule as Follow M8).
- **Chain transpose and scales**: a phrase a chain row transposes shows the transpose under its
  number in the tree (`+5`, `-12`), and its notes as played in the transpose colour: the written
  note moved by the chain and project TRANSPOSE, then brought into the track's scale. **Played
  notes** (`T`) switches back to the notes as written. Instruments with `TRANSP.` OFF keep their
  notes. The track's scale is the project SCALE (with its Scale view KEY) until an `SCA` on the
  track or an `SCG` on any track changes it (`SCA XY`: key X, scale Y). The Selection panel shows
  the track scale, what a note plays (`D-4 (F-4 -2, scale -1) · 4th of A MINOR`) and its scale
  detune; when the scale lets every note through it guesses the key the phrase's notes fit
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
  on the device are folded back into the view. **Show on M8** (`Enter`) walks the device to the
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
| `3` | Side | Look along the wall |
| `E` | Open all | Open the walls of every track |
| `X` | Dramatic | Skewed, tilted camera angles for front, turn, side and the turns toward a wall |
| `T` | Played notes | Transposed phrases show the notes they play |
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
npm install          # links ../yam8d/packages/m8-sdk (build it first: npm run build:sdk in yam8d)
npm run dev          # http://localhost:5176/
```

In yam8d, add `http://localhost:5176/` under External Apps. Opened on its own the page shows the
last explored song (or a demo song) and runs the SDK in standalone mode: **Connect M8** connects
to the device from the page (Web Serial, WebUSB or Web MIDI) and plays its USB audio. Only one
page can hold the M8, so disconnect it in yam8d first. A device the page was granted before is
reopened at start. Standalone mode has not been tried on the device yet.

`npm test` runs the explorer against a fake M8 (`tests/fakeM8.ts`) and tests the semantics,
transpose and scales (`harmony`), the layout, playback, the MIDI sync check and the other-song
check; `npm run typecheck` and `npm run build` check the rest.

## How the exploration moves

Only arrows, Shift+arrows and Option+arrows are sent, never Edit or Play (Option+Left/Right is not
used on the Song view, where it solos tracks):

1. Song view, Option+Up to row 00, then Option+Down page by page (all 256 rows).
2. Each chain from its first song cell: Shift+Right; each phrase the chain plays (up to its first
   empty row) from its chain row with Shift+Right, or Option+Down from the phrase above it while
   the device agrees; Shift+Left back.
3. Instrument view, Option+Left/Right (±1) and Option+Up/Down (±16) to each instrument used, read
   TYPE and NAME, Shift+Right to its table and back.
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
  song row 07). 448 = 7 x 64 is the timeline row where that song row starts, so every track is
  placed exactly when Play is pressed, its first step on the next clock tick;
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

## Device facts (Model:02, firmware 6.5, checked live)

- Track mute / solo over MIDI (2026-10-17, CC MAP CHAN 11): a held note 12-19 mutes track 1-8
  (`M1`..`M8` next to the track list), 20-27 solos it (`S1`..; the other tracks then show `M`),
  note off ends it. Notes 28-31 do nothing visible.

- Content rows start on screen row 6; row 5 holds column headers.
- Phrase titles can end with `^` as well as `*` (`PHRASE 27^`).
- Names are padded with dashes to 12 characters (`DEMO2-------`).
- Option+Down in a phrase goes to the chain's next phrase.
- Option+Up/Down on the Table view does not step 16 tables toward the target (the explorer
  steps one by one there).
- Shift+Right from the Instrument view once stayed on the Instrument view; the explorer
  retries from the TYPE row.

- Scale view: `KEY   C` under the title, then `C  ON 00.00` ... `B  ON 00.00`; a note out of the
  scale reads `C# -- -- --` (drawn near the background colour); then TUNE, NAME, LOAD/SAVE.
  Option+Left/Right steps the scales. Scales 00 and 01 both showed KEY C (the manual calls KEY
  global). The Project view's SCALE row carries the key: `00C CHROMATIC`.
- Exploration with the Scale view step ran on LAAMAA_SNOWY (project scale 00 CHROMATIC, key C;
  no SCA/SCG in that song, so quantizing was not exercised).
- Groove view: title `GROOVE 00`, headers `TIC PPQ SWING` on row 5, then rows `0 07 24 58.3%`,
  `1 05`, `2 08    61.5%`, `3 05`, `4 --` ...: ticks at x 2, PPQ on row 0 only, swing on the even
  rows. The Project view's GROOVE row reads `00DEFAULT`. Exploration read both (ASHAMEDDATA,
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

## Not yet checked on a device

- Grooves: that a groove restarts at each phrase (step s plays groove row s modulo the loop:
  only checked with a 4-row groove, where it makes no difference); that `GRV` / `GGR` apply from
  the step they are on; how a PPQ above 24 maps onto the MIDI clock. `GRV` in tables and `DEL`
  are not followed.

- How the M8 brings a transposed note into the scale: the explorer moves it down to the scale
  note below. Notes that are not transposed are taken as already in the scale (the M8 quantizes
  note entry). SCA/SCG in tables, HOP and live mode are not followed.

- HSV mode in the Theme View (channels read as 00-FF);
- how SPP counts song rows whose chains have different lengths (the explorer then follows the
  screen markers);
- Start (`FA`) and SPP when playing from a Chain or Phrase view.
