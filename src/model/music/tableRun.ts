// A table as it plays: where its rows are, tick by tick, after a note started it. Four cursors
// walk it, one for the transpose / volume columns and one per FX lane, since each lane can run
// at its own speed (TIC in the lane) and hop on its own (HOP). THO hops them all.
//
// Only the modes with a plain ticks-per-row rate are played (TIC 01-FB). TIC 00 (one row per
// trigger), FC-FE (a row picked by octave, velocity or note) and FF (200 Hz) have no row to
// follow over time, so a cursor in one of them stands still.
//
// Not yet checked on the device (all of this follows the manual's wording):
// - a note restarts its table at row 0 and a note off stops it;
// - HOP XY in a lane hops that lane, and also the transpose / volume cursor (so a HOP shortens
//   the whole table); X = 0 hops for ever, else X times, then the table runs on past it;
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
  row : number
  /** Ticks per row, 0 for a mode without one (the cursor stands still). */
  rate: number
  /** Ticks spent on the row so far. */
  into: number
  /** Hops still to take at a HOP cell ('lane:row'). */
  hops: Map<string, number>
}

export interface TableRun {
  rows   : TableRow[]
  cursors: Cursor[]
}

/** A TIC value as a rate: 0 when it is a mode with no ticks per row. */
export const plainRate = (tic: number): number => (tic >= 1 && tic <= MAX_PLAIN_TIC ? tic : 0)

/** Starts a table at its first row at `tic` (TIC value); null when it has no rows or runs in no plain mode. */
export function startTableRun(rows: TableRow[] | undefined, tic: number): TableRun | null {
  const rate = plainRate(tic)
  if (!rows?.length || !rate) return null
  const run: TableRun = {
    rows,
    cursors: Array.from({ length: CURSORS }, () => ({
      row : 0,
      rate,
      into: 0,
      hops: new Map()
    }))
  }
  for (let index = 0; index < CURSORS; index += 1) enter(run, index, 0)
  return run
}

/** The lanes whose commands a cursor obeys: its own, or every lane for the transpose / volume cursor. */
const lanesOf = (index: number): number[] => (index === 0 ? Array.from({ length: FX_LANES }, (_, lane) => lane) : [index - 1])

/** Runs the commands of the row a cursor has just come to (TIC, HOP, THO). */
function enter(run: TableRun, index: number, depth: number): void {
  const cursor = run.cursors[index]
  const row    = run.rows[cursor.row]
  if (!row) return
  for (const lane of lanesOf(index)) {
    const fx = row.fx[lane]
    if (!fx || fx.cmd == null || fx.val == null) continue
    const { cmd, val } = fx
    if (cmd === 'TIC' && index > 0) cursor.rate = plainRate(val)
    if (depth >= MAX_HOP_DEPTH) continue
    if (cmd === 'THO') {
      const target = val & 0x0f
      for (const other of run.cursors) {
        other.row  = target
        other.into = 0
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

/** Moves the run on by `ticks`. The cursors move together, so a THO of one takes the others along at that moment. */
export function advanceTableRun(run: TableRun, ticks: number): void {
  let remaining = ticks
  for (let moves = 0; remaining > 1e-9 && moves < MAX_MOVES; moves += 1) {
    const moving = run.cursors.filter((cursor) => cursor.rate > 0)
    if (!moving.length) return
    const next = Math.min(remaining, ...moving.map((cursor) => cursor.rate - cursor.into))
    for (const cursor of moving) cursor.into += next
    remaining -= next
    run.cursors.forEach((cursor, index) => {
      if (cursor.rate <= 0 || cursor.rate - cursor.into > 1e-9) return
      cursor.row  = (cursor.row + 1) % ROWS_PER_TABLE
      cursor.into = 0
      enter(run, index, 0)
    })
  }
}

/** Where the run is: the row of the transpose / volume columns, and of each FX lane (null while it stands still). */
export function tableRunRows(run: TableRun): { main: number; lanes: (number | null)[] } {
  const [main, ...lanes] = run.cursors
  return {
    main : main.row,
    lanes: lanes.map((cursor) => (cursor.rate > 0 ? cursor.row : null))
  }
}
