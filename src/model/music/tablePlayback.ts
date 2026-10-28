// The tables playing along with the song. Each track's playhead (the tracker's: a timeline row,
// how far into it, and a serial that changes as each step starts, also when a HOP or a loop plays
// a step again) starts the table of every note it plays and drives it on by the ticks of its
// steps. A track has the table of its last note, and the aux table a TBX started beside it. See
// tableRun.ts for how a table moves (TIC 00: a row per note).
//
// Some steps are left to chance: a CHA XY plays the note, and the FX left of it, X times in 15
// (the FX right of it Y times), and an RND in a lane picks the value of the command last used in
// that lane, so an RND under a THO sends the table to a random row (RNL: the command left of it).
// What the M8 really did shows on its track panel, the note each track plays (device, fw 6.5): a
// note that changes says the step played. The note cannot say the row: it comes with the table's
// transpose, but also quantized by the scale and moved by TSP on other tracks. So a table sent to
// a random row is not drawn until the Table view shows it: its markers place a table exactly
// (see observeTableView). A row that may be one off (a chance note no note change could tell)
// is drawn fainter.

import { tableTicOf } from '../instrumentPage'
import { FX_LANES, fxValues, type PhraseStep, ROWS_PER_PHRASE, type SongModel, type TableRow, TRACKS } from '../song'
import { instanceAt, type Timeline } from '../timeline'
import { chainStepTicks, occurrenceKey } from './groove'
import { noteNumber } from './pitch'
import {
  advanceTableRun,
  copyTableRun,
  hopTableRun,
  noteTableRun,
  placeTableRun,
  startTableRun,
  type TableRun,
  tableRunPerNote,
  tableRunRows
} from './tableRun'

/** TIC of a table when neither the phrase nor the instrument tells (the device's default for TBL.TIC). */
export const DEFAULT_TIC   = 1
/** CHA XY: X and Y count in fifteenths, F is always. */
export const ALWAYS        = 0x0f
/** Steps the serial may move on between two frames and still be followed one by one; more is a fresh placing. */
const MAX_STEP_GAP         = 4
/** How long after a step starts its note may show on the track panel (screen reads, redraw, latency). */
const NOTE_SHOWS_WITHIN_MS = 160
/** A note may show a little before the step's start as the tracker has it. */
const NOTE_EARLY_MS        = 40

/** A table a step starts, and the TIC it runs at. */
export interface TableStart {
  table: number
  tic  : number
}

/** What a step does to its track's tables. */
export interface StepTables {
  /** A TBX on the step: the aux table it starts, or null when it stops it (TBX 00). Undefined without a TBX. */
  aux?     : TableStart | null
  /** The note starts the table of its instrument (or the one a TBL names). */
  primary  : TableStart | null
  /** A note off: the instrument's table stops. */
  off      : boolean
  /** A THO on the step: the row the table goes to (the aux table's when a TBX is on the step too). */
  tho      : number | null
  /** The THO's row is picked at random: an RND under it, an RNL right of it, or a THO the step's RND picks again. */
  randomRow: boolean
  /** Times in 15 the note plays (a CHA's X), 15 without a CHA. */
  chance   : number
  /** Times in 15 the THO plays: X when it is left of the CHA, Y right of it. */
  thoChance: number
}

const randomizers = ['RND', 'RNL']

/**
 * The tables step `step` starts or stops, playing instrument `instrument` (the I column or the last
 * one before it); `before` are the phrase's steps above it, for what an RND picks again.
 */
export function stepTables(model: SongModel, step: PhraseStep, instrument: number | null, before: PhraseStep[] = []): StepTables {
  const tic     = fxValues(step.fx, 'TIC')[0]
  const own     = tableTicOf(instrument == null ? undefined : model.instruments[instrument]) ?? DEFAULT_TIC
  const [aux]   = fxValues(step.fx, 'TBX')
  const chaLane = step.fx.findIndex((fx) => fx.cmd === 'CHA' && fx.val != null)
  const cha     = chaLane < 0 ? null : (step.fx[chaLane].val as number)
  const thoLane = step.fx.findIndex((fx) => fx.cmd === 'THO' && fx.val != null)
  const picked  = randomTho(step, before)
  const lane    = thoLane >= 0 ? thoLane : (picked?.lane ?? -1)
  const tho     = thoLane >= 0 ? (step.fx[thoLane].val as number) & 0x0f : (picked?.value ?? null)
  const out     : StepTables = {
    primary  : null,
    off      : step.note === 'OFF',
    tho,
    randomRow: picked != null,
    chance   : cha == null ? ALWAYS : cha >> 4,
    thoChance: cha == null || lane < 0 ? ALWAYS : lane < chaLane ? cha >> 4 : cha & 0x0f
  }
  // A TIC on the same step as a TBX is the aux table's.
  if (aux != null) out.aux = aux === 0 ? null : {
    table: aux,
    tic  : tic ?? own
  }
  if (step.note && !out.off && instrument != null) {
    const [table] = fxValues(step.fx, 'TBL')
    out.primary   = {
      table: table ?? instrument,
      tic  : aux == null ? (tic ?? own) : own
    }
  }
  return out
}

/** A THO an RND or RNL on the step sends to a random row: its lane and written row; null when there is none. */
function randomTho(step: PhraseStep, before: PhraseStep[]): { lane: number; value: number } | null {
  for (let lane = 0; lane < FX_LANES; lane += 1) {
    const cmd = step.fx[lane]?.cmd
    if (cmd === 'RNL' && step.fx[lane - 1]?.cmd === 'THO') return {
      lane : lane - 1,
      value: (step.fx[lane - 1].val ?? 0) & 0x0f
    }
    if (cmd !== 'RND') continue
    // The command last used in the lane, above the RND.
    for (let s = before.length - 1; s >= 0; s -= 1) {
      const used = before[s].fx[lane]
      if (used?.cmd == null || randomizers.includes(used.cmd)) continue
      if (used.cmd === 'THO') return {
        lane,
        value: (used.val ?? 0) & 0x0f
      }
      break
    }
  }
  return null
}

/** A table row's transpose in semitones (the byte: 80-FF go down). */
const transposeOf = (row: TableRow | undefined): number => {
  const value = row?.transpose ?? 0
  return value >= 0x80 ? value - 0x100 : value
}

/** Where a track plays, as the tracker has it. */
export interface TablePosition {
  /** Timeline row, null when the track plays nothing there. */
  row      : number | null
  phase    : number
  /** Changes as each step starts (see TrackPlayhead). */
  serial   : number
  /** When the step started, in ms. */
  startedAt: number
}

/** The note the M8's track panel shows for a track, and when it changed (ms). */
export interface TrackSound {
  /** Semitones, null for none. */
  pitch    : number | null
  changedAt: number
}

interface PlayingTable {
  table: number
  run  : TableRun
  /** False while a chance note may have moved it a row or not. */
  sure : boolean
  /** False once a random THO sent it to a row nothing says (until the Table view shows it). */
  known: boolean
}

/** A step left to chance, until the track panel says whether it played. */
interface Pending {
  tables   : StepTables
  /** The note written on the step, in semitones. */
  note     : number | null
  startedAt: number
}

interface TrackTables {
  head   : TablePosition | null
  primary: PlayingTable | null
  aux    : PlayingTable | null
  pending: Pending | null
  /** The last note the track panel showed, and the note written on the step that played last. */
  sound  : TrackSound | null
  note   : number | null
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
  /** False while a chance note may have moved it a row or not. */
  sure : boolean
  /** False while a random THO left it on a row nothing says. */
  known: boolean
}

export class TablePlayback {
  private readonly ticks : Map<string, number[]>
  private readonly tracks: TrackTables[] = Array.from({ length: TRACKS }, () => ({
    head   : null,
    primary: null,
    aux    : null,
    pending: null,
    sound  : null,
    note   : null
  }))

  constructor(
    private readonly model: SongModel,
    private readonly timeline: Timeline,
    /** The instrument each step plays, per instance key (see effectiveInstruments). */
    private readonly effective: Map<string, (number | null)[]>,
  ) {
    this.ticks = chainStepTicks(model, timeline)
  }

  /**
   * Moves track `track`'s tables to where it plays (null stops them), with the note its track panel
   * shows (`sound`) at time `now` (ms).
   */
  update(track: number, head: TablePosition | null, sound: TrackSound | null = null, now = 0): void {
    const state = this.tracks[track]
    const last  = state.head
    state.head  = head
    if (head?.row == null) {
      this.stop(state)
      return
    }
    if (!last || last.row == null || head.serial < last.serial) {
      // Playing starts here: the tables start from this step.
      this.stop(state)
      state.head = head
      this.enterStep(track, state, head.row, head.startedAt)
      this.advance(track, state, head.row, head.phase)
    } else if (head.serial === last.serial) {
      if (head.row === last.row && head.phase > last.phase) this.advance(track, state, head.row, head.phase - last.phase)
    } else if (head.serial - last.serial > MAX_STEP_GAP) {
      // Placed afresh by the tracker: the steps in between are not known.
      this.unsure(state)
      this.enterStep(track, state, head.row, head.startedAt)
      this.advance(track, state, head.row, head.phase)
    } else {
      // A step started (or a few): the one before ends, then each new one plays, wherever a HOP or a loop sent the track.
      this.advance(track, state, last.row, Math.max(0, 1 - last.phase))
      const gap = head.serial - last.serial
      if (gap > 1 && head.row - last.row === gap) {
        for (let row = last.row + 1; row < head.row; row += 1) {
          this.enterStep(track, state, row, head.startedAt)
          this.advance(track, state, row, 1)
        }
      }
      this.enterStep(track, state, head.row, head.startedAt)
      this.advance(track, state, head.row, head.phase)
    }
    if (sound && sound.changedAt !== state.sound?.changedAt) this.heard(state, sound)
    if (state.pending && now > state.pending.startedAt + NOTE_SHOWS_WITHIN_MS) this.settle(state)
  }

  /**
   * The Table view's markers: table `table` is on these rows (transpose / volume, then each lane),
   * for the track the M8 shows if it plays that table, else the first track that does. The
   * reading already shows what a step left to chance did, played or not: it settles it. (The
   * pitch to learn from comes with the same screen read, a frame later: see heard.)
   */
  observeTableView(table: number, main: number | null, lanes: (number | null)[], track: number | null): void {
    const playing = (t: number) => [this.tracks[t].primary, this.tracks[t].aux].find((p) => p?.table === table)
    const owner   = track != null && playing(track) ? track : this.tracks.findIndex((_, t) => playing(t))
    const found   = owner >= 0 ? playing(owner) : undefined
    if (!found) return
    placeTableRun(found.run, main, lanes)
    found.sure                 = true
    found.known                = true
    this.tracks[owner].pending = null
  }

  /** The tables playing on a track now. */
  cursors(track: number): TableCursors[] {
    const { primary, aux } = this.tracks[track]
    return [primary, aux].flatMap((playing) =>
      playing ? [{
        ...tableRunRows(playing.run),
        table: playing.table,
        aux  : playing === aux,
        sure : playing.sure,
        known: playing.known
      }] : [],
    )
  }

  private stop(state: TrackTables): void {
    state.primary = null
    state.aux     = null
    state.pending = null
  }

  private unsure(state: TrackTables): void {
    for (const playing of [state.primary, state.aux]) if (playing && tableRunPerNote(playing.run)) playing.known = false
  }

  /** Moves the tables on by `share` of the step on timeline row `row`. */
  private advance(track: number, state: TrackTables, row: number, share: number): void {
    const ticks = share * this.ticksOf(track, row)
    if (ticks <= 0) return
    for (const playing of [state.primary, state.aux]) if (playing) advanceTableRun(playing.run, ticks)
  }

  /** Ticks the step on timeline row `row` takes (0 where the track plays nothing). */
  private ticksOf(track: number, row: number): number {
    const instance = instanceAt(this.timeline, track, row)
    return instance ? (this.ticks.get(occurrenceKey(track, instance.songRow))?.[instance.chainRow * ROWS_PER_PHRASE + (row - instance.row)] ?? 0) : 0
  }

  /** The playhead came to the start of a step: what it does to the tables now, or once the track panel tells, for a step left to chance. */
  private enterStep(track: number, state: TrackTables, row: number, startedAt: number): void {
    const instance = instanceAt(this.timeline, track, row)
    const index    = instance ? row - instance.row : 0
    const steps    = instance ? this.model.phrases[instance.phrase]?.steps : undefined
    const step     = steps?.[index]
    if (!instance || !steps || !step) return
    const tables = stepTables(this.model, step, this.effective.get(instance.key)?.[index] ?? null, steps.slice(0, index))
    // A step still waiting is decided by now: what the panel showed so far.
    if (state.pending) this.settle(state)
    const note   = noteNumber(step.note)
    if (tables.chance < ALWAYS || tables.thoChance < ALWAYS) {
      state.pending = {
        tables,
        note,
        startedAt
      }
      return
    }
    this.apply(state, tables, note)
  }

  /** A step plays: its TBX, note off, note and THO. */
  private apply(state: TrackTables, tables: StepTables, note: number | null): void {
    if (tables.aux !== undefined) state.aux = tables.aux && this.start(tables.aux, tables.tho ?? 0)
    if (tables.off) {
      state.primary = null
      return
    }
    const tho = tables.aux ? null : tables.tho
    if (tables.primary) {
      const { table, tic } = tables.primary
      const current        = state.primary
      // TIC 00: the note moves the running table on a row (a THO: to its row); else the note starts the table.
      if (tic === 0 && current?.table === table && tableRunPerNote(current.run)) {
        if (tho != null) hopTableRun(current.run, tho)
        else noteTableRun(current.run)
      } else {
        state.primary = this.start(tables.primary, tho ?? 0)
      }
      state.note = note
    } else if (tho != null && state.primary) {
      hopTableRun(state.primary.run, tho)
    }
    if (tho != null && tables.randomRow && state.primary) state.primary.known = false
  }

  /** A table a note starts, on a known row. */
  private start({ table, tic }: TableStart, row: number): PlayingTable | null {
    const run = startTableRun(this.model.tables[table]?.rows, tic, row)
    return run ? {
      table,
      run,
      sure : true,
      known: true
    } : null
  }

  /** The track panel shows a new note: a step left to chance played. */
  private heard(state: TrackTables, sound: TrackSound): void {
    state.sound   = sound
    const pending = state.pending
    if (!pending || sound.changedAt < pending.startedAt - NOTE_EARLY_MS) return
    state.pending = null
    this.apply(state, pending.tables, pending.note)
  }

  /**
   * A step left to chance whose note never showed: it did not play. Unless playing it could have
   * shown the same note (the same written note on rows of the same transpose): then the table
   * may be a row off, and is unsure.
   */
  private settle(state: TrackTables): void {
    const pending = state.pending
    state.pending = null
    const primary = state.primary
    if (!pending || !primary?.known) return
    const { tables } = pending
    const rows       = primary.run.rows
    let candidates   : number[]
    if (tables.tho != null && !tables.aux) candidates = tables.randomRow ? rows.map((_, row) => row) : [tables.tho]
    else if (tables.primary?.table === primary.table && tableRunPerNote(primary.run)) {
      const tried = copyTableRun(primary.run)
      noteTableRun(tried)
      candidates  = [tableRunRows(tried).main]
    } else candidates = tables.primary ? [0] : []
    const now      = tableRunRows(primary.run).main
    const sameNote = !tables.primary || pending.note === state.note
    if (sameNote && candidates.some((row) => row !== now && transposeOf(rows[row]) === transposeOf(rows[now]))) primary.sure = false
  }
}
