import type { PhraseColumn, TableColumn } from '../m8/device'
import type { PhraseInstance } from './song'

export type Selection =
  /** A cell of a phrase as played at one place of the song. */
  | { kind: 'step'; instance: PhraseInstance; step: number; column: PhraseColumn }
  /** The chain / phrase labels in a track's gutter. */
  | { kind: 'chain'; instance: PhraseInstance }
  /** A table row cell, shown in the panel of `inst` on `track`'s wall. */
  | { kind: 'table'; table: number; row: number; column: TableColumn; track: number; inst: number | null }
  /** The header of an instrument / table panel. */
  | { kind: 'instrument'; inst: number | null; table: number; track: number }

export const PHRASE_COLUMNS: PhraseColumn[] = ['note', 'vel', 'inst', 'fx1cmd', 'fx1val', 'fx2cmd', 'fx2val', 'fx3cmd', 'fx3val']
export const TABLE_COLUMNS: TableColumn[] = ['transpose', 'volume', 'fx1cmd', 'fx1val', 'fx2cmd', 'fx2val', 'fx3cmd', 'fx3val']

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'step':
      return b.kind === 'step' && a.instance.key === b.instance.key && a.step === b.step && a.column === b.column
    case 'chain':
      return b.kind === 'chain' && a.instance.key === b.instance.key
    case 'table':
      return b.kind === 'table' && a.table === b.table && a.row === b.row && a.column === b.column && a.track === b.track
    case 'instrument':
      return b.kind === 'instrument' && a.table === b.table && a.track === b.track
  }
}
