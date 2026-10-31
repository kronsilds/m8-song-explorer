# M8 Song Explorer

A yam8d external app (or a standalone page) that reads a whole M8 song through the SDK (song → chains → phrases →
instruments → tables) and shows it as a 3D tracker:

- **Eight tracks, one song**: every step of the song from top to bottom, the eight tracks side by
  side, with each chain and phrase number as a tree in the track's gutter and song rows aligned
  the way they start together on the device.
- **Unfold a wall from any track**: `FX` opens the rest of every step (velocity, instrument,
  FX1–FX3), `INS` the instrument and table panels the track uses; the wall is hinged on the
  track's right edge, and its panels are linked to the steps that use them.
- **Instruments and tables beside the steps**: a panel shows the instrument's own view with its
  four modulators turned out of the wall, or a table with its rows, its speed and the chord its
  N column spells.
- **Follow the M8**: the cursor is highlighted wherever it goes, edits made on the device are
  folded back in, and the explorer checks (and offers to set) the MIDI sync the playheads need.
- **Explained as you go**: click any cell and the Selection panel says what it means, as the
  device and the SDK read it; the colours come from the M8's own theme.

## Run it

```bash
bun install          # installs the published @yam8d/m8-sdk from npm
bun run dev          # http://localhost:5176/
```

To try unpublished SDK changes from yam8d, point the dependency at `file:../yam8d/packages/m8-sdk`;
tests, lint and format are in [Development](docs/development.md).

In yam8d, add `http://localhost:5176/` under External Apps. Opened on its own the page shows the
last explored song (or a demo song) and runs the SDK in standalone mode: **Connect M8** connects
to the device from the page (Web Serial, WebUSB or Web MIDI) and plays its USB audio. Only one
page can hold the M8, so disconnect it in yam8d first. A device the page was granted before is
reopened at start. Standalone mode has been tried on the device and works.

## Keys and buttons

| Key | Button | Does |
|---|---|---|
| `0`, Home | All | Whole song, all tracks |
| `1` | Front | Tracker view |
| `2` | Turn | Turn the view to the right |
| `3` | Side | Look square at the walls |
| `E` | | Unfold the FX, instruments and tables of every track (again: fold them) |
| | UNFOLD `FX`, `INS` | Top bar: unfold one part of every track (again: fold it) |
| | `FX`, `INS` | In a track header: unfold its step details, its instrument and table panels (until pressed again) |
| | Wall angle | How far the wall is turned from the front (Options panel) |
| `X` | Dramatic | Skewed, tilted camera angles for front, turn and side; a new take each time a navigation moves the view (the cell stays put on screen) |
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
| `?` | ? | Keys and mouse; double click saves the [debug log](docs/debug-log.md) |
| `D` | | Print what the SDK reads on the M8 (screen, colours) to the console |
| | Explore song, Read theme, Follow M8, Connect M8 | See the [user guide](docs/guide.md) |
| | Export / Import | Save the explored song as JSON, or load one (Options panel) |
| | Demo | Show the demo song (Options panel) |

The settings used less often (Dramatic, Played notes, Trim tables, Read theme, CC MAP CH, song
file) are in the OPTIONS panel, a tab on the left edge: hover to open it, click the tab to keep
it open.

## Documentation

| Page | What it covers |
|---|---|
| [User guide](docs/guide.md) | The tracker, folding walls, panels, moving the selection, camera, scales, themes, mute / solo |
| [Playback](docs/playback.md) | Playheads, HOPs, MIDI clock and transport, chance steps, table playback |
| [Exploring a song](docs/exploration.md) | The exploration route, views that do not settle, the MIDI sync check, Read theme |
| [Device notes](docs/device-notes.md) | What has been checked on a real M8, and what is still taken from the manual |
| [Debug log](docs/debug-log.md) | The JSON saved from `?` and the analyzer that reads it |
| [Development](docs/development.md) | Code layout, tests, lint and format |
