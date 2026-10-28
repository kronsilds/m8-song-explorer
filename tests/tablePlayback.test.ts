// TablePlayback: the tables playing along with the song, driven by the tracker's playheads and put
// right by what the M8 shows (its track panel's notes, its Table view's markers).

import { describe, expect, test } from 'bun:test'
import { tableTicOf } from '../src/model/instrumentPage'
import { TablePlayback, type TablePosition } from '../src/model/music/tablePlayback'
import { emptyModel, emptyStep, emptyTable, type FxCell, type PhraseStep, ROWS_PER_PHRASE, type SongModel } from '../src/model/song'
import { buildTimeline, effectiveInstruments } from '../src/model/timeline'

const cell = (cmd: string, val: number): FxCell => ({
  cmd,
  val
})

/** An instrument whose table runs at TBL.TIC `tic`, as the Instrument view shows it. */
const instrument = (id: number, tic: string) => ({
  id,
  name : null,
  type : 'SAMPLER',
  lines: [`INST. ${String(id).padStart(2, '0')}`, '', 'TYPE    SAMPLER       LOAD SAVE', 'NAME    ------------', `TRANSP. ON   TBL.TIC ${tic}   EQ --`]
})

/** Track 1 plays phrase 00 alone in chain 00, its next song row empty; `steps` sets its steps. */
function song(tic: string, steps: (steps: PhraseStep[]) => void): SongModel {
  const model  = emptyModel('demo')
  const phrase = Array.from({ length: ROWS_PER_PHRASE }, emptyStep)
  steps(phrase)
  model.phrases        = {
    0: {
      id   : 0,
      steps: phrase
    }
  }
  model.chains         = {
    0: {
      id  : 0,
      rows: Array.from({ length: 16 }, (_, row) => ({
        phrase   : row === 0 ? 0 : null,
        transpose: 0
      }))
    }
  }
  model.song           = [[0, null, null, null, null, null, null, null]]
  model.instruments[5] = instrument(5, tic)
  // Table 05 transposes each row by its number, as GEN_INTERMIS's tables 01 and 06 do.
  const table          = emptyTable(5)
  table.rows.forEach((row, index) => {
    row.transpose = index
  })
  model.tables[5] = table
  return model
}

const note = (step: PhraseStep, ...fx: FxCell[]) => Object.assign(step, {
  note: 'C-4',
  inst: 5,
  fx  : [fx[0] ?? cell('---', 0), fx[1] ?? cell('---', 0), fx[2] ?? cell('---', 0)].map((f) => (f.cmd === '---' ? {
    cmd: null,
    val: null
  } : f))
})

function playback(model: SongModel): TablePlayback {
  const timeline = buildTimeline(model)
  return new TablePlayback(model, timeline, effectiveInstruments(model, timeline))
}

/** The tracker's playhead: step `serial` of the track is timeline row `row`, `phase` into it, started at `startedAt` ms. */
const head = (row: number, serial: number, phase = 0.1, startedAt = serial * 125): TablePosition => ({
  row,
  phase,
  serial,
  startedAt
})

/** C-4 (48) as the track panel shows it with the table's transpose `row`, at `at` ms. */
const shows = (row: number, at: number) => ({
  pitch    : 48 + row,
  changedAt: at
})

describe('table playback', () => {
  test('the instrument says how its table runs', () => {
    expect(tableTicOf(instrument(5, '00'))).toBe(0)
    expect(tableTicOf(instrument(5, '01'))).toBe(1)
  })

  test('a note starts its table, which then follows the step ticks; a note off stops it', () => {
    const tables = playback(song('04', (steps) => {
      note(steps[0])
      steps[3].note = 'OFF'
    }))
    tables.update(0, head(0, 0, 0.01))
    expect(tables.cursors(0).map((c) => [c.table, c.main, c.sure])).toEqual([[5, 0, true]])
    // A default step is six ticks: at four ticks per row the table is on its second row after one step.
    tables.update(0, head(0, 0, 0.99))
    tables.update(0, head(1, 1, 0.01))
    expect(tables.cursors(0)[0].main).toBe(1)
    tables.update(0, head(2, 2, 0.5))
    tables.update(0, head(3, 3, 0.5))
    expect(tables.cursors(0)).toEqual([])
  })

  test('a step a HOP plays again starts its note\'s table again, wherever the playhead jumps', () => {
    const tables = playback(song('02', (steps) => {
      note(steps[1])
      steps[2].fx[1] = cell('HOP', 0x01)
    }))
    tables.update(0, head(0, 0, 0.5))
    tables.update(0, head(1, 1, 0.9))
    expect(tables.cursors(0)[0].main).toBe(2)
    // HOP 01 on step 2: step 1 plays again (the serial moves on, the row goes back).
    tables.update(0, head(1, 2, 0.1))
    expect(tables.cursors(0)[0].main).toBe(0)
  })

  test('TIC 00: each note moves the table a row, and a THO on the step sends it to its row', () => {
    const tables = playback(song('00', (steps) => {
      note(steps[0], cell('THO', 0x03))
      note(steps[1])
      steps[2].fx[1] = cell('HOP', 0x01)
    }))
    tables.update(0, head(0, 0))
    expect(tables.cursors(0)[0].main).toBe(3)
    // Time alone does not move it.
    tables.update(0, head(0, 0, 0.9))
    expect(tables.cursors(0)[0].main).toBe(3)
    for (let serial = 1; serial <= 3; serial += 1) tables.update(0, head(1, serial))
    expect(tables.cursors(0)[0]).toMatchObject({
      main: 6,
      sure: true
    })
  })

  /** GEN_INTERMIS's tracks 2-4: step 0 THO 00, step 1 a chance note whose RND picks the THO's row again, HOP 01 loops step 1. */
  const randomSong = () =>
    song('00', (steps) => {
      note(steps[0], cell('THO', 0x00))
      note(steps[1], cell('RND', 0x0f), cell('CHA', 0x64))
      steps[2].fx[1] = cell('HOP', 0x01)
    })

  test('a chance note the track panel shows played sends the table to a random row: not drawn until the Table view shows it', () => {
    const tables = playback(randomSong())
    tables.update(0, head(0, 0, 0.1, 0), shows(0, 20), 30)
    expect(tables.cursors(0)[0]).toMatchObject({
      main : 0,
      sure : true,
      known: true
    })
    // Step 1 starts at 125 ms; the panel shows another note at 170 ms: the note played, the RND sent the table somewhere.
    tables.update(0, head(1, 1, 0.1, 125), shows(0, 20), 130)
    expect(tables.cursors(0)[0].known).toBe(true)
    tables.update(0, head(1, 1, 0.5, 125), shows(9, 170), 180)
    expect(tables.cursors(0)[0].known).toBe(false)
    tables.observeTableView(5, 9, [9, 9, 9], 0)
    expect(tables.cursors(0)[0]).toMatchObject({
      main : 9,
      lanes: [9, 9, 9],
      known: true
    })
  })

  test('a chance note the panel never shows did not play: the table stays', () => {
    const tables = playback(randomSong())
    tables.update(0, head(0, 0, 0.1, 0), shows(4, 20), 30)
    tables.update(0, head(1, 1, 0.1, 125), shows(4, 20), 130)
    tables.update(0, head(1, 1, 0.9, 125), shows(4, 20), 400)
    expect(tables.cursors(0)[0]).toMatchObject({
      main : 0,
      sure : true,
      known: true
    })
  })

  test('a chance note the panel could not tell (rows of the same transpose) leaves the table unsure', () => {
    const model = song('00', (steps) => {
      note(steps[0])
      note(steps[1], cell('CHA', 0x84))
      steps[2].fx[1] = cell('HOP', 0x01)
    })
    // A flat table: every row gives the same note.
    model.tables[5].rows.forEach((row) => {
      row.transpose = 0
    })
    const tables = playback(model)
    tables.update(0, head(0, 0, 0.1, 0), shows(0, 20), 30)
    tables.update(0, head(1, 1, 0.1, 125), shows(0, 20), 130)
    tables.update(0, head(1, 1, 0.9, 125), shows(0, 20), 400)
    expect(tables.cursors(0)[0]).toMatchObject({
      main : 0,
      sure : false,
      known: true
    })
    tables.observeTableView(5, 1, [1, 1, 1], 0)
    expect(tables.cursors(0)[0]).toMatchObject({
      main: 1,
      sure: true
    })
  })
})
