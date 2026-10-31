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

## Debug log

A double click on the **?** button saves the log described in [Debug log](debug-log.md).
