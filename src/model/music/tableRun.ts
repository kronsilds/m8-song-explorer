// A table as it plays: where its rows are, tick by tick, after a note started it. Four cursors
// walk it, one for the transpose / volume columns and one per FX lane, since each lane can run
// at its own speed (TIC in the lane) and hop on its own (HOP). THO hops them all.
//
// TIC 01-FB move a row every that many ticks. TIC 00 moves every column one row each time the
// instrument plays a note (noteTableRun), and the note does not restart the table (TM8C: "steps
// per triggered note"; device, fw 6.5: a table whose FX1 and FX2 HOP 01 on row 2 kept them on
// row 1 note after note, while FX3 went 2, 3 ... F, 0). FC-FE (a row picked by octave, velocity or
// note) and FF (200 Hz) have no row to follow, so a cursor in one of them stands still.
//
// The transpose / volume cursor is FX1's: it moves at FX1's rate and with FX1's HOPs (TM8C, and
// the device table above), not with the other lanes' HOPs.
//
// Not yet checked on the device (this follows the manual's wording, or the TM8C guide's
// "Working with tables" where the manual says nothing):
// - a note restarts its table at row 0 (TIC 01-FB) and a note off stops it;
// - HOP XY in a lane: X = 0 hops for ever, else X times, then the table runs on past it;
//   a HOP row takes no time; HOP X0 onto its own row stops the cursor there (TM8C);
// - REP XX in a lane plays the command above it XX more times, so the lane stays XX rows of
//   time on the REP row (TM8C);
// - TIC in a lane sets that lane's rate from its row on;
// - the table's tick is one MIDI clock tick (24 per quarter note), the groove's unit.

import { FX_LANES, ROWS_PER_TABLE, type TableRow } from '../song'

/** Highest TIC value that is a plain ticks-per-row count. */
export const MAX_PLAIN_TIC = 0xfb
/** Cursors: the transpose / volume columns, then the FX lanes. */
const CURSORS              = FX_LANES + 1
/** Nested hops one move may take (a HOP onto a HOP, THO onto a HOP), so a loop of them ends. */
const MAX_HOP_DEPTH        = 8
/** Rows one advance may move a cursor, so a table of 1-tick rows cannot run away. */
const MAX_MOVES            = 4096

interface Cursor {
  row    : number
  /** Ticks per row, 0 for a mode without one (the cursor stands still). */
  rate   : number
  /** TIC 00: a row per note the instrument plays. */
  perNote: boolean
  /** Rows of time the row lasts: 1, or the count of a REP on it. */
  span   : number
  /** Ticks spent on the row so far. */
  into   : number
  /** A HOP onto its own row stopped it there (until a THO moves it). */
  stopped: boolean
  /** Hops still to take at a HOP cell ('lane:row'). */
  hops   : Map<string, number>
}

export interface TableRun {
  rows   : TableRow[]
  cursors: Cursor[]
}

/** A TIC value as a rate: 0 when it is a mode with no ticks per row. */
export const plainRate = (tic: number): number => (tic >= 1 && tic <= MAX_PLAIN_TIC ? tic : 0)

/**
 * Starts a table at `tic` (TIC value) on row `row` (0, or the row a THO on the note's step names);
 * null when it has no rows or runs in a mode with no row to follow (FC-FF).
 */
export function startTableRun(rows: TableRow[] | undefined, tic: number, row = 0): TableRun | null {
  const rate    = plainRate(tic)
  const perNote = tic === 0
  if (!rows?.length || (!rate && !perNote)) return null
  const run: TableRun = {
    rows,
    cursors: Array.from({ length: CURSORS }, () => ({
      row    : row % ROWS_PER_TABLE,
      rate,
      perNote,
      span   : 1,
      into   : 0,
      stopped: false,
      hops   : new Map()
    }))
  }
  for (let index = 0; index < CURSORS; index += 1) enter(run, index, 0)
  return run
}

/** The lanes whose commands a cursor obeys: its own; the transpose / volume cursor is FX1's. */
const lanesOf = (index: number): number[] => [Math.max(0, index - 1)]

/** A cursor that moves on by itself: it has a rate and no HOP stopped it. */
const moving    = (cursor: Cursor): boolean => cursor.rate > 0 && !cursor.stopped
/** Ticks until the cursor's row ends. */
const ticksLeft = (cursor: Cursor): number => cursor.rate * cursor.span - cursor.into

/** Runs the commands of the row a cursor has just come to (TIC, REP, HOP, THO). */
function enter(run: TableRun, index: number, depth: number): void {
  const cursor = run.cursors[index]
  const row    = run.rows[cursor.row]
  cursor.span  = 1
  if (!row) return
  for (const lane of lanesOf(index)) {
    const fx = row.fx[lane]
    if (!fx || fx.cmd == null || fx.val == null) continue
    const { cmd, val } = fx
    if (cmd === 'TIC') {
      cursor.rate    = plainRate(val)
      cursor.perNote = val === 0
    }
    if (cmd === 'REP' && val > 0) cursor.span = val
    if (depth >= MAX_HOP_DEPTH) continue
    if (cmd === 'THO') {
      const target = val & 0x0f
      for (const other of run.cursors) {
        other.row     = target
        other.into    = 0
        other.stopped = false
      }
      for (let i = 0; i < CURSORS; i += 1) enter(run, i, depth + 1)
      return
    }
    if (cmd === 'HOP' && hop(cursor, lane, val)) {
      enter(run, index, depth + 1)
      return
    }
  }
}

/** Takes the HOP at the cursor's row when hops are left (X = 0: always); true when it hopped. */
function hop(cursor: Cursor, lane: number, value: number): boolean {
  const key   = `${lane}:${cursor.row}`
  const times = value >> 4
  // Hopping for ever onto its own row: the cursor stays there.
  if (times === 0 && (value & 0x0f) === cursor.row) {
    cursor.stopped = true
    return false
  }
  const left  = cursor.hops.get(key) ?? (times === 0 ? Number.POSITIVE_INFINITY : times)
  if (left <= 0) {
    // Used up: the table runs on past it, and the next pass hops again.
    cursor.hops.delete(key)
    return false
  }
  cursor.hops.set(key, left - 1)
  cursor.row  = value & 0x0f
  cursor.into = 0
  return true
}

/**
 * Moves every moving cursor on by `ticks` (no further than the nearest end of a row), then the
 * ones whose row ended to their next row. The cursors move together, so a THO of one takes the
 * others along at that moment. Returns the cursors that came to a row.
 */
function moveBy(run: TableRun, ticks: number): number[] {
  const active = run.cursors.filter(moving)
  for (const cursor of active) cursor.into += ticks
  const entered: number[] = []
  run.cursors.forEach((cursor, index) => {
    if (!active.includes(cursor) || ticksLeft(cursor) > 1e-9) return
    cursor.row  = (cursor.row + 1) % ROWS_PER_TABLE
    cursor.into = 0
    enter(run, index, 0)
    entered.push(index)
  })
  return entered
}

/** Moves the run on by `ticks`. */
export function advanceTableRun(run: TableRun, ticks: number): void {
  let remaining = ticks
  for (let moves = 0; remaining > 1e-9 && moves < MAX_MOVES; moves += 1) {
    const active = run.cursors.filter(moving)
    if (!active.length) return
    const next = Math.min(remaining, ...active.map(ticksLeft))
    moveBy(run, next)
    remaining -= next
  }
}

/** The instrument played a note: every TIC 00 cursor moves on a row (the others go by ticks). */
export function noteTableRun(run: TableRun): void {
  run.cursors.forEach((cursor, index) => {
    if (!cursor.perNote || cursor.stopped) return
    cursor.row  = (cursor.row + 1) % ROWS_PER_TABLE
    cursor.into = 0
    enter(run, index, 0)
  })
}

/** A THO on a phrase step: every cursor goes to row `row`. */
export function hopTableRun(run: TableRun, row: number): void {
  for (const cursor of run.cursors) {
    cursor.row     = row % ROWS_PER_TABLE
    cursor.into    = 0
    cursor.stopped = false
  }
  for (let index = 0; index < CURSORS; index += 1) enter(run, index, 0)
}

/** Puts the cursors on the rows the M8 shows (the transpose / volume one and each lane; null leaves one where it is). */
export function placeTableRun(run: TableRun, main: number | null, lanes: (number | null)[]): void {
  const rows = [main ?? lanes[0] ?? null, ...lanes]
  run.cursors.forEach((cursor, index) => {
    const row = rows[index]
    if (row == null || row === cursor.row) return
    cursor.row     = row
    cursor.into    = 0
    cursor.span    = 1
    cursor.stopped = false
  })
}

/** True when a column of the run moves a row per note (TIC 00). */
export const tableRunPerNote = (run: TableRun): boolean => run.cursors.some((cursor) => cursor.perNote)

/** A copy that moves on its own (to try what a note would do). */
export const copyTableRun = (run: TableRun): TableRun => ({
  rows   : run.rows,
  cursors: run.cursors.map((cursor) => ({
    ...cursor,
    hops: new Map(cursor.hops)
  }))
})

/** Moves the run to the next time a cursor comes to a row: the ticks that took and the cursors that did; null when none moves any more. */
export function stepTableRun(run: TableRun): { ticks: number; entered: number[] } | null {
  const active = run.cursors.filter(moving)
  if (!active.length) return null
  const ticks = Math.min(...active.map(ticksLeft))
  return {
    ticks,
    entered: moveBy(run, ticks)
  }
}

/** Everything that decides where the run goes from now, as a key: two equal keys play on the same. */
export const tableRunKey = (run: TableRun): string =>
  run.cursors
    .map((cursor) => [cursor.row, cursor.rate, cursor.perNote ? 1 : 0, cursor.span, cursor.into, cursor.stopped ? 1 : 0, [...cursor.hops].sort().join(',')].join(':'))
    .join('|')

/** Each cursor (transpose / volume first, then the FX lanes): its row, its rate (0: a mode without one), and whether a HOP stopped it. */
export const tableRunCursors = (run: TableRun): { row: number; rate: number; stopped: boolean }[] =>
  run.cursors.map((cursor) => ({
    row    : cursor.row,
    rate   : cursor.rate,
    stopped: cursor.stopped
  }))

/** Where the run is: the row of the transpose / volume columns, and of each FX lane (null while it stands still). */
export function tableRunRows(run: TableRun): { main: number; lanes: (number | null)[] } {
  const [main, ...lanes] = run.cursors
  return {
    main : main.row,
    lanes: lanes.map((cursor) => (cursor.rate > 0 || cursor.perNote ? cursor.row : null))
  }
}
