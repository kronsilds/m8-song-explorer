# Development

How to check the explorer and how the code is laid out. Run it is in the
[README](../README.md#run-it).

To try unpublished SDK changes from yam8d, set the dependency to `file:../yam8d/packages/m8-sdk`,
run `bun run build:sdk` in yam8d, then `bun install` here.

## Tests, lint and format

`bun run test` runs the explorer against a fake M8 (`tests/fakeM8.ts`) and tests the semantics,
transpose and scales (`harmony`), the layout, playback, the MIDI sync check, the other-song
check, the debug log and the layer rules (`layers.test.ts`); `bun run typecheck` (`tsc -b`:
`tsconfig.app.json` for `src/`, `tsconfig.test.json` for the tests and scripts) and
`bun run build` check the rest. `bun run lint`
runs Biome; `bun run format` runs Biome (lint fixes, imports), then `scripts/alignObjects.ts`.
Do not format the code with another formatter: the object layout (one property per line, colons
aligned on the longest key, no trailing comma) is applied by that script, and Biome's own
formatter is off because it would undo it.

## Code layout

Layers, each importing only from the ones above it: `src/model/` (plain data and pure
functions: the song, timeline, song context, columns, screens, selection, harmony, grooves,
palette, debug log, and the live types the views draw) → `src/m8/` (the device: `port.ts`,
`driver.ts`, `screen/`, `tasks/`, `playback.ts`, `semantics.ts`, `midiControl.ts`) → `src/app/`
(`ExplorerApp` and its helpers) → `src/main.ts`. The 3D view `src/scene/` (three.js: `layout.ts`,
`world.ts`, `track/`, `input/`, `markers/`, `camera/`) and the HUD `src/ui/` (DOM: `hud.ts`, song
and debug files) import from `src/model/` only, never from each other or from `src/m8/`; `src/app/`
wires them. `tests/layers.test.ts` checks these rules, and that three.js stays in `src/scene/` and
the device SDK out of `src/scene/` and `src/ui/`.

The app builds a `SongContext` (`src/model/songContext.ts`: the model, its timeline, the
instrument each step plays, the track scales) for every version of the song model, and hands
the same one to the 3D view, the playback tracker, the device cursor and the cell descriptions.
An edit made on the M8 changes the model in place; the app builds a new context when the edit
reaches the whole scene (at once for an edit that moves things, else once the screen is quiet).

Each large part is a small front that hands its work to parts with one job each:

- `app/app.ts` (`ExplorerApp`) only wires: the song shown (`shownSong.ts`), the connection
  (`deviceLink.ts`), what the M8 shows now: cursor, edits, another song (`liveSync.ts`), the tasks
  run on the M8 (`deviceTasks.ts`), the view options (`viewToggles.ts`); `deviceSession.ts` is the
  device state they share (client, port, the task running, another song loaded).
- `scene/world.ts` (`World`) builds the track views and runs the frame loop. The camera's
  framings and navigations are `camera/navigator.ts`, moves by hand `camera/handCamera.ts`, where
  headers stick and how far the view goes `camera/stickyHeaders.ts`, measures of the camera
  `camera/viewProbe.ts`, what the view centres on `camera/viewFocus.ts`; the folds
  `track/wallFolds.ts`, where tracks stand `track/placement.ts`, panel faces
  `track/panelFaces.ts`; the marks `markers/highlights.ts` and `markers/playbackMarks.ts`; the
  arrow keys `input/selectionMoves.ts`. `scene/content.ts` is what they read: the layout, the
  track views, the wall angle.
- `scene/track/trackView.ts` draws a track's column, wall and header; its panel cards are
  `track/panelCards.ts`.
- `scene/layout.ts` (`SongLayout`) places the song (bands, rows, panels, links); which panels a
  wall shows for the rows in view, and where they stick, is `scene/panelStacks.ts`; the sizes are
  `scene/dimensions.ts` (re-exported by `layout.ts`).
- `m8/playback.ts` (`PlaybackTracker`) measures on the device where each track plays (screen
  markers, MIDI clock and transport); how tracks move through the song in clock ticks (grooves,
  chain ends, HOPs, phrase loops) is `model/music/songWalk.ts`.

## Debug log

A double click on the **?** button saves the log described in [Debug log](debug-log.md).
