// What the user (or the followed M8 cursor) points at in the song.

import type { PhraseColumn, TableColumn } from './columns'
import type { InstrumentScreen } from './instrumentPage'
import type { PhraseInstance } from './timeline'

export type Selection =
  /** A cell of a phrase as played at one place of the song. */
  | { kind: 'step'; instance: PhraseInstance; step: number; column: PhraseColumn }
  /**
   * The chain / phrase labels in a track's gutter. `view` says which M8 view the place came from:
   * a Song view cell marks the whole chain, a Chain view row marks one phrase of it. Unset (a click): both labels.
   */
  | { kind: 'chain'; instance: PhraseInstance; view?: 'song' | 'chain' }
  /** A table row cell, shown in the panel of `instrument` on `track`'s wall. */
  | { kind: 'table'; table: number; row: number; column: TableColumn; track: number; instrument: number | null }
  /** The header of an instrument / table panel. */
  | { kind: 'instrument'; instrument: number | null; table: number; track: number }
  /**
   * A value of an instrument (Instrument view) or of one of its modulators (Inst. Mods view),
   * on the instrument face of its panel: where the value is on the device screen (stored line, x).
   */
  | { kind: 'instParam'; instrument: number; screen: InstrumentScreen; line: number; x: number; table: number; track: number }

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b) return a === b
  switch (a.kind) {
    case 'step':
      return b.kind === 'step' && a.instance.key === b.instance.key && a.step === b.step && a.column === b.column
    case 'chain':
      return b.kind === 'chain' && a.instance.key === b.instance.key && a.view === b.view
    case 'table':
      return b.kind === 'table' && a.table === b.table && a.row === b.row && a.column === b.column && a.track === b.track
    case 'instrument':
      return b.kind === 'instrument' && a.table === b.table && a.track === b.track
    case 'instParam':
      return b.kind === 'instParam' && a.instrument === b.instrument && a.screen === b.screen && a.line === b.line && a.x === b.x && a.track === b.track
  }
}

export const selectionTrack = (selection: Selection): number =>
  selection.kind === 'step' || selection.kind === 'chain' ? selection.instance.track : selection.track

/**
 * True for cells shown on a track's wall: velocity, instrument and FX of a step, table rows
 * panel headers and instrument values. The instrument column is on the front too; the wall shows it with the rest of the step.
 */
export const isWallCell     = (selection: Selection): boolean =>
  selection.kind === 'table' ||
  selection.kind === 'instrument' ||
  selection.kind === 'instParam' ||
  (selection.kind === 'step' && selection.column !== 'note')
