// The tables playing along with the song: each track's playhead (a position in timeline rows)
// starts the table of every note it passes, and drives it on by the ticks of the steps it
// runs through. A track has the table of its last note, and the aux table a TBX started
// beside it. See tableRun.ts for what is modelled and what is not checked on the device yet.

import { tableTicOf } from '../instrumentPage'
import { fxValues, ROWS_PER_PHRASE, type SongModel, TRACKS } from '../song'
import { instanceAt, type Timeline } from '../timeline'
import { chainStepTicks, occurrenceKey } from './groove'
import { advanceTableRun, startTableRun, type TableRun, tableRunRows } from './tableRun'

/** A move of the playhead longer than this many rows is a jump (a seek, a new chain): the tables stop. */
const MAX_MOVE_ROWS = 1.5
/** TIC of a table when neither the phrase nor the instrument tells (the device's default for TBL.TIC). */
const DEFAULT_TIC   = 1

interface TrackTables {
  last   : number | null
  /** The table of the track's last note, and the one a TBX started. */
  primary: PlayingTable | null
  aux    : PlayingTable | null
}

interface PlayingTable {
  table: number
  run  : TableRun
}

/** Where a playing table is, for drawing. */
export interface TableCursors {
  table: number
  /** The aux table (TBX) of the track, else the table of its instrument. */
  aux  : boolean
  /** Row of the transpose / volume columns. */
  main : number
  /** Row of each FX lane, null while it stands still. */
  lanes: (number | null)[]
}

export class TablePlayback {
  private readonly ticks : Map<string, number[]>
  private readonly tracks: TrackTables[] = Array.from({ length: TRACKS }, () => ({
    last   : null,
    primary: null,
    aux    : null
  }))

  constructor(
    private readonly model: SongModel,
    private readonly timeline: Timeline,
    /** The instrument each step plays, per instance key (see effectiveInstruments). */
    private readonly effective: Map<string, (number | null)[]>,
  ) {
    this.ticks = chainStepTicks(model, timeline)
  }

  /** Moves track `track`'s tables to its playhead at `position` (timeline row + phase); null stops them. */
  update(track: number, position: number | null): void {
    const state = this.tracks[track]
    const last  = state.last
    state.last  = position
    if (position == null || last == null || position < last || position - last > MAX_MOVE_ROWS) {
      state.primary = null
      state.aux     = null
      return
    }
    for (let row = Math.floor(last); row <= Math.floor(position); row += 1) {
      if (row > Math.floor(last)) this.enterStep(track, state, row)
      const share = Math.min(position, row + 1) - Math.max(last, row)
      for (const playing of [state.primary, state.aux]) if (playing) advanceTableRun(playing.run, share * this.ticksOf(track, row))
    }
  }

  /** The tables playing on a track now. */
  cursors(track: number): TableCursors[] {
    const { primary, aux } = this.tracks[track]
    return [primary, aux].flatMap((playing) =>
      playing ? [{
        ...tableRunRows(playing.run),
        table: playing.table,
        aux  : playing === aux
      }] : [],
    )
  }

  /** Ticks the step on timeline row `row` takes (0 where the track plays nothing). */
  private ticksOf(track: number, row: number): number {
    const instance = instanceAt(this.timeline, track, row)
    return instance ? (this.ticks.get(occurrenceKey(track, instance.songRow))?.[instance.chainRow * ROWS_PER_PHRASE + (row - instance.row)] ?? 0) : 0
  }

  /** The playhead came to the start of a step: its TBX, then its note, start and stop tables. */
  private enterStep(track: number, state: TrackTables, row: number): void {
    const instance = instanceAt(this.timeline, track, row)
    const index    = instance ? row - instance.row : 0
    const step     = instance ? this.model.phrases[instance.phrase]?.steps[index] : undefined
    if (!instance || !step) return
    const instrument = this.effective.get(instance.key)?.[index] ?? null
    const tic        = fxValues(step.fx, 'TIC')[0]
    const own        = tableTicOf(instrument == null ? undefined : this.model.instruments[instrument]) ?? DEFAULT_TIC
    const [aux]      = fxValues(step.fx, 'TBX')
    if (aux != null) {
      // A TIC on the same step as a TBX is the aux table's.
      state.aux = aux === 0 ? null : this.start(aux, tic ?? own)
    }
    if (step.note === 'OFF') {
      state.primary = null
    } else if (step.note && instrument != null) {
      const [table] = fxValues(step.fx, 'TBL')
      state.primary = this.start(table ?? instrument, aux == null ? (tic ?? own) : own)
    }
  }

  private start(table: number, tic: number): PlayingTable | null {
    const run = startTableRun(this.model.tables[table]?.rows, tic)
    return run ? { table, run } : null
  }
}
