import { describe, expect, test } from 'bun:test'
import { advanceTableRun, hopTableRun, noteTableRun, startTableRun, type TableRun, tableRunRows } from '../src/model/music/tableRun'
import { emptyTable, type FxCell, type TableRow } from '../src/model/song'

const cell = (cmd: string, val: number): FxCell => ({
  cmd,
  val
})

/** An empty 16-row table with FX cells set at (row, lane). */
function tableWith(...cells: [row: number, lane: number, cmd: string, val: number][]): TableRow[] {
  const { rows } = emptyTable(0)
  for (const [row, lane, cmd, val] of cells) rows[row].fx[lane] = cell(cmd, val)
  return rows
}

/** The row of the transpose / volume cursor after each tick of a run of one-tick moves, starting before the first. */
function mainRowsPerTick(run: TableRun, ticks: number): number[] {
  const rows = [tableRunRows(run).main]
  for (let i = 0; i < ticks; i += 1) {
    advanceTableRun(run, 1)
    rows.push(tableRunRows(run).main)
  }
  return rows
}

describe('table run', () => {
  test('moves one row per TIC ticks and loops at the end', () => {
    const run = startTableRun(emptyTable(0).rows, 2) as TableRun
    advanceTableRun(run, 1)
    expect(tableRunRows(run).main).toBe(0)
    advanceTableRun(run, 1)
    expect(tableRunRows(run).main).toBe(1)
    advanceTableRun(run, 30)
    expect(tableRunRows(run).main).toBe(0)
  })

  test('HOP00 loops back for ever', () => {
    const run = startTableRun(tableWith([3, 0, 'HOP', 0x00]), 1) as TableRun
    expect(mainRowsPerTick(run, 8)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2])
  })

  test('HOP XY hops X times, then the table runs on', () => {
    const run = startTableRun(tableWith([3, 0, 'HOP', 0x21]), 1) as TableRun
    expect(mainRowsPerTick(run, 8)).toEqual([0, 1, 2, 1, 2, 1, 2, 3, 4])
  })

  test('a lane with its own TIC runs at its own speed', () => {
    const run = startTableRun(tableWith([0, 1, 'TIC', 2]), 1) as TableRun
    advanceTableRun(run, 4)
    expect(tableRunRows(run)).toEqual({
      main : 4,
      lanes: [4, 2, 4]
    })
  })

  test('modes with no ticks per row stand still', () => {
    expect(startTableRun(emptyTable(0).rows, 0xff)).toBeNull()
    const run = startTableRun(tableWith([0, 2, 'TIC', 0xfc]), 1) as TableRun
    advanceTableRun(run, 3)
    expect(tableRunRows(run).lanes).toEqual([3, 3, null])
  })

  test('a HOP onto its own row stops the column there; a THO moves it again', () => {
    const run = startTableRun(tableWith([2, 0, 'HOP', 0x02], [5, 1, 'THO', 0x00]), 1) as TableRun
    advanceTableRun(run, 4)
    expect(tableRunRows(run)).toEqual({
      main : 2,
      lanes: [2, 4, 4]
    })
    advanceTableRun(run, 1)
    expect(tableRunRows(run)).toEqual({
      main : 0,
      lanes: [0, 0, 0]
    })
  })

  test("a REP in a lane holds that lane on its row for the count, not the others (the transpose / volume cursor is FX1's)", () => {
    const run = startTableRun(tableWith([1, 0, 'CUT', 0x02], [2, 0, 'REP', 0x03]), 1) as TableRun
    advanceTableRun(run, 2)
    expect(tableRunRows(run)).toEqual({
      main : 2,
      lanes: [2, 2, 2]
    })
    advanceTableRun(run, 2)
    expect(tableRunRows(run)).toEqual({
      main : 2,
      lanes: [2, 4, 4]
    })
    advanceTableRun(run, 1)
    expect(tableRunRows(run)).toEqual({
      main : 3,
      lanes: [3, 5, 5]
    })
  })

  test("a HOP moves its own column only, FX1's the transpose / volume cursor too", () => {
    const run = startTableRun(tableWith([2, 1, 'HOP', 0x00]), 1) as TableRun
    advanceTableRun(run, 3)
    expect(tableRunRows(run)).toEqual({
      main : 3,
      lanes: [3, 1, 3]
    })
  })

  test('TIC 00: every column moves a row per note, time aside (device: FX1 and FX2 HOP 01 on row 2, FX3 walks on)', () => {
    const run = startTableRun(tableWith([2, 0, 'HOP', 0x01], [2, 1, 'HOP', 0x01]), 0x00, 0) as TableRun
    advanceTableRun(run, 50)
    expect(tableRunRows(run)).toEqual({
      main : 0,
      lanes: [0, 0, 0]
    })
    const rows = Array.from({ length: 4 }, () => {
      noteTableRun(run)
      return tableRunRows(run)
    })
    expect(rows.map((row) => row.lanes)).toEqual([[1, 1, 1], [1, 1, 2], [1, 1, 3], [1, 1, 4]])
    expect(rows.map((row) => row.main)).toEqual([1, 1, 1, 1])
    for (let note = 0; note < 12; note += 1) noteTableRun(run)
    expect(tableRunRows(run).lanes[2]).toBe(0)
    // A THO on a note's step sends every column to its row.
    hopTableRun(run, 7)
    expect(tableRunRows(run)).toEqual({
      main : 7,
      lanes: [7, 7, 7]
    })
  })

  test('THO hops every cursor', () => {
    const run = startTableRun(tableWith([2, 0, 'THO', 0x05]), 1) as TableRun
    advanceTableRun(run, 2)
    expect(tableRunRows(run)).toEqual({
      main : 5,
      lanes: [5, 5, 5]
    })
  })
})

