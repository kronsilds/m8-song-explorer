import { expect, test } from 'bun:test'
import { describeSelection } from '../src/m8/semantics'
import { demoSong } from '../src/model/demo'
import { incrementText, parameterBase, repeatedCell, repeatLanes, repeatRuns, repeatText, stepQuarters, traceLane } from '../src/model/music/repeats'
import { emptyModel, emptyStep, type FxCell, type PhraseStep } from '../src/model/song'
import { buildSongContext } from '../src/model/songContext'

const fx     = (cmd: string | null, val: number | null = null): FxCell => ({
  cmd,
  val
})
const empty  = fx(null)
/** An instrument whose CUTOFF is `value`. */
const cutoff = (value: number) => (cmd: string) => (cmd === 'CUT' ? value : null)

test('a REP step is a signed number of quarters: 01 is +0.25, 04 +1, 7F +31.75, 80 -32, FC -1, FF -0.25', () => {
  expect([0x01, 0x04, 0x7f, 0x80, 0xfc, 0xff].map(incrementText)).toEqual(['+0.25', '+1', '+31.75', '−32', '−1', '−0.25'])
  expect([0x01, 0x7f, 0x80, 0xff].map(stepQuarters)).toEqual([1, 127, -128, -1])
})

test('REP shifts the computed value: CUTOFF 40 with CUT 70 is B0, REP 04 adds 1 per row', () => {
  const { rows } = traceLane([fx('CUT', 0x70), fx('REP', 0x04), empty, empty], cutoff(0x40))
  expect(rows.map((row) => row.event)).toEqual(['set', 'rep', 'continue', 'continue'])
  expect(rows.map((row) => row.computed)).toEqual([null, 177 * 4, 178 * 4, 179 * 4])
  // The cells show the value the parameter has (B1, B2, B3), not the shift the lane carries.
  expect(rows.map((row) => row.value)).toEqual([null, 0xb1, 0xb2, 0xb3])
  expect(rows[2]).toMatchObject({
    base    : 0x40,
    relative: true
  })
  expect(repeatedCell(rows[2])).toEqual([null, 'CUT', 'B2'])
  expect(repeatRuns(rows)).toEqual([[1, 3]])
})

test('the computed value keeps its quarters: REP 01 adds 0.25 per row', () => {
  const { rows } = traceLane([fx('CUT', 0x70), fx('REP', 0x01), empty, empty, empty], cutoff(0x40))
  expect(rows.map((row) => row.computed)).toEqual([null, 705, 706, 707, 708])
  expect(repeatText(rows[1])).toContain('B0 (176.25)')
  expect(repeatText(rows[2])).toContain('(176.5)')
  expect(repeatText(rows[4])).toContain('B1 (177)')
  expect(repeatText(rows[4])).toContain("the instrument's 40 (64), shifted by +113")
  expect(repeatText(rows[4])).toContain('+0.25 per row')
})

test('it stops at FF and at 00 and never wraps', () => {
  const up   = traceLane([fx('CUT', 0x0a), fx('REP', 0x7f), empty, empty, empty], cutoff(0xf0)).rows
  expect(up.map((row) => row.computed)).toEqual([null, 0xff * 4, 0xff * 4, 0xff * 4, 0xff * 4])
  expect(up[1].held).toBe('max')
  expect(repeatText(up[2])).toContain('cannot go above FF (255)')
  const down = traceLane([fx('CUT', 0x00), fx('REP', 0xfc), empty, empty, empty], cutoff(0x02)).rows
  expect(down.map((row) => row.computed)).toEqual([null, 1 * 4, 0, 0, 0])
  expect(down[2].held).toBe('min')
  expect(repeatText(down[3])).toContain('cannot go below 00 (0)')
})

test('RTO is an absolute value the computed value stops at', () => {
  const { rows } = traceLane([fx('CUT', 0x00), fx('RTO', 0xf0), fx('REP', 0x20), empty, empty], cutoff(0xe0))
  expect(rows.map((row) => row.event)).toEqual(['set', 'limit', 'rep', 'continue', 'continue'])
  expect(rows.map((row) => row.computed)).toEqual([null, null, 0xe8 * 4, 0xf0 * 4, 0xf0 * 4])
  expect(rows[3].held).toBe('limit')
  expect(repeatText(rows[4])).toContain('RTO F0 (240) is the stop value')
  expect(repeatText(rows[1])).toContain('absolute value, not a shift')
})

test('a negative REP counts down from the shift and stops at the RTO value from above', () => {
  const { rows } = traceLane([fx('CUT', 0x00), fx('RTO', 0x30), fx('REP', 0x80), empty], cutoff(0x40))
  expect(rows.map((row) => row.computed)).toEqual([null, null, 0x30 * 4, 0x30 * 4])
  expect(rows[2].held).toBe('limit')
})

test('REP 00 stops it, a new command replaces it, and a REP with nothing above is an orphan', () => {
  const stopped  = traceLane([fx('CUT', 0x10), fx('REP', 0x04), empty, fx('REP', 0), empty], cutoff(0x40)).rows
  expect(stopped.map((row) => row.event)).toEqual(['set', 'rep', 'continue', 'stop', 'none'])
  expect(stopped[4].active).toBe(false)
  expect(repeatText(stopped[3])).toContain('REP 00 stops')
  const replaced = traceLane([fx('CUT', 0x10), fx('REP', 0x04), fx('RES', 0x20), empty], cutoff(0x40)).rows
  expect(replaced.map((row) => row.event)).toEqual(['set', 'rep', 'replace', 'none'])
  expect(traceLane([fx('REP', 3)]).rows[0].event).toBe('orphan')
})

test('a parameter whose instrument value is not known shows the shift, marked with its sign', () => {
  const { rows } = traceLane([fx('PIT', 0x10), fx('REP', 0x08), empty])
  expect(rows.map((row) => row.shift)).toEqual([null, 72, 80])
  expect(rows.map((row) => row.computed)).toEqual([null, null, null])
  expect(repeatedCell(rows[2])).toEqual(['+', 'PIT', '14'])
  expect(repeatText(rows[2])).toContain("PIT is now +20 from the instrument's own value")
  expect(repeatText(rows[2])).toContain('(+14)')
  // Going down: the cell shows the size of the shift after a minus, not a two's complement byte.
  const down     = traceLane([fx('PIT', 0xfe), fx('REP', 0xfc), empty, empty]).rows
  expect(down.map((row) => row.shift)).toEqual([null, -12, -16, -20])
  expect(repeatedCell(down[3])).toEqual(['-', 'PIT', '05'])
  expect(repeatText(down[3])).toContain('PIT is now −5 from')
})

test("the instrument's own value is read for FM amounts, sampler loop and length, and modulator amounts", () => {
  const { instruments } = demoSong()
  const of              = (type: string) => Object.values(instruments).find((instrument) => instrument.type === type)
  expect(parameterBase(of('FMSYNTH'), 'FM1')).toBe(0x70)
  expect(parameterBase(of('SAMPLER'), 'LEN')).toBe(0xa0)
  expect(parameterBase(of('SAMPLER'), 'LOP')).toBe(0x00)
  expect(parameterBase(of('SAMPLER'), 'CUT')).toBe(0xc8)
  // EA2 moves the amount of modulator 2 (Inst. Mods view).
  expect(parameterBase(instruments[0], 'EA2')).toBe(0xff)
  // No value on the instrument's screens: these show a shift.
  for (const cmd of ['PIT', 'VOL', 'FIN']) expect(parameterBase(of('SAMPLER'), cmd)).toBeNull()
})

test('a REP of a command that is not relative counts its own value', () => {
  const { rows } = traceLane([fx('KIL', 0x02), fx('REP', 0x04), empty])
  expect(rows.map((row) => row.computed)).toEqual([null, 3 * 4, 4 * 4])
  expect(rows[2].relative).toBe(false)
})

function twoPhraseSong() {
  const model      = emptyModel('demo')
  const steps      = (cells: [number, FxCell][]): PhraseStep[] => {
    const list = Array.from({ length: 16 }, emptyStep)
    for (const [step, cell] of cells) list[step].fx[1] = cell
    return list
  }
  model.phrases[0] = {
    id   : 0,
    steps: steps([[14, fx('VOL', 0x10)], [15, fx('REP', 0x03)]])
  }
  model.phrases[1] = {
    id   : 1,
    steps: steps([])
  }
  model.chains[0]  = {
    id  : 0,
    rows: [0, 1, 0].map((phrase) => ({
      phrase,
      transpose: 0
    }))
  }
  model.song[0]    = [0, null, null, null, null, null, null, null]
  return buildSongContext(model)
}

test('the REP carries across the phrases of a chain with its quarters', () => {
  const song              = twoPhraseSong()
  const [, second, third] = song.timeline.byTrack[0]
  // VOL has no instrument value here, so the shift is counted: 16 + 0.75 on step F, then 0.75 a row.
  expect(repeatLanes(song).get(second.key)?.[1][0]).toMatchObject({
    carried: true,
    event  : 'continue',
    shift  : 70,
    value  : 0x11
  })
  expect(repeatLanes(song).get(third.key)?.[1][0]).toMatchObject({
    carried: true,
    event  : 'continue',
    shift  : 118,
    value  : 0x1d
  })
})

test('the panel explains a REP in decimal, and names one carried in from the previous phrase', () => {
  const song     = twoPhraseSong()
  const instance = song.timeline.byTrack[0][1]
  const details  = describeSelection(song, {
    kind  : 'step',
    instance,
    step  : 2,
    column: 'fx2cmd'
  })
  const text     = details.facts.find(([label]) => label === 'Repeat')?.[1]
  expect(text).toContain('+0.75 per row')
  expect(text).toContain('previous phrase')
  expect(text).toContain('VOL')
  // The SDK's whole-number reading of the lane is not shown next to it.
  expect(details.parts.some((part) => part.kind === 'fxLane')).toBe(false)
})

