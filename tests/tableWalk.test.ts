import { describe, expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { arpeggioText, chordName, describeWalk, intervalsText, rowRuns, type TableWalk, unitsText, walkTable } from '../src/model/music/tableWalk'
import { emptyTable, type TableRow } from '../src/model/song'

/** An empty 16-row table with transposes (row, N) and FX cells (row, lane, cmd, value). */
function table(transposes: [row: number, n: number][], ...cells: [row: number, lane: number, cmd: string, val: number][]): TableRow[] {
  const { rows } = emptyTable(0)
  for (const [row, n] of transposes) rows[row].transpose = n
  for (const [row, lane, cmd, val] of cells) rows[row].fx[lane] = {
    cmd,
    val
  }
  return rows
}

/** The TM8C arpeggio: a minor chord on rows 0-3, a HOP00 on row 4 sends it back. */
const ARPEGGIO = table([[0, 0x00], [1, 0x03], [2, 0x07], [3, 0x0c]], [4, 0, 'HOP', 0x00])

/** walkTable for a TIC that is walked. */
function walked(rows: TableRow[], tic: number): TableWalk {
  const walk = walkTable(rows, tic)
  if (!walk) throw new Error(`TIC ${tic} is not walked`)
  return walk
}

describe('walking a table', () => {
  test('an arpeggio loops its four rows', () => {
    const walk = walked(ARPEGGIO, 1)
    expect(walk.unit).toBe('tick')
    expect(walk.cursors[0]).toEqual({
      kind      : 'loop',
      intro     : [],
      loop      : [0, 1, 2, 3],
      introUnits: 0,
      loopUnits : 4
    })
    // The other lanes do not obey FX1's HOP: they play all 16 rows.
    expect(walk.cursors[2].loop).toHaveLength(16)
    expect(describeWalk(walk.cursors[0], 'tick', 120)).toBe('loops rows 0–3, 4 ticks, 83 ms per pass')
  })

  test('a table LFO made of CUT and REP rows, at 200 Hz', () => {
    const rows = table([], [0, 0, 'CUT', 0x02], [1, 0, 'REP', 0x05], [2, 0, 'CUT', 0xfe], [3, 0, 'REP', 0x0b], [4, 0, 'CUT', 0x02], [5, 0, 'REP', 0x05], [6, 0, 'HOP', 0x00])
    const walk = walked(rows, 0xff)
    expect(walk.unit).toBe('fast')
    expect(walk.cursors[1].loop).toEqual([0, 1, 2, 3, 4, 5])
    expect(walk.cursors[1].loopUnits).toBe(24)
    expect(describeWalk(walk.cursors[1], 'fast', null)).toBe('loops rows 0–5, 120 ms per pass')
  })

  test('a HOP onto its own row plays the table once', () => {
    const walk = walked(table([], [15, 0, 'HOP', 0x0f]), 1)
    expect(walk.cursors[0].kind).toBe('stop')
    expect(walk.cursors[1].intro).toHaveLength(16)
    expect(describeWalk(walk.cursors[1], 'tick', 120)).toBe('plays rows 0–F once and stops on row F, 15 ticks, 313 ms after the note')
  })

  test('HOP XY repeats a stretch X times, then the table runs on', () => {
    const walk = walked(table([], [3, 0, 'HOP', 0x21]), 1)
    expect(walk.cursors[1].loop).toEqual([0, 1, 2, 1, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(rowRuns(walk.cursors[1].loop)).toBe('0–2, 1–2, 1–F')
  })

  test('a lane with its own TIC loops at its own speed', () => {
    const walk = walked(table([], [0, 2, 'TIC', 0x03], [2, 2, 'HOP', 0x00]), 1)
    expect(walk.cursors[3].loop).toEqual([0, 1])
    expect(walk.cursors[3].loopUnits).toBe(6)
  })

  test('TIC 00 counts notes, the maps pick a row and are not walked', () => {
    const walk = walked(ARPEGGIO, 0x00)
    expect(walk.unit).toBe('note')
    expect(describeWalk(walk.cursors[0], 'note', null)).toBe('loops rows 0–3, 4 notes per pass')
    expect(walkTable(ARPEGGIO, 0xfe)).toBeNull()
  })
})

describe('words', () => {
  test('chords, intervals and notes', () => {
    expect(chordName([0x00, 0x03, 0x07, 0x0c])).toBe('minor chord')
    expect(chordName([0, 4, 7, 11])).toBe('major 7th chord')
    expect(chordName([0, 12])).toBe('octaves')
    expect(chordName([3, 7])).toBeNull()
    expect(chordName([0, 0])).toBeNull()
    expect(intervalsText([0, 0, 3, 7, 12])).toBe('0 +3 +7 +12')
    expect(arpeggioText('C-4', [0, 3, 7, 12])).toBe('C-4 D#4 G-4 C-5')
  })

  test('durations', () => {
    expect(unitsText(24, 'tick', 120)).toBe('24 ticks (4 steps), 500 ms')
    expect(unitsText(1, 'tick', null)).toBe('1 tick')
    expect(unitsText(3, 'fast', null)).toBe('15 ms')
  })
})

describe('the selection panel on a table cell', () => {
  test('says how fast the table runs, where the column goes, and the chord it spells', () => {
    const model     = demoSong()
    model.tempo     = 120
    model.tables[0] = {
      id  : 0,
      rows: ARPEGGIO
    }
    const facts     = Object.fromEntries(describeSelection(model, {
      kind      : 'table',
      table     : 0,
      row       : 6,
      column    : 'transpose',
      track     : 0,
      instrument: 0
    }).facts)
    expect(facts.Speed).toMatch(/^TIC [0-9A-F]{2}: one row every/)
    expect(facts['Started by']).toMatch(/note/)
    expect(facts['N and V']).toMatch(/^loops rows 0–3/)
    expect(facts['Not played']).toBe('N and V never reach row 6')
    expect(facts['N column']).toBe('0 +3 +7 +12 st: minor chord')
  })
})
