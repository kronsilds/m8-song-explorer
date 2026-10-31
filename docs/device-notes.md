# Device notes (Model:02, firmware 6.5, checked live)

What has been measured on a real M8, and what the explorer still takes from the manual.

## Checked on the device

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

- Tables: the TM8C rules in [Table playback](playback.md#table-playback) (`HOP` onto its own row,
  `REP` as a row count); whether a `TBX`
  table starts at `TIC 06` (TM8C) or at the instrument's
  `TBL.TIC` (the model); whether the N column counts scale steps on a scale other than
  chromatic (TM8C). `DEL` in a table is not followed.

- Play on a cell with no chain: that the track then plays its last chain above (the SPP fits), and the SPP on a blank row below an isolated row (re-test with a check that the song is stopped before each press);
