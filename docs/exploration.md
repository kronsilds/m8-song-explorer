# Exploring a song

Explore song reads the whole song through the SDK and builds the model the view shows. This page
has the route it takes, what happens when the device does not settle, and the MIDI sync check and
Read theme actions that go with it.

## The route

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

## When a view does not settle

A view counts as drawn when two reads in a row match (the `>` play markers aside). A view that does
not get there ends the item with a warning that says whether it never passed the fully-drawn check
or kept changing, and the run's log holds the screen at that moment. An instrument of type NONE has
no modulators and its Inst. Mods view is an empty page, so the exploration does not open it.
(Exploring a playing song first showed this as a timeout on a NONE instrument; the dots the M8
draws under the bars of the Mods view while playing are rectangles and never reach the screen text.)

## Where the M8 is left

When it is done (not when cancelled) and after the MIDI sync check, the M8 is left on the Song view with
the cursor on the first cell (row 00, track 1), so Play starts from the top.

## MIDI sync check

After an exploration (or with key **M**) the explorer opens Project > MIDI SETTINGS and reads
SYNC OUT. When it is not CLK+TRANSP+SPP it asks whether to set it (Edit held + Right on the
value, checked after each step). The change stays in the loaded song until you save it on the M8.

## Read theme

*Read theme* is the only action that presses Edit: on SYSTEM SETTINGS (Project row 20) and EDIT
THEME (System Settings row 7), each time only after checking the cursor row says so.
