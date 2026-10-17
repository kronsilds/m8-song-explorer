// The song as read from the M8: song grid -> chains -> phrases -> instruments -> tables.
// Plain JSON so it can be stored, exported and reloaded.

import type { M8Theme } from '@yam8d/m8-sdk'

export const TRACKS = 8
export const ROWS_PER_PHRASE = 16
export const ROWS_PER_CHAIN = 16
export const SONG_ROWS = 256

export interface FxCell {
  /** Upper case command ('KIL'), null when the lane is empty. */
  cmd: string | null
  val: number | null
}

export interface PhraseStep {
  /** 'C-4', 'OFF', ... upper case; null for '---'. */
  note: string | null
  vel: number | null
  inst: number | null
  fx: FxCell[]
}

export interface Phrase {
  id: number
  steps: PhraseStep[]
}

export interface ChainRow {
  phrase: number | null
  transpose: number | null
}

export interface Chain {
  id: number
  rows: ChainRow[]
}

export interface TableRow {
  transpose: number | null
  volume: number | null
  fx: FxCell[]
}

export interface Table {
  id: number
  rows: TableRow[]
}

export interface Instrument {
  id: number
  name: string | null
  /** As the TYPE row shows it: 'SAMPLER', 'FMSYNTH', 'NONE'... */
  type: string | null
  /** Instrument screen rows (title to the last parameter), for the details panel. */
  lines: string[]
}

/** One interval row of a Scale view: semitones above the key. */
export interface ScaleNote {
  /** ON; false for a note out of the scale (the device draws it '-- -- --'); null when not read. */
  enabled: boolean | null
  /** Detune in semitones (-24..+24), null when not read. */
  offset: number | null
}

export interface Scale {
  id: number
  name: string | null
  /** The 12 interval rows, from the key up (row 'C' is the key itself). */
  notes: ScaleNote[]
  /** KEY row as a pitch class (0 = C), null when not read. The device shows the same KEY on every scale. */
  key: number | null
}

/** A Groove view: the ticks each phrase step takes. */
export interface Groove {
  id: number
  /** The 16 rows: ticks per step (00 skips the step), null for '--' (the groove loops there). */
  ticks: (number | null)[]
  /** Ticks per quarter note the rows count in (24, 48, 96 or 192), null when not read. */
  ppq: number | null
}

/** Colours the device used for each column of a view, learnt from the screen while exploring. */
export interface ObservedColumnColors {
  filled?: string
  empty?: string
}
export type ObservedColors = Record<string, Record<string, ObservedColumnColors>>

export interface SongModel {
  version: 1
  source: 'device' | 'demo' | 'file'
  capturedAt: number
  name: string | null
  /** Project tempo in BPM, when read. */
  tempo?: number | null
  /** Project TRANSPOSE as the raw byte (80-FF negative), when read. */
  projectTranspose?: number | null
  /** Project SCALE: the scale the song plays with until SCA / SCG, when read. */
  projectScale?: number | null
  /** The key shown with it on the Project view ('00C CHROMATIC'), as a pitch class. */
  projectKey?: number | null
  /** Project GROOVE: the groove every track plays with until GRV / GGR, when read. */
  projectGroove?: number | null
  /** Grooves read from the Groove view: the project's and the ones GRV / GGR point at. */
  grooves?: Record<number, Groove>
  /** Scales read from the Scale view: the project's and the ones SCA / SCG point at. */
  scales?: Record<number, Scale>
  /** song[row][track]: chain number or null. Only the rows that were read. */
  song: (number | null)[][]
  chains: Record<number, Chain>
  phrases: Record<number, Phrase>
  instruments: Record<number, Instrument>
  tables: Record<number, Table>
  observedColors: ObservedColors
  theme: M8Theme | null
  /** MIDI Settings SYNC IN / SYNC OUT as the device shows them, when read. */
  midiSync?: { syncIn: string | null; syncOut: string | null } | null
  warnings: string[]
}

export const emptyModel = (source: SongModel['source']): SongModel => ({
  version: 1,
  source,
  capturedAt: Date.now(),
  name: null,
  song: [],
  chains: {},
  phrases: {},
  instruments: {},
  tables: {},
  observedColors: {},
  theme: null,
  warnings: [],
})

export const hex2 = (n: number | null | undefined, empty = '--'): string =>
  n == null ? empty : n.toString(16).toUpperCase().padStart(2, '0')

export const emptyFx = (): FxCell => ({ cmd: null, val: null })
export const emptyStep = (): PhraseStep => ({ note: null, vel: null, inst: null, fx: [emptyFx(), emptyFx(), emptyFx()] })
export const emptyTableRow = (): TableRow => ({ transpose: 0, volume: null, fx: [emptyFx(), emptyFx(), emptyFx()] })

/** Phrases a chain plays: its rows up to the first empty one (the manual: '--' ends the chain). */
export function chainLength(chain: Chain | undefined): number {
  if (!chain) return 1
  const end = chain.rows.findIndex((r) => r.phrase == null)
  return end === -1 ? chain.rows.length : end
}

/** Last song row with any chain, -1 for an empty song. */
export function lastSongRow(model: SongModel): number {
  for (let r = model.song.length - 1; r >= 0; r -= 1) if (model.song[r]?.some((c) => c != null)) return r
  return -1
}

// ---------------------------------------------------------------------------
// Timeline: the song unrolled step by step, the way the 3D view shows it.

/** One phrase as it is played at one place of the song. */
export interface PhraseInstance {
  key: string
  track: number
  songRow: number
  chain: number
  chainRow: number
  phrase: number
  /** First timeline row of this instance. */
  row: number
}

/** A song row: the timeline rows it spans (the longest chain on that row). */
export interface SongBand {
  songRow: number
  row: number
  length: number
  /** Chain per track, null for an empty cell. */
  chains: (number | null)[]
}

export interface Timeline {
  bands: SongBand[]
  instances: PhraseInstance[]
  /** instances per track, sorted by row. */
  byTrack: PhraseInstance[][]
  /** instances of each phrase number. */
  byPhrase: Map<number, PhraseInstance[]>
  totalRows: number
}

/** Rows an empty song row takes, so it still shows as a gap. */
const EMPTY_BAND_ROWS = 1

export function buildTimeline(model: SongModel): Timeline {
  const bands: SongBand[] = []
  const instances: PhraseInstance[] = []
  const byTrack: PhraseInstance[][] = Array.from({ length: TRACKS }, () => [])
  const byPhrase = new Map<number, PhraseInstance[]>()
  const last = lastSongRow(model)
  let row = 0
  for (let r = 0; r <= last; r += 1) {
    const chains = Array.from({ length: TRACKS }, (_, t) => model.song[r]?.[t] ?? null)
    let longest = 0
    chains.forEach((chainId, track) => {
      if (chainId == null) return
      const chain = model.chains[chainId]
      const len = chainLength(chain)
      longest = Math.max(longest, len)
      for (let i = 0; i < len; i += 1) {
        const phrase = chain?.rows[i]?.phrase
        if (phrase == null) continue
        const inst: PhraseInstance = {
          key: `${track}:${r}:${i}`,
          track,
          songRow: r,
          chain: chainId,
          chainRow: i,
          phrase,
          row: row + i * ROWS_PER_PHRASE,
        }
        instances.push(inst)
        byTrack[track].push(inst)
        const list = byPhrase.get(phrase) ?? []
        list.push(inst)
        byPhrase.set(phrase, list)
      }
    })
    const length = longest > 0 ? longest * ROWS_PER_PHRASE : EMPTY_BAND_ROWS
    bands.push({ songRow: r, row, length, chains })
    row += length
  }
  return { bands, instances, byTrack, byPhrase, totalRows: row }
}

/** The instance of a track covering a timeline row, if any. */
export function instanceAt(timeline: Timeline, track: number, row: number): PhraseInstance | null {
  const list = timeline.byTrack[track]
  let lo = 0
  let hi = list.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const inst = list[mid]
    if (row < inst.row) hi = mid - 1
    else if (row >= inst.row + ROWS_PER_PHRASE) lo = mid + 1
    else return inst
  }
  return null
}

export function bandAt(timeline: Timeline, row: number): SongBand | null {
  for (const band of timeline.bands) if (row >= band.row && row < band.row + band.length) return band
  return null
}

/**
 * Instrument each step plays: the I column, or the last one set earlier on the track
 * ('--' keeps the current instrument). Keyed by instance key, 16 entries each.
 */
export function effectiveInstruments(model: SongModel, timeline: Timeline): Map<string, (number | null)[]> {
  const out = new Map<string, (number | null)[]>()
  for (const list of timeline.byTrack) {
    let current: number | null = null
    for (const inst of list) {
      const steps = model.phrases[inst.phrase]?.steps ?? []
      const row: (number | null)[] = []
      for (let s = 0; s < ROWS_PER_PHRASE; s += 1) {
        const step = steps[s]
        if (step?.inst != null) current = step.inst
        const ins = step?.fx.find((f) => f.cmd === 'INS' && f.val != null)
        if (ins?.val != null) current = ins.val
        row.push(current)
      }
      out.set(inst.key, row)
    }
  }
  return out
}

/** Tables a set of FX cells points at (TBL sets the table, TBX plays one alongside). */
export function referencedTables(fx: FxCell[]): number[] {
  return fx.filter((f) => (f.cmd === 'TBL' || f.cmd === 'TBX') && f.val != null).map((f) => f.val as number)
}

/** Instruments and tables the song uses, sorted. */
export function usedItems(model: SongModel): { instruments: number[]; tables: number[] } {
  const instruments = new Set<number>()
  const tables = new Set<number>()
  for (const phrase of Object.values(model.phrases)) {
    for (const step of phrase.steps) {
      if (step.inst != null) instruments.add(step.inst)
      for (const f of step.fx) if (f.cmd === 'INS' && f.val != null) instruments.add(f.val)
      for (const t of referencedTables(step.fx)) tables.add(t)
    }
  }
  for (const table of Object.values(model.tables)) {
    for (const row of table.rows) for (const t of referencedTables(row.fx)) tables.add(t)
  }
  const sort = (s: Set<number>) => [...s].sort((a, b) => a - b)
  return { instruments: sort(instruments), tables: sort(tables) }
}
