import { describe, expect, test } from 'bun:test'
import { DeviceCursor } from '../src/app/deviceCursor'
import { absorbScreen } from '../src/m8/screen/liveScreen'
import { isPage, readInstrument, readInstrumentMods, viewOf } from '../src/m8/screen/screenReader'
import { describeSelection } from '../src/m8/semantics'
import { exploreSong } from '../src/m8/tasks/explorer'
import { demoSong } from '../src/model/demo'
import { cellAt, instrumentCells, instrumentPage, modCells, modSlots } from '../src/model/instrumentPage'
import { modShape } from '../src/model/modShapes'
import { INSTRUMENT_TEMPLATES, instrumentLines, instrumentModsLines, MOD_ROWS, storedScreen } from '../src/model/screens'
import { usedItems } from '../src/model/song'
import { FACE_CHARS, isTitlePlace, layoutInstrumentFace, MOD_CARD_ROWS, MODS_X, placeAt, placeOf } from '../src/scene/instrumentFace'
import { PANEL_ROWS, SongLayout } from '../src/scene/layout'
import { FakeM8 } from './fakeM8'

// Captured on the device (Model:02, fw 6.5, 2026-10-21): stored lines, title row first, no margin.
const FM_SCREEN = [
  'INST. 01',
  '',
  'TYPE    FMSYNTH       LOAD SAVE',
  'NAME    GRAYSATURN--',
  'TRANSP. ON   TBL.TIC 0E   EQ --',
  '',
  'ALGO    02[A>B+C]>D',
  '        A SW4 B W0F C SIN D SIN',
  'RATIO   01.00 01.00 01.00 01.00',
  'LEV/FB  80/00 80/00 80/00 80/00',
  'MOD     1>RAT ----- ----- -----',
  '        ----- ----- ----- -----',
  'MOD1    70        AMP 00',
  'MOD2    00        LIM 00CLIP',
  'MOD3    00        PAN 80',
  'MOD4    00        DRY C0',
  'FILTER  01LOWPASS MFX 00',
  'CUTOFF  8F        DEL C0',
  'RES     B0        REV 00',
]

const MODS_SCREEN = [
  'INST. MODS 04',
  '',
  'MOD1 00AHD ENV  MOD3 03LFO',
  'DEST 02PITCH    DEST 00OFF',
  'AMT  FF         AMT  FF',
  'ATK  00         OSC  00TRI',
  'HOLD 00         TRIG 00FREE',
  'DEC  0D         FREQ 10',
  '',
  '',
  'MOD2 01ADSR ENV MOD4 03LFO',
  'DEST 01VOLUME   DEST 00OFF',
  'AMT  FF         AMT  FF',
  'ATK  00         OSC  00TRI',
  'DEC  80         TRIG 00FREE',
  'SUS  00         FREQ 10',
  'REL  10',
]

/** A screen as the SDK reports it: margin, lower case text, the track panel from column 34. */
function deviceScreen(stored: string[]) {
  const lines = storedScreen(stored).map((line) => line.toLowerCase())
  lines[5]    = `${lines[5].padEnd(34)}t>139`
  return {
    width : 40,
    height: 24,
    lines
  }
}

describe('instrument screens', () => {
  test('Instrument view cells keep their device place', () => {
    const cells = instrumentCells(FM_SCREEN)
    const find  = (label: string, operator?: string) => cells.find((c) => c.label === label && c.operator === operator)
    expect(find('CUTOFF')).toMatchObject({
      line : 17,
      x    : 8,
      shape: 'level',
      value: 0x8f
    })
    expect(find('LIM')).toMatchObject({
      x     : 22,
      shape : 'option',
      option: 'CLIP'
    })
    expect(find('PAN')?.shape).toBe('bipolar')
    expect(find('ALGO')?.option).toBe('[A>B+C]>D')
    expect(find('RATIO', 'D')).toMatchObject({
      x   : 26,
      text: '01.00'
    })
    expect(find('LEV/FB', 'B')).toMatchObject({
      shape: 'level',
      value: 0x80
    })
    expect(find('SHAPE', 'B')?.text).toBe('W0F')
    expect(find('TBL.TIC')).toMatchObject({
      x   : 21,
      text: '0E'
    })
    expect(cells.filter((c) => c.label === 'MOD' && c.line === 11)).toHaveLength(4)
  })

  test('every instrument type parses, the mixer column on the right', () => {
    for (const type of Object.keys(INSTRUMENT_TEMPLATES)) {
      const cells = instrumentCells(instrumentLines(5, type, 'TEST'))
      expect(cells.find((c) => c.label === 'TYPE')?.text).toBe(type)
      if (type !== 'MIDI OUT') expect(cells.find((c) => c.label === 'REV')?.x).toBe(22)
    }
    const midi = instrumentCells(instrumentLines(5, 'MIDI OUT', null))
    expect(midi.find((c) => c.label === 'CCA CC:VAL')?.x).toBe(12)
    expect(midi.find((c) => c.label === 'PORT')?.option).toBe('MIDI+USB')
    const external = instrumentCells(instrumentLines(5, 'EXTERNAL', null))
    expect(external.find((c) => c.label === 'CCA')).toMatchObject({
      x    : 4,
      shape: 'text'
    })
    expect(external.find((c) => c.label === 'INPUT')?.option).toBe('LINE-IN STEREO')
  })

  test('the four modulators and their slots', () => {
    const slots = modSlots(modCells(MODS_SCREEN))
    expect(slots.map((s) => [s.slot, s.kind, s.dest])).toEqual([
      [1, 'AHD', 'PITCH'],
      [2, 'ADSR', 'VOLUME'],
      [3, 'LFO', null],
      [4, 'LFO', null],
    ])
    expect(slots[1].cells.REL?.value).toBe(0x10)
    expect(slots[2].cells.OSC?.option).toBe('TRI')
  })

  test('every modulator type has a shape inside its card', () => {
    const types = Object.keys(MOD_ROWS)
    for (const [i, type] of types.entries()) {
      const rows   = MOD_ROWS[type].map((label): [string, string] => [label, label === 'DEST' ? '07CUTOFF' : label === 'OSC' ? '01SIN' : label === 'TRIG' ? '00FREE' : label === 'SRC' ? '00NOTE' : '40'])
      const lines  = instrumentModsLines(9, [{
        type: `0${i}${type}`,
        rows
      }])
      const [slot] = modSlots(modCells(lines))
      expect(slot.type).toBe(type)
      expect(slot.dest).toBe('CUTOFF')
      const points = modShape(slot)
      expect(points.length).toBeGreaterThan(1)
      for (const [t, v] of points) {
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(1)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  test('the Inst. Mods view is told apart from the Instrument view', () => {
    const mods = viewOf(deviceScreen(MODS_SCREEN))
    expect(mods.kind).toBe('instmods')
    expect(mods.id).toBe(4)
    expect(isPage(mods, 'instmods', 4)).toBe(true)
    expect(readInstrumentMods(mods)?.lines).toEqual(MODS_SCREEN.map((line) => line.toLowerCase()))
    const inst = viewOf(deviceScreen(FM_SCREEN))
    expect(inst.kind).toBe('inst')
    // FM operator D (x 26-30) is kept; the track panel is not.
    expect(readInstrument(inst)?.lines[8]).toBe('ratio   01.00 01.00 01.00 01.00')
    expect(readInstrument(inst)?.lines[2]).toBe('type    fmsynth       load save')
  })
})

describe('instrument face', () => {
  test('every parameter has a place; modulator values sit on their card', () => {
    const instrument = {
      id   : 4,
      name : 'TEST',
      type : 'FMSYNTH',
      lines: FM_SCREEN,
      mods : MODS_SCREEN
    }
    const face       = layoutInstrumentFace(instrument)
    const page       = instrumentPage(instrument)
    for (const cell of page.cells) expect(placeOf(face, 'inst', cell.line, cell.x)).not.toBeNull()
    // Every modulator value is on its own card: MOD2 under MOD1 on the left, MOD3 / MOD4 on the right.
    for (const cell of page.mods) {
      const place = placeOf(face, 'mods', cell.line, cell.x)
      const card  = face.cards.find((c) => c.slot.slot === cell.slot)
      expect(place?.cell).toBe(cell)
      expect(card && place && place.row >= card.row && place.row < card.row + MOD_CARD_ROWS).toBe(true)
      expect(card && place && place.col >= card.col).toBe(true)
    }
    expect(face.cards.map((card) => [card.col > MODS_X, card.row > 0])).toEqual([[false, false], [false, true], [true, false], [true, true]])
    // MOD1's title is a value of the card, not the instrument's title.
    const mod1 = face.places.find((p) => p.cell.label === 'MOD1')
    expect(mod1 && isTitlePlace(mod1)).toBe(false)
    // The CUTOFF value is under its own characters.
    const cutoff = face.places.find((p) => p.cell.label === 'CUTOFF')
    expect(cutoff && placeAt(face, cutoff.col + 0.5, cutoff.row)?.cell.label).toBe('CUTOFF')
    expect(face.cards.map((card) => card.active)).toEqual([true, true, false, false])
  })

  test('every type fits a face as tall as a table panel', () => {
    const mods = instrumentModsLines(1, Object.keys(MOD_ROWS).slice(0, 4).map((type) => ({
      type: `00${type}`,
      rows: MOD_ROWS[type].map((label): [string, string] => [label, label === 'DEST' ? '01VOLUME' : '40'])
    })))
    for (const type of Object.keys(INSTRUMENT_TEMPLATES)) {
      const instrument = {
        id   : 1,
        name : null,
        type,
        lines: instrumentLines(1, type, null),
        mods
      }
      const face       = layoutInstrumentFace(instrument)
      const page       = instrumentPage(instrument)
      expect(face.rows).toBe(PANEL_ROWS)
      expect(face.lines.length).toBe(PANEL_ROWS)
      for (const line of face.lines) expect(line.reduce((n, [text]) => n + text.length, 0)).toBeLessThanOrEqual(FACE_CHARS)
      for (const cell of [...page.cells, ...page.mods]) expect(placeOf(face, cell.screen, cell.line, cell.x)).not.toBeNull()
      for (const place of face.places) expect(place.row + place.height).toBeLessThanOrEqual(PANEL_ROWS)
    }
  })

  test('a parameter a modulator drives is marked with its slot', () => {
    const face = layoutInstrumentFace(demoSong().instruments[5])
    expect(face.bars.find((bar) => bar.slots.includes(3))).toBeDefined()
  })
})

describe('instrument on the device', () => {
  test('the exploration reads each instrument and its modulators, without editing', async () => {
    const device = demoSong()
    const fake   = new FakeM8(device)
    const model  = await exploreSong(fake, {
      pollMs         : 0,
      settleTimeoutMs: 400
    })
    expect(fake.forbidden).toEqual([])
    for (const id of usedItems(device).instruments) {
      expect(model.instruments[id].lines).toEqual(device.instruments[id].lines.map((line) => line.toLowerCase()))
      expect(model.instruments[id].mods?.filter(Boolean)).toEqual(device.instruments[id].mods?.map((line) => line.toLowerCase()).filter(Boolean))
    }
  })

  test('the M8 cursor on a value selects it on every panel of that instrument', () => {
    const model  = demoSong()
    const layout = new SongLayout(model)
    const cursor = new DeviceCursor()
    // CUTOFF of instrument 05 (FM): line 17, x 8.
    const places = cursor.placesOf(layout, {
      view      : 'inst',
      id        : 5,
      row       : null,
      column    : null,
      cursor    : {
        x: 8,
        y: 3 + 17
      },
      chainMarks: []
    })
    expect(places.length).toBeGreaterThan(0)
    for (const place of places) expect(place).toMatchObject({
      kind  : 'instParam',
      screen: 'inst',
      line  : 17,
      x     : 8
    })
  })

  test('the Selection panel explains a value and what modulates it', () => {
    const model  = demoSong()
    const cutoff = describeSelection(model, {
      kind      : 'instParam',
      instrument: 5,
      screen    : 'inst',
      line      : 17,
      x         : 8,
      table     : 5,
      track     : 0
    })
    expect(cutoff.title).toBe('CUTOFF · B0')
    expect(cutoff.parts.map((p) => p.text).join(' ')).toMatch(/Filter Cutoff/)
    expect(cutoff.facts.find(([label]) => label === 'Modulated by')?.[1]).toMatch(/^MOD3 · ADSR ENV/)
    const page    = instrumentPage(model.instruments[5])
    const attack  = page.slots[2].cells.ATK
    const modCell = describeSelection(model, {
      kind      : 'instParam',
      instrument: 5,
      screen    : 'mods',
      line      : attack.line,
      x         : attack.x,
      table     : 5,
      track     : 0
    })
    expect(modCell.path).toContain('MOD3')
    expect(modCell.parts.map((p) => p.text).join(' ')).toMatch(/Attack/)
  })

  test('values edited on the device are folded in, modulators too', () => {
    const model  = demoSong()
    const before = model.instruments[1].lines
    const edited = before.map((line) => (line.startsWith('START') ? line.replace('START   08', 'START   40') : line))
    expect(absorbScreen(model, deviceScreen(edited))).toBe(true)
    expect(cellAt(instrumentPage(model.instruments[1]), 'inst', 10, 8)?.value).toBe(0x40)
    expect(model.instruments[1].mods).toBeDefined()
    const mods = instrumentModsLines(1, [{
      type: '03LFO',
      rows: [['DEST', '07CUTOFF'], ['AMT', '80'], ['OSC', '01SIN'], ['TRIG', '00FREE'], ['FREQ', '10']]
    }])
    expect(absorbScreen(model, deviceScreen(mods))).toBe(true)
    expect(instrumentPage(model.instruments[1]).slots[0].kind).toBe('LFO')
  })
})
