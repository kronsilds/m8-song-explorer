// The song as read from the M8: song grid -> chains -> phrases -> instruments -> tables, plus
// the project settings, scales and grooves. Plain JSON so it can be stored, exported and
// reloaded; the field names are kept short as in exported files, so do not rename them.

import type { M8Theme } from '@yam8d/m8-sdk'

export const TRACKS          = 8
export const ROWS_PER_PHRASE = 16
export const ROWS_PER_CHAIN  = 16
export const ROWS_PER_TABLE  = 16
export const SONG_ROWS       = 256
export const FX_LANES        = 3

export interface FxCell {
  /** Upper case command ('KIL'), null when the lane is empty. */
  cmd: string | null
  val: number | null
}

export interface PhraseStep {
  /** 'C-4', 'OFF', ... upper case; null for '---'. */
  note: string | null
  /** Velocity. */
  vel : number | null
  /** Instrument number. */
  inst: number | null
  fx  : FxCell[]
}

export interface Phrase {
  id   : number
  steps: PhraseStep[]
}

export interface ChainRow {
  phrase   : number | null
  /** TSP as the raw byte (80-FF are negative). */
  transpose: number | null
}

export interface Chain {
  id  : number
  rows: ChainRow[]
}

export interface TableRow {
  transpose: number | null
  volume   : number | null
  fx       : FxCell[]
}

export interface Table {
  id  : number
  rows: TableRow[]
}

export interface Instrument {
  id   : number
  name : string | null
  /** As the TYPE row shows it: 'SAMPLER', 'FMSYNTH', 'NONE'... */
  type : string | null
  /** Instrument screen rows (title to the last parameter), for the details panel. */
  lines: string[]
}

/** One interval row of a Scale view: semitones above the key. */
export interface ScaleNote {
  /** ON; false for a note out of the scale (the device draws it '-- -- --'); null when not read. */
  enabled: boolean | null
  /** Detune in semitones (-24..+24), null when not read. */
  offset : number | null
}

export interface Scale {
  id   : number
  name : string | null
  /** The 12 interval rows, from the key up (row 'C' is the key itself). */
  notes: ScaleNote[]
  /** KEY row as a pitch class (0 = C), null when not read. The device shows the same KEY on every scale. */
  key  : number | null
}

/** A Groove view: the ticks each phrase step takes. */
export interface Groove {
  id   : number
  /** The 16 rows: ticks per step (00 skips the step), null for '--' (the groove loops there). */
  ticks: (number | null)[]
  /** Ticks per quarter note the rows count in (24, 48, 96 or 192), null when not read. */
  ppq  : number | null
}

/** Colours the device used for each column of a view, learnt from the screen while exploring. */
export interface ObservedColumnColors {
  filled?: string
  empty? : string
}

/** Observed colours per view kind, then per field key. */
export type ObservedColors = Record<string, Record<string, ObservedColumnColors>>

export interface MidiSync {
  syncIn : string | null
  syncOut: string | null
}

export interface SongModel {
  version          : 1
  source           : 'device' | 'demo' | 'file'
  capturedAt       : number
  name             : string | null
  /** Project tempo in BPM, when read. */
  tempo?           : number | null
  /** Project TRANSPOSE as the raw byte (80-FF negative), when read. */
  projectTranspose?: number | null
  /** Project SCALE: the scale the song plays with until SCA / SCG, when read. */
  projectScale?    : number | null
  /** The key shown with it on the Project view ('00C CHROMATIC'), as a pitch class. */
  projectKey?      : number | null
  /** Project GROOVE: the groove every track plays with until GRV / GGR, when read. */
  projectGroove?   : number | null
  /** Grooves read from the Groove view: the project's and the ones GRV / GGR point at. */
  grooves?         : Record<number, Groove>
  /** Scales read from the Scale view: the project's and the ones SCA / SCG point at. */
  scales?          : Record<number, Scale>
  /** song[row][track]: chain number or null. Only the rows that were read. */
  song             : (number | null)[][]
  chains           : Record<number, Chain>
  phrases          : Record<number, Phrase>
  instruments      : Record<number, Instrument>
  tables           : Record<number, Table>
  observedColors   : ObservedColors
  theme            : M8Theme | null
  /** MIDI Settings SYNC IN / SYNC OUT as the device shows them, when read. */
  midiSync?        : MidiSync | null
  warnings         : string[]
}

export const emptyModel    = (source: SongModel['source']): SongModel => ({
  version       : 1,
  source,
  capturedAt    : Date.now(),
  name          : null,
  song          : [],
  chains        : {},
  phrases       : {},
  instruments   : {},
  tables        : {},
  observedColors: {},
  theme         : null,
  warnings      : []
})

export const emptyFx       = (): FxCell => ({
  cmd: null,
  val: null
})
const emptyFxLanes         = (): FxCell[] => Array.from({ length: FX_LANES }, emptyFx)
export const emptyStep     = (): PhraseStep => ({
  note: null,
  vel : null,
  inst: null,
  fx  : emptyFxLanes()
})
export const emptyTableRow = (): TableRow => ({
  transpose: 0,
  volume   : null,
  fx       : emptyFxLanes()
})
export const emptyTable    = (id: number): Table => ({
  id,
  rows: Array.from({ length: ROWS_PER_TABLE }, emptyTableRow)
})

const sortedNumbers        = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b)

/** Phrases a chain plays: its rows up to the first empty one (the manual: '--' ends the chain). */
export function chainLength(chain: Chain | undefined): number {
  if (!chain) return 1
  const end = chain.rows.findIndex((row) => row.phrase == null)
  return end === -1 ? chain.rows.length : end
}

/** Last song row with any chain, -1 for an empty song. */
export function lastSongRow(model: SongModel): number {
  for (let row = model.song.length - 1; row >= 0; row -= 1) if (model.song[row]?.some((chain) => chain != null)) return row
  return -1
}

/** Values of the FX cells running one of `commands`, in lane order. */
export function fxValues(fx: FxCell[], ...commands: string[]): number[] {
  return fx.flatMap((cell) => (cell.cmd != null && cell.val != null && commands.includes(cell.cmd) ? [cell.val] : []))
}

/** Every FX lane of the song: phrase steps first, then table rows. */
export function* allFxCells(model: SongModel): Generator<FxCell[]> {
  for (const phrase of Object.values(model.phrases)) for (const step of phrase.steps) yield step.fx
  for (const table of Object.values(model.tables)) for (const row of table.rows) yield row.fx
}

/** Tables a set of FX cells points at (TBL sets the table, TBX plays one alongside). */
export const referencedTables = (fx: FxCell[]): number[] => fxValues(fx, 'TBL', 'TBX')

/** Instruments and tables the song uses, sorted. */
export function usedItems(model: SongModel): { instruments: number[]; tables: number[] } {
  const instruments = new Set<number>()
  const tables      = new Set<number>()
  for (const phrase of Object.values(model.phrases)) {
    for (const step of phrase.steps) {
      if (step.inst != null) instruments.add(step.inst)
      for (const instrument of fxValues(step.fx, 'INS')) instruments.add(instrument)
    }
  }
  for (const fx of allFxCells(model)) for (const table of referencedTables(fx)) tables.add(table)
  return {
    instruments: sortedNumbers(instruments),
    tables     : sortedNumbers(tables)
  }
}

/** Numbers the FX `commands` point at anywhere in the song (phrases and tables), sorted. */
export function referencedValues(model: SongModel, commands: string[], mask = 0xff): number[] {
  const values = new Set<number>()
  for (const fx of allFxCells(model)) for (const value of fxValues(fx, ...commands)) values.add(value & mask)
  return sortedNumbers(values)
}
