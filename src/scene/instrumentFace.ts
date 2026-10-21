// The instrument face of a panel, laid out in character cells: the Instrument view's rows as
// the device places them (so every value sits where the M8 cursor would be), a bar after each
// level, a mark under the parameters a modulator drives, and a card per modulator with the
// shape of its envelope or LFO. Pure layout; trackView draws it.

import { hex2 } from '../model/hex'
import { type InstrumentCell, type InstrumentPage, instrumentPage, type ModSlot } from '../model/instrumentPage'
import { modShape, type Point } from '../model/modShapes'
import type { Instrument } from '../model/song'

/** Face width in characters: the Instrument view's content (FM operator D ends at x 30). */
export const FACE_CHARS     = 33
/** Title and TRANSP. rows above the parameters. */
export const FACE_HEADER    = 2
export const MOD_CARD_CHARS = 8
export const MOD_CARD_ROWS  = 5
/** Rows of a card's curve, under its title row. */
export const MOD_CURVE_ROWS = 3
/** The mixer column's labels start here; left bars stop a blank before. */
const MIXER_X               = 18
/** Bars shorter than this are not drawn. */
const MIN_BAR_CHARS         = 2

export type TextRole = 'title' | 'label' | 'value' | 'option' | 'empty' | `slot${1 | 2 | 3 | 4}`

/** A run of characters drawn in one colour. */
export type TextRun = [text: string, role: TextRole]

/** Where a cell sits on the face, in characters and rows from its top-left corner. */
export interface FacePlace {
  cell  : InstrumentCell
  col   : number
  row   : number
  width : number
  height: number
}

export interface FaceBar {
  col    : number
  row    : number
  width  : number
  /** 0..1 */
  level  : number
  bipolar: boolean
  /** A thin meter under the value instead of a bar after it (FM operator levels). */
  under  : boolean
  /** Slots (1-4) whose destination is this parameter. */
  slots  : number[]
}

export interface ModCard {
  slot  : ModSlot
  col   : number
  row   : number
  /** The curve: t and v in 0..1 across the card's curve rows. */
  points: Point[]
  /** Its destination is set (not OFF). */
  active: boolean
  /** LFOs swing around the middle; envelopes rise from the bottom. */
  center: boolean
}

export interface InstrumentFace {
  rows  : number
  lines : TextRun[][]
  places: FacePlace[]
  bars  : FaceBar[]
  cards : ModCard[]
}

const SHORT_KINDS: Record<string, string> = {
  AHD     : 'AHD',
  ADSR    : 'ADSR',
  DRUM    : 'DRUM',
  LFO     : 'LFO',
  TRIG    : 'TRIG',
  TRACKING: 'TRACK'
}

/** Colour roles of a device line: labels, then each value over them (options dimmer after their number). */
function lineRuns(text: string, cells: InstrumentCell[]): TextRun[] {
  const roles: TextRole[] = Array.from(text, (char) => (char === ' ' ? 'empty' : 'label'))
  for (const cell of cells) {
    const empty = /^[-:]+$/.test(cell.text)
    for (let i = 0; i < cell.text.length && cell.x + i < roles.length; i += 1) {
      roles[cell.x + i] = empty ? 'empty' : cell.shape === 'option' && i >= 2 ? 'option' : 'value'
    }
  }
  return runsOf(text, roles)
}

function runsOf(text: string, roles: TextRole[]): TextRun[] {
  const runs: TextRun[] = []
  for (let i = 0; i < text.length; i += 1) {
    const last = runs[runs.length - 1]
    if (last && last[1] === roles[i]) last[0] += text[i]
    else runs.push([text[i], roles[i]])
  }
  return runs
}

/** The title row: 'I01 GRAYSATURN' on the left, the type on the right. */
function titleRow(instrument: Instrument, page: InstrumentPage, places: FacePlace[]): TextRun[] {
  const nameCell = page.cells.find((cell) => cell.label === 'NAME')
  const typeCell = page.cells.find((cell) => cell.label === 'TYPE')
  const name     = (instrument.name ?? '').padEnd(12, '-').slice(0, 12)
  const type     = (instrument.type ?? typeCell?.text ?? '?').slice(0, 14)
  const typeCol  = FACE_CHARS - type.length
  if (nameCell) places.push({
    cell  : nameCell,
    col   : 4,
    row   : 0,
    width : 12,
    height: 1
  })
  if (typeCell) places.push({
    cell  : typeCell,
    col   : typeCol,
    row   : 0,
    width : type.length,
    height: 1
  })
  return [[`I${hex2(instrument.id)} `, 'title'], [name, instrument.name ? 'value' : 'empty'], [' '.repeat(typeCol - 16), 'empty'], [type, 'label']]
}

/** Bars of the level values on one device line. */
function barsOf(cells: InstrumentCell[], row: number, page: InstrumentPage): FaceBar[] {
  const bars: FaceBar[] = []
  for (const cell of cells) {
    if ((cell.shape !== 'level' && cell.shape !== 'bipolar') || cell.value == null) continue
    const slots = page.slots.filter((slot) => slot.dest != null && slot.dest === cell.label).map((slot) => slot.slot)
    if (cell.operator) {
      bars.push({
        col    : cell.x,
        row,
        width  : cell.width,
        level  : cell.value / 0xff,
        bipolar: false,
        under  : true,
        slots
      })
      continue
    }
    const col = cell.x + cell.width + 1
    const end = cell.x < MIXER_X ? MIXER_X - 1 : FACE_CHARS
    if (end - col < MIN_BAR_CHARS) continue
    bars.push({
      col,
      row,
      width  : end - col,
      level  : cell.value / 0xff,
      bipolar: cell.shape === 'bipolar',
      under  : false,
      slots
    })
  }
  return bars
}

/** The four modulator cards: title, curve, destination; their cells placed on them. */
function modCards(page: InstrumentPage, top: number, lines: TextRun[][], places: FacePlace[]): ModCard[] {
  const cards  = page.slots.map((slot, i): ModCard => ({
    slot,
    col   : i * MOD_CARD_CHARS,
    row   : top,
    points: modShape(slot),
    active: slot.dest != null,
    center: slot.kind === 'LFO'
  }))
  const titles : TextRun[] = []
  const dests  : TextRun[] = []
  for (const card of cards) {
    const { slot } = card
    const kind     = (slot.kind ? SHORT_KINDS[slot.kind] : (slot.type ?? '?')).slice(0, MOD_CARD_CHARS - 3)
    const dest     = (slot.dest ?? 'OFF').slice(0, MOD_CARD_CHARS - 1)
    titles.push([String(slot.slot), `slot${slot.slot}` as TextRole], [` ${kind}`.padEnd(MOD_CARD_CHARS - 1), card.active ? 'label' : 'empty'])
    dests.push([dest.padEnd(MOD_CARD_CHARS), card.active ? 'value' : 'empty'])
    const head = slot.cells[`MOD${slot.slot}`]
    const at   = (cell: InstrumentCell | undefined, row: number, height: number) => {
      if (cell) places.push({
        cell,
        col  : card.col,
        row,
        width: MOD_CARD_CHARS - 1,
        height
      })
    }
    at(head, top, 1)
    at(head, top + 1, MOD_CURVE_ROWS)
    at(slot.cells.DEST, top + 1 + MOD_CURVE_ROWS, 1)
  }
  lines.push(titles)
  for (let r = 0; r < MOD_CURVE_ROWS; r += 1) lines.push([])
  lines.push(dests)
  return cards
}

/** Lays out an instrument's face from its stored screens. */
export function layoutInstrumentFace(instrument: Instrument): InstrumentFace {
  const page   = instrumentPage(instrument)
  const places : FacePlace[] = []
  const bars   : FaceBar[] = []
  const lines  : TextRun[][] = [titleRow(instrument, page, places)]
  const stored = instrument.lines.map((line) => line.toUpperCase())

  // The TRANSP. / TBL.TIC / EQ line under the title.
  const transpLine  = stored.findIndex((line) => line.startsWith('TRANSP.'))
  const headerCells = page.cells.filter((cell) => cell.line === transpLine)
  lines.push(transpLine >= 0 ? lineRuns(stored[transpLine], headerCells) : [['NOT READ', 'empty']])
  for (const cell of headerCells) places.push({
    cell,
    col   : cell.x,
    row   : 1,
    width : cell.width,
    height: 1
  })

  // The parameters, line for line as on the device (the blank line under TRANSP. is left out).
  let first = transpLine + 1
  while (first < stored.length && !stored[first].trim()) first += 1
  let last  = stored.length - 1
  while (last >= first && !stored[last].trim()) last -= 1
  for (let line = first; line <= last && transpLine >= 0; line += 1) {
    const row   = lines.length
    const cells = page.cells.filter((cell) => cell.line === line)
    lines.push(lineRuns(stored[line].slice(0, FACE_CHARS), cells))
    bars.push(...barsOf(cells, row, page))
    for (const cell of cells) places.push({
      cell,
      col   : cell.x,
      row,
      width : Math.min(cell.width, FACE_CHARS - cell.x),
      height: 1
    })
  }

  lines.push([])
  let cards: ModCard[] = []
  if (page.slots.length) cards = modCards(page, lines.length, lines, places)
  else lines.push([['MODULATORS NOT READ · EXPLORE AGAIN', 'empty']])
  return {
    rows: lines.length,
    lines,
    places,
    bars,
    cards
  }
}

/**
 * Where a value is drawn: its own place, or for a modulator value without one (ATK, AMT...)
 * the curve of its card.
 */
export function placeOf(face: InstrumentFace, screen: InstrumentCell['screen'], line: number, x: number): FacePlace | null {
  const own = face.places.find((place) => place.cell.screen === screen && place.cell.line === line && place.cell.x === x)
  if (own) return own
  if (screen !== 'mods') return null
  const slot = face.cards.find((card) => Object.values(card.slot.cells).some((cell) => cell.line === line && cell.x === x))
  return slot ? (face.places.find((place) => place.cell.slot === slot.slot.slot && place.height === MOD_CURVE_ROWS) ?? null) : null
}

/** The place under a face position (characters, rows), the smallest first. */
export function placeAt(face: InstrumentFace, col: number, row: number): FacePlace | null {
  const hits = face.places.filter((place) => col >= place.col - 0.5 && col < place.col + place.width + 0.5 && row >= place.row && row < place.row + place.height)
  return hits.sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null
}
