# Playback

How the explorer follows a song while it plays, from the screen and from the MIDI clock, and how
it models the tables and the steps it cannot see.

## Playheads and grooves

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

## Phrase repeats and play markers

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

## HOPs

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

## Following the view

The view follows the playhead furthest down the song, a third of the way down the view on the
followed track's column, at any camera angle (dramatic ones included). A track
that loops a chain of its own (an empty cell under it) while the others go on stays behind, and
does not hold the view back. A track whose playhead is out of sight glows in its column, beating
with it: under its header when it plays above the view, at the bottom when it plays below. The
glow shows with Follow M8 off too, and **P** jumps the view to the furthest playhead.

## MIDI clock and transport

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

## Instruments, tables and chance

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

## Table playback

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
