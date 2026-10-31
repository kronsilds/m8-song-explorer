# User guide

What the explorer shows, and how it behaves while you use it. The keys and buttons are in the
[README](../README.md#keys-and-buttons); the deeper notes are in [Playback](playback.md),
[Exploring a song](exploration.md) and [Device notes](device-notes.md).

## The tracker

- **Front**: the eight tracks side by side, every step of the song from top to bottom (note and
  instrument), with the chain and phrase numbers as a tree in each track's gutter. Song rows are
  aligned across tracks, the way they start together on the device.
- **Sticky track headers**: the track title, its instrument and the column names stay at the top
  of the view while the song scrolls under them (on the wall too, on one line with the front).

## Moving the selection and the camera

- **Moving the selection** with the arrows onto a velocity / FX cell or a table unfolds the part
  of the wall it is on (it never folds anything, and the camera does not turn). The view then
  shows the whole phrase the cell is in (a Song view cell: its chain), across the front column and
  the step details when they are unfolded, clear of the pinned Selection panel at the heights it
  covers (measured after the panel took its new content). Nothing moves while it shows. Else the
  view scrolls (a page at a time; following the M8, the phrase lands just under the headers) and
  slides along the tracks, keeping its distance from them (as a pan does), to bring that track,
  with as much of its unfolded wall as fits, to the middle of the free room. A phrase taller or
  wider than the screen shows its cell first. A panel cell shows its whole card with its track's
  column beside it (the card first when both do not fit). A move to another track first pans by
  the distance between the two tracks (as they settled before the move), so the new track shows
  where the old one was and a cell at the same place in it (row, column) lands exactly where the
  old one was; the rules above then move the view only if something is still cut. With Dramatic
  on and a preset chosen (Front, Turn, Side), a navigation that moved the view also takes a new
  dramatic angle, the camera swinging around the cell, which stays where it was put on screen
  (a panel cell nearly: panels stick under the headers). The same rules apply to Follow M8 and
  Auto select. While the song plays with Follow M8, the playheads scroll the view, not the cursor:
  a move to another track only pans to it, the playhead keeping its place on screen, and a new
  dramatic angle swings around that playhead.
- **Camera**: the angle presets (Turn, Side, Front) only set the angle; the walls open by the
  buttons. Turn and Side centre the focused track's column and what it has unfolded and stand
  back as far as they need, within readable distances. Front centres on all the tracks and
  slides only as far as it takes to show the focused one; facing the front, Follow M8 and the
  arrows frame all the tracks the same way while they fit the screen (the track headers stay
  clear of the top bar, even when it wraps onto more rows in a narrow window). A drag that
  turns the view goes around the track it starts on, which stays where it is on screen. Panning moves
  parallel to the tracks, so the zoom never changes, and a pan drag keeps what it grabbed under
  the pointer (sideways; nearer things move faster). With nothing selected, the track in the
  middle of the view is the focused one. Ctrl+wheel zooms toward the pointer.

## Folding the wall

- **Fold buttons** (`FX` and `INS` on the line under each track's title, beside `+`): a track
  unfolds a wall hinged on its right edge, from any camera angle, and as many tracks as you like
  can be open at once. `FX` unfolds the rest of each step (velocity, instrument, FX1–FX3) row for
  row; `INS` the panels of the instruments and tables the track uses, linked to the steps that use
  them (`I` column, `INS`, `TBL`, `TBX`). With only the panels open the wall slides back by the
  width of the step details, so the panels keep the same room from the front column as from the FX
  columns, and the links leave from the right edge of the front column instead. A part a navigation
  reaches (a click, the arrows, `I`, or the followed M8 cursor going to an FX cell or a panel)
  unfolds by itself, its button showing only a lit label, and folds again once the navigation
  leaves the track; pressing its button then keeps it unfolded. The tracks to its right make room
  as it opens: the wall's reach along x at its angle and the instrument faces turned out of it, then
  the same gap for every track (not the camera, so tracks never slide while you turn the view;
  perspective still pulls a deep wall's far end toward the middle of the screen). **Wall angle** (Options
  panel, 40° by default) turns the wall from the front: low reads best from the front, high leaves
  more room beside the next track. *UNFOLD* `FX` / `INS` in the top bar do what the header
  buttons do, for every track at once (lit: every track keeps that part; only the label: some
  tracks have it unfolded); `E` unfolds both on every track, again folds them.

## Instruments and tables

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
  cursor's value is selected as it moves, on the panel of the track the M8 came from (else the
  nearest track using it). Going to a panel cell (Auto select, Follow M8, the arrows) brings its
  whole card into view as it settles, as large as the face it turns to: the view slides along the
  tracks, and scrolls only when no row using the panel is near (panels stick under the headers)
  or when the card would be cut at the bottom (at the start of the song, where the headers rest
  lower).
- **Table cells** in the Selection panel also say how the table plays (`src/model/music/tableWalk.ts`):
  its speed (the `TIC` the song starts it at most often, in rows per step and in ms at the
  project tempo), what starts it (notes, `TBX` steps, which tracks), where the selected cell's
  column goes after the note (`loops rows 0–3, 4 ticks, 83 ms per pass`, or `plays rows 0–F once
  and stops on row F`), a `Not played` line when that column never reaches the row, and the
  chord its N column spells (`0 +3 +7 +12 st: minor chord`) with the notes it makes from the
  first note that starts it (only on a scale that lets every note through, since the N column
  may count scale steps on other scales). It follows the [table playback rules](playback.md#table-playback).
- **Many instruments at once**: panels that would overlap tile into extra columns deeper along the
  wall (a wall has two columns at most; a track that wants more shows a `+` beside its `INS`
  button that adds a column, up to four, and `-` takes them away again) and then stack downward. A
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

## Notes, scales and meanings

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
  any screen; *Read theme* (see [Read theme](exploration.md#read-theme)) opens System Settings ›
  Theme and takes the 13 exact colours; the colour of each column is learnt from the screens read
  while exploring.

## Following the M8

- **Follow M8** highlights (and follows) every place of the song the M8 cursor is on, and edits made
  on the device are folded back into the view (the song, chains, phrases, tables, instruments and modulators, grooves, scales and the Project view's TRANSPOSE, GROOVE and SCALE). **Show on M8** (`Enter`) walks the device to the
  selected cell. The place followed is in the song cell the M8 came from: on a Phrase view, the
  repeat its `<` marks when the phrase plays more than once in the chain (Option+Up/Down moves
  along). It moves along with Option+Left/Right on a Chain or Phrase view (the same song row on
  the other track) and Option+Up/Down on a Chain view (the track's next chain in the song).
  The cursor is read 30 ms after the M8 stops drawing, and at least every 100 ms while it keeps
  drawing (a held key, notes on the cursor row while the song plays) (`src/app/syncScheduler.ts`).
  Before any Song view, the song cell of the place followed last is kept as a guess, so a chain
  or phrase used in several song cells stays near it rather than jumping to its first use.
- **Auto select** (`A`) makes the selection follow the M8 cursor, so the Selection panel explains
  what the cursor is on. Reaching the velocity / instrument / FX columns of a phrase, a table or an instrument
  unfolds that part of the wall (also while the song plays); it stays open until you fold it.
  A click wins until the M8 cursor moves again.
- **Edits made on the M8** show at once on the item edited: a cursor read reads them once the
  screen has shown that item for 150 ms (drawn whole). A phrase's text, a table's panels and an
  instrument's panels and face are laid out again, the old text showing until the new one is
  ready; a song, chain, project, scale or groove edit updates the whole scene at once. The rest
  (bars, links, panels coming or going) follows, and the song is saved, once the screen has been
  quiet for 140 ms. That update is incremental (`World.updateSong`): the new layout takes over
  where the panels were and how they showed, a track whose content did not change keeps its view
  (`SongLayout.trackSignature`), a rebuilt one takes over the old one's header, panel texts and
  faces, and texts that show the same stay; nothing blinks or fades in again, and the camera stays.
- **Another song loaded**: when the M8 shows another song than the one explored (another name on
  the Project view, or many different cells on the Song view), live updates, device markers and
  playheads pause until you explore it (or go back to the explored song).

## Playing, syncing and muting

- **Space** plays / stops the M8 from the explorer (Shift+Space continues from the cursor).
- **MIDI sync check**: after an exploration (or with key **M**) the explorer reads Project >
  MIDI SETTINGS > SYNC OUT and offers to set it to CLK+TRANSP+SPP, the sync the playheads need.
  How it does that is in [Exploring a song](exploration.md#midi-sync-check).
- **Mute / solo** buttons (`M` `S`) in each track header hold the M8's MIDI notes through Web
  MIDI to its USB MIDI port: a held note mutes or solos, its release ends it. Notes 12-19 mute
  tracks 1-8, 20-27 solo them, on CC MAP CHAN (picked in *CC MAP CH*, 11 by default as on the
  M8). The M8 does not report mutes back, so the buttons show the notes held from here; leaving
  the page releases them. In yam8d the External Apps iframe allows `midi`.
