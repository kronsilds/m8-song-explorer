import { describe, expect, test } from 'bun:test'
import { demoSong } from '../src/model/demo'
import { TablePlayback } from '../src/model/music/tablePlayback'
import { advanceTableRun, startTableRun, type TableRun, tableRunRows } from '../src/model/music/tableRun'
import { emptyFx, emptyStep, emptyTable, type FxCell, type TableRow } from '../src/model/song'
import { buildTimeline, effectiveInstruments } from '../src/model/timeline'

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
    expect(startTableRun(emptyTable(0).rows, 0x00)).toBeNull()
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

  test('a REP in a lane holds that lane on its row for the count, not the others', () => {
    const run = startTableRun(tableWith([1, 0, 'CUT', 0x02], [2, 0, 'REP', 0x03]), 1) as TableRun
    advanceTableRun(run, 2)
    expect(tableRunRows(run)).toEqual({
      main : 2,
      lanes: [2, 2, 2]
    })
    advanceTableRun(run, 2)
    expect(tableRunRows(run)).toEqual({
      main : 4,
      lanes: [2, 4, 4]
    })
    advanceTableRun(run, 1)
    expect(tableRunRows(run).lanes[0]).toBe(3)
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

describe('table playback', () => {
  /** The demo song with track 0's first phrase holding one note (instrument 5, TIC 04) and nothing else in its first steps. */
  function setup(extra?: (steps: ReturnType<typeof emptyStep>[]) => void) {
    const model    = demoSong()
    const timeline = buildTimeline(model)
    const first    = timeline.byTrack[0][0]
    const steps    = model.phrases[first.phrase].steps
    for (let s = 0; s < 4; s += 1) steps[s] = emptyStep()
    Object.assign(steps[0], {
      note: 'C-4',
      inst: 5,
      fx  : [cell('TIC', 4), emptyFx(), emptyFx()]
    })
    model.tables[5] = emptyTable(5)
    extra?.(steps)
    return {
      first,
      playback: new TablePlayback(model, timeline, effectiveInstruments(model, timeline))
    }
  }

  test('a note starts its table, which then follows the step ticks', () => {
    const { first, playback } = setup()
    playback.update(0, first.row - 0.5)
    expect(playback.cursors(0)).toEqual([])
    playback.update(0, first.row + 0.01)
    expect(playback.cursors(0).map((c) => [c.table, c.aux, c.main])).toEqual([[5, false, 0]])
    // A default step is six ticks: at four ticks per row the table is on its second row after one step.
    playback.update(0, first.row + 0.99)
    playback.update(0, first.row + 1)
    expect(playback.cursors(0)[0].main).toBe(1)
  })

  test('a note off stops the table, a jump of the playhead too', () => {
    const { first, playback } = setup((steps) => {
      steps[1].note = 'OFF'
    })
    playback.update(0, first.row - 0.5)
    playback.update(0, first.row + 0.5)
    expect(playback.cursors(0)).toHaveLength(1)
    playback.update(0, first.row + 1.1)
    expect(playback.cursors(0)).toEqual([])
    playback.update(0, first.row + 0.5)
    expect(playback.cursors(0)).toEqual([])
  })

  test('a TBX starts an aux table beside it', () => {
    const { first, playback } = setup((steps) => {
      steps[2].fx[1] = cell('TBX', 0x80)
    })
    playback.update(0, first.row - 0.5)
    for (const position of [0.5, 1.5, 2.5]) playback.update(0, first.row + position)
    expect(playback.cursors(0).map((c) => [c.table, c.aux])).toEqual([[5, false], [0x80, true]])
  })
})
